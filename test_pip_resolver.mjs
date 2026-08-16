// Deterministic tests for the %pip partial-bundle resolver (no browser, no
// network, no live CDN): fixture lockfile only. See www/js/pip_resolver.js.
import { readFileSync } from 'node:fs';

new Function(readFileSync(new URL('./www/js/pip_resolver.js', import.meta.url), 'utf8'))();
const R = globalThis.PipResolver;

let failures = 0;
const check = (name, ok, detail = '') => {
    console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ': ' + detail : ''}`);
    if (!ok) failures++;
};
const throws = (fn, code) => {
    try { fn(); return false; } catch (e) { return e.code === code ? true : 'wrong code: ' + e.code; }
};

// Fixture lock: mirrors the official pyodide-lock.json shape, including a
// distribution whose import name differs (soup4 -> bsoup) and a dependency
// graph for partial-recovery testing.
const LOCK = { packages: {
    numpy: { name: 'numpy', version: '2.0.2', file_name: 'numpy-2.0.2.whl', depends: [], imports: ['numpy'] },
    plotlib: { name: 'plotlib', version: '3.8.4', file_name: 'plotlib-3.8.4.whl',
        depends: ['numpy', 'kiwi', 'soup4'], imports: ['plotlib'] },
    kiwi: { name: 'kiwi', version: '1.4.5', file_name: 'kiwi-1.4.5.whl', depends: [], imports: ['kiwi'] },
    soup4: { name: 'soup4', version: '4.12.3', file_name: 'soup4-4.12.3.whl', depends: [], imports: ['bsoup'] },
    'ruamel.yaml': { name: 'ruamel.yaml', version: '0.18.6', file_name: 'ruamel_yaml-0.18.6.whl', depends: [] },
} };

console.log('1. Requirement parsing (PEP 508 subset)');
check('bare name', R.parseRequirement('plotlib').norm === 'plotlib');
check('pinned', JSON.stringify(R.parseRequirement('plotlib==3.8.4').specifiers) === '[{"op":"==","version":"3.8.4"}]');
check('range with two clauses', R.parseRequirement('numpy>=1.20,<3').specifiers.length === 2);
check('extras accepted and recorded', R.parseRequirement('plotlib[png]').extras.join() === 'png');
check('dotted names normalize', R.parseRequirement('Ruamel.YAML').norm === 'ruamel-yaml');
check('direct reference rejected', throws(() => R.parseRequirement('pkg @ https://x/y.whl'), 'UNSUPPORTED') === true);
check('URL rejected', throws(() => R.parseRequirement('https://x/y.whl'), 'UNSUPPORTED') === true);
check('marker rejected', throws(() => R.parseRequirement('pkg; python_version<"3.10"'), 'UNSUPPORTED') === true);
check('pip option rejected', throws(() => R.parseRequirement('-r requirements.txt'), 'UNSUPPORTED') === true);

console.log('2. Version specifiers (PEP 440 subset)');
check('== satisfied', R.versionSatisfies('3.8.4', [{ op: '==', version: '3.8.4' }]));
check('== unsatisfied', !R.versionSatisfies('3.8.4', [{ op: '==', version: '0.0.1' }]));
check('>= satisfied', R.versionSatisfies('3.8.4', [{ op: '>=', version: '3.0' }]));
check('>= unsatisfied', !R.versionSatisfies('3.8.4', [{ op: '>=', version: '4.0' }]));
check('< works', R.versionSatisfies('3.8.4', [{ op: '<', version: '4' }]));
check('prefix ==1.4.* satisfied', R.versionSatisfies('1.4.5', [{ op: '==', version: '1.4.*' }]));
check('prefix ==1.5.* unsatisfied', !R.versionSatisfies('1.4.5', [{ op: '==', version: '1.5.*' }]));
check('~=3.8 satisfied by 3.9', R.versionSatisfies('3.9.0', [{ op: '~=', version: '3.8' }]));
check('~=3.8.1 not satisfied by 3.9.0', !R.versionSatisfies('3.9.0', [{ op: '~=', version: '3.8.1' }]));

console.log('3. Constraint authority: no silent substitution');
const okRes = R.resolveFromLock(LOCK, R.parseRequirement('plotlib==3.8.4'), new Set());
check('satisfied pin resolves', okRes.version === '3.8.4');
check('unsatisfied pin -> VERSION_CONFLICT (was: silently installed 3.8.4)',
    throws(() => R.resolveFromLock(LOCK, R.parseRequirement('plotlib==0.0.1'), new Set()), 'VERSION_CONFLICT') === true);
check('unsatisfied >= -> VERSION_CONFLICT',
    throws(() => R.resolveFromLock(LOCK, R.parseRequirement('plotlib>=4'), new Set()), 'VERSION_CONFLICT') === true);
check('satisfied >= resolves', R.resolveFromLock(LOCK, R.parseRequirement('plotlib>=3'), new Set()).version === '3.8.4');
check('unknown package -> NOT_IN_DISTRIBUTION',
    throws(() => R.resolveFromLock(LOCK, R.parseRequirement('nosuchpkg'), new Set()), 'NOT_IN_DISTRIBUTION') === true);
check('conflict carries the available version',
    (() => { try { R.resolveFromLock(LOCK, R.parseRequirement('plotlib==0.0.1'), new Set()); } catch (e) { return e.available === '3.8.4'; } })());

console.log('4. Import names come from the lock');
check('mismatched import name surfaces (soup4 -> bsoup)',
    R.resolveFromLock(LOCK, R.parseRequirement('soup4'), new Set()).importNames.join() === 'bsoup');
check('fallback to underscored name when lock omits imports',
    R.importNamesOf(LOCK.packages['ruamel.yaml'], 'ruamel.yaml').join() === 'ruamel_yaml');

console.log('5. Dependency traversal with partial recovery');
const fresh = R.resolveFromLock(LOCK, R.parseRequirement('plotlib'), new Set());
check('fresh install lists whole graph, deps first',
    JSON.stringify(fresh.files) === JSON.stringify(['numpy-2.0.2.whl', 'kiwi-1.4.5.whl', 'soup4-4.12.3.whl', 'plotlib-3.8.4.whl']),
    fresh.files.join());
const partial = R.resolveFromLock(LOCK, R.parseRequirement('plotlib'), new Set(['plotlib', 'numpy']));
check('loaded parent skipped, its MISSING deps still recovered',
    JSON.stringify(partial.files) === JSON.stringify(['kiwi-1.4.5.whl', 'soup4-4.12.3.whl']),
    partial.files.join());
const allLoaded = R.resolveFromLock(LOCK, R.parseRequirement('plotlib'), new Set(['plotlib', 'numpy', 'kiwi', 'soup4']));
check('fully loaded graph needs nothing', allLoaded.files.length === 0);

console.log(`\n${failures ? `FAILED: ${failures}` : 'All pip-resolver tests passed.'}`);
process.exitCode = failures ? 1 : 0;
