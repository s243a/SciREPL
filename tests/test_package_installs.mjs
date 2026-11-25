/** Controller boundaries with local synthetic archives and explicit UI/storage mocks. */
import assert from 'node:assert/strict';
import { File } from 'node:buffer';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../www/js/package_installs.js', import.meta.url), 'utf8');
const loaderSource = readFileSync(new URL('../www/js/package_loader.js', import.meta.url), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const error = code => Object.assign(new Error(code), { code });
const idFor = byte => byte.toString(16).padStart(2, '0').repeat(32);
const file = (byte = 1, name = 'fixture.zip') => new File([Uint8Array.of(byte)], name);
const deferred = () => {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
};
const tick = () => new Promise(resolve => setImmediate(resolve));

function harness({ choice = 'persistent', initial = [] } = {}) {
    const events = [];
    const records = new Map(initial.map(record => [record.id, { ...record }]));
    const payloads = new Map(initial.map(record => [record.id, Uint8Array.of(parseInt(record.id.slice(0, 2), 16))]));
    let clock = 1000;
    const metadata = byte => ({ id: idFor(byte), sha256: idFor(byte), name: `Saved ${byte}`,
        filename: `fixture-${byte}.zip`, size: 1, createdAt: ++clock });
    const store = {
        async list() { events.push({ op: 'list' }); return [...records.values()].map(record => ({ ...record })).sort((a, b) => a.createdAt - b.createdAt); },
        async save(input) {
            events.push({ op: 'save', input });
            const id = idFor(input.bytes[0]);
            const existing = records.get(id);
            const saved = existing ? { ...existing, createdAt: ++clock } : { ...metadata(input.bytes[0]), name: input.name, filename: input.filename };
            records.set(id, saved); payloads.set(id, input.bytes.slice());
            const result = { ...saved };
            Object.defineProperty(result, 'createdNew', { value: !existing, enumerable: false });
            return result;
        },
        async read(id) {
            events.push({ op: 'read', id });
            return records.has(id) ? { ...records.get(id), bytes: payloads.get(id).slice() } : null;
        },
        async remove(id, options = {}) {
            events.push({ op: 'remove', id, options });
            const current = records.get(id);
            if (options.ifCreatedAt !== undefined && current?.createdAt !== options.ifCreatedAt) return false;
            payloads.delete(id); return records.delete(id);
        },
    };
    const ui = {
        async choose(options) { events.push({ op: 'choose', options }); return choice; },
        message(failure) { return `Translated ${failure.code || 'failure'}`; },
        async notify(failure) { events.push({ op: 'notify', failure }); },
        async manage(input) { events.push({ op: 'manage', store: input }); },
    };
    const validation = { async prepare(input) {
        events.push({ op: 'validate', filename: input.name });
        const bytes = new Uint8Array(await input.arrayBuffer());
        return { name: `Validated ${input.name}`, filename: input.name, bytes, manifest: null, fileMap: new Map() };
    } };
    let loader = {
        async loadPrepared(prepared) { events.push({ op: 'load', prepared }); return { files: 1, notebooks: 0 }; },
        async remountPrepared(prepared, paths) { events.push({ op: 'remount', prepared, paths }); },
    };
    const window = { Capacitor: { getPlatform: () => 'web' }, PackageInstallUI: ui, PackageArchiveValidation: validation,
        packageLoader: loader, packageCatalog: { _syncInstallButtons() { events.push({ op: 'sync' }); } } };
    const context = vm.createContext({ window, File, Uint8Array, Map, Set, console,
        fetch() { events.push({ op: 'network' }); throw new Error('No network authority'); } });
    // Keep the controller's shared-support classification real; import effects
    // alone are mocked here. Manifest and raw paths must use one policy.
    vm.runInContext(loaderSource, context, { filename: 'package_loader.js' });
    loader = Object.assign(window.packageLoader, loader);
    vm.runInContext(source, context, { filename: 'package_installs.js' });
    const controller = new window.PackageInstalls(store);
    return { controller, store, ui, validation, loader, events, records, payloads, metadata, window };
}

test('persistent choice commits validated original bytes before initial import', async () => {
    const h = harness();
    const pkg = { id: 'remote', name: 'Remote package' };
    const result = await h.controller.install(file(), { name: 'Display package', pkg });
    assert.deepEqual(plain(result), { files: 1, notebooks: 0, mode: 'persistent', archiveId: idFor(1) });
    assert.deepEqual(h.events.filter(event => ['choose', 'validate', 'save', 'load'].includes(event.op)).map(event => event.op), ['choose', 'validate', 'save', 'load']);
    assert.equal(h.events.find(event => event.op === 'choose').options.name, 'Display package');
    assert.deepEqual(Array.from(h.events.find(event => event.op === 'save').input.bytes), [1]);
    assert.equal(pkg._localArchiveId, idFor(1));
    assert(h.controller.savedIds.has(idFor(1)));
    assert.equal(h.controller.busy, false);
});

test('explicit session choice imports but does not save or silently keep a local-archive identity', async () => {
    const h = harness({ choice: 'session' });
    const pkg = { id: 'session', name: 'Session package', _localArchiveId: 'old' };
    const result = await h.controller.install(file(), { pkg });
    assert.equal(result.mode, 'session');
    assert.equal(result.archiveId, null);
    assert.equal(h.events.some(event => event.op === 'save'), false);
    assert.equal(h.events.filter(event => event.op === 'load').length, 1);
    assert.equal(pkg._localArchiveId, undefined);
    assert.equal(h.controller.isInstalled(pkg, []), true);
    assert.equal(h.records.size, 0);
});

test('Cancel, missing UI choice and unrecognized choice have no storage, validation or import side effects', async () => {
    for (const choice of [null, undefined, 'unexpected']) {
        const h = harness(); h.ui.choose = async () => choice;
        await assert.rejects(h.controller.install(file()), { code: 'INSTALL_CANCELLED' });
        assert.equal(h.events.some(event => ['save', 'validate', 'load', 'remove'].includes(event.op)), false);
        assert.equal(h.controller.busy, false);
    }
});

test('a second install while a choice is open is rejected without queuing another dialog', async () => {
    const h = harness();
    const gate = deferred(); let dialogs = 0;
    h.ui.choose = async () => { dialogs++; return gate.promise; };
    const first = h.controller.install(file());
    await tick();
    await assert.rejects(h.controller.install(file(2)), { code: 'INSTALL_CANCELLED' });
    assert.equal(dialogs, 1);
    gate.resolve(null);
    await assert.rejects(first, { code: 'INSTALL_CANCELLED' });
    await tick();
    assert.equal(dialogs, 1);
    assert.equal(h.events.some(event => event.op === 'load'), false);
});

test('full or unavailable persistent storage never falls back to session import', async () => {
    for (const code of ['ARCHIVE_STORE_FULL', 'STORE_UNAVAILABLE']) {
        const h = harness();
        h.store.save = async () => { h.events.push({ op: 'save' }); throw error(code); };
        await assert.rejects(h.controller.install(file()), failure => failure.code === code && failure.message === `Translated ${code}`);
        assert.equal(h.events.some(event => event.op === 'load'), false);
        assert.equal(h.events.some(event => event.op === 'remove'), false);
        assert.equal(h.controller.savedIds.size, 0);
        assert.equal(h.controller.busy, false);
    }
});

test('invalid archive validation fails before a persistent save or import', async () => {
    const h = harness();
    h.validation.prepare = async () => { throw error('ARCHIVE_CORRUPT'); };
    await assert.rejects(h.controller.install(file()), { code: 'ARCHIVE_CORRUPT' });
    assert.equal(h.events.some(event => ['save', 'load'].includes(event.op)), false);
    assert.equal(h.records.size, 0);
});

test('failed initial import rolls back only a newly created retained copy with its generation guard', async () => {
    const h = harness();
    h.loader.loadPrepared = async () => { throw error('IMPORT_FAILED'); };
    await assert.rejects(h.controller.install(file()), { code: 'IMPORT_FAILED' });
    const removal = h.events.find(event => event.op === 'remove');
    assert.equal(removal?.id, idFor(1));
    assert(Number.isSafeInteger(removal?.options.ifCreatedAt));
    assert.equal(h.records.size, 0);
    assert.equal(h.controller.savedIds.has(idFor(1)), false);
});

test('failed deduplicated import keeps a pre-existing retained archive', async () => {
    const seed = { id: idFor(1), sha256: idFor(1), name: 'Pre-existing', filename: 'fixture.zip', size: 1, createdAt: 500 };
    const h = harness({ initial: [seed] });
    h.loader.loadPrepared = async () => { throw error('IMPORT_FAILED'); };
    await assert.rejects(h.controller.install(file()), { code: 'IMPORT_FAILED' });
    assert.equal(h.records.has(seed.id), true);
    assert.equal(h.events.some(event => event.op === 'remove'), false);
    assert.equal(h.controller.savedIds.has(seed.id), true);
});

test('another explicit reuse during a failed import is not deleted by stale rollback', async () => {
    const h = harness();
    h.loader.loadPrepared = async prepared => {
        await h.store.save({ name: 'Concurrent reuse', filename: prepared.filename, bytes: prepared.bytes });
        throw error('IMPORT_FAILED');
    };
    await assert.rejects(h.controller.install(file()), { code: 'IMPORT_FAILED' });
    assert.equal(h.records.has(idFor(1)), true);
    assert.equal(h.controller.savedIds.has(idFor(1)), true);
});

test('offline restore reads and validates saved bytes before remounting, with shared path tracking and no URL fallback', async () => {
    const h = harness();
    const first = h.metadata(1), second = h.metadata(2);
    h.records.set(first.id, first); h.payloads.set(first.id, Uint8Array.of(1));
    h.records.set(second.id, second); h.payloads.set(second.id, Uint8Array.of(2));
    const results = await h.controller.restore();
    assert.deepEqual(plain(results), [{ id: first.id, restored: true }, { id: second.id, restored: true }]);
    assert.deepEqual(h.events.filter(event => ['read', 'validate', 'remount'].includes(event.op)).map(event => event.op), ['read', 'validate', 'remount', 'read', 'validate', 'remount']);
    const mounts = h.events.filter(event => event.op === 'remount');
    assert.equal(mounts[0].paths, mounts[1].paths);
    assert.equal(mounts[0].prepared.bytes[0], 1);
    assert.equal(mounts[1].prepared.bytes[0], 2);
    assert.equal(h.events.some(event => ['network', 'load', 'save', 'choose'].includes(event.op)), false);
});

test('restore continues after corrupt entries, disables their installed status and names all failures in one notice', async () => {
    const h = harness();
    const seeds = [h.metadata(1), h.metadata(2), h.metadata(3)];
    for (const seed of seeds) { h.records.set(seed.id, seed); h.payloads.set(seed.id, Uint8Array.of(parseInt(seed.id.slice(0, 2), 16))); }
    const baseRead = h.store.read;
    h.store.read = async id => { if ([seeds[0].id, seeds[1].id].includes(id)) throw error('ARCHIVE_CORRUPT'); return baseRead(id); };
    const result = await h.controller.restore();
    assert.deepEqual(plain(result).map(item => item.restored), [false, false, true]);
    assert.equal(h.events.filter(event => event.op === 'remount').length, 1);
    assert.equal(h.controller.savedIds.has(seeds[0].id), false);
    assert.equal(h.controller.savedIds.has(seeds[1].id), false);
    assert.equal(h.controller.savedIds.has(seeds[2].id), true);
    const notices = h.events.filter(event => event.op === 'notify');
    assert.equal(notices.length, 1);
    assert.equal(notices[0].failure.code, 'RESTORE_FAILED');
    assert(String(notices[0].failure.names).includes(seeds[0].name));
    assert(String(notices[0].failure.names).includes(seeds[1].name));
    assert.equal(h.events.some(event => event.op === 'network'), false);
});

test('simultaneous restoration callers share the same work instead of remounting twice', async () => {
    const h = harness();
    const seed = h.metadata(1); h.records.set(seed.id, seed); h.payloads.set(seed.id, Uint8Array.of(1));
    const baseRead = h.store.read, gate = deferred(); let reads = 0;
    h.store.read = async id => { reads++; await gate.promise; return baseRead(id); };
    const first = h.controller.restore(), second = h.controller.restore();
    await tick(); assert.equal(reads, 1); gate.resolve();
    assert.deepEqual(plain(await first), plain(await second));
    assert.equal(h.events.filter(event => event.op === 'remount').length, 1);
});

test('restoration waits for an active install instead of mounting behind its unresolved choice', async () => {
    const h = harness();
    const gate = deferred(); h.ui.choose = () => gate.promise;
    const installing = h.controller.install(file());
    const restoring = h.controller.restore();
    await tick();
    assert.equal(h.events.some(event => ['list', 'read', 'save', 'remount'].includes(event.op)), false);
    gate.resolve('session');
    await installing; await restoring;
    assert(h.events.findIndex(event => event.op === 'load') < h.events.findIndex(event => event.op === 'list'));
});

test('an install cannot open a new modal while restoration is in progress', async () => {
    const h = harness();
    const seed = h.metadata(1); h.records.set(seed.id, seed); h.payloads.set(seed.id, Uint8Array.of(1));
    const baseRead = h.store.read, gate = deferred();
    h.store.read = async id => { await gate.promise; return baseRead(id); };
    const restoring = h.controller.restore(); await tick();
    await assert.rejects(h.controller.install(file(2)), { code: 'INSTALL_CANCELLED' });
    assert.equal(h.events.some(event => event.op === 'choose'), false);
    gate.resolve(); await restoring;
});

test('store-opening restore failure remains explicit and a later attempt can retry', async () => {
    const h = harness();
    const baseList = h.store.list; let attempts = 0;
    h.store.list = async () => { if (!attempts++) throw error('STORE_UNAVAILABLE'); return baseList(); };
    await assert.rejects(h.controller.restore(), { code: 'STORE_UNAVAILABLE' });
    assert.deepEqual(plain(await h.controller.restore()), []);
});

test('saved-copy management removes the requested archive, refreshes install status and does not import or run anything', async () => {
    const h = harness();
    const seed = h.metadata(1); h.records.set(seed.id, seed); h.payloads.set(seed.id, Uint8Array.of(1));
    await h.controller.refresh(); assert.equal(h.controller.savedIds.has(seed.id), true);
    h.ui.manage = async store => { assert.equal(store, h.store); await store.remove(seed.id); };
    await h.controller.manage();
    assert.equal(h.controller.savedIds.has(seed.id), false);
    assert.equal(h.records.size, 0);
    assert.equal(h.events.some(event => ['load', 'remount', 'network'].includes(event.op)), false);
    assert.equal(h.controller.busy, false);
});

test('every kernel-shared manifest root and raw education archive requires a committed Shared snapshot', async () => {
    const variants = ['/shared', '/tmp', '/education', '/user/education'].map(root => ({
        manifest: { files: [{ src: 'support.pl', dest: `${root}/support.pl`, target: 'prolog' }] },
        fileMap: new Map([['support.pl', 'fixture(ok).']]),
    }));
    variants.push({ manifest: null, fileMap: new Map([['education/support.pl', 'fixture(ok).']]) });
    for (const variant of variants) {
        const h = harness();
        const prepare = h.validation.prepare;
        h.validation.prepare = async input => ({ ...await prepare(input), ...variant });
        h.window.sessionManager = { async savePrologState() { return true; }, async saveSharedState() { return false; } };
        await assert.rejects(h.controller.install(file()), failure => failure.code === 'PACKAGE_SNAPSHOT_FAILED');
        assert.equal(h.records.size, 0, 'failed first persistent installation rolls back its new retained archive');
        assert.equal(h.events.filter(event => event.op === 'remove').length, 1);
    }
});

test('shared-support classification excludes unrelated roots and notebook-only raw archives', () => {
    const { loader } = harness();
    for (const path of ['/user/notes.pl', '/education-other/x.pl', '/user/education-other/x.pl', '/nb/1/x', '/local/x']) {
        assert.equal(loader.isSharedSupportPath(path), false);
        assert.equal(loader.hasSharedSupport({ manifest: { files: [{ dest: path, target: 'prolog' }] } }), false);
    }
    assert.equal(loader.hasSharedSupport({ manifest: null, fileMap: new Map([['education/notes.ipynb', '{}']]) }), false);
    assert.equal(loader.hasSharedSupport({ manifest: { files: [{ dest: '/user/data.txt', target: 'shared' }] } }), true);
});
