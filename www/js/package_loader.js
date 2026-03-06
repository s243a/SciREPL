/**
 * package_loader.js — Loads SciREPL packages from archives.
 * A package is an archive (.zip, .tar.gz, .rar) containing:
 *   - scirepl.json manifest (optional)
 *   - .ipynb notebook files
 *   - Supporting files (.pl, .py, data, etc.)
 *
 * If no manifest is found, each .ipynb in the archive becomes a notebook.
 */

class PackageLoader {
    constructor() {
        this._manifestSchema = {
            required: ['format_version'],
            format_versions: ['1.0', '2.0']
        };
        this._binaryExts = new Set([
            'wasm', 'bin', 'dat', 'png', 'jpg', 'jpeg', 'gif', 'webp',
            'woff', 'woff2', 'ttf', 'otf', 'ico', 'bmp', 'tiff',
        ]);
    }

    /**
     * Check if a file path has a binary extension.
     */
    _isBinaryExt(path) {
        const ext = (path.split('.').pop() || '').toLowerCase();
        return this._binaryExts.has(ext);
    }

    /**
     * Load a package from a File object.
     * @param {File} file — archive file
     */
    async loadFromFile(file) {
        // Extract archive
        const fileMap = await ArchiveExtractors.extract(file);

        // Look for manifest
        const manifest = this._findManifest(fileMap);

        if (manifest) {
            return this._loadWithManifest(manifest, fileMap);
        } else {
            return this._loadWithoutManifest(fileMap, file.name);
        }
    }

    /**
     * Find and parse scirepl.json from the file map.
     * Handles archives where files may be inside a top-level directory.
     */
    _findManifest(fileMap) {
        // Direct path
        if (fileMap.has('scirepl.json')) {
            return this._parseManifest(fileMap.get('scirepl.json'));
        }

        // Check inside a top-level directory
        for (const [path, content] of fileMap) {
            const parts = path.split('/');
            if (parts.length === 2 && parts[1] === 'scirepl.json') {
                const parsed = this._parseManifest(content);
                if (parsed) {
                    parsed._baseDir = parts[0] + '/';
                }
                return parsed;
            }
        }

        return null;
    }

    /**
     * Parse and validate a manifest JSON string.
     */
    _parseManifest(content) {
        try {
            const data = typeof content === 'string' ? JSON.parse(content) : JSON.parse(new TextDecoder().decode(content));

            // Validate required fields
            if (!data.format_version) {
                console.warn('Invalid scirepl.json: missing format_version');
                return null;
            }

            if (!this._manifestSchema.format_versions.includes(data.format_version)) {
                console.warn('Unknown scirepl.json format_version:', data.format_version);
                // Continue anyway for forward compat
            }

            return data;
        } catch (e) {
            console.warn('Failed to parse scirepl.json:', e);
            return null;
        }
    }

    /**
     * Load package with a valid manifest.
     */
    async _loadWithManifest(manifest, fileMap) {
        const baseDir = manifest._baseDir || '';
        const nm = window.notebookManager;
        if (!nm) throw new Error('NotebookManager not available');

        // 1. Mount supporting files to VFS
        if (manifest.files && manifest.files.length > 0) {
            await this._mountFiles(manifest.files, fileMap, baseDir);
        }

        // 1b. Sync Python modules if the Python kernel is already initialized
        this._syncPythonModules();

        // 2. Add search paths
        if (manifest.search_paths && manifest.search_paths.length > 0) {
            this._addSearchPaths(manifest.search_paths);
        }

        // 2b. Load WASM modules
        if (manifest.wasm_modules && manifest.wasm_modules.length > 0) {
            await this._loadWasmModules(manifest.wasm_modules, fileMap, baseDir);
        }

        // 3. Create notebooks (if manifest has any)
        let notebooks = null;
        if (manifest.notebooks && manifest.notebooks.length > 0) {
            const resolvedFileMap = new Map();
            for (const [path, content] of fileMap) {
                const resolvedPath = path.startsWith(baseDir) ? path.substring(baseDir.length) : path;
                resolvedFileMap.set(resolvedPath, content);
            }

            notebooks = await nm.loadFromManifest(manifest, resolvedFileMap);

            // 4. Populate notebook cells (render cards but don't execute)
            if (notebooks && notebooks.length > 0) {
                const autoSwitch = localStorage.getItem('scirepl_auto_switch_workbook') !== '0';
                for (const nb of notebooks) {
                    if (nb.cells && nb.cells.length > 0) {
                        nm.switchTo(nb.id);
                        this._populateCells(nb);
                    }
                }
                if (autoSwitch) {
                    nm.switchTo(notebooks[0].id);
                }
            }
        }

        return {
            name: manifest.name || 'Package',
            notebooks: notebooks ? notebooks.length : 0,
            files: manifest.files ? manifest.files.length : 0,
            wasm_modules: manifest.wasm_modules ? manifest.wasm_modules.length : 0
        };
    }

    /**
     * Load package without a manifest — each .ipynb becomes a notebook.
     */
    async _loadWithoutManifest(fileMap, archiveName) {
        const nm = window.notebookManager;
        if (!nm) throw new Error('NotebookManager not available');

        // Find .ipynb files
        const ipynbFiles = [];
        const otherFiles = [];

        for (const [path, content] of fileMap) {
            if (path.endsWith('.ipynb')) {
                ipynbFiles.push({ path, content });
            } else {
                otherFiles.push({ path, content });
            }
        }

        if (ipynbFiles.length === 0) {
            // No notebooks — mount all files to VFS as a plain archive
            await this._mountRawFiles(fileMap);
            return {
                name: archiveName,
                notebooks: 0,
                files: fileMap.size
            };
        }

        // Mount non-notebook files to VFS
        if (otherFiles.length > 0) {
            await this._mountRawFiles(new Map(otherFiles.map(f => [f.path, f.content])));
        }

        // Create a notebook for each .ipynb
        const createdNotebooks = [];
        for (const ipynb of ipynbFiles) {
            const name = ipynb.path.split('/').pop().replace('.ipynb', '');
            const nb = nm.createNotebook({ name });

            try {
                const parsed = typeof ipynb.content === 'string'
                    ? JSON.parse(ipynb.content)
                    : JSON.parse(new TextDecoder().decode(ipynb.content));

                const cells = nm._extractCellsFromIpynb(parsed);
                nb.cells = cells.map((c, i) => ({ ...c, id: i + 1 }));
                nb.cellCounter = cells.length;
            } catch (e) {
                console.warn('Failed to parse:', ipynb.path, e);
            }

            createdNotebooks.push(nb);
        }

        // Switch to first and populate cells (render cards, don't execute)
        if (createdNotebooks.length > 0) {
            const autoSwitch = localStorage.getItem('scirepl_auto_switch_workbook') !== '0';
            for (const nb of createdNotebooks) {
                if (nb.cells && nb.cells.length > 0) {
                    nm.switchTo(nb.id);
                    this._populateCells(nb);
                }
            }
            if (autoSwitch) {
                nm.switchTo(createdNotebooks[0].id);
            }
        }

        return {
            name: archiveName,
            notebooks: createdNotebooks.length,
            files: otherFiles.length
        };
    }

    /**
     * Populate a notebook with cell cards (render markdown, show code)
     * without executing any code cells. User can run them manually.
     */
    _populateCells(nb) {
        const ai = window._appInternals;
        if (!ai) return;

        // Take the parsed cell definitions and clear window._cells
        // (switchTo already set window._cells = nb.cells, same ref)
        const cellDefs = [...nb.cells]; // copy before clearing
        window._cells.length = 0;

        for (const cellDef of cellDefs) {
            window._cellCounter++;
            const cellId = window._cellCounter;
            const language = cellDef.language || 'python';

            const inputCard = ai.createInputCard(cellDef.code, cellId, cellDef.type, language);

            const cell = {
                id: cellId,
                code: cellDef.code,
                type: cellDef.type,
                language: language,
                inputCard: inputCard,
                outputCard: null
            };

            // Render markdown cells immediately
            if (cellDef.type === 'markdown') {
                const outputCard = ai.createOutputCard(cellId, 'markdown');
                const body = outputCard.querySelector('.card-body');
                if (body) body.innerHTML = ai.renderMarkdown(cellDef.code);
                const pre = inputCard.querySelector('pre');
                if (pre) pre.style.display = 'none';
                cell.outputCard = outputCard;
            }

            window._cells.push(cell);
        }

        // Update notebook state
        nb.cellCounter = window._cellCounter;

        // Save via NotebookManager to preserve ALL tabs (not just active)
        const nm = window.notebookManager;
        if (nm && nm.saveState) {
            nm.saveState();
        } else if (ai.saveCellsToSession) {
            ai.saveCellsToSession();
        }
    }

    /**
     * Resolve content for a file spec, preserving binary data when appropriate.
     */
    _resolveContent(content, destPath, spec) {
        const isBinary = spec.binary || this._isBinaryExt(destPath);
        if (isBinary) {
            return (content instanceof Uint8Array) ? content : new TextEncoder().encode(content);
        }
        return (typeof content === 'string') ? content : new TextDecoder().decode(content);
    }

    /**
     * Mount manifest-specified files to VFS with target routing.
     * Supports targets: "shared", "prolog", "all" (default: "prolog").
     */
    async _mountFiles(fileSpecs, fileMap, baseDir) {
        const km = window.kernelManager;
        if (!km) return;

        const sharedBatch = [];
        const prologBatch = [];

        for (const spec of fileSpecs) {
            const srcPath = baseDir + spec.src;
            const destPath = spec.dest;
            const target = spec.target || 'prolog';

            const addFile = (dest, content) => {
                const resolved = this._resolveContent(content, dest, spec);
                // Auto-route: paths under /shared/ or /tmp/ always go to SharedVFS
                const isSharedPath = dest.startsWith('/shared/') || dest.startsWith('/tmp/');
                if (target === 'shared' || target === 'all' || isSharedPath) {
                    sharedBatch.push({ path: dest, content: resolved, origin: 'package' });
                }
                if (target === 'prolog' || target === 'all') {
                    // Prolog VFS needs text content
                    const textContent = (typeof resolved === 'string')
                        ? resolved
                        : new TextDecoder().decode(resolved);
                    prologBatch.push({ path: dest, content: textContent });
                }
            };

            if (spec.src.endsWith('/')) {
                for (const [path, content] of fileMap) {
                    if (path.startsWith(srcPath)) {
                        const relPath = path.substring(srcPath.length);
                        addFile(destPath + relPath, content);
                    }
                }
            } else {
                const content = fileMap.get(srcPath);
                if (content) {
                    addFile(destPath, content);
                }
            }
        }

        // Write to SharedVFS
        if (sharedBatch.length > 0 && window.sharedVFS) {
            console.log(`[PackageLoader] Mounting ${sharedBatch.length} files to SharedVFS...`);
            const t0 = performance.now();
            for (const entry of sharedBatch) {
                // Ensure parent directories exist
                const parts = entry.path.split('/');
                for (let i = 2; i < parts.length; i++) {
                    const dir = parts.slice(0, i).join('/');
                    if (dir) window.sharedVFS.mkdir(dir);
                }
                window.sharedVFS.writeFile(entry.path, entry.content, entry.origin);
            }
            console.log(`[PackageLoader] SharedVFS mount done in ${(performance.now() - t0).toFixed(0)}ms`);
        }

        // Write to Prolog VFS
        if (prologBatch.length > 0) {
            try {
                await km.ensureReady('prolog');
                const vfs = km.getKernel('prolog').getVFS();
                if (vfs) {
                    console.log(`[PackageLoader] Mounting ${prologBatch.length} files to Prolog VFS...`);
                    const t0 = performance.now();
                    vfs.bulkWrite(prologBatch);
                    console.log(`[PackageLoader] Prolog VFS mount done in ${(performance.now() - t0).toFixed(0)}ms`);
                }
            } catch (e) {
                console.warn('Could not mount to Prolog VFS:', e);
            }
        }
    }

    /**
     * Load WASM modules declared in the manifest.
     * Compiles, instantiates, and registers them at window.wasmModules[name].
     */
    async _loadWasmModules(modules, fileMap, baseDir) {
        if (!window.wasmModules) window.wasmModules = {};

        for (const mod of modules) {
            const wasmPath = baseDir + mod.file;
            const wasmBytes = fileMap.get(wasmPath);
            if (!wasmBytes) {
                console.warn('[PackageLoader] WASM module not found in archive:', wasmPath);
                continue;
            }

            // Ensure Uint8Array
            const bytes = (wasmBytes instanceof Uint8Array)
                ? wasmBytes
                : new TextEncoder().encode(wasmBytes);

            // Load optional JS wrapper for imports
            let imports = {};
            if (mod.js_wrapper) {
                const wrapperPath = baseDir + mod.js_wrapper;
                const wrapperCode = fileMap.get(wrapperPath);
                if (wrapperCode) {
                    const wrapperStr = (typeof wrapperCode === 'string')
                        ? wrapperCode
                        : new TextDecoder().decode(wrapperCode);
                    try {
                        const wrapperFn = new Function('return ' + wrapperStr);
                        imports = wrapperFn();
                    } catch (e) {
                        console.warn(`[PackageLoader] Failed to load JS wrapper for ${mod.name}:`, e);
                    }
                }
            }

            try {
                const compiled = await WebAssembly.compile(bytes);
                const instance = await WebAssembly.instantiate(compiled, imports);

                const entry = {
                    instance,
                    module: compiled,
                    exports: instance.exports,
                    name: mod.name,
                };

                // Add JSON FFI call helper
                if (mod.ffi === 'json') {
                    entry.call = this._makeJsonCaller(instance);
                }

                window.wasmModules[mod.name] = entry;

                // Also store bytes in SharedVFS for other kernels
                if (window.sharedVFS) {
                    window.sharedVFS.mkdir('/shared/lib/wasm');
                    window.sharedVFS.writeFile(
                        `/shared/lib/wasm/${mod.name}.wasm`, bytes, 'package'
                    );
                }

                console.log(`[PackageLoader] Loaded WASM module: ${mod.name}`,
                    `(${mod.exports ? mod.exports.length : '?'} declared exports)`);
            } catch (e) {
                console.error(`[PackageLoader] Failed to load WASM module ${mod.name}:`, e);
            }
        }
    }

    /**
     * Build a JSON FFI caller for a WASM module.
     * The module must export: alloc(len) -> ptr, dealloc(ptr, len), call(func_ptr, args_ptr) -> result_ptr
     * plus a `memory` export.
     */
    _makeJsonCaller(instance) {
        const { memory, alloc, dealloc, call } = instance.exports;

        if (!memory || !alloc || !dealloc || !call) {
            console.warn('[PackageLoader] WASM module missing required JSON FFI exports (memory, alloc, dealloc, call)');
            return null;
        }

        const encoder = new TextEncoder();
        const decoder = new TextDecoder();

        return function jsonCall(funcName, args) {
            // Encode function name as null-terminated string
            const funcBytes = encoder.encode(funcName + '\0');
            const funcPtr = alloc(funcBytes.length);
            new Uint8Array(memory.buffer, funcPtr, funcBytes.length).set(funcBytes);

            // Encode args as JSON null-terminated string
            const argsJson = JSON.stringify(args);
            const argsBytes = encoder.encode(argsJson + '\0');
            const argsPtr = alloc(argsBytes.length);
            new Uint8Array(memory.buffer, argsPtr, argsBytes.length).set(argsBytes);

            // Call the WASM function
            const resultPtr = call(funcPtr, argsPtr);

            // Read null-terminated result string
            const resultView = new Uint8Array(memory.buffer, resultPtr);
            let end = 0;
            while (resultView[end] !== 0 && end < 1024 * 1024) end++;
            const resultJson = decoder.decode(resultView.slice(0, end));

            // Cleanup
            dealloc(funcPtr, funcBytes.length);
            dealloc(argsPtr, argsBytes.length);
            dealloc(resultPtr, end + 1);

            return JSON.parse(resultJson);
        };
    }

    /**
     * Add search paths from manifest.
     */
    _addSearchPaths(paths) {
        const km = window.kernelManager;
        if (!km) return;
        const kernel = km.getKernel('prolog');
        if (!kernel || !kernel.getVFS) return;
        const vfs = kernel.getVFS();
        if (!vfs) return;

        for (const p of paths) {
            if (p.alias && p.dir) {
                vfs.addSearchPath(p.alias, p.dir);
            }
        }
    }

    /**
     * Mount raw files from archive to VFS (no manifest, uses bulk write).
     */
    async _mountRawFiles(fileMap) {
        const km = window.kernelManager;
        if (!km) return;

        try {
            await km.ensureReady('prolog');
        } catch (e) {
            console.warn('Could not init Prolog for VFS:', e);
            return;
        }

        const vfs = km.getKernel('prolog').getVFS();
        if (!vfs) return;

        const batch = [];
        for (const [path, content] of fileMap) {
            // Skip directories and hidden files
            if (path.endsWith('/') || path.startsWith('.') || path.includes('/.')) continue;
            const dest = '/user/' + path;
            const textContent = typeof content === 'string'
                ? content
                : new TextDecoder().decode(content);
            batch.push({ path: dest, content: textContent });
        }

        console.log(`[PackageLoader] Raw mounting ${batch.length} files to VFS...`);
        const t0 = performance.now();
        vfs.bulkWrite(batch);
        console.log(`[PackageLoader] VFS mount done in ${(performance.now() - t0).toFixed(0)}ms`);
    }

    /**
     * If the Python kernel is already initialized, sync .py files from
     * SharedVFS /shared/lib/python/ into Pyodide's FS.
     */
    _syncPythonModules() {
        const km = window.kernelManager;
        if (!km) return;
        const pyKernel = km.getKernel('python');
        if (!pyKernel || !pyKernel.isReady || !pyKernel.isReady()) return;
        if (pyKernel._syncSharedPythonModules) {
            pyKernel._syncSharedPythonModules();
        }
    }
}

// Export singleton
window.packageLoader = new PackageLoader();
