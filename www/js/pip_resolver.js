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
                const sm = /^(===|==|!=|~=|>=|<=|>|<)\s*([A-Za-z0-9!+*._-]+)$/.exec(c);
                if (!sm) fail(`bad specifier clause '${c}'`);
                specifiers.push({ op: sm[1] === '===' ? '==' : sm[1], version: sm[2] });
            }
        }
        return { name, norm: normName(name), extras, specifiers, raw: text };
    }

    /** Release-segment comparison (PEP 440 subset: numeric release parts;
     *  pre/post/dev/local segments compare after their release numbers and
     *  are treated as opaque suffix ordering — good enough for lockfile
     *  versions, which are plain releases in practice). */
    function cmpVersions(a, b) {
        const parse = (v) => String(v).split('+')[0].split(/[.\-]/).map(p => {
            const n = /^\d+$/.test(p) ? Number(p) : null;
            return n === null ? p : n;
        });
        const pa = parse(a), pb = parse(b);
        const len = Math.max(pa.length, pb.length);
        for (let i = 0; i < len; i++) {
            const x = pa[i], y = pb[i];
            if (x === undefined) return (typeof y === 'string') ? 1 : (y === 0 ? 0 : -1);
            if (y === undefined) return (typeof x === 'string') ? -1 : (x === 0 ? 0 : 1);
            if (x === y) continue;
            if (typeof x === 'number' && typeof y === 'number') return x < y ? -1 : 1;
            if (typeof x === 'number') return 1;   // numeric > pre-release word
            if (typeof y === 'number') return -1;
            return x < y ? -1 : 1;
        }
        return 0;
    }

    function prefixMatch(version, pattern) {
        // '1.2.*' — compare the numeric prefix segments
        const want = pattern.slice(0, -2).split('.');
        const have = String(version).split('+')[0].split('.');
        if (have.length < want.length) return false;
        for (let i = 0; i < want.length; i++) {
            if (String(have[i]) !== String(want[i])) return false;
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

    globalThis.PipResolver = {
        normName, parseRequirement, cmpVersions, versionSatisfies,
        indexLock, importNamesOf, resolveFromLock,
    };
})();
