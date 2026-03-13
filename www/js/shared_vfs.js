/**
 * shared_vfs.js — Shared Virtual Filesystem for SciREPL
 *
 * Provides a JS-level in-memory filesystem that multiple WASM kernels
 * (Prolog/swipl-wasm, Bash/brush-wasm) can share. Files under /tmp/
 * and /shared/ are accessible to all kernels with originship tracking.
 *
 * Loaded before kernel scripts via index.html.
 * Registered as window.sharedVFS.
 */

class SharedVFS {
    constructor() {
        /** @type {Map<string, {content: string|Uint8Array, origin: string, created: number, modified: number, size: number}>} */
        this._files = new Map();

        /** @type {Set<string>} */
        this._dirs = new Set([
            '/', '/tmp', '/shared', '/education', '/user', '/user/education',
            '/shared/lib', '/shared/lib/python', '/shared/lib/prolog', '/shared/lib/wasm',
            '/shared/bin', '/shared/data', '/shared/config', '/shared/notebooks',
            '/nb', '/workbook', '/local',
        ]);

        /** @type {Map<string, Set<Function>>} */
        this._listeners = new Map();
    }

    // ── Path helpers ────────────────────────────────────────────

    /**
     * Normalize a path: resolve `.` and `..`, ensure leading `/`.
     * For /nb/ paths, preserves `.` and `+N`/`-N` cell identifiers
     * (these are NotebookVFS addressing, not filesystem navigation).
     */
    _normalize(path) {
        if (!path.startsWith('/')) path = '/' + path;
        const parts = path.split('/');
        const resolved = [];
        // Detect /nb/ paths — cell ident is part index 2 (parts[0]='', parts[1]='nb', parts[2]=cellIdent)
        const isNb = parts.length >= 2 && parts[1] === 'nb';
        for (let i = 0; i < parts.length; i++) {
            const p = parts[i];
            if (p === '') continue;
            // In /nb/ paths, preserve the cell identifier (index 2) even if it's '.' or '+N'/'-N'
            if (isNb && i === 2) {
                resolved.push(p);
                continue;
            }
            if (p === '.') continue;
            if (p === '..') { resolved.pop(); continue; }
            resolved.push(p);
        }
        return '/' + resolved.join('/');
    }

    /**
     * Get the parent directory of a path.
     */
    _parentDir(path) {
        const idx = path.lastIndexOf('/');
        return idx <= 0 ? '/' : path.substring(0, idx);
    }

    /**
     * Check if a path is under a shared prefix.
     */
    isSharedPath(path) {
        const n = this._normalize(path);
        return n === '/tmp' || n.startsWith('/tmp/') ||
               n === '/shared' || n.startsWith('/shared/') ||
               n === '/education' || n.startsWith('/education/') ||
               n.startsWith('/user/education/') ||
               n === '/nb' || n.startsWith('/nb/') ||
               n === '/workbook' || n.startsWith('/workbook/') ||
               n === '/local' || n.startsWith('/local/');
    }

    /**
     * Check if a path should be delegated to NotebookVFS.
     */
    _isNbPath(path) {
        return path === '/nb' || path.startsWith('/nb/');
    }

    /**
     * Check if a path should be delegated to WorkbookVFS.
     */
    _isWorkbookPath(path) {
        return path === '/workbook' || path.startsWith('/workbook/');
    }

    /**
     * Check if a path should be delegated to LocalStorageVFS.
     */
    _isLocalPath(path) {
        return path === '/local' || path.startsWith('/local/');
    }

    // ── Core file operations ────────────────────────────────────

    /**
     * Write a file. Creates parent directories automatically.
     * @param {string} path
     * @param {string|Uint8Array} content
     * @param {string} origin - Kernel that wrote this file ('prolog', 'bash', 'python', 'user')
     */
    writeFile(path, content, origin = 'unknown') {
        path = this._normalize(path);

        // Delegate /nb/ paths to NotebookVFS
        if (this._isNbPath(path) && window.notebookVFS) {
            window.notebookVFS.writeFile(path, content);
            return;
        }
        if (this._isWorkbookPath(path) && window.workbookVFS) {
            window.workbookVFS.writeFile(path, content);
            return;
        }
        if (this._isLocalPath(path) && window.localStorageVFS) {
            window.localStorageVFS.writeFile(path, content);
            return;
        }

        this.mkdirTree(this._parentDir(path));

        const now = Date.now();
        const size = typeof content === 'string' ? content.length : content.byteLength;
        const existing = this._files.get(path);

        this._files.set(path, {
            content,
            origin,
            created: existing ? existing.created : now,
            modified: now,
            size
        });

        this._emit('write', { path, origin, size });
    }

    /**
     * Read a file.
     * @param {string} path
     * @param {string} [encoding] - 'utf8' for string, undefined for raw
     * @returns {string|Uint8Array|null}
     */
    readFile(path, encoding) {
        path = this._normalize(path);

        // Delegate /nb/ paths to NotebookVFS
        if (this._isNbPath(path) && window.notebookVFS) {
            return window.notebookVFS.readFile(path);
        }
        if (this._isWorkbookPath(path) && window.workbookVFS) {
            return window.workbookVFS.readFile(path);
        }
        if (this._isLocalPath(path) && window.localStorageVFS) {
            return window.localStorageVFS.readFile(path);
        }

        const entry = this._files.get(path);
        if (!entry) return null;

        if (encoding === 'utf8' && entry.content instanceof Uint8Array) {
            return new TextDecoder().decode(entry.content);
        }
        return entry.content;
    }

    /**
     * Check if a path exists (file or directory).
     */
    exists(path) {
        path = this._normalize(path);
        if (this._isNbPath(path) && window.notebookVFS) {
            return window.notebookVFS.exists(path);
        }
        if (this._isWorkbookPath(path) && window.workbookVFS) {
            return window.workbookVFS.exists(path);
        }
        if (this._isLocalPath(path) && window.localStorageVFS) {
            return window.localStorageVFS.exists(path);
        }
        return this._files.has(path) || this._dirs.has(path);
    }

    /**
     * Check if a path is a file.
     */
    isFile(path) {
        path = this._normalize(path);
        if (this._isNbPath(path) && window.notebookVFS) {
            const s = window.notebookVFS.stat(path);
            return s ? s.isFile : false;
        }
        if (this._isWorkbookPath(path) && window.workbookVFS) {
            const s = window.workbookVFS.stat(path);
            return s ? s.isFile : false;
        }
        if (this._isLocalPath(path) && window.localStorageVFS) {
            const s = window.localStorageVFS.stat(path);
            return s ? s.isFile : false;
        }
        return this._files.has(path);
    }

    /**
     * Check if a path is a directory.
     */
    isDir(path) {
        path = this._normalize(path);
        if (this._isNbPath(path) && window.notebookVFS) {
            const s = window.notebookVFS.stat(path);
            return s ? s.isDir : false;
        }
        if (this._isWorkbookPath(path) && window.workbookVFS) {
            const s = window.workbookVFS.stat(path);
            return s ? s.isDir : false;
        }
        if (this._isLocalPath(path) && window.localStorageVFS) {
            const s = window.localStorageVFS.stat(path);
            return s ? s.isDir : false;
        }
        return this._dirs.has(path);
    }

    /**
     * Delete a file. For /nb/ paths, deletes a cell.
     */
    unlink(path) {
        path = this._normalize(path);
        if (this._isNbPath(path) && window.notebookVFS) {
            const parsed = window.notebookVFS._parsePath(path);
            if (parsed.cellIdent && !parsed.property) {
                return window.notebookVFS.deleteCell(parsed.cellIdent);
            }
            return false;
        }
        const existed = this._files.delete(path);
        if (existed) {
            this._emit('delete', { path });
        }
        return existed;
    }

    /**
     * Create a directory (no error if exists).
     * For /nb/ paths, creates a new cell.
     */
    mkdir(path) {
        path = this._normalize(path);
        if (this._isNbPath(path) && window.notebookVFS) {
            // mkdir /nb/cell_name → create a new cell
            const parsed = window.notebookVFS._parsePath(path);
            if (parsed.cellIdent && !parsed.property) {
                window.notebookVFS.createCell(parsed.cellIdent);
            }
            return;
        }
        if (!this._dirs.has(path)) {
            this._dirs.add(path);
            this._emit('mkdir', { path });
        }
    }

    /**
     * Create a directory tree recursively.
     */
    mkdirTree(path) {
        path = this._normalize(path);
        const parts = path.split('/').filter(Boolean);
        let current = '';
        for (const part of parts) {
            current += '/' + part;
            if (!this._dirs.has(current)) {
                this._dirs.add(current);
            }
        }
    }

    /**
     * List directory contents (file and dir names, not full paths).
     */
    listDir(path) {
        path = this._normalize(path);
        if (this._isNbPath(path) && window.notebookVFS) {
            return window.notebookVFS.listDir(path) || [];
        }
        if (this._isWorkbookPath(path) && window.workbookVFS) {
            return window.workbookVFS.listDir(path) || [];
        }
        if (this._isLocalPath(path) && window.localStorageVFS) {
            return window.localStorageVFS.listDir(path) || [];
        }
        if (!path.endsWith('/')) path += '/';
        const entries = new Set();

        for (const filePath of this._files.keys()) {
            if (filePath.startsWith(path)) {
                const rest = filePath.substring(path.length);
                const name = rest.split('/')[0];
                if (name) entries.add(name);
            }
        }
        for (const dirPath of this._dirs) {
            if (dirPath.startsWith(path) && dirPath !== path.slice(0, -1)) {
                const rest = dirPath.substring(path.length);
                const name = rest.split('/')[0];
                if (name) entries.add(name);
            }
        }

        return Array.from(entries).sort();
    }

    /**
     * Get file/directory metadata.
     */
    stat(path) {
        path = this._normalize(path);
        if (this._isNbPath(path) && window.notebookVFS) {
            return window.notebookVFS.stat(path);
        }
        if (this._isWorkbookPath(path) && window.workbookVFS) {
            return window.workbookVFS.stat(path);
        }
        if (this._isLocalPath(path) && window.localStorageVFS) {
            return window.localStorageVFS.stat(path);
        }
        const entry = this._files.get(path);
        if (entry) {
            return {
                isDir: false,
                isFile: true,
                size: entry.size,
                origin: entry.origin,
                created: entry.created,
                modified: entry.modified
            };
        }
        if (this._dirs.has(path)) {
            return { isDir: true, isFile: false, size: 0, origin: null, created: 0, modified: 0 };
        }
        return null;
    }

    // ── Ownership queries ───────────────────────────────────────

    /**
     * Get the origin of a file.
     */
    getOrigin(path) {
        const entry = this._files.get(this._normalize(path));
        return entry ? entry.origin : null;
    }

    /**
     * Get all files owned by a specific kernel.
     */
    getFilesByOrigin(origin) {
        const result = [];
        for (const [path, entry] of this._files) {
            if (entry.origin === origin) {
                result.push({ path, size: entry.size, modified: entry.modified });
            }
        }
        return result;
    }

    // ── Rust bridge helpers ─────────────────────────────────────

    /**
     * Delegate a vfs_read_file to virtual mounts (/nb/, /workbook/, /local/).
     * Returns undefined if not a virtual path (caller should fall through).
     */
    _delegateVfsRead(path) {
        for (const [check, vfs] of [
            [this._isNbPath(path), window.notebookVFS],
            [this._isWorkbookPath(path), window.workbookVFS],
            [this._isLocalPath(path), window.localStorageVFS],
        ]) {
            if (check && vfs) {
                const content = vfs.readFile(path);
                if (content === null) return null;
                return typeof content === 'string' ? new TextEncoder().encode(content) : content;
            }
        }
        return undefined; // not a virtual path
    }

    // ── Rust bridge methods (called from wasm-bindgen) ──────────
    // These use snake_case to match Rust naming conventions.
    // wasm-bindgen imports reference window.sharedVFS.vfs_*

    /**
     * Read a file and return as Uint8Array (for Rust Vec<u8>).
     * Returns null if file doesn't exist.
     */
    vfs_read_file(path) {
        path = this._normalize(path);
        // Delegate to virtual mounts
        const vfsDelegate = this._delegateVfsRead(path);
        if (vfsDelegate !== undefined) return vfsDelegate;
        const entry = this._files.get(path);
        if (!entry) return null;

        if (entry.content instanceof Uint8Array) {
            return entry.content;
        }
        // Convert string to bytes
        return new TextEncoder().encode(entry.content);
    }

    /**
     * Write bytes from Rust to SharedVFS.
     * @param {string} path
     * @param {Uint8Array} content
     */
    vfs_write_file(path, content) {
        const normalized = this._normalize(path);
        if (this._isNbPath(normalized) && window.notebookVFS) {
            const copy = content instanceof Uint8Array ? new Uint8Array(content) : content;
            window.notebookVFS.writeFile(normalized, copy);
            return;
        }
        if (this._isWorkbookPath(normalized) && window.workbookVFS) {
            const copy = content instanceof Uint8Array ? new Uint8Array(content) : content;
            window.workbookVFS.writeFile(normalized, copy);
            return;
        }
        if (this._isLocalPath(normalized) && window.localStorageVFS) {
            window.localStorageVFS.writeFile(normalized, content);
            return;
        }
        // Copy the Uint8Array — wasm-bindgen passes a view into WASM linear
        // memory which becomes detached when the memory grows.
        const copy = content instanceof Uint8Array ? new Uint8Array(content) : content;
        this.writeFile(path, copy, 'bash');
    }

    /**
     * Check if a path exists (file or directory).
     */
    vfs_exists(path) {
        const normalized = this._normalize(path);
        if (this._isNbPath(normalized) && window.notebookVFS) {
            return window.notebookVFS.exists(normalized);
        }
        if (this._isWorkbookPath(normalized) && window.workbookVFS) {
            return window.workbookVFS.exists(normalized);
        }
        if (this._isLocalPath(normalized) && window.localStorageVFS) {
            return window.localStorageVFS.exists(normalized);
        }
        return this.exists(path);
    }

    /**
     * Create a directory. For /nb/ paths, creates a new cell.
     */
    vfs_mkdir(path) {
        const normalized = this._normalize(path);
        if (this._isNbPath(normalized) && window.notebookVFS) {
            const parsed = window.notebookVFS._parsePath(normalized);
            if (parsed.cellIdent && !parsed.property) {
                window.notebookVFS.createCell(parsed.cellIdent);
            }
            return;
        }
        this.mkdirTree(path);
    }

    /**
     * Read a chunk for large-file spill mode.
     * @param {string} path
     * @param {number} offset
     * @param {number} len
     * @returns {Uint8Array|null}
     */
    vfs_read_chunk(path, offset, len) {
        const data = this.vfs_read_file(path);
        if (!data) return null;
        return data.slice(offset, offset + len);
    }

    /**
     * Append a chunk to an existing file (for spill writes).
     */
    vfs_append_chunk(path, chunk) {
        path = this._normalize(path);
        const entry = this._files.get(path);
        if (!entry) {
            this.vfs_write_file(path, chunk);
            return;
        }

        const existing = entry.content instanceof Uint8Array
            ? entry.content
            : new TextEncoder().encode(entry.content);
        const combined = new Uint8Array(existing.length + chunk.length);
        combined.set(existing);
        combined.set(chunk, existing.length);

        entry.content = combined;
        entry.size = combined.length;
        entry.modified = Date.now();
    }

    /**
     * List directory contents for Rust (returns JSON string).
     * Format: [{"name":"foo","size":0,"is_dir":true,"modified":0}, ...]
     */
    vfs_list_dir(path) {
        path = this._normalize(path);
        if (this._isNbPath(path) && window.notebookVFS) {
            return window.notebookVFS.vfs_list_dir(path);
        }
        if (this._isWorkbookPath(path) && window.workbookVFS) {
            return window.workbookVFS.vfs_list_dir(path);
        }
        if (this._isLocalPath(path) && window.localStorageVFS) {
            return window.localStorageVFS.vfs_list_dir(path);
        }
        // Check if path is a known directory
        if (!path.endsWith('/')) path += '/';
        const isDir = this._dirs.has(path.slice(0, -1)) || path === '/';
        if (!isDir) return null;

        const entries = new Map();

        for (const [filePath, entry] of this._files) {
            if (filePath.startsWith(path)) {
                const rest = filePath.substring(path.length);
                const name = rest.split('/')[0];
                if (name && !entries.has(name)) {
                    // Check if this name is itself a directory
                    const childFull = path + name;
                    const childIsDir = this._dirs.has(childFull);
                    entries.set(name, {
                        name,
                        size: childIsDir ? 0 : (entry.size || 0),
                        is_dir: childIsDir,
                        modified: childIsDir ? 0 : (entry.modified || 0)
                    });
                }
            }
        }
        for (const dirPath of this._dirs) {
            if (dirPath.startsWith(path) && dirPath !== path.slice(0, -1)) {
                const rest = dirPath.substring(path.length);
                const name = rest.split('/')[0];
                if (name && !entries.has(name)) {
                    entries.set(name, { name, size: 0, is_dir: true, modified: 0 });
                }
            }
        }

        return JSON.stringify(Array.from(entries.values()));
    }

    /**
     * Remove a file or empty directory for Rust.
     * For /nb/ paths, deletes a cell.
     */
    vfs_remove(path) {
        path = this._normalize(path);
        if (this._isNbPath(path) && window.notebookVFS) {
            const parsed = window.notebookVFS._parsePath(path);
            if (parsed.cellIdent && !parsed.property) {
                return window.notebookVFS.deleteCell(parsed.cellIdent);
            }
            return false;
        }
        // Try to delete as file first
        if (this._files.has(path)) {
            return this.unlink(path);
        }
        // Try to delete as empty directory
        if (this._dirs.has(path)) {
            // Check if empty
            const prefix = path + '/';
            for (const f of this._files.keys()) {
                if (f.startsWith(prefix)) return false;
            }
            for (const d of this._dirs) {
                if (d.startsWith(prefix)) return false;
            }
            this._dirs.delete(path);
            return true;
        }
        return false;
    }

    /**
     * Get stat for Rust (returns JSON string).
     * Format: {"size":0,"is_dir":true,"modified":0}
     */
    vfs_stat(path) {
        const normalized = this._normalize(path);
        // Delegate to virtual mounts
        for (const [check, vfs] of [
            [this._isNbPath(normalized), window.notebookVFS],
            [this._isWorkbookPath(normalized), window.workbookVFS],
            [this._isLocalPath(normalized), window.localStorageVFS],
        ]) {
            if (check && vfs) {
                const info = vfs.stat(normalized);
                if (!info) return null;
                return JSON.stringify({
                    size: info.size || 0,
                    is_dir: info.isDir || false,
                    modified: info.modified || 0
                });
            }
        }
        const info = this.stat(path);
        if (!info) return null;
        return JSON.stringify({
            size: info.size || 0,
            is_dir: info.isDir || false,
            modified: info.modified || 0
        });
    }

    // ── Events ──────────────────────────────────────────────────

    /**
     * Subscribe to events: 'write', 'delete', 'mkdir'.
     */
    on(event, callback) {
        if (!this._listeners.has(event)) {
            this._listeners.set(event, new Set());
        }
        this._listeners.get(event).add(callback);
    }

    off(event, callback) {
        const set = this._listeners.get(event);
        if (set) set.delete(callback);
    }

    _emit(event, data) {
        const set = this._listeners.get(event);
        if (set) {
            for (const cb of set) {
                try { cb(data); } catch (e) { console.error('[SharedVFS] Event handler error:', e); }
            }
        }
    }

    // ── Persistence ─────────────────────────────────────────────

    /**
     * Snapshot the entire filesystem for persistence.
     * Returns a serializable object.
     */
    snapshot() {
        const files = [];
        for (const [path, entry] of this._files) {
            // Only snapshot string content (skip large binary)
            if (typeof entry.content === 'string') {
                files.push({
                    path,
                    content: entry.content,
                    origin: entry.origin
                });
            } else if (entry.content instanceof Uint8Array && entry.size < 512 * 1024) {
                // Small binary: base64 encode
                files.push({
                    path,
                    content: btoa(String.fromCharCode(...entry.content)),
                    origin: entry.origin,
                    binary: true
                });
            }
        }
        return { files, dirs: Array.from(this._dirs) };
    }

    /**
     * Restore from a snapshot.
     */
    restore(snap) {
        if (!snap) return;
        if (snap.dirs) {
            for (const d of snap.dirs) this._dirs.add(d);
        }
        if (snap.files) {
            for (const f of snap.files) {
                let content = f.content;
                if (f.binary) {
                    const binary = atob(content);
                    const bytes = new Uint8Array(binary.length);
                    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
                    content = bytes;
                }
                this.writeFile(f.path, content, f.origin || 'restored');
            }
        }
    }

    // ── IndexedDB persistence ────────────────────────────────

    /**
     * Save all SharedVFS data to IndexedDB.
     * Called at beforeunload (fire-and-forget) and periodically.
     */
    async saveToIndexedDB() {
        const store = window.vfsStore;
        if (!store || !store.isReady()) return false;

        const files = [];
        for (const [path, entry] of this._files) {
            files.push({
                path,
                content: entry.content,
                origin: entry.origin,
                size: entry.size,
                created: entry.created,
                modified: entry.modified
            });
        }
        const dirs = Array.from(this._dirs);

        await store.saveAllSharedFiles(files, dirs);
        if (files.length > 0) {
            console.log(`[SharedVFS] Saved ${files.length} files to IndexedDB`);
        }
        return true;
    }

    /**
     * Restore SharedVFS data from IndexedDB.
     * Called early during startup, before kernels initialize.
     */
    async restoreFromIndexedDB() {
        const store = window.vfsStore;
        if (!store || !store.isReady()) return false;

        const [files, dirs] = await Promise.all([
            store.loadSharedFiles(),
            store.loadSharedDirs()
        ]);

        // Always restore dirs (merge with defaults)
        for (const d of dirs) this._dirs.add(d);
        for (const f of files) {
            this._files.set(f.path, {
                content: f.content,
                origin: f.origin || 'restored',
                created: f.created || Date.now(),
                modified: f.modified || Date.now(),
                size: f.size || 0
            });
        }
        console.log(`[SharedVFS] Restored ${files.length} files, ${dirs.length} dirs from IndexedDB`);
        // Only count as successful if actual files were restored;
        // dirs alone are just defaults and shouldn't block localStorage migration
        return files.length > 0;
    }

    /**
     * Alias for unlink() — matches the interface expected by the
     * Files & Storage panel's delete button.
     */
    removeFile(path) {
        return this.unlink(path);
    }

    /**
     * Get a tree listing for debugging/display.
     */
    getTree(basePath = '/') {
        basePath = this._normalize(basePath);
        const result = [];

        const allPaths = new Set([...this._files.keys(), ...this._dirs]);
        const sorted = Array.from(allPaths).filter(p => p.startsWith(basePath)).sort();

        for (const p of sorted) {
            const entry = this._files.get(p);
            result.push({
                path: p,
                isDir: this._dirs.has(p),
                size: entry ? entry.size : 0,
                origin: entry ? entry.origin : null
            });
        }
        return result;
    }
}

// Register globally
window.sharedVFS = new SharedVFS();
console.log('[SharedVFS] Initialized — /tmp/, /shared/, and /education/ ready');
