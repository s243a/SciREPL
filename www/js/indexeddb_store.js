/**
 * indexeddb_store.js — IndexedDB-backed storage for VFS files and search paths.
 *
 * Primary persistent store for all user-generated files:
 * - Prolog VFS files and search paths (vfs_files, search_paths)
 * - SharedVFS files and directories (shared_files, shared_dirs)
 *
 * IndexedDB supports 50MB+ per origin and stores Uint8Array natively
 * via structured clone (no base64 encoding needed).
 */

class VFSStore {
    constructor() {
        this._db = null;
        this._dbName = 'scirepl_vfs';
        this._dbVersion = 2;
    }

    /**
     * Open (or create) the IndexedDB database.
     * Must be called before any other method.
     */
    async init() {
        if (this._db) return;

        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this._dbName, this._dbVersion);

            request.onupgradeneeded = (event) => {
                const db = event.target.result;

                // v1 stores: Prolog VFS files and search paths
                if (!db.objectStoreNames.contains('vfs_files')) {
                    db.createObjectStore('vfs_files', { keyPath: 'path' });
                }
                if (!db.objectStoreNames.contains('search_paths')) {
                    db.createObjectStore('search_paths', { keyPath: 'alias' });
                }

                // v2 stores: SharedVFS files and directories
                if (!db.objectStoreNames.contains('shared_files')) {
                    db.createObjectStore('shared_files', { keyPath: 'path' });
                }
                if (!db.objectStoreNames.contains('shared_dirs')) {
                    db.createObjectStore('shared_dirs', { keyPath: 'path' });
                }
            };

            request.onsuccess = (event) => {
                this._db = event.target.result;
                resolve();
            };

            request.onerror = (event) => {
                console.warn('[VFSStore] IndexedDB open failed:', event.target.error);
                reject(event.target.error);
            };
        });
    }

    /**
     * Check if the store is ready.
     */
    isReady() {
        return this._db !== null;
    }

    // ── Prolog VFS (vfs_files, search_paths) ──────────────────

    /**
     * Save an array of files to IndexedDB.
     * Each file: { path: string, content: string, origin?: string }
     * Replaces all existing files (clear + put).
     */
    async saveFiles(files) {
        if (!this._db) return;

        return new Promise((resolve, reject) => {
            const tx = this._db.transaction('vfs_files', 'readwrite');
            const store = tx.objectStore('vfs_files');

            // Clear existing files first
            store.clear();

            for (const file of files) {
                store.put({
                    path: file.path,
                    content: file.content,
                    origin: file.origin || 'unknown',
                    size: file.content ? file.content.length : 0
                });
            }

            tx.oncomplete = () => resolve();
            tx.onerror = (event) => {
                console.warn('[VFSStore] saveFiles failed:', event.target.error);
                reject(event.target.error);
            };
        });
    }

    /**
     * Load all stored VFS files.
     * Returns: [{ path, content, origin, size }, ...]
     */
    async loadFiles() {
        if (!this._db) return [];

        return new Promise((resolve, reject) => {
            const tx = this._db.transaction('vfs_files', 'readonly');
            const store = tx.objectStore('vfs_files');
            const request = store.getAll();

            request.onsuccess = () => resolve(request.result || []);
            request.onerror = (event) => {
                console.warn('[VFSStore] loadFiles failed:', event.target.error);
                reject(event.target.error);
            };
        });
    }

    /**
     * Clear all stored VFS files.
     */
    async clearFiles() {
        if (!this._db) return;

        return new Promise((resolve, reject) => {
            const tx = this._db.transaction('vfs_files', 'readwrite');
            const store = tx.objectStore('vfs_files');
            const request = store.clear();

            request.onsuccess = () => resolve();
            request.onerror = (event) => reject(event.target.error);
        });
    }

    /**
     * Save search paths to IndexedDB.
     * Each path: { alias: string, dir: string }
     * Replaces all existing paths.
     */
    async saveSearchPaths(paths) {
        if (!this._db) return;

        return new Promise((resolve, reject) => {
            const tx = this._db.transaction('search_paths', 'readwrite');
            const store = tx.objectStore('search_paths');

            store.clear();

            for (const p of paths) {
                if (p.alias && p.dir) {
                    store.put({ alias: p.alias, dir: p.dir });
                }
            }

            tx.oncomplete = () => resolve();
            tx.onerror = (event) => {
                console.warn('[VFSStore] saveSearchPaths failed:', event.target.error);
                reject(event.target.error);
            };
        });
    }

    /**
     * Load all stored search paths.
     * Returns: [{ alias, dir }, ...]
     */
    async loadSearchPaths() {
        if (!this._db) return [];

        return new Promise((resolve, reject) => {
            const tx = this._db.transaction('search_paths', 'readonly');
            const store = tx.objectStore('search_paths');
            const request = store.getAll();

            request.onsuccess = () => resolve(request.result || []);
            request.onerror = (event) => {
                console.warn('[VFSStore] loadSearchPaths failed:', event.target.error);
                reject(event.target.error);
            };
        });
    }

    // ── SharedVFS (shared_files, shared_dirs) ─────────────────

    /**
     * Bulk save all SharedVFS files and directories.
     * Replaces all existing data (clear + put).
     * Used at beforeunload for full flush.
     */
    async saveAllSharedFiles(files, dirs) {
        if (!this._db) return;

        return new Promise((resolve, reject) => {
            const tx = this._db.transaction(['shared_files', 'shared_dirs'], 'readwrite');
            const fileStore = tx.objectStore('shared_files');
            const dirStore = tx.objectStore('shared_dirs');

            fileStore.clear();
            dirStore.clear();

            for (const f of files) {
                fileStore.put({
                    path: f.path,
                    content: f.content,
                    origin: f.origin || 'unknown',
                    size: f.size || 0,
                    created: f.created || 0,
                    modified: f.modified || 0
                });
            }

            for (const d of dirs) {
                dirStore.put({ path: d });
            }

            tx.oncomplete = () => resolve();
            tx.onerror = (event) => {
                console.warn('[VFSStore] saveAllSharedFiles failed:', event.target.error);
                reject(event.target.error);
            };
        });
    }

    /**
     * Load all SharedVFS files from IndexedDB.
     * Returns: [{ path, content, origin, size, created, modified }, ...]
     */
    async loadSharedFiles() {
        if (!this._db) return [];

        return new Promise((resolve, reject) => {
            const tx = this._db.transaction('shared_files', 'readonly');
            const request = tx.objectStore('shared_files').getAll();

            request.onsuccess = () => resolve(request.result || []);
            request.onerror = (event) => {
                console.warn('[VFSStore] loadSharedFiles failed:', event.target.error);
                reject(event.target.error);
            };
        });
    }

    /**
     * Load all SharedVFS directories from IndexedDB.
     * Returns: string[]
     */
    async loadSharedDirs() {
        if (!this._db) return [];

        return new Promise((resolve, reject) => {
            const tx = this._db.transaction('shared_dirs', 'readonly');
            const request = tx.objectStore('shared_dirs').getAll();

            request.onsuccess = () => resolve((request.result || []).map(r => r.path));
            request.onerror = (event) => {
                console.warn('[VFSStore] loadSharedDirs failed:', event.target.error);
                reject(event.target.error);
            };
        });
    }

    /**
     * Write a single SharedVFS file (incremental update).
     */
    async putSharedFile(path, entry) {
        if (!this._db) return;

        return new Promise((resolve, reject) => {
            const tx = this._db.transaction('shared_files', 'readwrite');
            tx.objectStore('shared_files').put({
                path,
                content: entry.content,
                origin: entry.origin || 'unknown',
                size: entry.size || 0,
                created: entry.created || Date.now(),
                modified: entry.modified || Date.now()
            });
            tx.oncomplete = () => resolve();
            tx.onerror = (event) => reject(event.target.error);
        });
    }

    /**
     * Delete a single SharedVFS file (incremental update).
     */
    async deleteSharedFile(path) {
        if (!this._db) return;

        return new Promise((resolve, reject) => {
            const tx = this._db.transaction('shared_files', 'readwrite');
            tx.objectStore('shared_files').delete(path);
            tx.oncomplete = () => resolve();
            tx.onerror = (event) => reject(event.target.error);
        });
    }

    /**
     * Clear all SharedVFS data (files + dirs). Used by Clear History.
     */
    async clearSharedFiles() {
        if (!this._db) return;

        return new Promise((resolve, reject) => {
            const tx = this._db.transaction(['shared_files', 'shared_dirs'], 'readwrite');
            tx.objectStore('shared_files').clear();
            tx.objectStore('shared_dirs').clear();
            tx.oncomplete = () => resolve();
            tx.onerror = (event) => reject(event.target.error);
        });
    }

    // ── Utilities ─────────────────────────────────────────────

    /**
     * Get storage usage estimate (if available).
     * Returns: { usage: number, quota: number } or null.
     */
    async getStorageEstimate() {
        if (navigator.storage && navigator.storage.estimate) {
            return navigator.storage.estimate();
        }
        return null;
    }
}

// Initialize singleton early
window.vfsStore = new VFSStore();
window.vfsStore.init().catch(e => {
    console.warn('[VFSStore] Failed to initialize IndexedDB:', e);
});
