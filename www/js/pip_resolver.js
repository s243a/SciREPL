/**
 * pip_resolver.js — pure resolution logic for %pip's partial-bundle fallback.
 *
 * The Free build vendors a partial Pyodide distribution; packages outside it
 * are resolved against the OFFICIAL Pyodide lockfile for the interpreter
 * version. This module owns everything deterministic about that: requirement
 * parsing (PEP 508 subset), version-specifier matching (PEP 440 subset),
 * import-name lookup, and dependency-graph traversal with partial recovery.
 * No DOM, no fetch, no pyodide — so it runs under node for regression tests.
 *
 * Loaded as a classic script in the app (globalThis.PipResolver); the node
 * test evaluates this file and reads the same global.
 */
(function () {
    'use strict';

    /** Distribution-name normalization per PEP 503. */
    function normName(name) {
        return String(name).toLowerCase().replace(/[-_.]+/g, '-');
    }

    /**
     * Parse one %pip requirement token. Supported: name, extras (accepted,
     * recorded, not resolved), version specifiers (==, !=, >=, <=, >, <, ~=,
     * with .* prefixes on == / !=). Rejected with {code:'UNSUPPORTED'}:
     * direct references (name @ url), bare URLs/paths, environment markers
     * (;), and pip options (-r, --index-url, ...). Never guess.
     */
    function parseRequirement(raw) {
        const text = String(raw).trim();
        const fail = (reason) => {
            const e = new Error(`unsupported requirement '${text}': ${reason}`);
            e.code = 'UNSUPPORTED';
            throw e;
        };
        if (!text) fail('empty');
        if (text.startsWith('-')) fail('pip options are not supported in %pip');
        if (text.includes(';')) fail('environment markers are not supported');
        if (text.includes('@') || /^[a-z]+:\/\//i.test(text) || text.includes('/')) {
            fail('direct references and URLs are not supported');
        }
        const m = /^([A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?)(\[[A-Za-z0-9,._ -]*\])?\s*(.*)$/.exec(text);
        if (!m) fail('cannot parse');
        const name = m[1];
        let extras = [];
        if (m[3] !== undefined) {
            // Extras must be a non-empty, well-formed, comma-separated list:
            // 'pkg[]', 'pkg[,]', 'pkg[x,]' are malformed, not "empty extras".
            const inner = m[3].slice(1, -1);
            const items = inner.split(',').map(s => s.trim());
            const EXTRA = /^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?$/;
            if (!items.length || items.some(s => !EXTRA.test(s))) {
                fail(`malformed extras list '${m[3]}'`);
            }
            extras = items;
        }
        let rest = m[4].trim();
        if (rest.startsWith('(') && rest.endsWith(')')) rest = rest.slice(1, -1).trim();
        const specifiers = [];
        if (rest) {
            // Empty clauses are malformed, never skipped: 'pkg>=1,,<4' and
            // leading/trailing commas reject the whole requirement.
            for (const clause of rest.split(',')) {
                const c = clause.trim();
                if (!c) fail('empty specifier clause (stray comma)');
                if (c.startsWith('===')) fail("arbitrary equality '===' is not supported");
                const sm = /^(==|!=|~=|>=|<=|>|<)\s*([A-Za-z0-9!+*._-]+)$/.exec(c);
                if (!sm) fail(`bad specifier clause '${c}'`);
                const op = sm[1], v = sm[2];
                if (v.includes('*')) {
                    // Wildcards: only a trailing '.*' on == / !=, and the stem
                    // must be a plain epoch+release version (PEP 440 allows a
                    // few exotic prefix forms; we reject rather than guess).
                    if (op !== '==' && op !== '!=') fail(`wildcard not allowed with '${op}'`);
                    if (!v.endsWith('.*') || v.indexOf('*') !== v.length - 1) {
                        fail(`invalid wildcard placement in '${v}'`);
                    }
                    const stem = parseVersion(v.slice(0, -2));   // throws UNSUPPORTED on garbage
                    if (stem.pre || stem.post !== null || stem.dev !== null || stem.local) {
                        fail(`unsupported prefix pattern '${v}'`);
                    }
                } else {
                    const pv = parseVersion(v);                  // throws UNSUPPORTED on garbage
                    if (pv.local && op !== '==' && op !== '!=') {
                        fail(`local version not allowed with '${op}'`);
                    }
                    if (op === '~=' && pv.release.length < 2) {
                        fail(`'~=' needs at least two release segments in '${v}'`);
                    }
                }
                specifiers.push({ op, version: v });
            }
        }
        return { name, norm: normName(name), extras, specifiers, raw: text };
    }

    /**
     * PEP 440 version parsing and comparison. Handles epochs (N!), release
     * segments, pre-releases (a/b/c/rc/alpha/beta/preview/pre), post
     * releases (.postN / -N / rev / r), dev releases (.devN), and local
     * versions (+local — compared as PEP 440 prescribes: a local version
     * sorts above the same public version). Unparseable versions throw
     * UNSUPPORTED so callers reject rather than mis-compare.
     */
    const PRE_RANK = { a: 0, alpha: 0, b: 1, beta: 1, c: 2, rc: 2, pre: 2, preview: 2 };

    function parseVersion(v) {
        const text = String(v).trim().toLowerCase().replace(/^v/, '');
        const m = /^(?:(\d+)!)?(\d+(?:\.\d+)*)(?:[._-]?(a|b|c|rc|alpha|beta|preview|pre)[._-]?(\d*))?(?:[._-]?(?:post|rev|r)[._-]?(\d*)|-(\d+))?(?:[._-]?dev[._-]?(\d*))?(?:\+([a-z0-9]+(?:[._-][a-z0-9]+)*))?$/.exec(text);
        if (!m) {
            const e = new Error(`unsupported version '${v}'`);
            e.code = 'UNSUPPORTED';
            throw e;
        }
        // Numeric components are BigInt: PEP 440 places no bound on epochs,
        // release segments, or pre/post/dev/local numbers, and Number would
        // silently collapse values beyond 2^53 (9007199254740993 would
        // compare equal to ...992).
        return {
            epoch: m[1] ? BigInt(m[1]) : 0n,
            release: m[2].split('.').map(BigInt),
            // pre: [rank, n]; ordering of an absent pre is phase-dependent
            // (see cmpParsed's canonical key)
            pre: m[3] ? [PRE_RANK[m[3]], m[4] ? BigInt(m[4]) : 0n] : null,
            post: m[5] !== undefined && m[5] !== null ? BigInt(m[5] || 0)
                : (m[6] !== undefined && m[6] !== null ? BigInt(m[6]) : null),
            dev: m[7] !== undefined && m[7] !== null ? BigInt(m[7] || 0) : null,
            local: m[8] || null,
        };
    }

    /** Total ORDER over versions (PEP 440). Ordering alone is not specifier
     *  matching — see versionSatisfies below for the operator rules. */
    function cmpVersions(a, b) {
        return cmpParsed(parseVersion(a), parseVersion(b));
    }

    // ---- PEP 440 specifier semantics (mirrors packaging.specifiers) ----
    //
    // Ordering (cmpVersions) is necessary but NOT sufficient: the spec adds
    // per-operator rules — '>V' excludes post-releases and local versions of
    // V's base, '<V' excludes pre-releases of V's base, '==' ignores the
    // candidate's local segment when the spec has none, prefix matching is
    // segment-wise on the canonical form, and '~=' expands to '>=V' plus an
    // epoch-aware '==prefix.*'. On top of that, a specifier SET excludes
    // pre-release candidates unless some specifier mentions a pre-release
    // (or the caller opts in). Verified differentially against
    // packaging.specifiers.SpecifierSet in test_pip_resolver.mjs.

    const isPrerelease = (p) => p.pre !== null || p.dev !== null;
    const isPostrelease = (p) => p.post !== null;

    /**
     * Canonical PEP 440 ordering tuple, mirroring packaging's _cmpkey:
     * (epoch, release, pre, post, dev, local), where
     *   - pre  is -inf for a DEV-ONLY version (no pre, no post, dev set),
     *     +inf for a final/post version without pre, else (rank, n) —
     *     so 1.0a1 < 1.0a1.post1 and 1.0a1.post1.dev2 < 1.0a1.post1;
     *   - post is -inf when absent (any post sorts above its base);
     *   - dev  is +inf when absent (any dev sorts below its base);
     *   - local is -inf when absent; else segment tuples with numeric
     *     segments above alphanumeric ones.
     * Every numeric component is BigInt — no precision cliffs.
     */
    function cmpParsed(va, vb) {
        if (va.epoch !== vb.epoch) return va.epoch < vb.epoch ? -1 : 1;
        const len = Math.max(va.release.length, vb.release.length);
        for (let i = 0; i < len; i++) {
            const x = i < va.release.length ? va.release[i] : 0n;   // 1.4 == 1.4.0
            const y = i < vb.release.length ? vb.release[i] : 0n;
            if (x !== y) return x < y ? -1 : 1;
        }
        // pre marker: -1 = -inf (dev-only), 0 = actual pre, 1 = +inf
        const preKind = (p) => p.pre ? 0 : (p.post === null && p.dev !== null ? -1 : 1);
        const ka = preKind(va), kb = preKind(vb);
        if (ka !== kb) return ka < kb ? -1 : 1;
        if (ka === 0) {
            if (va.pre[0] !== vb.pre[0]) return va.pre[0] < vb.pre[0] ? -1 : 1;
            if (va.pre[1] !== vb.pre[1]) return va.pre[1] < vb.pre[1] ? -1 : 1;
        }
        // post: absent (-inf) < any post — compared REGARDLESS of pre
        if ((va.post === null) !== (vb.post === null)) return va.post === null ? -1 : 1;
        if (va.post !== null && va.post !== vb.post) return va.post < vb.post ? -1 : 1;
        // dev: absent (+inf) > any dev — compared regardless of pre/post
        if ((va.dev === null) !== (vb.dev === null)) return va.dev === null ? 1 : -1;
        if (va.dev !== null && va.dev !== vb.dev) return va.dev < vb.dev ? -1 : 1;
        // local versions: absent < present; both present -> segment compare
        if (!va.local && !vb.local) return 0;
        if (!va.local) return -1;
        if (!vb.local) return 1;
        const la = va.local.split(/[._-]/), lb = vb.local.split(/[._-]/);
        for (let i = 0; i < Math.max(la.length, lb.length); i++) {
            const x = la[i], y = lb[i];
            if (x === undefined) return -1;
            if (y === undefined) return 1;
            const nx = /^\d+$/.test(x) ? BigInt(x) : null, ny = /^\d+$/.test(y) ? BigInt(y) : null;
            if (nx !== null && ny !== null) { if (nx !== ny) return nx < ny ? -1 : 1; }
            else if (nx !== null) return 1;      // numeric > alpha per PEP 440 local rules
            else if (ny !== null) return -1;
            else if (x !== y) return x < y ? -1 : 1;
        }
        return 0;
    }

    const publicOf = (p) => p.local ? { ...p, local: null } : p;

    /** Canonical dotted segments, packaging's _version_split shape:
     *  ['<epoch>', d0, ..., dLast(+preLetterN), ('postN')?, ('devN')?]. */
    function canonicalSegments(p) {
        // pre/post/dev are their own segments (packaging's _prefix_regex
        // splits '2a1' into '2','a1'), so '==2.2.*' matches 2.2a1
        const segs = [String(p.epoch), ...p.release.map(String)];
        if (p.pre) segs.push(['a', 'b', 'rc'][p.pre[0]] + String(p.pre[1]));
        if (p.post !== null) segs.push('post' + p.post);
        if (p.dev !== null) segs.push('dev' + p.dev);
        return segs;
    }

    /** Prefix match for '==stem.*' — stem is epoch+release only (enforced at
     *  parse time). Candidate's local is ignored; its numeric release is
     *  zero-padded to the stem's length before segment comparison. */
    function prefixSatisfies(cand, stem) {
        const want = [String(stem.epoch), ...stem.release.map(String)];
        let have = canonicalSegments(cand);
        const numLen = (a) => { let n = 0; while (n < a.length && /^\d+$/.test(a[n])) n++; return n; };
        const hn = numLen(have);
        if (hn < want.length) {
            have = [...have.slice(0, hn), ...Array(want.length - hn).fill('0'), ...have.slice(hn)];
        }
        return want.every((s, i) => have[i] === s);
    }

    /** One specifier clause against a parsed candidate (packaging's
     *  Specifier._compare_*; pre-release policy is handled by the caller). */
    function clauseSatisfies(cand, op, v) {
        if (v.endsWith('.*')) {
            const ok = prefixSatisfies(cand, parseVersion(v.slice(0, -2)));
            return op === '!=' ? !ok : ok;
        }
        const spec = parseVersion(v);
        switch (op) {
            case '==': {
                // A public spec ignores the candidate's local segment; a spec
                // with a local segment requires an exact match.
                const c = spec.local ? cand : publicOf(cand);
                return cmpParsed(c, spec) === 0;
            }
            case '!=': {
                const c = spec.local ? cand : publicOf(cand);
                return cmpParsed(c, spec) !== 0;
            }
            case '>=': return cmpParsed(publicOf(cand), spec) >= 0;
            case '<=': return cmpParsed(publicOf(cand), spec) <= 0;
            case '>': {
                if (cmpParsed(cand, spec) <= 0) return false;
                // '>V' must not match a post-release OF V (candidate minus
                // post/dev/local equals V) unless V is itself a post-release,
                // nor a local version of V (candidate's public part equals V)
                if (!isPostrelease(spec) && isPostrelease(cand)
                    && cmpParsed({ ...cand, post: null, dev: null, local: null }, spec) === 0) return false;
                if (cand.local && cmpParsed(publicOf(cand), spec) === 0) return false;
                return true;
            }
            case '<': {
                if (cmpParsed(cand, spec) >= 0) return false;
                // '<V' must not match a pre-release of V: candidate >= V's
                // earliest pre-release (V with dev=0), unless V is itself a
                // pre-release
                if (!isPrerelease(spec) && isPrerelease(cand)
                    && cmpParsed(cand, { ...spec, dev: 0n, local: null }) >= 0) return false;
                return true;
            }
            case '~=': {
                // '~=V' === '>=V' plus epoch-aware '==E!R[:-1].*'
                if (cmpParsed(publicOf(cand), spec) < 0) return false;
                const stem = { ...spec, release: spec.release.slice(0, -1), pre: null, post: null, dev: null, local: null };
                return prefixSatisfies(cand, stem);
            }
            default: return false;
        }
    }

    /**
     * SpecifierSet.contains semantics (packaging >= 24: per the updated
     * PEP 440 recommendation, specifiers MATCH pre-release candidates by
     * default — pre-release exclusion belongs to candidate selection, not
     * to satisfaction checks like ours; the per-operator rules above still
     * exclude e.g. post-releases under '>' and pre-releases of V under
     * '<V'). options.prereleases: false forbids pre-release candidates
     * outright. An empty set matches everything.
     */
    function versionSatisfies(version, specifiers, options) {
        const specs = specifiers || [];
        const cand = parseVersion(version);
        if (!specs.length) return true;
        if (options && options.prereleases === false && isPrerelease(cand)) return false;
        return specs.every(s => clauseSatisfies(cand, s.op, s.version));
    }

    /** Index a pyodide lockfile's packages by normalized name. Null-prototype
     *  so requirement names like 'constructor' can never resolve to inherited
     *  Object.prototype members. */
    function indexLock(lock) {
        const byNorm = Object.create(null);
        for (const [key, entry] of Object.entries((lock && lock.packages) || {})) {
            byNorm[normName(entry.name || key)] = entry;
        }
        return byNorm;
    }

    /** Import names for a distribution: the lock entry's declared imports
     *  (beautifulsoup4 -> ['bs4']), falling back to the underscored name. */
    function importNamesOf(entry, name) {
        if (entry && Array.isArray(entry.imports) && entry.imports.length) return entry.imports;
        return [normName(name).replace(/-/g, '_')];
    }

    /**
     * Resolve one requirement against a lockfile.
     *
     * @param lock        parsed pyodide-lock.json
     * @param requirement output of parseRequirement
     * @param loadedNorms Set of normalized names already loaded in the
     *                    interpreter. The graph is traversed through loaded
     *                    parents (partial recovery): a loaded parent's own
     *                    wheel is skipped, its missing dependencies are not.
     * @returns { name, version, importNames, files } — files are lock
     *          file_name strings for every graph node that still needs
     *          loading, dependencies before dependents.
     * @throws  {code:'NOT_IN_DISTRIBUTION'} or
     *          {code:'VERSION_CONFLICT', available} — never a silent
     *          substitution of an incompatible version.
     */
    function resolveFromLock(lock, requirement, loadedNorms) {
        const byNorm = indexLock(lock);
        const rootEntry = byNorm[requirement.norm];
        if (!rootEntry) {
            const e = new Error(`'${requirement.name}' is not in the Pyodide distribution lockfile`);
            e.code = 'NOT_IN_DISTRIBUTION';
            throw e;
        }
        if (!versionSatisfies(rootEntry.version, requirement.specifiers)) {
            const e = new Error(
                `'${requirement.raw}' cannot be satisfied: the Pyodide distribution provides ` +
                `${requirement.name} ${rootEntry.version} only`);
            e.code = 'VERSION_CONFLICT';
            e.available = rootEntry.version;
            throw e;
        }
        const files = [];
        const seen = new Set();
        const visit = (norm) => {
            if (seen.has(norm)) return;
            seen.add(norm);
            const entry = byNorm[norm];
            if (!entry) return;   // dep outside the lock: leave to the runtime to report
            for (const dep of entry.depends || []) visit(normName(dep));
            // partial recovery: traverse THROUGH loaded parents, but do not
            // reload their own wheel
            if (!loadedNorms.has(norm)) files.push(entry.file_name);
        };
        visit(requirement.norm);
        return {
            name: rootEntry.name,
            version: rootEntry.version,
            importNames: importNamesOf(rootEntry, requirement.name),
            files,
        };
    }

    /**
     * Dependency closure for a root that is ALREADY satisfied outside the
     * lock (installed metadata / a directly-loaded wheel). The lock serves
     * purely as a dependency graph here: the root's own wheel is never
     * listed and the lock's root VERSION is deliberately not re-checked —
     * a satisfying installed version outranks the lock's copy. Returns the
     * lock file_names of every missing dependency, dependencies first, or
     * [] when the root is not in the lock (nothing to consult).
     */
    function resolveDepsOf(lock, norm, loadedNorms) {
        const byNorm = indexLock(lock);
        const rootEntry = byNorm[norm];
        if (!rootEntry) return [];
        const files = [];
        const seen = new Set();
        const visit = (n, isRoot) => {
            if (seen.has(n)) return;
            seen.add(n);
            const entry = byNorm[n];
            if (!entry) return;   // dep outside the lock: leave to the runtime to report
            for (const dep of entry.depends || []) visit(normName(dep), false);
            if (!isRoot && !loadedNorms.has(n)) files.push(entry.file_name);
        };
        visit(norm, true);
        return files;
    }

    /**
     * Parse a complete %pip install argument sequence ATOMICALLY: if any
     * token is an option, marker, direct reference, URL, or otherwise
     * unsupported, the whole line is rejected — nothing on the line may be
     * installed from a source the user did not request (e.g. '-r
     * requirements.txt' must not fall through to installing a distribution
     * literally named 'requirements.txt').
     */
    function parsePipLine(argsText) {
        const tokens = String(argsText).trim().split(/\s+/).filter(Boolean);
        if (!tokens.length) {
            const e = new Error('empty %pip install line');
            e.code = 'UNSUPPORTED';
            throw e;
        }
        // 'name @ url' arrives as three tokens; join lines containing '@'
        if (tokens.includes('@')) {
            const e = new Error(`unsupported requirement '${argsText.trim()}': direct references are not supported`);
            e.code = 'UNSUPPORTED';
            throw e;
        }
        return tokens.map(parseRequirement);   // any throw aborts the whole line
    }

    /** Reverse index: top-level import name -> normalized distribution name.
     *  Null-prototype for the same reason as indexLock. */
    function importIndex(lock) {
        const idx = Object.create(null);
        for (const [key, entry] of Object.entries((lock && lock.packages) || {})) {
            const norm = normName(entry.name || key);
            for (const imp of importNamesOf(entry, entry.name || key)) idx[imp] = norm;
        }
        return idx;
    }

    globalThis.PipResolver = {
        parsePipLine, importIndex,
        normName, parseRequirement, parseVersion, cmpVersions, versionSatisfies,
        indexLock, importNamesOf, resolveFromLock, resolveDepsOf,
    };
})();
