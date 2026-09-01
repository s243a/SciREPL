/**
 * persistence.js — Handles saving/loading SciREPL state.
 */

class SessionManager {
    constructor() {
        this.STORAGE_KEY = 'scirepl_session_v2';
        this.STORAGE_KEY_V1 = 'scirepl_session_v1';
        this.session = this.load();
    }

    /**
     * Load session from localStorage, with v1 → v2 migration.
     */
    load() {
        try {
            // Try v2 first
            let raw = localStorage.getItem(this.STORAGE_KEY);
            if (raw) return JSON.parse(raw);

            // Migrate from v1
            raw = localStorage.getItem(this.STORAGE_KEY_V1);
            if (raw) {
                const v1 = JSON.parse(raw);
                const v2 = this.defaultSession();
                // Copy v1 fields
                v2.history = v1.history || [];
                v2.cellCounter = v1.cellCounter || 0;
                v2.cells = v1.cells || [];
                v2.darkMode = v1.darkMode;
                v2.prologPaths = v1.prologPaths || [];
                v2.prologFiles = v1.prologFiles || [];
                // Save as v2 and remove v1
                localStorage.setItem(this.STORAGE_KEY, JSON.stringify(v2));
                localStorage.removeItem(this.STORAGE_KEY_V1);
                console.log('Migrated session storage v1 → v2');
                return v2;
            }

            return this.defaultSession();
        } catch (e) {
            console.error('Failed to load session:', e);
            return this.defaultSession();
        }
    }

    defaultSession() {
        return {
            history: [],           // Command history
            historyIndex: -1,      // For up/down arrow navigation (runtime only)
            cellCounter: 0,        // Last cell index
            cells: [],             // Saved cells: [{code, type, language}]
            darkMode: true,        // Theme preference (future)
            prologPaths: [],       // Prolog search paths: [{alias, dir}]
            prologFiles: [],       // VFS file contents: [{path, content}] (for session restore)
            notebooks: [],         // Multi-notebook state: [{id, name, cells, ...}]
            activeNotebookId: null,// Currently active notebook ID
            notebookStateVersion: 0,// 1 = notebooks are authoritative even when active is empty
            notebookUIMode: 'auto',// 'auto' | 'dropdown' | 'sidebar' | 'tabs'
            sharedVFS: null,       // SharedVFS snapshot for cross-kernel file persistence
            sharedVFSDeletedPaths: [] // Tombstones when an awaited destructive flush fails
        };
    }

    /**
     * Save current session state.
     */
    save() {
        try {
            // Don't save transient runtime state like historyIndex
            const toSave = {
                history: this.session.history.slice(-100), // Keep last 100 commands
                cellCounter: this.session.cellCounter,
                cells: this.session.cells || [],
                darkMode: this.session.darkMode,
                // VFS data now stored in IndexedDB; keep empty arrays for backward compat
                prologPaths: this.session.prologPaths || [],
                prologFiles: this.session.prologFiles || [],
                notebooks: this.session.notebooks || [],
                activeNotebookId: this.session.activeNotebookId || null,
                notebookStateVersion: Number(this.session.notebookStateVersion) || 0,
                notebookUIMode: this.session.notebookUIMode || 'auto',
                sharedVFS: this.session.sharedVFS || null,
                sharedVFSDeletedPaths: Array.isArray(this.session.sharedVFSDeletedPaths)
                    ? this.session.sharedVFSDeletedPaths : []
            };
            localStorage.setItem(this.STORAGE_KEY, JSON.stringify(toSave));
        } catch (e) {
            console.error('Failed to save session:', e);
        }
    }

    /**
     * Add a command to history and save.
     */
    addToHistory(code) {
        if (!code) return;
        // Remove duplicates if same as last command
        if (this.session.history.length > 0 &&
            this.session.history[this.session.history.length - 1] === code) {
            return;
        }
        this.session.history.push(code);
        this.save();
    }

    /**
     * Save the current cells list (code + type + name, no DOM refs).
     */
    saveCells(cells) {
        this.session.cells = cells.map(c => ({
            code: c.code,
            type: c.type,
            language: c.language || 'python',
            name: c.name || ''
        }));
        this.save();
    }

    /**
     * Get saved cells for restoration.
     */
    getSavedCells() {
        return this.session.cells || [];
    }

    /**
     * Get executed command at index (allow negative for reverse indexing).
     */
    getHistory(index) {
        if (index < 0) index = this.session.history.length + index;
        if (index < 0 || index >= this.session.history.length) return null;
        return this.session.history[index];
    }

    /**
     * Save multi-notebook state.
     * @param {Array} notebooks - Serialized notebook objects
     * @param {string} activeId - ID of the active notebook
     */
    saveNotebooks(notebooks, activeId) {
        this.session.notebooks = notebooks || [];
        this.session.activeNotebookId = activeId || null;
        this.session.notebookStateVersion = 1;
        this.save();
    }

    /**
     * Get saved notebook state for restoration.
     */
    getSavedNotebooks() {
        return this.session.notebooks || [];
    }

    /**
     * Save Prolog search paths and VFS file contents for session restore.
     * Uses IndexedDB for large file storage (no size cap).
     * Called when cells are saved if Prolog kernel is active.
     */
    savePrologState() {
        const km = window.kernelManager;
        if (!km) return;
        const kernel = km.getKernel('prolog');
        if (!kernel || !kernel.getVFS) return;
        const vfs = kernel.getVFS();
        if (!vfs) return;

        const searchPaths = vfs.getSearchPaths();

        // Collect all user files (skip prelude.pl)
        const files = vfs.getMountedFiles();
        const savedFiles = [];
        for (const f of files) {
            if (f.path === '/user/prelude.pl') continue;
            try {
                const content = vfs.readFile(f.path);
                savedFiles.push({ path: f.path, content: content });
            } catch (e) {
                // Skip files that can't be read as text
            }
        }

        // Save to IndexedDB (fire-and-forget, async)
        const store = window.vfsStore;
        if (store && store.isReady()) {
            store.saveFiles(savedFiles).catch(e =>
                console.warn('[SessionManager] IndexedDB saveFiles failed:', e));
            store.saveSearchPaths(searchPaths).catch(e =>
                console.warn('[SessionManager] IndexedDB saveSearchPaths failed:', e));
            // Clear localStorage VFS data (migrated to IndexedDB)
            this.session.prologFiles = [];
            this.session.prologPaths = [];
            this.save();
        } else {
            // Fallback: save to localStorage with size cap
            const MAX_TOTAL = 5 * 1024 * 1024;
            let totalSize = 0;
            const capped = [];
            for (const f of savedFiles) {
                if (totalSize + (f.content ? f.content.length : 0) > MAX_TOTAL) break;
                capped.push(f);
                totalSize += f.content ? f.content.length : 0;
            }
            this.session.prologPaths = searchPaths;
            this.session.prologFiles = capped;
            this.save();
        }
    }

    /**
     * Save SharedVFS state for cross-kernel file persistence.
     * Uses IndexedDB as primary (no size limit), localStorage snapshot as fallback.
     */
    async saveSharedState({ deletedPaths = [] } = {}) {
        if (!window.sharedVFS) return false;
        const validDeletedPaths = (Array.isArray(deletedPaths) ? deletedPaths : [])
            .filter(path => typeof path === 'string'
                && /^\/shared\/notebooks\/[^/]+\.srwb$/.test(path));
        const rememberFallback = () => {
            this.session.sharedVFSDeletedPaths = [...new Set([
                ...(this.session.sharedVFSDeletedPaths || []),
                ...validDeletedPaths
            ])];
            // Tombstones are safety-critical and must survive even if an
            // unrelated file cannot be represented in the compact snapshot.
            try {
                this.session.sharedVFS = window.sharedVFS.snapshot();
            } catch (e) {
                console.warn('[SessionManager] SharedVFS fallback snapshot failed:', e);
            }
            this.save();
        };
        try {
            // Callers may ignore this Promise (for example beforeunload), but
            // destructive workbook operations await it so deleted synchronized
            // files cannot reappear after an immediate hard restart.
            const saved = await window.sharedVFS.saveToIndexedDB();
            if (saved) {
                // Clear fallback data only after the authoritative disk state
                // (including any requested deletions) has committed.
                if (this.session.sharedVFS
                    || (this.session.sharedVFSDeletedPaths || []).length > 0) {
                    this.session.sharedVFS = null;
                    this.session.sharedVFSDeletedPaths = [];
                    this.save();
                }
                return true;
            }
            // IndexedDB may not be ready yet. Preserve the same state in the
            // existing localStorage fallback rather than reporting success.
            rememberFallback();
            return false;
        } catch (e) {
            console.warn('[SessionManager] IndexedDB SharedVFS save failed, using localStorage:', e);
            try {
                rememberFallback();
            } catch (e2) {
                console.warn('Failed to save SharedVFS state:', e2);
            }
            return false;
        }
    }

    /**
     * Restore SharedVFS state from IndexedDB (primary) or localStorage (fallback).
     * Called early during startup, before kernels initialize.
     */
    async restoreSharedState() {
        if (!window.sharedVFS) return;

        const snap = this.session.sharedVFS;
        const deletedPaths = Array.isArray(this.session.sharedVFSDeletedPaths)
            ? this.session.sharedVFSDeletedPaths.filter(path => typeof path === 'string'
                && /^\/shared\/notebooks\/[^/]+\.srwb$/.test(path)) : [];
        const applyFallback = () => {
            if (snap) window.sharedVFS.restore(snap);
            // Snapshot restore is intentionally a merge so large binaries that
            // cannot fit in localStorage survive. Tombstones make destructive
            // changes authoritative without discarding those unrelated files.
            for (const path of deletedPaths) {
                try {
                    if (window.sharedVFS.exists(path)) window.sharedVFS.unlink(path);
                } catch (_) { }
            }
        };
        const clearPersistedFallback = () => {
            this.session.sharedVFS = null;
            this.session.sharedVFSDeletedPaths = [];
            this.save();
        };

        // Ensure vfsStore is ready
        const store = window.vfsStore;
        if (store && !store.isReady()) {
            try { await store.init(); } catch (e) {
                console.warn('[SessionManager] VFSStore init failed:', e);
            }
        }

        // Try IndexedDB first
        if (store && store.isReady()) {
            try {
                const restored = await window.sharedVFS.restoreFromIndexedDB();
                if (restored && !snap && deletedPaths.length === 0) {
                    return;
                }
                if (snap || deletedPaths.length > 0) {
                    console.log('[SessionManager] Applying localStorage SharedVFS fallback');
                    applyFallback();
                    const saved = await window.sharedVFS.saveToIndexedDB();
                    if (saved) clearPersistedFallback();
                    return;
                }
            } catch (e) {
                console.warn('[SessionManager] IndexedDB SharedVFS restore failed:', e);
            }
        }

        // Fallback: localStorage snapshot
        if (!snap && deletedPaths.length === 0) return;
        try {
            applyFallback();
            console.log('[SessionManager] Restored SharedVFS from localStorage');

            // Migrate to IndexedDB for next time
            if (store && store.isReady()) {
                window.sharedVFS.saveToIndexedDB().then((saved) => {
                    if (saved) {
                        clearPersistedFallback();
                        console.log('[SessionManager] Migrated SharedVFS to IndexedDB');
                    }
                }).catch(() => {});
            }
        } catch (e) {
            console.warn('Failed to restore SharedVFS state:', e);
        }
    }

    /**
     * Restore Prolog VFS state from IndexedDB (or localStorage fallback).
     * Called after Prolog kernel initializes. Returns a Promise.
     */
    async restorePrologState() {
        const km = window.kernelManager;
        if (!km) return;
        const kernel = km.getKernel('prolog');
        if (!kernel || !kernel.getVFS) return;
        const vfs = kernel.getVFS();
        if (!vfs) return;

        let files = [];
        let paths = [];

        // Try IndexedDB first
        const store = window.vfsStore;
        if (store && store.isReady()) {
            try {
                files = await store.loadFiles();
                paths = await store.loadSearchPaths();
            } catch (e) {
                console.warn('[SessionManager] IndexedDB load failed, trying localStorage:', e);
                files = [];
                paths = [];
            }
        }

        // Fall back to localStorage if IndexedDB had nothing
        if (files.length === 0) {
            files = this.session.prologFiles || [];
        }
        if (paths.length === 0) {
            paths = this.session.prologPaths || [];
        }

        // Restore files to VFS
        if (files.length > 0) {
            const batch = files.map(f => ({ path: f.path, content: f.content }));
            try {
                vfs.bulkWrite(batch);
                console.log(`[SessionManager] Restored ${files.length} VFS files`);
            } catch (e) {
                // Fallback: write one by one
                let restored = 0;
                for (const f of files) {
                    try {
                        vfs.writeFile(f.path, f.content);
                        restored++;
                    } catch (err) {
                        console.warn('Failed to restore VFS file:', f.path, err);
                    }
                }
                console.log(`[SessionManager] Restored ${restored}/${files.length} VFS files (fallback)`);
            }
        }

        // Restore search paths (skip default 'user' path which is already set)
        for (const p of paths) {
            if (p.alias === 'user' && p.dir === '/user') continue;
            vfs.addSearchPath(p.alias, p.dir);
        }

        if (paths.length > 0) {
            console.log(`[SessionManager] Restored ${paths.length} search paths`);
        }

        // Migrate: if we loaded from localStorage, push to IndexedDB for next time
        if (store && store.isReady() && (this.session.prologFiles || []).length > 0) {
            store.saveFiles(this.session.prologFiles).catch(() => {});
            store.saveSearchPaths(this.session.prologPaths || []).catch(() => {});
            this.session.prologFiles = [];
            this.session.prologPaths = [];
            this.save();
            console.log('[SessionManager] Migrated VFS data from localStorage to IndexedDB');
        }
    }
}

// Export singleton
window.sessionManager = new SessionManager();
