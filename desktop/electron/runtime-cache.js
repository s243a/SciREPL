/**
 * runtime-cache.js — a persistent on-disk cache for CDN runtimes, kept in the
 * application's own data directory.
 *
 * Why this exists
 * ---------------
 * `www/sw.js` maintains a `CDN_CACHE` so that a runtime fetched once (Lua, R,
 * a Pyodide mirror) keeps working offline. That mechanism cannot work in the
 * shell: the Cache API only accepts `http`/`https` requests, and this
 * application is served from `app://`, so every `cache.addAll()` rejects with
 * "Request scheme 'app' is unsupported". Measured: both caches present, zero
 * entries.
 *
 * Chromium's ordinary HTTP disk cache partly compensates, but only partly —
 * measured, Lua (~200 kB) survives a restart while webR (~50 MB) does not, and
 * raising `--disk-cache-size` to 2 GB does not change that. It is a heuristic,
 * evictable cache that was never a promise.
 *
 * So the shell keeps its own. This intercepts `https` for an allowlist of
 * runtime hosts, serves a hit straight from disk, and on a miss fetches once and
 * writes the bytes into `userData/runtime-cache/`. That directory is the app's
 * own storage: not evictable, not size-limited by Chromium, and it survives
 * restarts and updates.
 *
 * Deliberately narrow
 * -------------------
 *   - Only the hosts in the allowlist are touched. Everything else is passed
 *     straight through to `net.fetch` unmodified.
 *   - Only `GET` is cached, only `200`, and never a range request — a partial
 *     body written as if whole is a corrupt cache entry, which is worse than no
 *     cache.
 *   - Nothing is exposed to the renderer beyond static facts in the existing
 *     getDistributionInfo() result (ipc.js), taken once at startup: whether
 *     this cache is active, its host allowlist, and which cached URLs are
 *     intact or missing (snapshotSync). The renderer uses them only to decide
 *     whether a runtime it loaded before may skip the download prompt. No new
 *     IPC channel, no paths, no contents, so it does not widen the boundary
 *     described in security.js.
 */

const { net } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

/**
 * Hosts whose responses may be cached. These are the runtime and package hosts
 * from build-profiles.json and package_catalog.js — the things the service
 * worker's CDN_CACHE was for. Deliberately a subset of protocol.js's
 * REMOTE_ORIGINS: the GitHub API and similar are reachable but must not be
 * cached, since their responses change.
 */
const CACHEABLE_HOSTS = new Set([
  'cdn.jsdelivr.net',
  'unpkg.com',
  'repo.r-wasm.org',
  'webr.r-wasm.org',
  'files.pythonhosted.org',
]);

/**
 * Requests that must never be cached, because the resource behind them changes.
 *
 * `repo.r-wasm.org` is a **mutable package repository**: its `PACKAGES` indexes
 * list what is currently available and at which version. Caching those forever
 * would freeze the catalogue at whatever it happened to be on the day a user
 * first installed something — so `install.packages()` would keep offering stale
 * versions, and any future update checker would be reading a permanent snapshot
 * and reporting "up to date" indefinitely.
 *
 * A query string is treated the same way: it almost always means the response
 * is parameterised rather than a fixed asset.
 *
 * These pass straight through to the network, so they are correct when online
 * and simply unavailable offline — which is the honest behaviour for "what
 * exists right now?".
 */
const NEVER_CACHE = [
  /\/PACKAGES(\.gz|\.rds)?$/i,   // R repository indexes
  /\/PACKAGES\.json$/i,
  /\/index\.json$/i,
];

/**
 * Is this URL a version-pinned, immutable asset?
 *
 * Only these may have a **404 cached**. A "not found" is a fact about a moment
 * in time for a mutable path — a package that does not exist today may exist
 * tomorrow — but for a version-pinned path it is permanent, and caching it is
 * what lets webR's `HEAD` probes for optional files answer offline.
 *
 *   webr.r-wasm.org/v0.5.4/...            version segment
 *   cdn.jsdelivr.net/npm/scittle@0.6.22/  name@version
 *   unpkg.com/fengari-web@0.1.4/...       name@version
 *   .../ggplot2_3.5.1.tgz                 R package with version in the filename
 *   files.pythonhosted.org/...            content-addressed by hash
 */
function isVersionPinned(url) {
  if (url.hostname === 'files.pythonhosted.org') return true;
  const p = url.pathname;
  if (/\/v\d+\.\d+(\.\d+)?\//.test(p)) return true;      // /v0.5.4/
  if (/@\d+\.\d+/.test(p)) return true;                    // name@1.2.3
  if (/_\d[\w.-]*\.(tgz|tar\.gz|zip)$/i.test(p)) return true; // name_1.2.3.tgz
  return false;
}

/** Mutable repository metadata and other responses that must stay live. */
function isNeverCacheable(url) {
  if (url.search) return true;
  return NEVER_CACHE.some((re) => re.test(url.pathname));
}

/** Metadata we need to reconstruct a response. */
const META_SUFFIX = '.meta.json';

/**
 * Append-only list of every entry the cache set out to store ("METHOD url" per
 * line), written before the body is read or written, plus any entry first
 * served from a cache written by an older build that had no journal
 * (noteHit). Comparing it with the
 * entries actually present (snapshotSync) shows what has gone missing since:
 * a body or metadata deleted by hand, or a write that never finished. Removing
 * the whole directory removes the journal too, which is why the renderer also
 * requires its runtime's loader URL to be present, not merely not missing.
 */
const JOURNAL_NAME = 'journal.log';

/** Files in the cache directory that are not cache entries. */
function isBookkeeping(name) {
  return name === JOURNAL_NAME || name.endsWith(META_SUFFIX) || name.endsWith('.partial');
}

/**
 * Cache key. The method is part of it because webR probes its virtual
 * filesystem with HEAD before fetching with GET, and the two have different
 * bodies (a HEAD has none) but the same URL.
 */
function keyFor(url, method = 'GET') {
  return crypto.createHash('sha256').update(`${method} ${url}`).digest('hex');
}

/** Headers worth preserving on a replay. */
const PRESERVED_HEADERS = ['content-type', 'content-encoding', 'access-control-allow-origin'];

class RuntimeCache {
  constructor(cacheDir, { log = () => {} } = {}) {
    this.dir = cacheDir;
    this.log = log;
    this.stats = { hits: 0, misses: 0, stored: 0, bypassed: 0, errors: 0 };
    fs.mkdirSync(this.dir, { recursive: true });
    /** "METHOD url" lines already in the journal; loaded on first use. */
    this._journaled = null;
    /** Appends still in flight, so a concurrent caller can wait for the same line. */
    this._pendingJournal = new Map();
  }

  _journalPath() {
    return path.join(this.dir, JOURNAL_NAME);
  }

  _loadJournalSync() {
    let text = '';
    try { text = fs.readFileSync(this._journalPath(), 'utf8'); } catch { /* none yet */ }
    this._journaled = new Set(text.split('\n').filter((line) => line.indexOf(' ') > 0));
    return this._journaled;
  }

  _paths(url, method = 'GET') {
    const key = keyFor(url, method);
    return {
      body: path.join(this.dir, key),
      meta: path.join(this.dir, key + META_SUFFIX),
    };
  }

  async read(url, method = 'GET') {
    const { body, meta } = this._paths(url, method);
    try {
      const metaRaw = await fsp.readFile(meta, 'utf8');
      const parsed = JSON.parse(metaRaw);
      // A HEAD entry has no body by definition, and a cached error response
      // (see write()) has none either.
      const bytes = parsed.hasBody ? await fsp.readFile(body) : Buffer.alloc(0);
      return { bytes, meta: parsed };
    } catch {
      return null;
    }
  }

  /** Record that this entry is about to be stored (see JOURNAL_NAME). */
  async journal(url, method = 'GET') {
    const line = `${method} ${url}`;
    (this._journaled || this._loadJournalSync()).add(line);
    const pending = fsp.appendFile(this._journalPath(), `${line}\n`);
    this._pendingJournal.set(line, pending);
    try {
      await pending;
    } finally {
      if (this._pendingJournal.get(line) === pending) this._pendingJournal.delete(line);
    }
  }

  /**
   * A hit on an entry the journal does not know yet: one stored before the
   * journal existed (a cache written by an older build) has no line in it.
   * Journal it on first use, so that from then on deleting it shows up as
   * missing. Its presence never depended on this: snapshotSync() reports an
   * intact entry as present whether or not it is journaled, so an upgraded
   * cache is recognised from the first start.
   *
   * The hit path awaits this before it serves the response. The renderer
   * writes its receipt only after the runtime has loaded, i.e. after every
   * response it needed, so no receipt can exist for a load whose journal
   * lines are not yet written. After the first hit this is a Set lookup; the
   * one-time append per inherited entry is a small local write.
   */
  async noteHit(url, method = 'GET') {
    const line = `${method} ${url}`;
    const journaled = this._journaled || this._loadJournalSync();
    if (journaled.has(line)) {
      // Another request for the same entry may have started the append; its
      // response must not go out before the line is written either.
      const pending = this._pendingJournal.get(line);
      if (pending) await pending.catch(() => {});
      return false;
    }
    await this.journal(url, method);
    return true;
  }

  /**
   * Which stored entries are intact right now, and which journaled ones are
   * not. Synchronous and read once at startup, before the window loads: the
   * result is reported to the renderer as a static fact (ipc.js), and that is
   * enough, because the renderer only needs it to decide whether to skip the
   * download prompt for a runtime it has not loaded yet this session.
   *
   * @returns {{ present: string[], missing: string[] }} `present` lists URLs
   *   with an intact GET entry (metadata plus a body of the recorded size);
   *   `missing` lists URLs with a journaled GET or HEAD entry that is not intact.
   */
  snapshotSync() {
    const intact = new Set();   // "METHOD url"
    let names = [];
    try { names = fs.readdirSync(this.dir); } catch { /* no directory: nothing cached */ }
    for (const name of names) {
      if (!name.endsWith(META_SUFFIX)) continue;
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(this.dir, name), 'utf8'));
        if (typeof meta.url !== 'string' || typeof meta.method !== 'string') continue;
        const { body, meta: metaPath } = this._paths(meta.url, meta.method);
        if (metaPath !== path.join(this.dir, name)) continue; // not where read() would look
        if (meta.hasBody) {
          const st = fs.statSync(body, { throwIfNoEntry: false });
          if (!st || st.size !== meta.bytes) continue;
        }
        intact.add(`${meta.method} ${meta.url}`);
      } catch { /* unreadable metadata is not an intact entry */ }
    }
    const missing = new Set();
    for (const line of this._loadJournalSync()) {
      if (!intact.has(line)) missing.add(line.slice(line.indexOf(' ') + 1));
    }
    const present = [];
    for (const key of intact) {
      if (key.startsWith('GET ')) present.push(key.slice(4));
    }
    return { present: present.sort(), missing: [...missing].sort() };
  }

  async write(url, bytes, headers, { method = 'GET', status = 200 } = {}) {
    const { body, meta } = this._paths(url, method);
    const kept = {};
    for (const h of PRESERVED_HEADERS) {
      const v = headers.get(h);
      if (v) kept[h] = v;
    }
    const hasBody = bytes.length > 0;
    if (hasBody) {
      // Write to a temp name and rename, so a crash mid-write cannot leave a
      // truncated body that would then be served forever as a "hit".
      const tmp = body + '.partial';
      await fsp.writeFile(tmp, bytes);
      await fsp.rename(tmp, body);
    }
    // The metadata is written last, and read() keys off it, so a body without
    // metadata is simply never treated as a hit.
    await fsp.writeFile(meta, JSON.stringify({
      url, method, status, headers: kept, hasBody,
      bytes: bytes.length, storedAt: new Date().toISOString(),
    }));
    this.stats.stored++;
  }

  async size() {
    let total = 0;
    let entries = 0;
    for (const name of await fsp.readdir(this.dir).catch(() => [])) {
      if (isBookkeeping(name)) continue;
      const st = await fsp.stat(path.join(this.dir, name)).catch(() => null);
      if (st) { total += st.size; entries++; }
    }
    return { bytes: total, entries };
  }

  async clear() {
    await fsp.rm(this.dir, { recursive: true, force: true });
    fs.mkdirSync(this.dir, { recursive: true });
    this._journaled = new Set();
  }
}

/**
 * Install the cache on a session.
 *
 * @param {Electron.Session} session
 * @param {object} options
 * @param {string} options.cacheDir  directory inside userData
 * @param {Set<string>} [options.hosts]
 * @param {Function} [options.log]
 * @returns {RuntimeCache}
 */
function installRuntimeCache(session, options = {}) {
  const hosts = options.hosts || CACHEABLE_HOSTS;
  const cache = new RuntimeCache(options.cacheDir, { log: options.log });
  const debug = process.env.SCIREPL_RUNTIME_CACHE_DEBUG === '1';
  const log = options.log || (() => {});

  session.protocol.handle('https', async (request) => {
    const url = new URL(request.url);

    const range = request.headers.get('range');
    // webR probes its virtual filesystem with HEAD before fetching with GET, so
    // both must be cached or the probes hit the network and fail offline.
    const method = request.method;
    const cacheable =
      (method === 'GET' || method === 'HEAD') &&
      hosts.has(url.hostname) &&
      !range &&                 // never cache a partial body
      !isNeverCacheable(url);   // never cache mutable repository metadata

    if (debug) {
      // To a file, not the console: the main process's stderr is swallowed by
      // the test driver, which is exactly when this is most needed.
      try {
        fs.appendFileSync(path.join(options.cacheDir, '..', 'runtime-cache-debug.log'),
          `${cacheable ? 'CACHEABLE' : 'BYPASS   '} ${method} ` +
          `${range ? `(range ${range}) ` : ''}${request.url}\n`);
      } catch { /* diagnostics must never break the request */ }
    }

    if (!cacheable) {
      cache.stats.bypassed++;
      // Pass through untouched. bypassCustomProtocolHandlers stops this call
      // from re-entering this same handler.
      return net.fetch(request, { bypassCustomProtocolHandlers: true });
    }

    const hit = await cache.read(request.url, method);
    if (hit) {
      cache.stats.hits++;
      // Awaited, not fire-and-forget: the journal line must be written before
      // the response can contribute to a load the renderer then records.
      try {
        await cache.noteHit(request.url, method);
      } catch (e) {
        log('runtime-cache journal write failed', String(e && e.message));
      }
      return new Response(hit.meta.hasBody ? hit.bytes : null, {
        status: hit.meta.status || 200,
        headers: hit.meta.headers || {},
      });
    }

    cache.stats.misses++;
    let response;
    try {
      response = await net.fetch(request, { bypassCustomProtocolHandlers: true });
    } catch (err) {
      // Offline with nothing cached: fail the way the network would.
      cache.stats.errors++;
      throw err;
    }

    // Cache 200 always; cache 404 only for version-pinned paths.
    //
    // The 404 case matters because webR probes for optional files and a probe
    // that *errors* offline behaves differently from one that answers "no". But
    // "not found" is only permanently true for an immutable, version-pinned
    // URL. On a mutable path — an R package that has not been published yet —
    // caching the 404 would make it permanently non-existent for that user.
    // Anything else (5xx, redirects) passes through uncached as possibly
    // transient.
    if (response.status === 404 && !isVersionPinned(url)) return response;
    if (response.status !== 200 && response.status !== 404) return response;

    // Journal before the body is read: if the download or the write is cut
    // short, the entry shows up as missing at the next start rather than
    // silently never having existed.
    try {
      await cache.journal(request.url, method);
    } catch (e) {
      log('runtime-cache journal write failed', String(e && e.message));
    }

    // A HEAD has no body to read or store.
    const buf = method === 'HEAD'
      ? Buffer.alloc(0)
      : Buffer.from(await response.arrayBuffer());

    cache.write(request.url, buf, response.headers, { method, status: response.status })
      .catch((e) => {
        cache.stats.errors++;
        log('runtime-cache write failed', String(e && e.message));
      });

    const headers = {};
    for (const h of PRESERVED_HEADERS) {
      const v = response.headers.get(h);
      if (v) headers[h] = v;
    }
    return new Response(buf.length ? buf : null, { status: response.status, headers });
  });

  return cache;
}

module.exports = {
  installRuntimeCache, RuntimeCache, CACHEABLE_HOSTS, keyFor, JOURNAL_NAME,
  isVersionPinned, isNeverCacheable, NEVER_CACHE,
};
