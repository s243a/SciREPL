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
        const extras = m[3] ? m[3].slice(1, -1).split(',').map(s => s.trim()).filter(Boolean) : [];
        let rest = m[4].trim();
        if (rest.startsWith('(') && rest.endsWith(')')) rest = rest.slice(1, -1).trim();
        const specifiers = [];
        if (rest) {
            for (const clause of rest.split(',')) {
                const c = clause.trim();
                if (!c) continue;
                if (c.startsWith('===')) fail("arbitrary equality '===' is not supported");
                const sm = /^(==|!=|~=|>=|<=|>|<)\s*([A-Za-z0-9!+*._-]+)$/.exec(c);
                if (!sm) fail(`bad specifier clause '${c}'`);
                specifiers.push({ op: sm[1], version: sm[2] });
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
        return {
            epoch: m[1] ? Number(m[1]) : 0,
            release: m[2].split('.').map(Number),
            // pre: [rank, n]; absent pre sorts ABOVE any pre-release
            pre: m[3] ? [PRE_RANK[m[3]], m[4] ? Number(m[4]) : 0] : null,
            post: m[5] !== undefined && m[5] !== null ? Number(m[5] || 0)
                : (m[6] !== undefined && m[6] !== null ? Number(m[6]) : null),
            dev: m[7] !== undefined && m[7] !== null ? Number(m[7] || 0) : null,
            local: m[8] || null,
        };
    }

    function cmpVersions(a, b) {
        const va = parseVersion(a), vb = parseVersion(b);
        if (va.epoch !== vb.epoch) return va.epoch < vb.epoch ? -1 : 1;
        const len = Math.max(va.release.length, vb.release.length);
        for (let i = 0; i < len; i++) {
            const x = va.release[i] || 0, y = vb.release[i] || 0;   // 1.4 == 1.4.0
            if (x !== y) return x < y ? -1 : 1;
        }
        // dev < pre < final < post at the same release number
        const phase = (p) => p.dev !== null && p.pre === null && p.post === null ? 0
            : p.pre !== null ? 1 : p.post !== null ? 3 : 2;
        const pa = phase(va), pb = phase(vb);
        if (pa !== pb) return pa < pb ? -1 : 1;
        if (va.pre && vb.pre) {
            if (va.pre[0] !== vb.pre[0]) return va.pre[0] < vb.pre[0] ? -1 : 1;
            if (va.pre[1] !== vb.pre[1]) return va.pre[1] < vb.pre[1] ? -1 : 1;
        }
        if (pa === 3 && va.post !== vb.post) return va.post < vb.post ? -1 : 1;
        // dev segment orders within any phase (X.YaN.devM < X.YaN)
        const dv = (p) => p.dev === null ? [1, 0] : [0, p.dev];
        const [da, na] = dv(va), [db, nb] = dv(vb);
        if (da !== db) return da < db ? -1 : 1;
        if (na !== nb) return na < nb ? -1 : 1;
        // local versions: absent < present; both present -> segment compare
        if (!va.local && !vb.local) return 0;
        if (!va.local) return -1;
        if (!vb.local) return 1;
        const la = va.local.split(/[._-]/), lb = vb.local.split(/[._-]/);
        for (let i = 0; i < Math.max(la.length, lb.length); i++) {
            const x = la[i], y = lb[i];
            if (x === undefined) return -1;
            if (y === undefined) return 1;
            const nx = /^\d+$/.test(x) ? Number(x) : null, ny = /^\d+$/.test(y) ? Number(y) : null;
            if (nx !== null && ny !== null) { if (nx !== ny) return nx < ny ? -1 : 1; }
            else if (nx !== null) return 1;      // numeric > alpha per PEP 440 local rules
            else if (ny !== null) return -1;
            else if (x !== y) return x < y ? -1 : 1;
        }
        return 0;
    }

    function prefixMatch(version, pattern) {
        // '1.2.*' — compare release segments only, zero-padded (PEP 440
        // prefix matching ignores pre/post/dev suffixes of the candidate)
        const want = pattern.slice(0, -2).split('.').map(Number);
        const have = parseVersion(version).release;
        for (let i = 0; i < want.length; i++) {
            if ((have[i] || 0) !== want[i]) return false;
        }
        return true;
    }

    function versionSatisfies(version, specifiers) {
        for (const { op, version: v } of specifiers || []) {
            let ok;
            if (v.endsWith('.*') && (op === '==' || op === '!=')) {
                ok = prefixMatch(version, v);
                if (op === '!=') ok = !ok;
            } else if (op === '~=') {
                const parts = v.split('.');
                if (parts.length < 2) return false;
                const floor = cmpVersions(version, v) >= 0;
                const ceilingPattern = parts.slice(0, -1).join('.') + '.*';
                ok = floor && prefixMatch(version, ceilingPattern);
            } else {
                const c = cmpVersions(version, v);
                ok = { '==': c === 0, '!=': c !== 0, '>=': c >= 0, '<=': c <= 0, '>': c > 0, '<': c < 0 }[op];
            }
            if (!ok) return false;
        }
        return true;
    }

    /** Index a pyodide lockfile's packages by normalized name. */
    function indexLock(lock) {
        const byNorm = {};
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

    /** Reverse index: top-level import name -> normalized distribution name. */
    function importIndex(lock) {
        const idx = {};
        for (const [key, entry] of Object.entries((lock && lock.packages) || {})) {
            const norm = normName(entry.name || key);
            for (const imp of importNamesOf(entry, entry.name || key)) idx[imp] = norm;
        }
        return idx;
    }

    globalThis.PipResolver = {
        parsePipLine, importIndex,
        normName, parseRequirement, parseVersion, cmpVersions, versionSatisfies,
        indexLock, importNamesOf, resolveFromLock,
    };
})();
