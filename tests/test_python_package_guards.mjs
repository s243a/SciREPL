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

const prelude = readFileSync(new URL('../www/js/prelude.py', import.meta.url), 'utf8');
const section = prelude.split('# ---- Package installation via micropip ----')[1].split('# ---- Matplotlib inline backend ----')[0];
const python = spawnSync('python3', ['-c', `
import asyncio, contextlib, inspect, io, json, sys, types
import importlib.metadata as metadata
section = json.loads(sys.argv[1])
state = {'allow': False, 'fail': False, 'calls': [], 'gate': 0, 'verified': []}
native_distribution = metadata.distribution
class FixtureDistribution:
    version = '1.0'
    def read_text(self, name):
        return 'pyodide' if name == 'PYODIDE_SOURCE' else None
metadata.distribution = lambda name: FixtureDistribution() if name == 'scirepl-extra-fixture' else native_distribution(name)
micropip = types.ModuleType('micropip')
async def original(requirements, keep_going=False, deps=True, credentials=None, pre=False, index_urls=None, verbose=None):
    state['calls'].append((requirements, keep_going, deps, credentials, pre, index_urls, verbose))
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
    try:
        await micropip.install('not-started')
        raise AssertionError('missing consent must fail')
    except RuntimeError as error:
        assert 'consent required' in str(error)
    assert state['calls'] == []
    state['allow'] = True
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
