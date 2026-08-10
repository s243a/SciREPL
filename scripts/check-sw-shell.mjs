/**
 * check-sw-shell.mjs — a changed worker or app-shell asset must bump CACHE_VERSION.
 *
 *   node scripts/check-sw-shell.mjs           # verify (CI)
 *   node scripts/check-sw-shell.mjs --write   # append the current state
 *
 * The service worker keys its cache on CACHE_VERSION. If the worker logic or any
 * app-shell file changes but the version does not, browsers never see a new
 * worker (unchanged sw.js bytes / same cache name), so clients keep serving the
 * old assets and — worse — a re-install under the same cache name can wipe a
 * complete cache and leave a partial one. So a content change MUST bump the
 * version.
 *
 * Enforcement is an APPEND-ONLY history: www/sw-shell.lock.json maps each
 * version to the content hash that shipped it. The rules the history enforces:
 *
 *   - the current CACHE_VERSION must be present in the history;
 *   - the current content hash must equal what the history recorded for it;
 *   - a version already in the history can NEVER be re-assigned a different hash
 *     (so `--write` cannot paper over a same-version content change — the exact
 *     bypass this replaces);
 *   - the hash covers sw.js (the worker logic) as well as every app-shell asset.
 *
 * `--write` only ever ADDS a new version, or is a no-op when the current version
 * already records the current hash. It refuses to overwrite an existing version.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const WWW = path.join(ROOT, 'www');
const SW = path.join(WWW, 'sw.js');
const LOCK = path.join(WWW, 'sw-shell.lock.json');

const sw = readFileSync(SW, 'utf8');

const versionMatch = sw.match(/const CACHE_VERSION = '([^']+)'/);
if (!versionMatch) {
    console.error('[sw] could not find CACHE_VERSION in sw.js');
    process.exit(2);
}
const version = versionMatch[1];

const shellBlock = sw.match(/const APP_SHELL = \[([\s\S]*?)\];/);
if (!shellBlock) {
    console.error('[sw] could not find APP_SHELL in sw.js');
    process.exit(2);
}
const shell = [...shellBlock[1].matchAll(/'(\.\/[^']+)'/g)].map((m) => m[1]).sort();

// Hash the worker logic AND every app-shell asset. sw.js's CACHE_VERSION line is
// excluded, or the version bump itself would change the hash and defeat the
// "same content, must bump" check (the bump is the intended, hash-neutral edit).
const swForHash = sw.replace(/const CACHE_VERSION = '[^']+'/, "const CACHE_VERSION = '<version>'");
const hash = createHash('sha256');
hash.update(`entries=${shell.length}\n`);
hash.update('sw.js\0');
hash.update(swForHash);
hash.update('\0');
const missing = [];
for (const rel of shell) {
    const file = path.join(WWW, rel.replace(/^\.\//, ''));
    let bytes;
    try { bytes = readFileSync(file); } catch { missing.push(rel); continue; }
    hash.update(rel + '\0');
    hash.update(bytes);
    hash.update('\0');
}
if (missing.length) {
    console.error('[sw] APP_SHELL lists files that do not exist:', missing.join(', '));
    process.exit(1);
}
const digest = hash.digest('hex');

let lock = { reserved: [], history: {} };
try {
    const parsed = JSON.parse(readFileSync(LOCK, 'utf8'));
    if (parsed && parsed.history && typeof parsed.history === 'object') {
        lock = { reserved: Array.isArray(parsed.reserved) ? parsed.reserved : [], history: parsed.history };
    }
} catch { /* missing or legacy; treated as empty */ }

const recorded = lock.history[version];

// Monotonic floor. Every version ever used — recorded in history OR reserved as
// previously deployed — is off-limits for reuse, and a new version must be
// strictly greater than all of them. Rolling the worker back to an old ID (e.g.
// v129) would otherwise let --write append it and pass CI, while browsers reuse
// that cache name against changed content and wipe a good cache.
const asNum = (v) => { const m = /^v(\d+)$/.exec(v); return m ? parseInt(m[1], 10) : NaN; };
const usedVersions = [...Object.keys(lock.history), ...lock.reserved];
const floor = usedVersions.reduce((mx, v) => Math.max(mx, asNum(v) || 0), 0);
const curN = asNum(version);
if (!Number.isFinite(curN)) {
    console.error(`[sw] CACHE_VERSION '${version}' is not of the form vN; cannot order it.`);
    process.exit(2);
}
const isReserved = lock.reserved.includes(version);

if (process.argv.includes('--write')) {
    if (recorded && recorded !== digest) {
        console.error(`[sw] refusing to change the recorded hash for ${version}.\n` +
            '     A version, once shipped, is immutable. Bump CACHE_VERSION and\n' +
            '     re-run --write to append the new version.');
        process.exit(1);
    }
    if (recorded === digest) {
        console.log(`[sw] ${version} already recorded and unchanged; nothing to write.`);
        process.exit(0);
    }
    if (isReserved) {
        console.error(`[sw] '${version}' is a reserved, previously-deployed version and ` +
            'cannot be reused. Choose a version above v' + floor + '.');
        process.exit(1);
    }
    if (curN <= floor) {
        console.error(`[sw] '${version}' is at or below the highest used version (v${floor}). ` +
            'Versions only go up — reusing an old ID reuses its cache name against new ' +
            'content. Choose a version above v' + floor + '.');
        process.exit(1);
    }
    lock.history[version] = digest;
    writeFileSync(LOCK, JSON.stringify({ reserved: lock.reserved, history: lock.history }, null, 2) + '\n');
    console.log(`[sw] appended ${version} to the shell history (${shell.length} assets + worker).`);
    process.exit(0);
}

// Verify.
if (!recorded) {
    if (isReserved || curN <= floor) {
        console.error(`[sw] CACHE_VERSION '${version}' reuses a previously-deployed ID ` +
            `(floor is v${floor}). Versions only go up. Choose a version above v${floor}.`);
        process.exit(1);
    }
    console.error(`[sw] CACHE_VERSION '${version}' is not in the shell history.\n` +
        '     If you bumped the version, record it: node scripts/check-sw-shell.mjs --write');
    process.exit(1);
}
if (recorded !== digest) {
    console.error(`[sw] the worker or an app-shell asset changed but CACHE_VERSION ` +
        `is still '${version}'.\n` +
        '     Bump CACHE_VERSION in www/sw.js, then: node scripts/check-sw-shell.mjs --write\n' +
        '     (--write will NOT overwrite an existing version — that is the point.)');
    process.exit(1);
}
console.log(`[sw] ${version} matches the recorded shell hash (${Object.keys(lock.history).length} in history). OK.`);
