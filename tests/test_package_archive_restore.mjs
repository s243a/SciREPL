import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
function harness() {
    const files = new Map([['/user/edited.pl', 'user edit']]);
    const calls = { notebooks: 0, executes: 0, wasm: 0, shared: 0, search: [] };
    const vfs = { exists: path => files.has(path), bulkWrite(batch) { for (const item of batch) files.set(item.path, item.content); },
        addSearchPath(alias, dir) { calls.search.push({ alias, dir }); } };
    const context = vm.createContext({ console: { log() {}, warn() {} }, TextEncoder, TextDecoder, Uint8Array, performance, Map, Set });
    context.window = context;
    context.t = key => key;
    context.kernelManager = { async ensureReady() {}, getKernel: () => ({ getVFS: () => vfs, isReady: () => false }) };
    context.sharedVFS = { exists: path => path === '/shared/edited.txt', mkdir() { calls.shared++; }, writeFile() { calls.shared++; } };
    context.notebookManager = { loadFromManifest() { calls.notebooks++; }, createNotebook() { calls.notebooks++; } };
    vm.runInContext(read('www/js/package_loader.js'), context);
    const loader = context.packageLoader;
    loader._loadWasmModules = async () => { calls.wasm++; };
    loader._syncPythonModules = () => { calls.executes++; };
    return { context, loader, files, calls };
}
test('restores support only, preserves existing edits/shared data, and later package installs win', async () => {
    const { loader, files, calls } = harness();
    const paths = new Set();
    const prepared = value => ({ manifest: { _baseDir: '', files: [
        { src: 'lib.pl', dest: '/user/lib.pl' }, { src: 'edited.pl', dest: '/user/edited.pl' },
        { src: 'shared.txt', dest: '/shared/edited.txt', target: 'shared' }, { src: 'empty.pl', dest: '/user/empty.pl' },
    ], notebooks: [{ file: 'notes.ipynb' }], wasm_modules: [{ name: 'bad' }], search_paths: [{ alias: 'fixture', dir: '/user/lib' }] },
    fileMap: new Map([['lib.pl', value], ['edited.pl', 'archive version'], ['shared.txt', 'old shared value'], ['empty.pl', '']]) });
    await loader.remountPrepared(prepared('v1'), paths);
    await loader.remountPrepared(prepared('v2'), paths);
    assert.equal(files.get('/user/lib.pl'), 'v2');
    assert.equal(files.get('/user/edited.pl'), 'user edit');
    assert.equal(files.get('/user/empty.pl'), '');
    assert.equal(calls.shared, 0);
    assert.equal(calls.notebooks, 0);
    assert.equal(calls.executes, 0);
    assert.equal(calls.wasm, 0);
    assert.equal(calls.search.length, 2);
});
test('raw archives remount supporting files but never recreate notebook files', async () => {
    const { loader, files, calls } = harness();
    await loader.remountPrepared({ manifest: null, fileMap: new Map([['lib.pl', 'raw(ok).'], ['notes.ipynb', '{}'], ['workbook.srwb', '{}']]) });
    assert.equal(files.get('/user/lib.pl'), 'raw(ok).');
    assert.equal(files.has('/user/notes.ipynb'), false);
    assert.equal(files.has('/user/workbook.srwb'), false);
    assert.equal(calls.notebooks, 0);
});
test('prepared installs propagate mount failures rather than claim installation succeeded', async () => {
    const { context, loader } = harness();
    context.kernelManager.ensureReady = async () => { throw Error('runtime unavailable'); };
    await assert.rejects(loader.loadPrepared({ manifest: null, fileMap: new Map([['lib.pl', 'ok']]), filename: 'raw.zip' }), /runtime unavailable/);
    await assert.rejects(loader.loadPrepared({ manifest: { files: [{ src: 'lib.pl', dest: '/user/lib.pl' }] }, fileMap: new Map([['lib.pl', 'ok']]), filename: 'manifest.zip' }), /runtime unavailable/);
});
test('prepared shared-file installs fail explicitly when storage is missing or a write is denied', async () => {
    const { context, loader } = harness();
    const prepared = { manifest: { files: [{ src: 'lib.py', dest: '/shared/lib/python/fixture.py', target: 'shared' }] },
        fileMap: new Map([['lib.py', 'fixture = 1']]), filename: 'shared.zip' };
    delete context.sharedVFS;
    await assert.rejects(loader.loadPrepared(prepared), /filesystem is unavailable/);
    context.sharedVFS = { mkdir() {}, writeFile() { return false; } };
    await assert.rejects(loader.loadPrepared(prepared), /not permitted/);
});
test('initial prepared import rejects an unowned collision before writing other package files', async () => {
    const { context, loader, calls, files } = harness();
    context.packageInstalls = { isManagedPath: () => false };
    await assert.rejects(loader.loadPrepared({ manifest: { files: [
        { src: 'shared.txt', dest: '/shared/new.txt', target: 'shared' },
        { src: 'edited.pl', dest: '/user/edited.pl' },
    ] }, filename: 'conflict.zip', fileMap: new Map([['shared.txt', 'new'], ['edited.pl', 'replacement']]) }), error => error.code === 'PACKAGE_FILE_CONFLICT');
    assert.equal(calls.shared, 0);
    assert.equal(files.get('/user/edited.pl'), 'user edit');
});
test('prepared imports track only written support paths with their explicit mode', async () => {
    const { context, loader, files } = harness();
    const managed = new Map();
    context.packageInstalls = {
        isManagedPath: path => managed.has(path), isSessionOnlyManagedPath: path => managed.get(path) === false,
        trackSupportFiles(paths, { persistent }) { for (const path of paths) managed.set(path, persistent); },
    };
    const make = value => ({ filename: 'owned.zip', manifest: { files: [{ src: 'lib.pl', dest: '/user/lib.pl' }] }, fileMap: new Map([['lib.pl', value]]) });
    await loader.loadPrepared(make('persistent'), { persistent: true });
    assert.equal(managed.get('/user/lib.pl'), true);
    await loader.loadPrepared(make('session'), { persistent: false });
    assert.equal(managed.get('/user/lib.pl'), false);
    assert.equal(files.get('/user/lib.pl'), 'session');
});
test('session-only Shared import cannot discard a previously retained Shared snapshot', async () => {
    const { context, loader, calls } = harness();
    context.sharedVFS.exists = () => true;
    context.packageInstalls = { isManagedPath: () => true, isSessionOnlyManagedPath: () => false };
    await assert.rejects(loader.loadPrepared({ filename: 'session.zip', manifest: { files: [{ src: 'lib.py', dest: '/shared/lib.py', target: 'shared' }] },
        fileMap: new Map([['lib.py', 'replacement']]) }), error => error.code === 'PACKAGE_FILE_CONFLICT');
    assert.equal(calls.shared, 0);
});
test('archive restore fills missing Shared support but preserves an existing user copy', async () => {
    const { context, loader, calls } = harness();
    const owned = [];
    context.packageInstalls = { trackSupportFiles(paths, options) { owned.push({ paths, ...options }); } };
    await loader.remountPrepared({ manifest: { files: [
        { src: 'missing.py', dest: '/shared/missing.py', target: 'shared' },
        { src: 'edited.txt', dest: '/shared/edited.txt', target: 'shared' },
    ] }, fileMap: new Map([['missing.py', 'x = 1'], ['edited.txt', 'old copy']]) });
    assert.equal(owned.length, 1);
    assert.deepEqual(Array.from(owned[0].paths), ['/shared/missing.py']);
    assert.equal(owned[0].persistent, true);
    assert.ok(calls.shared > 0);
});
test('concurrent first Prolog cells await the same restoration; destroy resets it', async () => {
    const { context } = harness();
    let resolve;
    let calls = 0;
    context.packageCatalog = { _restorePromise: null, restoreInstalledToProlog() { calls++; return new Promise(done => { resolve = done; }); } };
    context.packageInstalls = { restorePromise: Promise.resolve() };
    context.kernelManager.register = () => {};
    vm.runInContext(read('www/js/kernels/prolog.js'), context);
    const kernel = vm.runInContext('new PrologKernel()', context);
    let completed = 0;
    const first = kernel._ensurePackagesRestored().then(() => completed++);
    const second = kernel._ensurePackagesRestored().then(() => completed++);
    await Promise.resolve();
    assert.equal(calls, 1); assert.equal(completed, 0);
    resolve(); await Promise.all([first, second]);
    assert.equal(completed, 2);
    await kernel.destroy();
    assert.equal(kernel._packagesRestored, false);
    assert.equal(context.packageInstalls.restorePromise, null);
    const again = kernel._ensurePackagesRestored(); resolve(); await again;
    assert.equal(calls, 2);
});
test('unavailable archive storage warns without disabling session-only Prolog and permits retry', async () => {
    const { context } = harness();
    let attempts = 0;
    context.packageCatalog = { async restoreInstalledToProlog() { if (++attempts === 1) throw Error('storage unavailable'); } };
    context.kernelManager.register = () => {};
    let notices = 0;
    context.PackageInstallUI = { notify() { notices++; } };
    vm.runInContext(read('www/js/kernels/prolog.js'), context);
    const kernel = vm.runInContext('new PrologKernel()', context);
    kernel._ready = true;
    kernel._syncNbToProlog = kernel._syncSharedPaths = kernel._syncNbFromProlog = () => {};
    kernel._executeBlock = async () => ({ stdout: 'session-only Prolog remains usable', result: null, error: null });
    const outcome = await kernel.execute('fixture.');
    assert.equal(outcome.stdout, 'session-only Prolog remains usable');
    assert.equal(outcome.error, null);
    assert.equal(notices, 1);
    assert.equal(kernel._packagesRestorePromise, null);
    await kernel._ensurePackagesRestored();
    assert.equal(attempts, 2);
    assert.equal(kernel._packagesRestored, true);
});
