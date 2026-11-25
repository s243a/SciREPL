/* Ownership regressions through the real installer, validator, loader and snapshots.
 * All archives are local fixtures; IndexedDB and the ephemeral Prolog VFS are mocks.
 */
import assert from 'node:assert/strict';
import { File } from 'node:buffer';
import { createHash, webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const copy = value => structuredClone(value);
const canonical = '/user/collision.pl';
const sharedBytes = 'shared_copy(original).';
const prologBytes = 'prolog_copy(different).';
const conflict = failure => failure.code === 'PACKAGE_FILE_CONFLICT';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const normalize = path => {
    const parts = [];
    for (const part of path.split('/')) {
        if (!part || part === '.') continue;
        if (part === '..') parts.pop(); else parts.push(part);
    }
    return '/' + parts.join('/');
};

function diskState() {
    return { archives: new Map(), sharedFiles: [], sharedDirs: [], local: new Map(), generation: 1000 };
}

function boot(disk = diskState()) {
    const prologFiles = new Map();
    const prologDirs = new Set(['/']);
    const captured = { prologFiles: null, prologPaths: null, notices: [] };
    // Real PrologVFS below distinguishes native .stat() from .exists(), whose
    // fallback can report a SharedVFS file even with no native Prolog copy.
    let prolog;
    const nativeFS = {
        stat(path) {
            path = normalize(path);
            if (prologFiles.has(path)) return { mode: 0o100644, size: prologFiles.get(path).length };
            if (prologDirs.has(path)) return { mode: 0o40755, size: 0 };
            throw new Error('ENOENT');
        },
        isDir: mode => (mode & 0o170000) === 0o40000,
        mkdir(path) { prologDirs.add(normalize(path)); },
        writeFile(path, content) { prologFiles.set(normalize(path), content); },
        readFile(path) {
            if (!prologFiles.has(normalize(path))) throw new Error('ENOENT');
            return prologFiles.get(normalize(path));
        },
    };
    const context = vm.createContext({
        console: { log() {}, warn() {}, error() {} },
        TextEncoder, TextDecoder, Uint8Array, Uint32Array, ArrayBuffer, DataView,
        Map, Set, Blob, File, crypto: webcrypto, performance, btoa, atob,
        setTimeout, clearTimeout, setImmediate,
        localStorage: {
            getItem: key => disk.local.get(key) ?? null,
            setItem: (key, value) => disk.local.set(key, value),
            removeItem: key => disk.local.delete(key),
        },
        fetch() { throw new Error('This regression has no network authority.'); },
    });
    context.window = context;
    context.Capacitor = { getPlatform: () => 'web' }; // Explicit controller; no Android auto-bootstrap.
    context.t = key => key;
    context.kernelManager = {
        async ensureReady() {},
        getKernel: name => name === 'prolog' ? { getVFS: () => prolog, isReady: () => false } : null,
    };
    context.notebookManager = { loadFromManifest: async () => [], saveState() {} };
    context.vfsStore = {
        isReady: () => true,
        async saveFiles(files) { captured.prologFiles = copy(files); },
        async saveSearchPaths(paths) { captured.prologPaths = copy(paths); },
        async saveAllSharedFiles(files, dirs) { disk.sharedFiles = copy(files); disk.sharedDirs = copy(dirs); },
        async loadSharedFiles() { return copy(disk.sharedFiles); },
        async loadSharedDirs() { return copy(disk.sharedDirs); },
    };
    const store = {
        async list() {
            return [...disk.archives.values()].map(({ bytes, ...record }) => copy(record))
                .sort((a, b) => a.createdAt - b.createdAt);
        },
        async read(id) { return disk.archives.has(id) ? copy(disk.archives.get(id)) : null; },
        async save({ name, filename, bytes }) {
            const id = digest(bytes);
            const createdNew = !disk.archives.has(id);
            const record = { id, sha256: id, name, filename, size: bytes.length,
                createdAt: ++disk.generation, bytes: bytes.slice() };
            disk.archives.set(id, record);
            const { bytes: omitted, ...result } = record;
            Object.defineProperty(result, 'createdNew', { value: createdNew });
            return result;
        },
        async remove(id, { ifCreatedAt } = {}) {
            if (ifCreatedAt !== undefined && disk.archives.get(id)?.createdAt !== ifCreatedAt) return false;
            return disk.archives.delete(id);
        },
    };
    context.PackageInstallUI = {
        choose: async () => 'persistent', message: failure => failure.message,
        notify: async failure => captured.notices.push(failure),
    };
    for (const path of [
        'www/vendor/jszip/jszip.min.js', 'www/js/package_archive_validation.js',
        'www/js/package_installs.js', 'www/js/persistence.js',
        'www/js/shared_vfs.js', 'www/js/prolog_vfs.js', 'www/js/package_loader.js',
    ]) vm.runInContext(read(path), context, { filename: path });
    context.fixtureSwipl = { FS: nativeFS,
        prolog: { query: () => ({ next: () => ({ done: true }), close() {}, once() {} }) } };
    prolog = vm.runInContext('new PrologVFS(fixtureSwipl)', context);
    context.packageInstalls = new context.PackageInstalls(store);
    return { context, disk, store, prologFiles, prolog, captured,
        controller: context.packageInstalls, shared: context.sharedVFS, loader: context.packageLoader };
}

async function archive(h, { target = 'shared', content = sharedBytes, filename = 'fixture.zip', dest = canonical, binary = false } = {}) {
    const zip = new h.context.JSZip();
    const src = binary ? 'support.bin' : 'support.pl';
    zip.file('scirepl.json', JSON.stringify({ format_version: '1.0', name: filename,
        files: [{ src, dest, target, ...(binary ? { binary: true } : {}) }] }));
    zip.file(src, content);
    return new File([await zip.generateAsync({ type: 'uint8array' })], filename);
}

async function install(h, file, mode = 'persistent') {
    h.context.PackageInstallUI.choose = async () => mode;
    return h.controller.install(file);
}

async function restart(h) {
    const cold = boot(h.disk);
    assert.notEqual(cold.controller, h.controller, 'cold start must have a fresh ownership registry');
    assert.notEqual(cold.shared, h.shared, 'cold start must restore SharedVFS from the durable snapshot');
    assert.equal(await cold.shared.restoreFromIndexedDB(), true);
    return cold;
}

// fake-indexeddb is not a repository dependency. This deliberately small IDB
// transaction double exercises VFSStore's real field selection and structured
// clone semantics; it does not pretend to provide browser transaction coverage.
function structuredCloneIDB() {
    const tables = new Map();
    const keyPaths = new Map();
    const db = {
        objectStoreNames: { contains: name => tables.has(name) },
        createObjectStore(name, { keyPath }) { tables.set(name, new Map()); keyPaths.set(name, keyPath); },
        transaction(names) {
            for (const name of Array.isArray(names) ? names : [names]) assert.ok(tables.has(name));
            const transaction = {
                objectStore(name) {
                    const table = tables.get(name);
                    return {
                        clear() { table.clear(); },
                        put(row) { table.set(row[keyPaths.get(name)], copy(row)); },
                        getAll() {
                            const request = {};
                            queueMicrotask(() => {
                                request.result = copy([...table.values()]);
                                request.onsuccess?.();
                            });
                            return request;
                        },
                    };
                },
            };
            queueMicrotask(() => transaction.oncomplete?.());
            return transaction;
        },
    };
    return { open() {
        const request = {};
        queueMicrotask(() => {
            request.result = db;
            if (!tables.size) request.onupgradeneeded?.({ target: request });
            request.onsuccess?.({ target: request });
        });
        return request;
    } };
}

async function useRealVFSStore(h, indexedDB) {
    h.context.indexedDB = indexedDB;
    vm.runInContext(read('www/js/indexeddb_store.js'), h.context, { filename: 'www/js/indexeddb_store.js' });
    await h.context.vfsStore.init();
}

test('registry normalization keeps filesystem identity explicit and unknown or missing namespaces fail closed', () => {
    const registry = boot().controller;
    registry.trackSupportFiles(['/user/lib/../collision.pl'], { filesystem: 'shared', persistent: true });
    assert.equal(registry.isManagedPath('/user//./collision.pl', 'shared'), true);
    assert.equal(registry.isManagedPath(canonical, 'prolog'), false);
    registry.trackSupportFiles([canonical], { filesystem: 'prolog', persistent: false });
    assert.equal(registry.isSessionOnlyManagedPath(canonical, 'prolog'), true);
    assert.equal(registry.isSessionOnlyManagedPath(canonical, 'shared'), false);
    for (const filesystem of [undefined, null, '', 'other', 'Shared']) {
        assert.equal(registry.isManagedPath(canonical, filesystem), false);
        assert.equal(registry.isSessionOnlyManagedPath(canonical, filesystem), false);
        registry.trackSupportFiles(['/user/unknown.pl'], { filesystem, persistent: true });
    }
    assert.equal(registry.isManagedPath('/user/unknown.pl', 'shared'), false);
    assert.equal(registry.isManagedPath('/user/unknown.pl', 'prolog'), false);
    assert.equal(registry.isManagedPath('/user/\0collision.pl', 'shared'), false);
});

test('session Prolog support at the same normalized path cannot discard a persistent Shared snapshot', async () => {
    const h = boot();
    await install(h, await archive(h));
    await install(h, await archive(h, { target: 'prolog', content: prologBytes, filename: 'session-prolog.zip' }), 'session');
    assert.equal(h.shared.readFile('/user/./collision.pl'), sharedBytes);
    assert.equal(h.prologFiles.get(canonical), prologBytes);
    assert.equal(h.shared.snapshot().files.find(file => file.path === canonical)?.content, sharedBytes,
        'Prolog ownership must not change SharedVFS persistence at the same path');
    assert.equal(h.disk.sharedFiles.find(file => file.path === canonical)?.content, sharedBytes);
    assert.equal(h.captured.prologFiles.some(file => file.path === canonical), false);
});

test('persistent Prolog support cannot silently persist session-only Shared bytes at the same path', async () => {
    const h = boot();
    await install(h, await archive(h), 'session');
    await install(h, await archive(h, { target: 'prolog', content: prologBytes, filename: 'persistent-prolog.zip' }));
    assert.equal(h.shared.readFile(canonical), sharedBytes);
    assert.equal(h.prologFiles.get(canonical), prologBytes);
    assert.equal(h.shared.snapshot().files.some(file => file.path === canonical), false,
        'Prolog persistence must not promote SharedVFS session data');
    assert.equal(h.disk.sharedFiles.some(file => file.path === canonical), false);
    assert.equal(h.captured.prologFiles.some(file => file.path === canonical), false);
});

test('ownership in SharedVFS cannot authorize overwriting an unowned Prolog file', async () => {
    const h = boot();
    h.prologFiles.set(canonical, 'user_owned(prolog).');
    await install(h, await archive(h));
    await assert.rejects(install(h, await archive(h, { target: 'prolog', content: prologBytes, filename: 'collision-prolog.zip' })), conflict);
    assert.equal(h.prologFiles.get(canonical), 'user_owned(prolog).');
    assert.equal(h.shared.readFile(canonical), sharedBytes);
});

test('ownership in PrologVFS cannot authorize overwriting an unowned Shared file', async () => {
    const h = boot();
    h.shared.writeFile(canonical, 'user_owned(shared).', 'user');
    await install(h, await archive(h, { target: 'prolog', content: prologBytes, filename: 'owner-prolog.zip' }));
    await assert.rejects(install(h, await archive(h)), conflict);
    assert.equal(h.shared.readFile(canonical), 'user_owned(shared).');
    assert.equal(h.prologFiles.get(canonical), prologBytes);
});

test('Prolog preflight uses native stat rather than mistaking Shared fallback existence for a collision', async () => {
    const h = boot();
    const dest = '/shared/data/native-stat.pl';
    await install(h, await archive(h, { dest }));
    assert.equal(h.prolog.stat(dest), null);
    assert.equal(h.prolog.exists(dest), true, 'real PrologVFS.exists sees the Shared fallback');
    await install(h, await archive(h, { dest, target: 'prolog', content: prologBytes, filename: 'native-stat.zip' }));
    assert.equal(h.prologFiles.get(dest), prologBytes);
    assert.equal(h.shared.readFile(dest), prologBytes, 'shared-root destinations deliberately route into both filesystems');
});

test('persistent Shared package can be reinstalled from the same validated archive after a cold restart', async () => {
    const warm = boot();
    const file = await archive(warm);
    const installed = await install(warm, file);
    assert.equal(installed.mode, 'persistent');
    assert.equal(warm.disk.sharedFiles.find(entry => entry.path === canonical)?.content, sharedBytes);
    const cold = await restart(warm);
    assert.equal(cold.shared.readFile(canonical), sharedBytes);
    const restored = await cold.controller.restore();
    assert.equal(restored.length, 1);
    assert.equal(restored[0].restored, true);
    const reinstalled = await install(cold, file);
    assert.equal(reinstalled.archiveId, installed.archiveId);
    assert.equal(cold.disk.archives.size, 1);
    assert.equal(cold.shared.readFile(canonical), sharedBytes);
    assert.equal(cold.disk.sharedFiles.find(entry => entry.path === canonical)?.content, sharedBytes);
});

test('cold-start reinstall can verify the same archive before lazy Prolog archive restoration runs', async () => {
    const warm = boot();
    const file = await archive(warm);
    const installed = await install(warm, file);
    const cold = await restart(warm);
    assert.equal(cold.controller.restorePromise, null);
    const reinstalled = await install(cold, file);
    assert.equal(reinstalled.archiveId, installed.archiveId);
    assert.equal(cold.shared.readFile(canonical), sharedBytes);
    assert.equal(cold.disk.archives.size, 1);
});

test('compact Shared snapshot restore retains only verifiable provenance needed for reinstall', async () => {
    const warm = boot();
    const file = await archive(warm);
    await install(warm, file);
    const compact = copy(warm.shared.snapshot());
    const cold = boot(warm.disk);
    cold.shared.restore(compact);
    await cold.controller.restore();
    await install(cold, file);
    assert.equal(cold.shared.readFile(canonical), sharedBytes);
    assert.equal(cold.disk.sharedFiles.find(entry => entry.path === canonical)?.content, sharedBytes);
});

test('an edited Shared copy on cold start is preserved and cannot be claimed for reinstall', async () => {
    const warm = boot();
    const file = await archive(warm);
    await install(warm, file);
    const cold = await restart(warm);
    cold.shared.writeFile(canonical, 'user_edit(before_archive_restore).', 'user');
    await cold.controller.restore();
    await assert.rejects(install(cold, file), conflict);
    assert.equal(cold.shared.readFile(canonical), 'user_edit(before_archive_restore).');
    assert.equal(cold.disk.archives.size, 1, 'failed reinstall must retain the previous validated archive');
});

test('a user edit after archive restoration also revokes authority to overwrite the Shared copy', async () => {
    const warm = boot();
    const file = await archive(warm);
    await install(warm, file);
    const cold = await restart(warm);
    await cold.controller.restore();
    cold.shared.writeFile(canonical, 'user_edit(after_archive_restore).', 'user');
    assert.equal(cold.controller.isManagedPath(canonical, 'shared'), false);
    assert.equal(cold.shared.snapshot().files.find(entry => entry.path === canonical)?.content,
        'user_edit(after_archive_restore).', 'persistent-mode edits remain user data in normal snapshots');
    await cold.context.sessionManager.saveSharedState();
    assert.equal(cold.disk.sharedFiles.find(entry => entry.path === canonical)?.content,
        'user_edit(after_archive_restore).');
    await assert.rejects(install(cold, file), conflict);
    assert.equal(cold.shared.readFile(canonical), 'user_edit(after_archive_restore).');
});

test('editing session-only Shared support never promotes its bytes into snapshots or grants overwrite authority', async () => {
    const h = boot();
    const file = await archive(h);
    await install(h, file, 'session');
    h.shared.writeFile(canonical, 'edited_session_bytes(still_temporary).', 'user');
    assert.equal(h.controller.isManagedPath(canonical, 'shared'), false);
    assert.equal(h.shared.snapshot().files.some(entry => entry.path === canonical), false);
    await h.context.sessionManager.saveSharedState();
    assert.equal(h.disk.sharedFiles.some(entry => entry.path === canonical), false);
    await assert.rejects(install(h, file), conflict);
    assert.equal(h.shared.readFile(canonical), 'edited_session_bytes(still_temporary).');
});

test('byte-identical user content without package provenance is not claimed on archive restore', async () => {
    const warm = boot();
    const file = await archive(warm);
    await install(warm, file);
    const cold = boot(warm.disk);
    cold.shared.writeFile(canonical, sharedBytes, 'package'); // A user-controlled label is not provenance.
    await cold.controller.restore();
    await assert.rejects(install(cold, file), conflict);
    assert.equal(cold.shared.readFile(canonical), sharedBytes);
});

test('malformed or foreign archive provenance cannot claim an existing Shared file', async () => {
    for (const packageOrigin of [null, [], {}, { archiveId: 'not-a-sha256' },
        { archiveId: 'A'.repeat(64) }, { archiveId: '0'.repeat(64) }]) {
        const warm = boot();
        const file = await archive(warm);
        await install(warm, file);
        const snapshot = warm.disk.sharedFiles.find(entry => entry.path === canonical);
        snapshot.packageOrigin = copy(packageOrigin);
        const cold = await restart(warm);
        await cold.controller.restore();
        await assert.rejects(install(cold, file), conflict);
        assert.equal(cold.shared.readFile(canonical), sharedBytes);
    }
});

test('unknown provenance fields fail closed rather than becoming file ownership', async () => {
    const warm = boot();
    const file = await archive(warm);
    const installed = await install(warm, file);
    warm.disk.sharedFiles.find(entry => entry.path === canonical).packageOrigin = {
        archiveId: installed.archiveId, unexpected: 'not in the provenance schema',
    };
    const cold = await restart(warm);
    await cold.controller.restore();
    await assert.rejects(install(cold, file), conflict);
    assert.equal(cold.shared.readFile(canonical), sharedBytes);
});

test('a matching archive identity does not claim Shared bytes that differ from its validated support file', async () => {
    const warm = boot();
    const file = await archive(warm);
    const installed = await install(warm, file);
    const snapshot = warm.disk.sharedFiles.find(entry => entry.path === canonical);
    snapshot.packageOrigin = { archiveId: installed.archiveId };
    snapshot.content = 'edited_bytes(with_retained_marker).';
    const cold = await restart(warm);
    await cold.controller.restore();
    await assert.rejects(install(cold, file), conflict);
    assert.equal(cold.shared.readFile(canonical), 'edited_bytes(with_retained_marker).');
});

test('binary Shared support and provenance round-trip through real VFSStore serialization and reinstall', async () => {
    const indexedDB = structuredCloneIDB();
    const warm = boot();
    await useRealVFSStore(warm, indexedDB);
    const dest = '/user/collision.bin';
    const bytes = Uint8Array.of(0, 255, 128, 10);
    const file = await archive(warm, { dest, content: bytes, binary: true, filename: 'binary.zip' });
    const installed = await install(warm, file);
    const diskFile = (await warm.context.vfsStore.loadSharedFiles()).find(entry => entry.path === dest);
    assert.deepEqual(Array.from(diskFile.content), Array.from(bytes));
    assert.equal(diskFile.packageOrigin?.archiveId, installed.archiveId);
    const compact = copy(warm.shared.snapshot());
    assert.equal(compact.files.find(entry => entry.path === dest).binary, true);
    const cold = boot(warm.disk);
    await useRealVFSStore(cold, indexedDB);
    assert.equal(await cold.shared.restoreFromIndexedDB(), true);
    await cold.controller.restore();
    await install(cold, file);
    assert.deepEqual(Array.from(cold.shared.readFile(dest)), Array.from(bytes));

    const fallback = boot(warm.disk);
    fallback.shared.restore(compact);
    await fallback.controller.restore();
    await install(fallback, file);
    assert.deepEqual(Array.from(fallback.shared.readFile(dest)), Array.from(bytes));
});
