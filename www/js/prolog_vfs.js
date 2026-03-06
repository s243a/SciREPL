/**
 * prolog_vfs.js — Virtual Filesystem wrapper for swipl-wasm.
 * Wraps the Emscripten FS API to provide file mounting, directory
 * management, and search path configuration for the Prolog kernel.
 */

class PrologVFS {
    /**
     * @param {Object} swipl — The swipl-wasm instance (has .FS and .prolog)
     */
    constructor(swipl) {
        this._swipl = swipl;
        this._FS = swipl.FS;
        this._prolog = swipl.prolog;
        this._mountedFiles = []; // Track {path, size} for UI
        this._sharedDirty = new Set(); // Paths written by other kernels

        // Ensure base mount point exists
        this._ensureDir('/user');

        // Subscribe to SharedVFS events from other kernels
        if (window.sharedVFS) {
            window.sharedVFS.on('write', ({ path, origin }) => {
                if (origin !== 'prolog') {
                    this._sharedDirty.add(path);
                }
            });
        }
    }

    /**
     * Check if a path is under a shared prefix.
     */
    _isSharedPath(path) {
        return path === '/tmp' || path.startsWith('/tmp/') ||
               path === '/shared' || path.startsWith('/shared/') ||
               path === '/education' || path.startsWith('/education/') ||
               path.startsWith('/user/education/');
    }

    /**
     * Sync a file from SharedVFS into Emscripten FS (for cross-kernel reads).
     */
    _syncFromShared(path) {
        if (!window.sharedVFS || !this._sharedDirty.has(path)) return false;
        const content = window.sharedVFS.vfs_read_file(path);
        if (content) {
            const dir = path.substring(0, path.lastIndexOf('/'));
            if (dir) this._ensureDir(dir);
            this._FS.writeFile(path, content);
            this._sharedDirty.delete(path);
            return true;
        }
        return false;
    }

    // ---- Filesystem operations ----

    writeFile(path, content) {
        // Ensure parent directory exists
        const dir = path.substring(0, path.lastIndexOf('/'));
        if (dir) this._ensureDir(dir);

        if (typeof content === 'string') {
            this._FS.writeFile(path, content);
        } else {
            // ArrayBuffer or Uint8Array
            this._FS.writeFile(path, new Uint8Array(content));
        }

        // Track mounted file
        const size = typeof content === 'string' ? content.length : content.byteLength || content.length;
        const existing = this._mountedFiles.findIndex(f => f.path === path);
        if (existing >= 0) {
            this._mountedFiles[existing].size = size;
        } else {
            this._mountedFiles.push({ path, size });
        }

        // Mirror to SharedVFS for cross-kernel access
        if (this._isSharedPath(path) && window.sharedVFS) {
            window.sharedVFS.writeFile(path, content, 'prolog');
        }
    }

    readFile(path, encoding) {
        // Sync from SharedVFS if another kernel wrote this file
        if (this._isSharedPath(path)) {
            this._syncFromShared(path);
        }
        return this._FS.readFile(path, { encoding: encoding || 'utf8' });
    }

    mkdir(path) {
        try {
            this._FS.mkdir(path);
        } catch (e) {
            // EEXIST is fine
            if (!e.message || !e.message.includes('EEXIST')) {
                // Check if it's an errno-based error (code 20 = EEXIST in Emscripten)
                if (e.errno !== 20) throw e;
            }
        }
    }

    /**
     * Recursively create directories.
     */
    mkdirTree(path) {
        const parts = path.split('/').filter(Boolean);
        let current = '';
        for (const part of parts) {
            current += '/' + part;
            this.mkdir(current);
        }
    }

    _ensureDir(path) {
        // Fast path: check if directory already exists
        if (this._knownDirs && this._knownDirs.has(path)) return;
        this.mkdirTree(path);
        if (!this._knownDirs) this._knownDirs = new Set();
        this._knownDirs.add(path);
    }

    /**
     * Bulk write many files efficiently. Pre-creates all directories in one
     * pass to avoid redundant mkdirTree calls per file.
     * @param {Array<{path: string, content: string|Uint8Array}>} files
     */
    bulkWrite(files) {
        if (!files || files.length === 0) return;

        // Collect all unique parent directories
        const dirs = new Set();
        for (const f of files) {
            const dir = f.path.substring(0, f.path.lastIndexOf('/'));
            if (dir) dirs.add(dir);
        }

        // Sort by depth so parents are created before children
        const sortedDirs = [...dirs].sort((a, b) => a.length - b.length);

        // Create all directories
        const created = new Set();
        for (const dir of sortedDirs) {
            const parts = dir.split('/').filter(Boolean);
            let current = '';
            for (const part of parts) {
                current += '/' + part;
                if (created.has(current)) continue;
                this.mkdir(current);
                created.add(current);
            }
        }

        // Write all files (skip _ensureDir since dirs already exist)
        if (!this._knownDirs) this._knownDirs = new Set();
        for (const dir of created) this._knownDirs.add(dir);

        for (const f of files) {
            if (typeof f.content === 'string') {
                this._FS.writeFile(f.path, f.content);
            } else {
                this._FS.writeFile(f.path, new Uint8Array(f.content));
            }
            const size = typeof f.content === 'string' ? f.content.length : f.content.byteLength || f.content.length;
            const existing = this._mountedFiles.findIndex(m => m.path === f.path);
            if (existing >= 0) {
                this._mountedFiles[existing].size = size;
            } else {
                this._mountedFiles.push({ path: f.path, size });
            }
        }
    }

    exists(path) {
        try {
            this._FS.stat(path);
            return true;
        } catch (e) {
            // Check SharedVFS for files written by other kernels
            if (this._isSharedPath(path) && window.sharedVFS && window.sharedVFS.exists(path)) {
                return true;
            }
            return false;
        }
    }

    listDir(path) {
        try {
            return this._FS.readdir(path).filter(n => n !== '.' && n !== '..');
        } catch (e) {
            return [];
        }
    }

    stat(path) {
        try {
            const s = this._FS.stat(path);
            return { isDir: this._FS.isDir(s.mode), size: s.size || 0 };
        } catch (e) {
            return null;
        }
    }

    /**
     * Remove a file from VFS.
     */
    removeFile(path) {
        try {
            this._FS.unlink(path);
            this._mountedFiles = this._mountedFiles.filter(f => f.path !== path);
        } catch (e) {
            console.warn('VFS removeFile:', e.message);
        }
        // Also remove from SharedVFS
        if (this._isSharedPath(path) && window.sharedVFS) {
            window.sharedVFS.unlink(path);
        }
    }

    /**
     * Get list of all mounted files.
     */
    getMountedFiles() {
        return this._mountedFiles.slice();
    }

    // ---- Batch operations ----

    /**
     * Mount multiple files at once.
     * @param {Array<{name: string, content: string}>} files
     * @param {string} baseDir — default '/user'
     */
    mountFiles(files, baseDir) {
        baseDir = baseDir || '/user';
        this._ensureDir(baseDir);

        for (const file of files) {
            const path = baseDir + '/' + file.name;
            this.writeFile(path, file.content);
        }
    }

    /**
     * Extract a .zip archive and mount all entries into VFS.
     * Requires JSZip to be loaded globally.
     * @param {ArrayBuffer} zipBuffer
     * @param {string} baseDir — default '/user'
     * @returns {Promise<string[]>} — list of mounted file paths
     */
    async mountZip(zipBuffer, baseDir) {
        baseDir = baseDir || '/user';

        if (typeof JSZip === 'undefined') {
            throw new Error('JSZip not loaded. Cannot extract .zip archives.');
        }

        const zip = await JSZip.loadAsync(zipBuffer);
        const paths = [];

        for (const [relativePath, entry] of Object.entries(zip.files)) {
            if (entry.dir) {
                this._ensureDir(baseDir + '/' + relativePath);
                continue;
            }

            // Determine if binary or text
            const ext = relativePath.split('.').pop().toLowerCase();
            const textExts = ['pl', 'pro', 'P', 'txt', 'md', 'json', 'csv', 'py', 'js', 'html', 'css', 'xml'];
            const isText = textExts.includes(ext);

            const fullPath = baseDir + '/' + relativePath;

            if (isText) {
                const content = await entry.async('string');
                this.writeFile(fullPath, content);
            } else {
                const content = await entry.async('uint8array');
                this.writeFile(fullPath, content);
            }

            paths.push(fullPath);
        }

        return paths;
    }

    // ---- Search path management ----

    /**
     * Get current file_search_path/2 entries from Prolog.
     * Returns [{alias, dir}]
     */
    getSearchPaths() {
        const paths = [];
        try {
            const q = this._prolog.query('file_search_path(Alias, Dir).');
            try {
                let step = q.next();
                while (true) {
                    const val = step.value || step;
                    if (val && val.success !== false && val.Alias && val.Dir) {
                        // Only include user-defined paths (skip system ones like 'library')
                        const alias = String(val.Alias);
                        const dir = String(val.Dir);
                        if (dir.startsWith('/user') || alias === 'user') {
                            paths.push({ alias, dir });
                        }
                    }
                    if (step.done) break;
                    step = q.next();
                }
            } finally {
                if (q.close) q.close();
            }
        } catch (e) {
            console.warn('getSearchPaths error:', e);
        }
        return paths;
    }

    /**
     * Add a file_search_path entry.
     */
    addSearchPath(alias, dir) {
        this._ensureDir(dir);
        try {
            this._prolog.query(
                `assertz(file_search_path('${alias}', '${dir}')).`
            ).once();
        } catch (e) {
            console.warn('addSearchPath error:', e);
        }
    }

    /**
     * Remove a file_search_path entry.
     */
    removeSearchPath(alias, dir) {
        try {
            this._prolog.query(
                `retract(file_search_path('${alias}', '${dir}')).`
            ).once();
        } catch (e) {
            console.warn('removeSearchPath error:', e);
        }
    }

    // ---- Fetch from URL ----

    /**
     * Fetch a file from a URL and write it to VFS.
     * @param {string} url — Remote URL
     * @param {string} localPath — VFS path to write to (default: /user/<filename>)
     * @returns {Promise<string>} — The local path written
     */
    async fetchFile(url, localPath) {
        if (!localPath) {
            // Derive filename from URL
            const urlObj = new URL(url);
            const filename = urlObj.pathname.split('/').pop() || 'fetched.pl';
            localPath = '/user/' + filename;
        }

        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`Fetch failed: ${response.status} ${response.statusText}`);
        }

        const contentType = response.headers.get('content-type') || '';
        if (contentType.includes('text') || localPath.endsWith('.pl') || localPath.endsWith('.pro') || localPath.endsWith('.txt')) {
            const text = await response.text();
            this.writeFile(localPath, text);
        } else {
            const buffer = await response.arrayBuffer();
            this.writeFile(localPath, buffer);
        }

        return localPath;
    }

    /**
     * Get a recursive listing of VFS directory for display.
     * Returns [{path, type: 'file'|'dir', size}]
     */
    getTree(path, depth) {
        path = path || '/user';
        depth = depth || 0;
        const MAX_DEPTH = 5;
        const entries = [];

        if (depth > MAX_DEPTH) return entries;

        const items = this.listDir(path);
        for (const name of items) {
            const fullPath = path + '/' + name;
            try {
                const stat = this._FS.stat(fullPath);
                const isDir = this._FS.isDir(stat.mode);
                entries.push({
                    path: fullPath,
                    name: name,
                    type: isDir ? 'dir' : 'file',
                    size: isDir ? 0 : stat.size,
                    depth: depth
                });
                if (isDir) {
                    entries.push(...this.getTree(fullPath, depth + 1));
                }
            } catch (e) {
                // Skip inaccessible entries
            }
        }

        return entries;
    }
}
