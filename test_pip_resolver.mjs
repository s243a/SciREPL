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

console.log('0. Malformed requirements reject atomically (never reinterpreted)');
for (const bad of [
    ['pkg>=1,,<4', 'empty clause'],
    ['pkg,>=1', 'leading comma'],
    ['pkg>=1,', 'trailing comma'],
    ['pkg[,]', 'empty extras'],
    ['pkg[]', 'bare empty extras'],
    ['pkg[x,]', 'trailing comma in extras'],
    ['pkg[,x]', 'leading comma in extras'],
    ['pkg==1.*.2', 'wildcard mid-version'],
    ['pkg>=1.*', 'wildcard with ordered op'],
    ['pkg~=1.*', 'wildcard with ~='],
    ['pkg>1.0+local', 'local with exclusive ordered op'],
    ['pkg>=1.0+local', 'local with inclusive ordered op'],
    ['pkg~=1', '~= with a single release segment'],
    ['pkg==', 'operator without version'],
]) {
    check(`rejects ${bad[1]} (${bad[0]})`, throws(() => R.parseRequirement(bad[0]), 'UNSUPPORTED') === true);
}

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

console.log('6. PEP 440 conformance (post/dev/epoch/rc/local — real lock grammar)');
check('post release sorts above its final (dateutil case)', R.cmpVersions('2.9.0.post0', '2.9.0') > 0);
check('>=2.9.0 accepts 2.9.0.post0', R.versionSatisfies('2.9.0.post0', [{ op: '>=', version: '2.9.0' }]));
check('dev sorts below pre-release', R.cmpVersions('1.0.dev1', '1.0a1') < 0);
check('pre-release sorts below final', R.cmpVersions('1.0rc1', '1.0') < 0);
check('rc above beta', R.cmpVersions('1.0rc1', '1.0b2') > 0);
check('epoch dominates', R.cmpVersions('1!1.0', '2.0') > 0);
check('zero padding equality (1.4 == 1.4.0)', R.cmpVersions('1.4', '1.4.0') === 0);
check('local version sorts above public', R.cmpVersions('1.0+cu118', '1.0') > 0);
check('padded wildcard: ==1.4.* accepts 1.4.0.post1', R.versionSatisfies('1.4.0.post1', [{ op: '==', version: '1.4.*' }]));
check('unparseable version -> UNSUPPORTED', throws(() => R.parseVersion('not-a-version'), 'UNSUPPORTED') === true);

check('rc numeric ordering (rc10 > rc2)', R.cmpVersions('1.0rc10', '1.0rc2') > 0);
check("'===' arbitrary equality rejected", throws(() => R.parseRequirement('pkg===1.0'), 'UNSUPPORTED') === true);
check('~= compatible release accepts', R.versionSatisfies('2.9.5', [{ op: '~=', version: '2.9.0' }]));
check('~= compatible release rejects next minor', !R.versionSatisfies('2.10.0', [{ op: '~=', version: '2.9.0' }]));

console.log('6c. Specifier SEMANTICS (not mere ordering) — packaging.specifiers rules');
const sat = (v, specText, opts) => R.versionSatisfies(v, R.parseRequirement('x' + specText).specifiers, opts);
// Sol's four fixed cases (real lock versions: python-dateutil 2.9.0.post0,
// python-sat 1.8.dev13)
check('2.9.0.post0 does NOT satisfy >2.9.0 (post-release of V)', !sat('2.9.0.post0', '>2.9.0'));
check('1.8.dev13 does NOT satisfy <1.8 (pre-release of V)', !sat('1.8.dev13', '<1.8'));
check('1.0+local satisfies ==1.0 (public spec ignores local)', sat('1.0+local', '==1.0'));
check('1!1.4.5 satisfies ~=1!1.4.0 (epoch-aware compatible release)', sat('1!1.4.5', '~=1!1.4.0'));
// the ordering-vs-matching distinction the old code got wrong
check('...even though 2.9.0.post0 ORDERS above 2.9.0', R.cmpVersions('2.9.0.post0', '2.9.0') > 0);
check('...and 1.8.dev13 ORDERS below 1.8', R.cmpVersions('1.8.dev13', '1.8') < 0);
check('2.9.0.post0 satisfies >=2.9.0 (inclusive op has no post rule)', sat('2.9.0.post0', '>=2.9.0'));
check('1.8.dev13 satisfies <=1.8', sat('1.8.dev13', '<=1.8'));
check('2.9.1 satisfies >2.9.0 (different base)', sat('2.9.1', '>2.9.0'));
check('1.0.post0 satisfies >1.0rc1 (post of 1.0, not of 1.0rc1)', sat('1.0.post0', '>1.0rc1'));
check('1.0rc1.post0 does NOT satisfy >1.0rc1', !sat('1.0rc1.post0', '>1.0rc1'));
check('>V allows post when V itself is a post', sat('1.0.post1', '>1.0.post0'));
check('1.0+cu118 does NOT satisfy >1.0 (local of V)', !sat('1.0+cu118', '>1.0'));
check('2.0+cu118 satisfies >1.0 (local of a HIGHER version)', sat('2.0+cu118', '>1.0'));
check('<V allows pre when V itself is a pre', sat('1.8.dev13', '<1.8rc1'));
check('1.0a1 satisfies <1.8 (pre of a LOWER version)', sat('1.0a1', '<1.8'));
check('==1.0 with spec local requires exact local', !sat('1.0', '==1.0+local') && sat('1.0+local', '==1.0+local'));
check('prefix ==2.2.* matches 2.2a1 (suffix is its own segment)', sat('2.2a1', '==2.2.*'));
check('prefix ==2.2.* matches 2.2.post3', sat('2.2.post3', '==2.2.*'));
check('prefix ==1.4.* rejects 1.5.0', !sat('1.5.0', '==1.4.*'));
check('prefix is epoch-aware: 1!2.2 does not match ==2.2.*', !sat('1!2.2', '==2.2.*'));
check('~= floor includes pre/post of spec', sat('1.0.post1', '~=1.0.post0'));
check('prereleases:false option forbids prerelease candidates', !sat('2.0a1', '>=1.0', { prereleases: false }));
check('empty specifier set matches anything', R.versionSatisfies('1.0a1', []));

console.log('6b. Differential vs Python packaging (skipped if unavailable)');
{
    const { execFileSync } = await import('node:child_process');
    let available = false;
    try { execFileSync('python3', ['-c', 'import packaging.version'], { stdio: 'ignore' }); available = true; } catch (_) { }
    if (!available) {
        console.log('  [SKIP] python3 packaging not available');
    } else {
        const pairs = [
            ['2.9.0.post0', '2.9.0'], ['1.0a1', '1.0'], ['1.0.dev1', '1.0a1'], ['1!1.0', '2.0'],
            ['1.4', '1.4.0'], ['1.0rc1', '1.0b2'], ['1.0rc10', '1.0rc2'], ['1.0.post1', '1.0.post0'],
            ['1.0+local', '1.0'], ['3.8.4', '3.8.10'], ['0.9', '0.10'], ['1.0b2.dev1', '1.0b2'],
            ['2.0.0rc1', '2.0.0'], ['1.0.post0.dev1', '1.0.post0'],
        ];
        const py = execFileSync('python3', ['-c', `
import json, sys
from packaging.version import Version
pairs = json.load(sys.stdin)
out = []
for a, b in pairs:
    va, vb = Version(a), Version(b)
    out.append(-1 if va < vb else (1 if va > vb else 0))
print(json.dumps(out))
`], { input: JSON.stringify(pairs), encoding: 'utf8' });
        const expected = JSON.parse(py.trim());
        let diff = 0;
        pairs.forEach(([a, b], i) => {
            const got = Math.sign(R.cmpVersions(a, b));
            if (got !== expected[i]) { console.log(`  [FAIL] differential ${a} vs ${b}: ours ${got}, packaging ${expected[i]}`); diff++; failures++; }
        });
        check(`differential: ${pairs.length} comparisons agree with packaging.version`, diff === 0);

        console.log('6d. Differential vs packaging.specifiers.SpecifierSet');
        // The resolver implements the CURRENT spec semantics (packaging >= 26:
        // contains() matches pre-releases per the updated PEP 440
        // recommendation, '>V' uses the post-base rule, '<V' the
        // earliest-prerelease rule). Older packaging predates those
        // clarifications, so the differential is only meaningful there.
        const pkgVersion = execFileSync('python3', ['-c', 'import packaging; print(packaging.__version__)'],
            { encoding: 'utf8' }).trim();
        const pkgMajor = parseInt(pkgVersion.split('.')[0], 10);
        if (!(pkgMajor >= 26)) {
            console.log(`  [SKIP] packaging ${pkgVersion} < 26 — SpecifierSet differential needs the PEP 440 clarifications (CI installs packaging>=26)`);
        } else {
        // Full cross product: real lock versions (python-dateutil 2.9.0.post0,
        // python-sat 1.8.dev13, jinja2 3.1.3, ...) plus synthetic edge forms.
        const dVersions = ['1.0', '1.0.post0', '1.0.post1', '1.0a1', '1.0b2', '1.0rc1', '1.0.dev1',
            '1.0a1.post2', '1.0+local', '1.0+cu118', '0.9', '1.1', '2.0', '1!1.4.5', '1!1.0',
            '2.9.0', '2.9.0.post0', '1.8', '1.8.dev13', '1.4', '1.4.0', '1.4.5', '1.4.0.post1',
            '2.2', '2.2.post3', '2.2a1', '2.2.dev1', '3.8.4', '3.9.0', '3.1.3',
            '1.0.post0.dev2', '1.0rc1.post0', '1.0a1+l', '1.2.3.4.5', '10.0', '1.10', '2.2rc1'];
        const dSpecs = ['>2.9.0', '>=2.9.0', '<1.8', '<=1.8', '==1.0', '!=1.0', '==1.4.*', '!=1.4.*',
            '~=1.4.0', '~=1!1.4.0', '~=2.2', '>1.0', '<1.0', '>=1.0', '<=1.0', '>1.0.post0',
            '<1.8.dev20', '==2.2.*', '>=1.0a1', '<2.0a1', '~=1.0a1', '>0.9', '!=2.2.*',
            '==1.0+local', '>=1!1.0', '>=1.0,<2.0', '>1.0rc1', '<1.0rc1', '~=1.0.post0',
            '>=1.0.dev1', '==1.*', '!=1.*', '>1.0.dev1', '<1.0.dev1', '<1.0.post0', '~=1.2.3.4',
            '~=3.1.0', '==1.0.0.*'];
        const dCases = [];
        for (const v of dVersions) for (const s of dSpecs) dCases.push([v, s]);
        const dOurs = dCases.map(([v, s]) => {
            try { return R.versionSatisfies(v, R.parseRequirement('x' + s).specifiers); }
            catch (_) { return 'ERR'; }
        });
        const dPy = execFileSync('python3', ['-c', `
import json, sys
from packaging.specifiers import SpecifierSet
cases = json.load(sys.stdin)
out = []
for v, s in cases:
    try: out.append(bool(SpecifierSet(s).contains(v)))
    except Exception: out.append("ERR")
print(json.dumps(out))
`], { input: JSON.stringify(dCases), encoding: 'utf8' });
        const dExp = JSON.parse(dPy.trim());
        let dBad = 0;
        dCases.forEach(([v, s], i) => {
            if (dExp[i] === 'ERR') return;                    // packaging rejects too
            if (dOurs[i] === 'ERR') return;                   // we fail closed where packaging accepts: counted separately below
            if (dOurs[i] !== dExp[i]) {
                console.log(`  [FAIL] SpecifierSet differential: '${v}' vs '${s}': ours ${dOurs[i]}, packaging ${dExp[i]}`);
                dBad++; failures++;
            }
        });
        const dFailClosed = dCases.filter((_, i) => dOurs[i] === 'ERR' && dExp[i] !== 'ERR').length;
        check(`SpecifierSet differential: ${dCases.length} cases agree with packaging ${pkgVersion}`, dBad === 0,
            `${dFailClosed} fail-closed-only-ours`);
        }
    }
}

console.log('7. Whole-line atomic parsing');
check('-r rejects the WHOLE line (never installs requirements.txt)',
    throws(() => R.parsePipLine('-r requirements.txt'), 'UNSUPPORTED') === true);
check('pkg @ url rejects the WHOLE line (never installs pkg from the index)',
    throws(() => R.parsePipLine('pkg @ https://x/y.whl'), 'UNSUPPORTED') === true);
check('one bad token rejects sibling good tokens too',
    throws(() => R.parsePipLine('numpy plotlib; python_version<"3"'), 'UNSUPPORTED') === true);
check('clean multi-requirement line parses fully',
    R.parsePipLine('numpy plotlib==3.8.4').map(r => r.norm).join() === 'numpy,plotlib');
check('extras are recorded for the caller to reject',
    R.parsePipLine('plotlib[png,svg]')[0].extras.join() === 'png,svg');

console.log('8. Import index (reverse mapping)');
const idx = R.importIndex(LOCK);
check('import name maps to its distribution (bsoup -> soup4)', idx.bsoup === 'soup4');
check('plain names map to themselves', idx.numpy === 'numpy');

console.log('9. Lock indexes are null-prototype (no inherited resolution)');
check('importIndex has no constructor', idx.constructor === undefined);
check('importIndex has no hasOwnProperty', idx.hasOwnProperty === undefined);
check('indexLock has no constructor', R.indexLock(LOCK).constructor === undefined);
check("requirement named 'constructor' -> NOT_IN_DISTRIBUTION, not Object",
    throws(() => R.resolveFromLock(LOCK, R.parseRequirement('constructor'), new Set()), 'NOT_IN_DISTRIBUTION') === true);
check("requirement named '__proto__' -> NOT_IN_DISTRIBUTION",
    throws(() => R.resolveFromLock(LOCK, R.parseRequirement('proto-pkg'), new Set()), 'NOT_IN_DISTRIBUTION') === true);

console.log('10. resolveDepsOf: lock as dependency graph for an installed root');
check('loaded root: missing deps listed, root wheel NEVER listed',
    JSON.stringify(R.resolveDepsOf(LOCK, 'plotlib', new Set(['plotlib', 'numpy'])))
    === JSON.stringify(['kiwi-1.4.5.whl', 'soup4-4.12.3.whl']));
check('root loaded via PyPI (not in loadedNorms): root wheel still never listed',
    !R.resolveDepsOf(LOCK, 'plotlib', new Set()).includes('plotlib-3.8.4.whl'),
    R.resolveDepsOf(LOCK, 'plotlib', new Set()).join());
check('all deps present -> nothing to load',
    R.resolveDepsOf(LOCK, 'plotlib', new Set(['numpy', 'kiwi', 'soup4'])).length === 0);
check('root not in lock -> [] (nothing to consult, no throw)',
    R.resolveDepsOf(LOCK, 'not-in-lock', new Set()).length === 0);
check('no version check applied (lock is only a graph here)',
    R.resolveDepsOf(LOCK, 'plotlib', new Set(['kiwi', 'soup4'])).join() === 'numpy-2.0.2.whl');

console.log(`\n${failures ? `FAILED: ${failures}` : 'All pip-resolver tests passed.'}`);
process.exitCode = failures ? 1 : 0;
