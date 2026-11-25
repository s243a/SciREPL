/* Real snapshot methods with an exact package-support registry. No device data. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const root = '/user/scirepl-managed-fixture';
const managedProlog = [`${root}/persistent.pl`, `${root}/session.pl`];
const ownedShared = ['/shared/lib/python/persistent_fixture.py', '/tmp/session_fixture.bin',
    '/shared/lib/python/session_fixture.py', '/shared/data/persistent_fixture.bin'];
const aliases = [{ alias: 'fixture_persistent', dir: `${root}/persistent` }, { alias: 'fixture_session', dir: `${root}/session` }];

function harness({ indexed = false, failFiles = false, defer = null } = {}) {
    const saved = new Map();
    const reads = [];
    const legacy = { path: '/user/legacy-package/lib.pl', content: 'legacy user-owned copy' };
    const context = vm.createContext({
        console: { log() {}, warn() {}, error() {} }, TextEncoder, TextDecoder, Uint8Array,
        ArrayBuffer, Map, Set, btoa, atob,
        localStorage: { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value), removeItem: key => saved.delete(key) },
    });
    context.window = context;
    context.Capacitor = { getPlatform: () => 'web' }; // No app-owned Android bootstrap.
    for (const path of ['www/js/package_installs.js', 'www/js/persistence.js', 'www/js/shared_vfs.js']) {
        vm.runInContext(read(path), context, { filename: path });
    }
    context.packageInstalls = new context.PackageInstalls(null);
    context.packageInstalls.trackSupportFiles([managedProlog[0]], { filesystem: 'prolog', persistent: true });
    context.packageInstalls.trackSupportFiles([managedProlog[1]], { filesystem: 'prolog', persistent: false });
    context.packageInstalls.trackSupportSearchPaths(aliases);
    const files = new Map([
        ['/user/prelude.pl', 'prelude'],
        [managedProlog[0], 'persistent library'], [managedProlog[1], 'session library'],
        [`${root}/session.pl.copy`, 'explicit user copy'],
        ['/user/my-notes.pl', 'ordinary user content'], [legacy.path, legacy.content],
    ]);
    const searchPaths = [{ alias: 'user', dir: '/user' }, ...aliases,
        { alias: 'fixture_session', dir: '/user/unrelated-directory' }, { alias: 'legacy', dir: '/user/legacy-package' }];
    const vfs = {
        getMountedFiles: () => [...files.keys()].map(path => ({ path })),
        readFile(path) { reads.push(path); return files.get(path); },
        getSearchPaths: () => searchPaths.slice(),
    };
    context.kernelManager = { getKernel: () => ({ getVFS: () => vfs }) };
    context.sessionManager.session.notebooks = [{ id: 'existing-one', cells: [{ code: 'print(1)' }] }];
    context.sessionManager.session.prologFiles = [legacy];
    context.sessionManager.session.prologPaths = [{ alias: 'legacy', dir: '/user/legacy-package' }];
    const captured = { files: null, paths: null, shared: null, dirs: null };
    context.vfsStore = {
        isReady: () => indexed,
        async saveFiles(value) {
            if (defer) await defer;
            if (failFiles) throw Error('fixture failed write');
            captured.files = plain(value);
        },
        async saveSearchPaths(value) { if (defer) await defer; captured.paths = plain(value); },
        async saveAllSharedFiles(files, dirs) { captured.shared = files.map(file => ({ ...file })); captured.dirs = [...dirs]; },
    };
    const shared = context.sharedVFS;
    shared.writeFile(ownedShared[0], 'managed python', 'package');
    shared.writeFile(ownedShared[1], new Uint8Array([1, 2, 3]), 'package');
    shared.writeFile(ownedShared[2], 'session python', 'package');
    shared.writeFile(ownedShared[3], new Uint8Array([7, 8, 9]), 'package');
    // Like the loader, claim only successful writes. Ordinary SharedVFS writes
    // clear earlier ownership, so claiming before writing would test stale state.
    context.packageInstalls.trackSupportFiles([ownedShared[0], ownedShared[3]], { filesystem: 'shared', persistent: true });
    context.packageInstalls.trackSupportFiles([ownedShared[1], ownedShared[2]], { filesystem: 'shared', persistent: false });
    shared.writeFile('/shared/data/user.txt', 'ordinary shared text', 'user');
    shared.writeFile('/shared/data/user.bin', new Uint8Array([4, 5, 6]), 'user');
    return { context, captured, saved, reads, files, searchPaths };
}

test('support ownership is exact, app-session scoped and preserves nearby user paths and aliases', () => {
    const { context } = harness();
    const registry = context.packageInstalls;
    assert.equal(registry.isManagedPath(managedProlog[0], 'prolog'), true);
    assert.equal(registry.isManagedPath(managedProlog[0], 'shared'), false);
    assert.equal(registry.isSessionOnlyManagedPath(managedProlog[0], 'prolog'), false);
    assert.equal(registry.isSessionOnlyManagedPath(managedProlog[1], 'prolog'), true);
    assert.equal(registry.isManagedPath(`${root}/session.pl.copy`, 'prolog'), false);
    assert.equal(registry.isManagedPath(root, 'prolog'), false);
    assert.equal(registry.isManagedSearchPath('fixture_session', `${root}/session`), true);
    assert.equal(registry.isManagedSearchPath('fixture_session', '/user/unrelated-directory'), false);
    assert.equal(new context.PackageInstalls(null).isManagedPath(managedProlog[0], 'prolog'), false);
});

test('IndexedDB Prolog snapshots exclude both persistent and session package support and aliases', async () => {
    const { context, captured, reads } = harness({ indexed: true });
    const notebooks = JSON.stringify(context.sessionManager.session.notebooks);
    assert.equal(await context.sessionManager.savePrologState(), true);
    assert.deepEqual(captured.files.map(file => file.path), [`${root}/session.pl.copy`, '/user/my-notes.pl', '/user/legacy-package/lib.pl']);
    assert.deepEqual(captured.paths, [
        { alias: 'user', dir: '/user' }, { alias: 'fixture_session', dir: '/user/unrelated-directory' }, { alias: 'legacy', dir: '/user/legacy-package' },
    ]);
    assert.ok(!reads.includes(managedProlog[0]) && !reads.includes(managedProlog[1]));
    assert.equal(JSON.stringify(context.sessionManager.session.notebooks), notebooks);
});

test('localStorage fallback applies the same support filters without deleting unknown legacy files', async () => {
    const { context, saved } = harness();
    assert.equal(await context.sessionManager.savePrologState(), true);
    const snapshot = JSON.parse(saved.get('scirepl_session_v2'));
    assert.deepEqual(snapshot.prologFiles.map(file => file.path), [`${root}/session.pl.copy`, '/user/my-notes.pl', '/user/legacy-package/lib.pl']);
    assert.equal(snapshot.prologPaths.some(path => aliases.some(owned => owned.alias === path.alias && owned.dir === path.dir)), false);
    assert.equal(snapshot.notebooks[0].id, 'existing-one');
});

test('package-owned file edits stay in this session; a separate user copy persists', async () => {
    const { context, files, captured } = harness({ indexed: true });
    files.set(managedProlog[1], 'session edit must not silently persist');
    assert.equal(await context.sessionManager.savePrologState(), true);
    assert.equal(captured.files.some(file => file.path === managedProlog[1]), false);
    assert.equal(captured.files.find(file => file.path === `${root}/session.pl.copy`).content, 'explicit user copy');
});

test('SharedVFS snapshots retain persistent support for Python-first startup but exclude session text/binary', async () => {
    const { context, captured } = harness({ indexed: true });
    const snapshot = context.sharedVFS.snapshot();
    const expected = [ownedShared[0], ownedShared[3], '/shared/data/user.txt', '/shared/data/user.bin'];
    assert.deepEqual(plain(snapshot.files.map(file => file.path)), expected);
    assert.equal(await context.sharedVFS.saveToIndexedDB(), true);
    assert.deepEqual(plain(captured.shared.map(file => file.path)), expected);
    assert.deepEqual(Array.from(captured.shared.find(file => file.path.endsWith('user.bin')).content), [4, 5, 6]);
    assert.deepEqual(Array.from(captured.shared.find(file => file.path === ownedShared[3]).content), [7, 8, 9]);
    assert.ok(context.sharedVFS.exists(ownedShared[0]), 'filtering does not remove current-session support');
});

test('SessionManager SharedVFS fallback is filtered too when IndexedDB is unavailable', async () => {
    const { context, saved } = harness();
    assert.equal(await context.sessionManager.saveSharedState(), false);
    const snapshot = JSON.parse(saved.get('scirepl_session_v2')).sharedVFS;
    assert.deepEqual(snapshot.files.map(file => file.path), [ownedShared[0], ownedShared[3], '/shared/data/user.txt', '/shared/data/user.bin']);
});

test('registry records the explicit persistence mode without claiming neighboring user files', () => {
    const { context } = harness();
    const registry = context.packageInstalls;
    registry.trackSupportFiles(['/shared/data/new_package.txt'], { filesystem: 'shared', persistent: true });
    assert.equal(registry.isManagedPath('/shared/data/new_package.txt', 'shared'), true);
    assert.equal(registry.isManagedPath('/shared/data/new_package.txt', 'prolog'), false);
    assert.equal(registry.isSessionOnlyManagedPath('/shared/data/new_package.txt', 'shared'), false);
    registry.trackSupportFiles(['/shared/data/new_package.txt'], { filesystem: 'shared', persistent: false });
    assert.equal(registry.isSessionOnlyManagedPath('/shared/data/new_package.txt', 'shared'), true);
    assert.equal(registry.isManagedPath('/shared/data/new_package.txt.copy', 'shared'), false);
});

test('savePrologState waits for both writes and keeps fallback data if a write fails', async () => {
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    const { context } = harness({ indexed: true, defer: pending });
    let settled = false;
    const operation = context.sessionManager.savePrologState().then(result => { settled = true; return result; });
    await Promise.resolve();
    assert.equal(settled, false);
    assert.equal(context.sessionManager.session.prologFiles.length, 1);
    release();
    assert.equal(await operation, true);
    assert.equal(context.sessionManager.session.prologFiles.length, 0);
    const failed = harness({ indexed: true, failFiles: true });
    assert.equal(await failed.context.sessionManager.savePrologState(), false);
    assert.equal(failed.context.sessionManager.session.prologFiles[0].path, '/user/legacy-package/lib.pl');
});

