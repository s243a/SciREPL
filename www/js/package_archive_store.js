/**
 * Original package archives retained only by an explicit persistent install.
 * This store never fetches URLs or silently evicts another installed package.
 * Notebook code shares this origin: a digest detects damaged records, not a
 * signature or a claim that same-origin code cannot change the store.
 */
(function (root) {
    'use strict';

    const LIMITS = Object.freeze({ maxArchiveBytes: 32 * 1024 * 1024,
        maxTotalBytes: 96 * 1024 * 1024, maxArchives: 32 });
    const ID = /^[a-f0-9]{64}$/;
    const META_KEYS = ['createdAt', 'filename', 'id', 'name', 'sha256', 'size'];
    const unsafeText = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;
    const invalidUnicode = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

    function failure(code) {
        const messages = {
            STORE_UNAVAILABLE: 'Persistent package storage is unavailable. Nothing was installed for this session instead.',
            ARCHIVE_TOO_LARGE: 'This package archive is too large to keep on this device.',
            ARCHIVE_STORE_FULL: 'Persistent package storage is full. Remove a saved package before installing another.',
            ARCHIVE_CORRUPT: 'The saved package archive is invalid or damaged.',
        };
        return Object.assign(new Error(messages[code]), { code });
    }

    function storageFailure(error) {
        if (error?.code && ['STORE_UNAVAILABLE', 'ARCHIVE_TOO_LARGE', 'ARCHIVE_STORE_FULL', 'ARCHIVE_CORRUPT'].includes(error.code)) return error;
        return failure(error?.name === 'QuotaExceededError' ? 'ARCHIVE_STORE_FULL' : 'STORE_UNAVAILABLE');
    }

    function text(value, max) {
        if (typeof value !== 'string' || !value.trim() || value.length > max
            || unsafeText.test(value) || invalidUnicode.test(value)) throw failure('ARCHIVE_CORRUPT');
        return value;
    }

    function filename(value) {
        text(value, 240);
        if (value !== value.trim() || /[\\/:]/.test(value) || value === '.' || value === '..'
            || !/\.(?:zip|tar\.gz|tgz)$/i.test(value)) throw failure('ARCHIVE_CORRUPT');
        return value;
    }

    class PackageArchiveStore {
        constructor(options = {}) {
            this._indexedDB = options.indexedDB === undefined ? root.indexedDB : options.indexedDB;
            this._crypto = options.crypto === undefined ? root.crypto : options.crypto;
            this._dbName = options.dbName || 'scirepl_package_archives';
            this._openTimeoutMs = options.openTimeoutMs || 5000;
            this._db = null;
            this._opening = null;
            this.limits = Object.freeze(Object.fromEntries(Object.entries(LIMITS).map(([key, maximum]) => {
                const value = options.limits?.[key] ?? maximum;
                if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) throw failure('ARCHIVE_CORRUPT');
                return [key, value];
            })));
        }

        _metadata(record) {
            if (!record || typeof record !== 'object'
                || Object.keys(record).sort().join(',') !== META_KEYS.join(',')
                || !ID.test(record.id) || record.sha256 !== record.id
                || !Number.isSafeInteger(record.size) || record.size <= 0 || record.size > this.limits.maxArchiveBytes
                || !Number.isSafeInteger(record.createdAt) || record.createdAt <= 0) throw failure('ARCHIVE_CORRUPT');
            return { id: record.id, sha256: record.sha256, name: text(record.name, 160), filename: filename(record.filename),
                size: record.size, createdAt: record.createdAt };
        }

        _bytes(input) {
            let bytes;
            if (input instanceof ArrayBuffer) bytes = new Uint8Array(input);
            else if (ArrayBuffer.isView(input) && input.BYTES_PER_ELEMENT === 1) bytes = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
            else throw failure('ARCHIVE_CORRUPT');
            if (bytes.length > this.limits.maxArchiveBytes) throw failure('ARCHIVE_TOO_LARGE');
            if (!bytes.length) throw failure('ARCHIVE_CORRUPT');
            // Snapshot the view, not its whole backing buffer, before hashing.
            return bytes.slice();
        }

        async _digest(bytes) {
            try {
                if (typeof this._crypto?.subtle?.digest !== 'function') throw failure('STORE_UNAVAILABLE');
                const hash = await this._crypto.subtle.digest('SHA-256', bytes);
                const digest = Array.from(new Uint8Array(hash), n => n.toString(16).padStart(2, '0')).join('');
                if (!ID.test(digest)) throw failure('STORE_UNAVAILABLE');
                return digest;
            } catch (error) { throw storageFailure(error); }
        }

        async _open() {
            if (this._db) return this._db;
            if (this._opening) return this._opening;
            this._opening = new Promise((resolve, reject) => {
                let settled = false;
                let request;
                const finish = (error, db) => {
                    if (settled) { db?.close(); return; }
                    settled = true;
                    clearTimeout(timer);
                    if (error) reject(storageFailure(error)); else resolve(db);
                };
                const timer = setTimeout(() => finish(failure('STORE_UNAVAILABLE')), this._openTimeoutMs);
                try {
                    if (typeof this._indexedDB?.open !== 'function') throw failure('STORE_UNAVAILABLE');
                    request = this._indexedDB.open(this._dbName, 1);
                } catch (error) { finish(error); return; }
                request.onupgradeneeded = () => {
                    try {
                        for (const name of ['metadata', 'archives']) {
                            if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name, { keyPath: 'id' });
                        }
                    } catch (error) { try { request.transaction.abort(); } catch (_) {} finish(error); }
                };
                request.onerror = () => finish(request.error);
                request.onblocked = () => finish(failure('STORE_UNAVAILABLE'));
                request.onsuccess = () => {
                    const db = request.result;
                    if (settled) { db.close(); return; }
                    if (!['metadata', 'archives'].every(name => db.objectStoreNames.contains(name))) {
                        db.close(); finish(failure('ARCHIVE_CORRUPT')); return;
                    }
                    db.onversionchange = () => { db.close(); if (this._db === db) this._db = null; };
                    this._db = db;
                    finish(null, db);
                };
            });
            try { return await this._opening; }
            finally { this._opening = null; }
        }

        async _transaction(mode, run) {
            const db = await this._open();
            return new Promise((resolve, reject) => {
                let tx;
                let result;
                let failed;
                const fail = error => {
                    failed ||= storageFailure(error);
                    try { tx.abort(); } catch (_) { reject(failed); }
                };
                try { tx = db.transaction(['metadata', 'archives'], mode); }
                catch (error) { if (this._db === db) this._db = null; reject(storageFailure(error)); return; }
                tx.oncomplete = () => failed ? reject(failed) : resolve(result);
                tx.onerror = event => { failed ||= storageFailure(event.target?.error || tx.error); };
                tx.onabort = () => reject(failed || storageFailure(tx.error));
                try { run(tx, value => { result = value; }, fail); }
                catch (error) { fail(error); }
            });
        }

        // Scan metadata and payload keys only; never deserialize all archives to
        // list installations or enforce capacity. One readwrite transaction
        // serializes admission against other instances/tabs without a JS lock.
        _catalog(tx, done, fail) {
            const records = [];
            let size = 0;
            const request = tx.objectStore('metadata').openCursor();
            request.onsuccess = () => {
                try {
                    const cursor = request.result;
                    if (cursor) {
                        const record = this._metadata(cursor.value);
                        if (cursor.primaryKey !== record.id) throw failure('ARCHIVE_CORRUPT');
                        records.push(record); size += record.size;
                        if (records.length > this.limits.maxArchives || size > this.limits.maxTotalBytes) throw failure('ARCHIVE_CORRUPT');
                        cursor.continue(); return;
                    }
                    const expected = new Set(records.map(record => record.id));
                    let count = 0;
                    const payloads = tx.objectStore('archives').openKeyCursor();
                    payloads.onsuccess = () => {
                        try {
                            const payload = payloads.result;
                            if (!payload) {
                                if (count !== records.length) throw failure('ARCHIVE_CORRUPT');
                                done(records, size); return;
                            }
                            if (!expected.has(payload.primaryKey) || ++count > this.limits.maxArchives) throw failure('ARCHIVE_CORRUPT');
                            payload.continue();
                        } catch (error) { fail(error); }
                    };
                } catch (error) { fail(error); }
            };
        }

        async save({ name, filename: archiveFilename, bytes: input } = {}) {
            const bytes = this._bytes(input);
            filename(archiveFilename);
            const displayName = text(name === undefined ? archiveFilename : name, 160);
            const id = await this._digest(bytes);
            const proposed = this._metadata({ id, sha256: id, name: displayName, filename: archiveFilename, size: bytes.length, createdAt: Date.now() });
            return this._transaction('readwrite', (tx, done, fail) => {
                this._catalog(tx, (records, size) => {
                    const existing = records.find(record => record.id === id);
                    if (existing && existing.size !== bytes.length) { fail(failure('ARCHIVE_CORRUPT')); return; }
                    if (!existing && (records.length >= this.limits.maxArchives || size + bytes.length > this.limits.maxTotalBytes)) {
                        fail(failure('ARCHIVE_STORE_FULL')); return;
                    }
                    // Retain the schema field name, but use it as the order of
                    // the last explicit install, including a deduplicated
                    // re-install. A wall-clock rollback or two installs in one
                    // millisecond must not reverse package precedence on restart.
                    const installedAt = Math.max(Date.now(), ...records.map(record => record.createdAt + 1));
                    const metadata = this._metadata({ ...(existing || proposed), createdAt: installedAt });
                    try {
                        tx.objectStore('metadata').put(metadata);
                        tx.objectStore('archives').put({ id, bytes });
                        const result = { ...metadata };
                        // Local operation bookkeeping, not persisted metadata.
                        // The admission transaction, not a preceding list(),
                        // determines whether a failed import owns this new copy.
                        Object.defineProperty(result, 'createdNew', { value: !existing, enumerable: false });
                        done(result);
                    } catch (error) { fail(error); }
                }, fail);
            });
        }

        async list() {
            return this._transaction('readonly', (tx, done, fail) => {
                this._catalog(tx, records => done(records.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))), fail);
            });
        }

        async read(id) {
            if (typeof id !== 'string' || !ID.test(id)) throw failure('ARCHIVE_CORRUPT');
            const pair = await this._transaction('readonly', (tx, done) => {
                const metadata = tx.objectStore('metadata').get(id);
                const archive = tx.objectStore('archives').get(id);
                let remaining = 2;
                const ready = () => { if (!--remaining) done({ metadata: metadata.result, archive: archive.result }); };
                metadata.onsuccess = ready; archive.onsuccess = ready;
            });
            if (pair.metadata === undefined && pair.archive === undefined) return null;
            const metadata = this._metadata(pair.metadata);
            if (metadata.id !== id || !pair.archive || pair.archive.id !== id
                || Object.keys(pair.archive).sort().join(',') !== 'bytes,id') throw failure('ARCHIVE_CORRUPT');
            let bytes;
            try { bytes = this._bytes(pair.archive.bytes); }
            catch (_) { throw failure('ARCHIVE_CORRUPT'); }
            if (bytes.length !== metadata.size || await this._digest(bytes) !== metadata.sha256) throw failure('ARCHIVE_CORRUPT');
            return { ...metadata, bytes };
        }

        async remove(id, { ifCreatedAt } = {}) {
            if (typeof id !== 'string' || !ID.test(id)) throw failure('ARCHIVE_CORRUPT');
            if (ifCreatedAt !== undefined && (!Number.isSafeInteger(ifCreatedAt) || ifCreatedAt <= 0)) throw failure('ARCHIVE_CORRUPT');
            return this._transaction('readwrite', (tx, done, fail) => {
                const found = tx.objectStore('metadata').get(id);
                found.onsuccess = () => {
                    try {
                        if (ifCreatedAt !== undefined) {
                            if (found.result === undefined) { done(false); return; }
                            const metadata = this._metadata(found.result);
                            if (metadata.id !== id) throw failure('ARCHIVE_CORRUPT');
                            // A different explicit install reused this digest
                            // after our save. Its retained copy is not ours to
                            // roll back, even when our own import later failed.
                            if (metadata.createdAt !== ifCreatedAt) { done(false); return; }
                        }
                        tx.objectStore('metadata').delete(id);
                        tx.objectStore('archives').delete(id);
                        done(found.result !== undefined);
                    } catch (error) { fail(error); }
                };
            });
        }

        close() { this._db?.close(); this._db = null; }
    }

    PackageArchiveStore.LIMITS = LIMITS;
    root.PackageArchiveStore = PackageArchiveStore;
})(typeof window === 'object' ? window : globalThis);
