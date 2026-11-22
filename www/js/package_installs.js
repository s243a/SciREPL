/* Android package choices and offline archive remounting. No download authority. */
(() => {
    'use strict';
    const android = () => window.Capacitor?.getPlatform?.() === 'android';
    const cancelled = () => Object.assign(new Error('Package installation cancelled.'), { code: 'INSTALL_CANCELLED' });
    class PackageInstalls {
        constructor(store) {
            this.store = store;
            this.savedIds = new Set();
            this.sessionIds = new Set();
            this.busy = false;
            this.restoring = false;
            this.operationPromise = null;
            this.restorePromise = null;
            // Prolog support is restored from archives, not generic kernel
            // snapshots. SharedVFS may still retain persistent-mode files for
            // Python-first startup; session mode must not leak through either
            // persistence system. Exact paths/pairs avoid claiming user files.
            this.managedSupportFiles = new Map();
            this.managedSupportSearchPaths = new Set();
        }
        identity(pkg) { return JSON.stringify([pkg?.id || null, pkg?.name || null]); }
        trackSupportFiles(paths, { persistent = false } = {}) {
            for (const path of paths || []) {
                if (typeof path === 'string') this.managedSupportFiles.set(path, persistent === true);
            }
        }
        trackSupportSearchPaths(paths) {
            for (const path of paths || []) {
                if (path && typeof path.alias === 'string' && typeof path.dir === 'string') {
                    this.managedSupportSearchPaths.add(JSON.stringify([path.alias, path.dir]));
                }
            }
        }
        isManagedPath(path) { return this.managedSupportFiles.has(path); }
        isSessionOnlyManagedPath(path) { return this.managedSupportFiles.get(path) === false; }
        isManagedSearchPath(alias, dir) {
            return this.managedSupportSearchPaths.has(JSON.stringify([alias, dir]));
        }
        async refresh() {
            const records = await this.store.list();
            this.savedIds = new Set(records.map(record => record.id));
            window.packageCatalog?._syncInstallButtons?.();
            return records;
        }
        isInstalled(pkg, remembered) {
            return this.sessionIds.has(this.identity(pkg)) || remembered.some(record => record
                && (record.id === pkg.id || record.name === pkg.name) && this.savedIds.has(record.archiveId));
        }
        async install(file, { name = file.name, pkg = null } = {}) {
            if (this.busy || this.restoring) throw cancelled(); // No queued installs behind a modal.
            this.busy = true;
            let releaseOperation;
            this.operationPromise = new Promise(resolve => { releaseOperation = resolve; });
            let record = null;
            try {
                const choice = await window.PackageInstallUI.choose({ name });
                if (!['persistent', 'session'].includes(choice)) throw cancelled();
                const prepared = await window.PackageArchiveValidation.prepare(file);
                if (choice === 'persistent') {
                    // Commit BEFORE import side effects. A full/unavailable store
                    // must not quietly turn a requested persistent install into a
                    // successful session-only one.
                    record = await this.store.save({ name: prepared.name, filename: prepared.filename, bytes: prepared.bytes });
                    this.savedIds.add(record.id);
                }
                const result = await window.packageLoader.loadPrepared(prepared, { persistent: choice === 'persistent' });
                // Await normal snapshots too. Package-owned Prolog paths must
                // not leak into the generic workspace cache, and persistent
                // SharedVFS support must be durable before Python-first startup.
                await window.sessionManager?.savePrologState?.();
                const sharedSaved = await window.sessionManager?.saveSharedState?.();
                const hasSharedSupport = prepared.manifest?.files?.some(spec => spec.target === 'shared' || spec.target === 'all'
                    || /^\/(?:shared|tmp|education)\//.test(spec.dest));
                if (choice === 'persistent' && hasSharedSupport && sharedSaved === false) {
                    throw Object.assign(new Error('Package snapshot could not be saved.'), { code: 'PACKAGE_SNAPSHOT_FAILED' });
                }
                if (pkg) {
                    if (record) pkg._localArchiveId = record.id;
                    else { delete pkg._localArchiveId; this.sessionIds.add(this.identity(pkg)); }
                }
                return { ...result, mode: choice, archiveId: record?.id || null };
            } catch (error) {
                if (record?.createdNew === true) {
                    // Never remove a previously installed deduplicated package.
                    try {
                        const removed = await this.store.remove(record.id, { ifCreatedAt: record.createdAt });
                        if (removed) this.savedIds.delete(record.id);
                    } catch (_) { /* retained valid bytes remain visible in Saved packages */ }
                }
                if (error.code !== 'INSTALL_CANCELLED') error.message = window.PackageInstallUI.message(error);
                throw error;
            } finally { this.busy = false; this.operationPromise = null; releaseOperation(); }
        }
        async restore() {
            if (this.operationPromise) { await this.operationPromise; return this.restore(); }
            if (this.restorePromise) return this.restorePromise;
            this.restoring = true;
            this.restorePromise = (async () => {
                const results = [];
                const failures = [];
                const restoredPaths = new Set();
                const records = await this.refresh();
                for (const metadata of records) {
                    try {
                        const record = await this.store.read(metadata.id);
                        if (!record) throw Object.assign(new Error('ARCHIVE_CORRUPT'), { code: 'ARCHIVE_CORRUPT' });
                        const file = new File([record.bytes], record.filename, { type: 'application/octet-stream' });
                        const prepared = await window.PackageArchiveValidation.prepare(file);
                        await window.packageLoader.remountPrepared(prepared, restoredPaths);
                        results.push({ id: record.id, restored: true });
                    } catch (error) {
                        this.savedIds.delete(metadata.id);
                        results.push({ id: metadata.id, restored: false });
                        // A corrupt retained archive must be visible, not silently
                        // fetched again or substituted with session state.
                        failures.push(metadata.name);
                    }
                }
                window.packageCatalog?._syncInstallButtons?.();
                if (failures.length) void window.PackageInstallUI.notify({ code: 'RESTORE_FAILED', names: failures.join(', ') });
                return results;
            })().catch(error => {
                this.restorePromise = null;
                throw error;
            }).finally(() => { this.restoring = false; });
            return this.restorePromise;
        }
        async manage() {
            if (this.busy || this.restoring) return;
            this.busy = true;
            let releaseOperation;
            this.operationPromise = new Promise(resolve => { releaseOperation = resolve; });
            try { await window.PackageInstallUI.manage(this.store); await this.refresh(); }
            catch (error) { await window.PackageInstallUI.notify(error); }
            finally { this.busy = false; this.operationPromise = null; releaseOperation(); }
        }
    }
    window.PackageInstalls = PackageInstalls;
    if (android()) {
        window.packageArchiveStore = new window.PackageArchiveStore();
        window.packageInstalls = new PackageInstalls(window.packageArchiveStore);
        // Open only the local store. No network, runtime init or archive mounting.
        window.packageInstalls.refresh().catch(() => {});
        const button = document.getElementById('catalog-manage-installed');
        if (button) {
            button.hidden = false;
            button.addEventListener('click', () => window.packageInstalls.manage());
        }
    }
})();
