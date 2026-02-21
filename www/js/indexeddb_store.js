/**
 * indexeddb_store.js — IndexedDB-backed storage for VFS files and search paths.
 *
 * Replaces localStorage for large data (Prolog VFS files from imported packages).
 * localStorage has a 5-10MB limit; IndexedDB supports 50MB+ per origin.
 */

class VFSStore {
    constructor() {
        this._db = null;
        this._dbName = 'scirepl_vfs';
        this._dbVersion = 1;
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

                // Store VFS files: keyed by path
                if (!db.objectStoreNames.contains('vfs_files')) {
                    db.createObjectStore('vfs_files', { keyPath: 'path' });
                }

                // Store search paths: keyed by alias
                if (!db.objectStoreNames.contains('search_paths')) {
                    db.createObjectStore('search_paths', { keyPath: 'alias' });
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
