// Deterministic public-loader and Python wrapper contracts; no network requests.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { spawnSync } from 'node:child_process';

const source = readFileSync(new URL('../www/js/kernels/python.js', import.meta.url), 'utf8');
let Kernel;
let consent = false, gateCalls = 0, loads = 0, callbackMessages = [];
const context = {
    window: { t: key => key, kernelManager: {
        register() {},
        ensureNetworkConsent: async () => { gateCalls++; },
        hasCurrentPrivacyConsent: () => consent,
    } },
    Map,
};
runInNewContext(source + '\nthis.Kernel = PythonKernel;', context);
Kernel = context.Kernel;
const modules = new Map();
const native = { loadedPackages: {},
    async loadPackage(names, options) {
        assert.equal(this, native, 'public loader retains its native receiver'); loads++;
        assert.equal(options.checkIntegrity, true);
        options.messageCallback?.('progress');
        if (names === 'fail') options.errorCallback('wheel download failed');
        return names;
    },
    registerJsModule(name, module) { modules.set(name, module); },
};
Kernel.configurePackageInstalls(native);
assert.equal(loads, 0, 'configuration installs nothing and sends no request');
const strict = native.loadPackage;
Kernel.configurePackageInstalls(native);
assert.equal(native.loadPackage, strict, 'strict loader setup is idempotent');
let messages = 0;
assert.equal(await native.loadPackage('success', { checkIntegrity: true, messageCallback: () => messages++ }), 'success');
assert.equal(messages, 1);
await assert.rejects(native.loadPackage('fail', { checkIntegrity: true,
    errorCallback: text => callbackMessages.push(text) }), /download\/install failed: wheel download failed/);
assert.deepEqual(callbackMessages, ['wheel download failed'], 'caller receives original failure callback');
await assert.rejects(modules.get('_scirepl_package_network').ensure_consent(), /privacyRequired/);
assert.equal(gateCalls, 1, 'a resolving gate without recorded current consent is not approval');
consent = true;
await modules.get('_scirepl_package_network').ensure_consent();
context.window.kernelManager = {};
await assert.rejects(modules.get('_scirepl_package_network').ensure_consent(), /disclosure is unavailable/);
console.log('Public package loader and consent bridge contracts passed.');

// Exercise the actual JavaScript wheel-fetch wrapper, including URL queries,
// case-insensitive extensions, Request-like objects and local offline assets.
context.URL = URL;
context.document = { baseURI: 'https://scirepl.test/app/' };
context.location = { origin: 'https://scirepl.test' };
let fetchCalls = 0;
context.window.fetch = async (_input, init) => { fetchCalls++; return init; };
context.window.kernelManager = {
    ensureNetworkConsent: async () => { gateCalls++; },
    hasCurrentPrivacyConsent: () => consent,
};
Kernel.installPackageFetchGuard();
const fetchGuard = context.window.fetch;
Kernel.installPackageFetchGuard();
assert.equal(context.window.fetch, fetchGuard, 'fetch guard setup is idempotent');
consent = false;
const beforeLocal = gateCalls;
await fetchGuard('vendor/bundled.whl');
assert.equal(gateCalls, beforeLocal, 'same-origin bundled wheel never requests disclosure');
await assert.rejects(fetchGuard({ url: 'https://packages.test/Package.WHL?version=1' }), /privacyRequired/);
assert.equal(fetchCalls, 1, 'unrecorded consent cannot reach native external fetch');
consent = true;
const options = { credentials: 'omit', signal: new AbortController().signal };
assert.equal(await fetchGuard(new URL('https://packages.test/package.whl?x=1'), options), options,
    'accepted requests preserve the exact options and AbortSignal');
assert.equal(fetchCalls, 2);
console.log('Actual package-fetch gating, local bypass and option contracts passed.');

// Shared libraries are not always wheels. Register exact release directories
// even after the wrapper exists, including an actual custom loader index.
context.window.KERNEL_CONFIG = { languages: { python: { sources: [
    { type: 'cdn', url: 'https://cdn.test/pyodide/v0.27.4/full/pyodide.js' },
] } } };
Kernel.installPackageFetchGuard('https://custom-runtime.test/runtime/');
assert.equal(context.window.fetch, fetchGuard, 'registering new roots does not stack wrappers');
consent = false;
const beforeArchives = fetchCalls;
for (const url of [
    'https://cdn.test/pyodide/v0.27.4/full/openblas-0.3.26.zip',
    'https://cdn.test/pyodide/v0.27.4/full/OPENSSL.ZIP?revision=1',
    'https://cdn.test/pyodide/v0.27.4/full/numpy-tests.tar',
    'https://cdn.test/pyodide/v0.27.4/full/future-library.data',
    'https://custom-runtime.test/runtime/opaque-package?download=1',
]) await assert.rejects(fetchGuard({ url }), /privacyRequired/, url);
assert.equal(fetchCalls, beforeArchives, 'all runtime asset types stop before native fetch');
const beforeUnrelated = gateCalls;
for (const url of [
    'vendor/pyodide/geos.zip',
    'vendor/pyodide/numpy-tests.tar',
    'https://cdn.test/pyodide/v0.27.40/full/geos.zip',
    'https://cdn.test/other/geos.zip',
    'https://cdn.test.evil/pyodide/v0.27.4/full/geos.zip',
]) await fetchGuard(url);
assert.equal(gateCalls, beforeUnrelated, 'local and unrelated archive requests retain native semantics');
consent = true;
assert.equal(await fetchGuard('https://cdn.test/pyodide/v0.27.4/full/geos.zip?x=1', options), options,
    'accepted archive requests preserve exact fetch options and AbortSignal');
context.window.kernelManager = {};
const beforeMissingGate = fetchCalls;
await assert.rejects(fetchGuard('https://cdn.test/pyodide/v0.27.4/full/geos.zip'), /disclosure is unavailable/);
assert.equal(fetchCalls, beforeMissingGate, 'unavailable disclosure cannot dispatch an archive');
console.log('All runtime archive types, active-index roots, path scope and fail-closed contracts passed.');

const prelude = readFileSync(new URL('../www/js/prelude.py', import.meta.url), 'utf8');
const section = prelude.split('# ---- Package installation via micropip ----')[1].split('# ---- Matplotlib inline backend ----')[0];
const python = spawnSync('python3', ['-c', `
import asyncio, contextlib, inspect, io, json, sys, types
import importlib.metadata as metadata
section = json.loads(sys.argv[1])
state = {'allow': False, 'fail': False, 'calls': [], 'gate': 0, 'verified': [], 'fetches': []}
pyodide = types.ModuleType('pyodide')
http = types.ModuleType('pyodide.http')
async def pyfetch(url, **kwargs):
    state['fetches'].append((url, kwargs))
    return 'native fetch'
http.pyfetch = pyfetch
pyodide.http = http
sys.modules['pyodide'] = pyodide
sys.modules['pyodide.http'] = http
native_distribution = metadata.distribution
class FixtureDistribution:
    version = '1.0'
    def read_text(self, name):
        return 'pyodide' if name == 'PYODIDE_SOURCE' else None
metadata.distribution = lambda name: FixtureDistribution() if name == 'scirepl-extra-fixture' else native_distribution(name)
micropip = types.ModuleType('micropip')
async def original(requirements, keep_going=False, deps=True, credentials=None, pre=False, index_urls=None, verbose=None):
    state['calls'].append((requirements, keep_going, deps, credentials, pre, index_urls, verbose))
    if requirements == 'networked-package':
        await http.pyfetch('https://custom-index.test/simple/package/', credentials=credentials)
    if state['fail']:
        raise RuntimeError('download failed')
    return 'native return'
micropip.install = original
bridge = types.ModuleType('_scirepl_package_network')
async def ensure_consent():
    state['gate'] += 1
    if not state['allow']:
        raise RuntimeError('consent required')
bridge.ensure_consent = ensure_consent
async def before_fetch(url):
    await ensure_consent()
bridge.before_fetch = before_fetch
async def verify_builtin_dependencies(name, version):
    state['verified'].append((name, version))
bridge.verify_builtin_dependencies = verify_builtin_dependencies
sys.modules['micropip'] = micropip
sys.modules['_scirepl_package_network'] = bridge
namespace = {}
exec(section, namespace)
guard = micropip.install
exec(section, namespace)
assert micropip.install is guard, 'prelude setup must not wrap a second time'
assert inspect.signature(guard) == inspect.signature(original)
async def main():
    assert await micropip.install('bundled-local') == 'native return'
    assert state['gate'] == 0 and state['fetches'] == [], 'local installs must not ask for network consent'
    try:
        await micropip.install('networked-package')
        raise AssertionError('missing consent must fail')
    except RuntimeError as error:
        assert 'consent required' in str(error)
    assert state['fetches'] == [], 'missing consent stops before native fetch'
    state['allow'] = True
    assert await http.pyfetch('https://custom-index.test/opaque-endpoint', credentials='omit') == 'native fetch'
    assert state['fetches'][-1] == ('https://custom-index.test/opaque-endpoint', {'credentials': 'omit'})
    from micropip import install
    req = ['pkg; python_version >= "3"', 'https://example.test/custom.whl']
    result = await install(req, keep_going=True, deps=False, credentials='omit', pre=True, index_urls=['https://example.test/simple'], verbose=True)
    assert result == 'native return'
    assert state['calls'][-1] == (req, True, False, 'omit', True, ['https://example.test/simple'], True)
    await install('scirepl-extra-fixture[foo]; extra == "foo"')
    assert state['verified'] == [('scirepl-extra-fixture', '1.0')]
    await install('scirepl-extra-fixture[foo]; extra == "bar"')
    await install('scirepl-extra-fixture', deps=False)
    await install('scirepl-extra-fixture @ https://example.test/custom.whl')
    assert state['verified'] == [('scirepl-extra-fixture', '1.0')]
    state['fail'] = True
    output = io.StringIO()
    tail = False
    try:
        with contextlib.redirect_stdout(output):
            await namespace['pip_install']('failed-package')
            tail = True
    except RuntimeError as error:
        assert str(error) == 'download failed'
    assert not tail and 'Installed failed-package' not in output.getvalue()
    assert 'Failed to install failed-package' in output.getvalue()
asyncio.run(main())
print('Python package consent, option forwarding, idempotence and failure propagation passed.')
`, JSON.stringify(section)], { encoding: 'utf8' });
assert.equal(python.status, 0, python.stderr);
process.stdout.write(python.stdout);
