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
            required: ['format_version', 'notebooks'],
            format_versions: ['1.0']
        };
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
            if (!data.format_version || !data.notebooks) {
                console.warn('Invalid scirepl.json: missing required fields');
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

        // 2. Add search paths
        if (manifest.search_paths && manifest.search_paths.length > 0) {
            this._addSearchPaths(manifest.search_paths);
        }

        // 3. Create notebooks
        const resolvedFileMap = new Map();
        for (const [path, content] of fileMap) {
            // Resolve relative to base dir
            const resolvedPath = path.startsWith(baseDir) ? path.substring(baseDir.length) : path;
            resolvedFileMap.set(resolvedPath, content);
        }

        const notebooks = await nm.loadFromManifest(manifest, resolvedFileMap);

        // 4. Populate notebook cells (render cards but don't execute)
        if (notebooks && notebooks.length > 0) {
            for (const nb of notebooks) {
                if (nb.cells && nb.cells.length > 0) {
                    nm.switchTo(nb.id);
                    this._populateCells(nb);
                }
            }
            // Switch to first notebook
            nm.switchTo(notebooks[0].id);
        }

        return {
            name: manifest.name || 'Package',
            notebooks: notebooks ? notebooks.length : 0,
            files: manifest.files ? manifest.files.length : 0
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
            for (const nb of createdNotebooks) {
                if (nb.cells && nb.cells.length > 0) {
                    nm.switchTo(nb.id);
                    this._populateCells(nb);
                }
            }
            nm.switchTo(createdNotebooks[0].id);
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

        // Save
        if (ai.saveCellsToSession) ai.saveCellsToSession();
    }

    /**
     * Mount manifest-specified files to VFS (bulk for performance).
     */
    async _mountFiles(fileSpecs, fileMap, baseDir) {
        const km = window.kernelManager;
        if (!km) return;

        // Ensure Prolog kernel is ready for VFS
        try {
            await km.ensureReady('prolog');
        } catch (e) {
            console.warn('Could not init Prolog for VFS:', e);
            return;
        }

        const vfs = km.getKernel('prolog').getVFS();
        if (!vfs) return;

        // Collect all files into a batch
        const batch = [];

        for (const spec of fileSpecs) {
            const srcPath = baseDir + spec.src;
            const destPath = spec.dest;

            if (spec.src.endsWith('/')) {
                // Directory — collect all files under that prefix
                for (const [path, content] of fileMap) {
                    if (path.startsWith(srcPath)) {
                        const relPath = path.substring(srcPath.length);
                        const dest = destPath + relPath;
                        const textContent = typeof content === 'string'
                            ? content
                            : new TextDecoder().decode(content);
                        batch.push({ path: dest, content: textContent });
                    }
                }
            } else {
                // Single file
                const content = fileMap.get(srcPath);
                if (content) {
                    const textContent = typeof content === 'string'
                        ? content
                        : new TextDecoder().decode(content);
                    batch.push({ path: destPath, content: textContent });
                }
            }
        }

        console.log(`[PackageLoader] Mounting ${batch.length} files to VFS...`);
        const t0 = performance.now();
        vfs.bulkWrite(batch);
        console.log(`[PackageLoader] VFS mount done in ${(performance.now() - t0).toFixed(0)}ms`);
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
}

// Export singleton
window.packageLoader = new PackageLoader();
