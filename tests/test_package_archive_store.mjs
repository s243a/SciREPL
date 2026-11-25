/** Real browser IndexedDB transactions; all payloads are local synthetic bytes. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { after, afterEach, before, beforeEach, test } from 'node:test';

const { chromium } = await import(process.env.SCIREPL_PLAYWRIGHT_MODULE || 'playwright');
const source = readFileSync(new URL('../www/js/package_archive_store.js', import.meta.url), 'utf8');
let server, browser, page;
before(async () => {
    server = createServer((_request, response) => {
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end('<!doctype html><title>Persistent archive store fixture</title>');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
});
beforeEach(async () => {
    page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.addScriptTag({ content: source });
});
afterEach(async () => { await page?.close(); });
after(async () => {
    await browser?.close();
    if (server) await new Promise(resolve => server.close(resolve));
});

test('retains exact view-sliced bytes across instances and returns metadata without payloads', async () => {
    const result = await page.evaluate(async () => {
        const store = new PackageArchiveStore();
        const source = new Uint8Array([255, 1, 2, 3, 254]);
        const pending = store.save({ name: 'Fixture package', filename: 'fixture.zip', bytes: source.subarray(1, 4) });
        source.fill(77);
        const saved = await pending;
        const listed = await store.list();
        store.close();
        const fresh = new PackageArchiveStore();
        const read = await fresh.read(saved.id);
        const data = { saved, listed, bytes: Array.from(read.bytes), missing: await fresh.read('f'.repeat(64)) };
        fresh.close(); return data;
    });
    assert.match(result.saved.id, /^[a-f0-9]{64}$/);
    assert.equal(result.saved.id, result.saved.sha256);
    assert.equal(result.saved.size, 3);
    assert.equal(result.saved.filename, 'fixture.zip');
    assert.deepEqual(result.bytes, [1, 2, 3]);
    assert.deepEqual(result.listed, [result.saved]);
    assert.equal('bytes' in result.listed[0], false);
    assert.equal(result.missing, null);
});

test('deduplicates bytes, preserves first names and never evicts when count is full', async () => {
    const result = await page.evaluate(async () => {
        const store = new PackageArchiveStore({ limits: { maxArchiveBytes: 16, maxTotalBytes: 32, maxArchives: 2 } });
        const a = await store.save({ filename: 'a.zip', bytes: new Uint8Array([1]) });
        const b = await store.save({ filename: 'b.tgz', bytes: new Uint8Array([2]) });
        const repeat = await store.save({ name: 'Changed name', filename: 'alias.zip', bytes: new Uint8Array([1]) });
        let error;
        try { await store.save({ filename: 'c.zip', bytes: new Uint8Array([3]) }); } catch (e) { error = e.code; }
        const beforeRemove = await store.list();
        const removed = await store.remove(a.id);
        const removedAgain = await store.remove(a.id);
        const c = await store.save({ filename: 'c.tar.gz', bytes: new Uint8Array([3]) });
        const result = { a, b, repeat, beforeRemove, error, removed, removedAgain, after: await store.list(), c };
        store.close(); return result;
    });
    assert.deepEqual({ ...result.repeat, createdAt: result.a.createdAt }, result.a);
    assert(result.repeat.createdAt > result.b.createdAt);
    assert.deepEqual(result.beforeRemove.map(x => x.id).sort(), [result.a.id, result.b.id].sort());
    assert.equal(result.error, 'ARCHIVE_STORE_FULL');
    assert.equal(result.removed, true);
    assert.equal(result.removedAgain, false);
    assert.deepEqual(result.after.map(x => x.id).sort(), [result.b.id, result.c.id].sort());
});

test('v1 then v2 then deduplicated v1 reinstall preserves explicit install precedence', async () => {
    const result = await page.evaluate(async () => {
        const originalNow = Date.now;
        Date.now = () => 1000;
        const store = new PackageArchiveStore({ limits: { maxArchiveBytes: 8, maxTotalBytes: 16, maxArchives: 2 } });
        try {
            const v1 = await store.save({ name: 'Package v1', filename: 'v1.zip', bytes: new Uint8Array([1]) });
            const v2 = await store.save({ name: 'Package v2', filename: 'v2.zip', bytes: new Uint8Array([2]) });
            Date.now = () => 500; // Reinstall after the device clock moved backwards.
            const reinstall = await store.save({ filename: 'alias.zip', bytes: new Uint8Array([1]) });
            return { v1, v2, reinstall, order: await store.list(), kept: Array.from((await store.read(v1.id)).bytes) };
        } finally { Date.now = originalNow; store.close(); }
    });
    assert.equal(result.v1.createdAt, 1000);
    assert.equal(result.v2.createdAt, 1001);
    assert.equal(result.reinstall.createdAt, 1002);
    assert.equal(result.reinstall.id, result.v1.id);
    assert.equal(result.reinstall.name, result.v1.name);
    assert.equal(result.reinstall.filename, result.v1.filename);
    assert.deepEqual(result.order.map(record => record.id), [result.v2.id, result.v1.id]);
    assert.deepEqual(result.kept, [1]);
});

test('rollback ownership and generation guard preserve another instance’s successful reuse', async () => {
    const result = await page.evaluate(async () => {
        const first = new PackageArchiveStore(), second = new PackageArchiveStore();
        try {
            const original = await first.save({ filename: 'fixture.zip', bytes: new Uint8Array([1, 2, 3]) });
            const reused = await second.save({ filename: 'alias.zip', bytes: new Uint8Array([1, 2, 3]) });
            const staleRollback = await first.remove(original.id, { ifCreatedAt: original.createdAt });
            const retained = await second.read(reused.id);
            const currentRemoval = await second.remove(reused.id, { ifCreatedAt: reused.createdAt });
            return { firstCreated: original.createdNew, secondCreated: reused.createdNew,
                bookkeepingEnumerable: Object.keys(original).includes('createdNew'),
                staleRollback, retainedBytes: Array.from(retained.bytes), currentRemoval,
                afterRemoval: await first.read(original.id) };
        } finally { first.close(); second.close(); }
    });
    assert.equal(result.firstCreated, true);
    assert.equal(result.secondCreated, false);
    assert.equal(result.bookkeepingEnumerable, false);
    assert.equal(result.staleRollback, false);
    assert.deepEqual(result.retainedBytes, [1, 2, 3]);
    assert.equal(result.currentRemoval, true);
    assert.equal(result.afterRemoval, null);
});

test('bounds individual and aggregate bytes separately without changing existing installations', async () => {
    const result = await page.evaluate(async () => {
        const store = new PackageArchiveStore({ limits: { maxArchiveBytes: 6, maxTotalBytes: 9, maxArchives: 4 } });
        const first = await store.save({ filename: 'a.zip', bytes: new Uint8Array([1, 2, 3, 4, 5]) });
        const errors = [];
        for (const bytes of [new Uint8Array(7), new Uint8Array([9, 8, 7, 6, 5])]) {
            try { await store.save({ filename: 'b.zip', bytes }); } catch (e) { errors.push(e.code); }
        }
        const kept = await store.read(first.id);
        const list = await store.list(); store.close();
        return { errors, count: list.length, kept: Array.from(kept.bytes) };
    });
    assert.deepEqual(result.errors, ['ARCHIVE_TOO_LARGE', 'ARCHIVE_STORE_FULL']);
    assert.equal(result.count, 1);
    assert.deepEqual(result.kept, [1, 2, 3, 4, 5]);
});

test('concurrent instances serialize count and byte admission in IndexedDB', async () => {
    const result = await page.evaluate(async () => {
        const options = { limits: { maxArchiveBytes: 8, maxTotalBytes: 9, maxArchives: 1 } };
        const first = new PackageArchiveStore(options), second = new PackageArchiveStore(options);
        const outcomes = await Promise.allSettled([
            first.save({ filename: 'a.zip', bytes: new Uint8Array([1, 1, 1, 1, 1]) }),
            second.save({ filename: 'b.zip', bytes: new Uint8Array([2, 2, 2, 2, 2]) }),
        ]);
        const result = { statuses: outcomes.map(x => x.status), errors: outcomes.filter(x => x.status === 'rejected').map(x => x.reason.code), count: (await first.list()).length };
        first.close(); second.close(); return result;
    });
    assert.deepEqual(result.statuses.sort(), ['fulfilled', 'rejected']);
    assert.deepEqual(result.errors, ['ARCHIVE_STORE_FULL']);
    assert.equal(result.count, 1);
});

test('invalid names, paths, empty payloads and invalid IDs cannot become retained records', async () => {
    const result = await page.evaluate(async () => {
        const store = new PackageArchiveStore();
        const errors = [];
        for (const filename of ['../bad.zip', '/bad.zip', 'C:bad.zip', 'sub\\bad.zip', 'bad.rar', 'bad.zip\n', 'bad\u202e.zip']) {
            try { await store.save({ filename, bytes: new Uint8Array([1]) }); } catch (e) { errors.push(e.code); }
        }
        try { await store.save({ filename: 'empty.zip', bytes: new Uint8Array() }); } catch (e) { errors.push(e.code); }
        try { await store.save({ name: '', filename: 'name.zip', bytes: new Uint8Array([1]) }); } catch (e) { errors.push(e.code); }
        try { await store.read('../escape'); } catch (e) { errors.push(e.code); }
        try { await store.remove('A'.repeat(64)); } catch (e) { errors.push(e.code); }
        const count = (await store.list()).length; store.close(); return { errors, count };
    });
    assert.equal(result.errors.length, 11);
    assert(result.errors.every(code => code === 'ARCHIVE_CORRUPT'));
    assert.equal(result.count, 0);
});

test('payload corruption and schema tampering are rejected before remounting', async () => {
    const result = await page.evaluate(async () => {
        const store = new PackageArchiveStore();
        const saved = await store.save({ filename: 'fixture.zip', bytes: new Uint8Array([1, 2, 3]) });
        const mutate = callback => new Promise((resolve, reject) => {
            const tx = store._db.transaction(['metadata', 'archives'], 'readwrite');
            callback(tx); tx.oncomplete = resolve; tx.onabort = () => reject(tx.error);
        });
        await mutate(tx => tx.objectStore('archives').put({ id: saved.id, bytes: new Uint8Array([3, 2, 1]) }));
        let digestError;
        try { await store.read(saved.id); } catch (e) { digestError = e.code; }
        // A fresh explicit save may repair the payload from validated original bytes.
        await store.save({ filename: 'fixture.zip', bytes: new Uint8Array([1, 2, 3]) });
        await mutate(tx => tx.objectStore('metadata').put({ ...saved, filename: '../unsafe.zip' }));
        let metadataError, listError;
        try { await store.read(saved.id); } catch (e) { metadataError = e.code; }
        try { await store.list(); } catch (e) { listError = e.code; }
        store.close(); return { digestError, metadataError, listError };
    });
    assert.deepEqual(result, { digestError: 'ARCHIVE_CORRUPT', metadataError: 'ARCHIVE_CORRUPT', listError: 'ARCHIVE_CORRUPT' });
});

test('missing payloads and orphan payload keys are not represented as healthy installations', async () => {
    const result = await page.evaluate(async () => {
        const store = new PackageArchiveStore();
        const saved = await store.save({ filename: 'fixture.zip', bytes: new Uint8Array([1]) });
        const tx = store._db.transaction('archives', 'readwrite'); tx.objectStore('archives').delete(saved.id);
        await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); });
        const errors = [];
        try { await store.read(saved.id); } catch (e) { errors.push(e.code); }
        try { await store.list(); } catch (e) { errors.push(e.code); }
        await store.remove(saved.id);
        const orphan = store._db.transaction('archives', 'readwrite');
        orphan.objectStore('archives').put({ id: 'a'.repeat(64), bytes: new Uint8Array([7]) });
        await new Promise((resolve, reject) => { orphan.oncomplete = resolve; orphan.onabort = () => reject(orphan.error); });
        try { await store.list(); } catch (e) { errors.push(e.code); }
        store.close(); return errors;
    });
    assert.deepEqual(result, ['ARCHIVE_CORRUPT', 'ARCHIVE_CORRUPT', 'ARCHIVE_CORRUPT']);
});

test('quota failure aborts the entire metadata/payload write and keeps prior records', async () => {
    const result = await page.evaluate(async () => {
        const store = new PackageArchiveStore();
        const first = await store.save({ filename: 'first.zip', bytes: new Uint8Array([1]) });
        const db = store._db;
        const originalTransaction = db.transaction.bind(db);
        db.transaction = (...args) => {
            const tx = originalTransaction(...args);
            if (args[1] === 'readwrite') {
                const originalStore = tx.objectStore.bind(tx);
                tx.objectStore = name => {
                    const objectStore = originalStore(name);
                    if (name === 'archives') objectStore.put = () => { throw new DOMException('fixture quota', 'QuotaExceededError'); };
                    return objectStore;
                };
            }
            return tx;
        };
        let error;
        try { await store.save({ filename: 'second.zip', bytes: new Uint8Array([2]) }); } catch (e) { error = e.code; }
        db.transaction = originalTransaction;
        const records = await store.list();
        const firstBytes = Array.from((await store.read(first.id)).bytes);
        store.close(); return { error, records, first, firstBytes };
    });
    assert.equal(result.error, 'ARCHIVE_STORE_FULL');
    assert.deepEqual(result.records, [result.first]);
    assert.deepEqual(result.firstBytes, [1]);
});

test('does not report success before transaction commit and rolls back an asynchronous abort', async () => {
    const result = await page.evaluate(async () => {
        const store = new PackageArchiveStore();
        await store.list();
        const db = store._db, originalTransaction = db.transaction.bind(db);
        db.transaction = (...args) => {
            const tx = originalTransaction(...args);
            if (args[1] === 'readwrite') {
                const originalStore = tx.objectStore.bind(tx);
                tx.objectStore = name => {
                    const objectStore = originalStore(name);
                    if (name === 'archives') {
                        const put = objectStore.put.bind(objectStore);
                        objectStore.put = value => {
                            const request = put(value);
                            request.addEventListener('success', () => tx.abort());
                            return request;
                        };
                    }
                    return objectStore;
                };
            }
            return tx;
        };
        let error;
        try { await store.save({ filename: 'aborted.zip', bytes: new Uint8Array([2]) }); } catch (e) { error = e.code; }
        db.transaction = originalTransaction;
        const records = await store.list(); store.close(); return { error, records };
    });
    assert.equal(result.error, 'STORE_UNAVAILABLE');
    assert.deepEqual(result.records, []);
});

test('unavailable, closed, blocked and missing-crypto storage fail explicitly without a session fallback', async () => {
    const result = await page.evaluate(async () => {
        const errors = [];
        for (const options of [{ indexedDB: null }, { indexedDB: { open() { throw new DOMException('denied', 'SecurityError'); } } }, { crypto: null }]) {
            try { await new PackageArchiveStore(options).save({ filename: 'test.zip', bytes: new Uint8Array([1]) }); } catch (e) { errors.push(e.code); }
        }
        let lateClosed = false;
        const request = {};
        const blocked = new PackageArchiveStore({ indexedDB: { open() { queueMicrotask(() => request.onblocked()); return request; } } });
        try { await blocked.list(); } catch (e) { errors.push(e.code); }
        request.result = { close() { lateClosed = true; } };
        request.onsuccess();
        const store = new PackageArchiveStore();
        await store.list(); store._db.close();
        try { await store.list(); } catch (e) { errors.push(e.code); }
        const reopened = await store.list(); store.close();
        return { errors, lateClosed, reopened };
    });
    assert.deepEqual(result.errors, Array(5).fill('STORE_UNAVAILABLE'));
    assert.equal(result.lateClosed, true);
    assert.deepEqual(result.reopened, []);
});
