/**
 * file_io.js — Handles File Import/Export and Menu interactions.
 * Export format is Jupyter Notebook (.ipynb).
 */

class FileIO {
    constructor() {
        this.menuModal = document.getElementById('menu-modal');
        this.menuBtn = document.getElementById('menu-btn');
        this.fileInput = document.getElementById('file-input');

        this.init();
    }

    init() {
        // Toggle Menu
        this.menuBtn.addEventListener('click', () => {
            this.menuModal.classList.remove('hidden');
        });

        // Close Menu
        this.menuModal.addEventListener('click', (e) => {
            if (e.target === this.menuModal || e.target.classList.contains('modal-close')) {
                this.menuModal.classList.add('hidden');
            }
        });

        // Save Session (Local)
        document.getElementById('btn-save-session').addEventListener('click', () => {
            if (window.sessionManager) {
                window.sessionManager.saveCells(window._cells || []);
                alert('Session saved to local storage.');
                this.menuModal.classList.add('hidden');
            }
        });

        // Clear Session — two-click confirmation (no confirm() dependency)
        const clearBtn = document.getElementById('btn-clear-session');
        let clearPending = false;
        let clearTimer = null;
        clearBtn.addEventListener('click', async () => {
            if (!clearPending) {
                // First click: show confirmation state
                clearPending = true;
                clearBtn.textContent = '⚠ Click again to confirm clear';
                clearBtn.style.background = 'rgba(248, 81, 73, 0.2)';
                clearTimer = setTimeout(() => {
                    clearPending = false;
                    clearBtn.textContent = '🗑 Clear History';
                    clearBtn.style.background = '';
                }, 3000);
                return;
            }
            // Second click: actually clear
            clearTimeout(clearTimer);
            clearBtn.textContent = 'Clearing...';
            localStorage.removeItem('scirepl_session_v2');
            localStorage.removeItem('scirepl_session_v1');
            // Also clear IndexedDB (VFS files and search paths)
            if (window.vfsStore && window.vfsStore.isReady()) {
                try {
                    await window.vfsStore.clearFiles();
                    await window.vfsStore.saveSearchPaths([]);
                } catch (e) {
                    console.warn('Failed to clear IndexedDB:', e);
                }
            }
            location.reload();
        });

        // Run All Cells
        document.getElementById('btn-run-all').addEventListener('click', () => {
            this.menuModal.classList.add('hidden');
            if (window.runAllCells) window.runAllCells();
        });

        // Export .ipynb
        document.getElementById('btn-export-ipynb').addEventListener('click', async () => {
            this.menuModal.classList.add('hidden');
            await this.exportNotebook();
        });

        // Import
        document.getElementById('btn-import-file').addEventListener('click', () => {
            this.fileInput.click();
        });

        this.fileInput.addEventListener('change', (e) => {
            this.handleFileUpload(e.target.files[0]);
            this.fileInput.value = ''; // Reset
            this.menuModal.classList.add('hidden');
        });

        // Prolog Settings
        const prologSettingsBtn = document.getElementById('btn-prolog-settings');
        if (prologSettingsBtn) {
            prologSettingsBtn.addEventListener('click', () => {
                this.menuModal.classList.add('hidden');
                if (window.prologSettings) {
                    window.prologSettings.open();
                } else {
                    alert('Prolog settings not available. Load the Prolog kernel first.');
                }
            });
        }

        // New Notebook
        const newNotebookBtn = document.getElementById('btn-new-notebook');
        if (newNotebookBtn) {
            newNotebookBtn.addEventListener('click', () => {
                this.menuModal.classList.add('hidden');
                if (window.notebookManager) {
                    const nm = window.notebookManager;
                    const nb = nm.createNotebook({
                        name: 'Notebook ' + (nm.getNotebooks().length + 1)
                    });
                    nm.switchTo(nb.id);
                }
            });
        }

        // Export Package
        const exportPackageBtn = document.getElementById('btn-export-package');
        if (exportPackageBtn) {
            exportPackageBtn.addEventListener('click', async () => {
                this.menuModal.classList.add('hidden');
                await this.exportPackage();
            });
        }

        // Import Package
        this.packageInput = document.getElementById('package-input');
        const importPackageBtn = document.getElementById('btn-import-package');
        if (importPackageBtn && this.packageInput) {
            importPackageBtn.addEventListener('click', () => {
                this.packageInput.click();
            });
            this.packageInput.addEventListener('change', (e) => {
                this._handlePackageImport(e.target.files[0]);
                this.packageInput.value = '';
                this.menuModal.classList.add('hidden');
            });
        }
    }

    /**
     * Handle package archive import (.zip with scirepl.json, .tar.gz, .rar).
     * Delegates to PackageLoader when available.
     */
    async _handlePackageImport(file) {
        if (!file) return;
        if (window.packageLoader) {
            try {
                await window.packageLoader.loadFromFile(file);
            } catch (err) {
                alert('Package import failed: ' + err.message);
            }
        } else {
            alert('Package loading is not yet available.');
        }
    }

    /**
     * Export current cells as a Jupyter Notebook (.ipynb).
     */
    async exportNotebook() {
        const cells = window._cells || [];
        if (cells.length === 0) {
            alert('No cells to export.');
            return;
        }

        // Detect primary language from cells
        const langCounts = {};
        cells.forEach(c => {
            if (c.type === 'code') {
                const lang = c.language || 'python';
                langCounts[lang] = (langCounts[lang] || 0) + 1;
            }
        });
        const primaryLang = Object.keys(langCounts).sort((a, b) => langCounts[b] - langCounts[a])[0] || 'python';

        const nbCells = cells.map((cell, i) => {
            const source = cell.code.split('\n').map((line, j, arr) =>
                j < arr.length - 1 ? line + '\n' : line
            );
            const cellLang = cell.language || 'python';
            if (cell.type === 'markdown') {
                return {
                    cell_type: 'markdown',
                    metadata: {},
                    source: source
                };
            }
            const meta = {};
            // Tag cells with non-primary language
            if (cellLang !== primaryLang) {
                meta.scirepl_language = cellLang;
            }
            return {
                cell_type: 'code',
                execution_count: cell.id,
                metadata: meta,
                outputs: [],
                source: source
            };
        });

        const kernelMap = {
            python: { display_name: 'Python 3 (Pyodide)', language: 'python', name: 'python3' },
            prolog: { display_name: 'SWI-Prolog (WASM)', language: 'prolog', name: 'swipl' }
        };

        const langInfoMap = {
            python: { name: 'python', version: '3.12', mimetype: 'text/x-python', file_extension: '.py' },
            prolog: { name: 'prolog', version: '9.x', mimetype: 'text/x-prolog', file_extension: '.pl' }
        };

        const notebook = {
            nbformat: 4,
            nbformat_minor: 5,
            metadata: {
                kernelspec: kernelMap[primaryLang] || kernelMap.python,
                language_info: langInfoMap[primaryLang] || langInfoMap.python,
                scirepl: {
                    version: 'pro',
                    exported_at: new Date().toISOString(),
                    languages: Object.keys(langCounts),
                    prolog_paths: this._getExportPrologPaths()
                }
            },
            cells: nbCells
        };

        const json = JSON.stringify(notebook, null, 1);
        await this.downloadFile('scirepl_export.ipynb', json, 'application/json');
    }

    /**
     * Export all notebooks and VFS files as a .zip package with scirepl.json manifest.
     */
    async exportPackage() {
        if (typeof JSZip === 'undefined') {
            alert('JSZip not loaded.');
            return;
        }

        const nm = window.notebookManager;
        const notebooks = nm ? nm.getNotebooks() : [];

        if (notebooks.length === 0) {
            alert('No notebooks to export.');
            return;
        }

        const zip = new JSZip();

        // Build manifest (v2.0)
        const manifest = {
            format_version: '2.0',
            name: 'SciREPL Package',
            version: '1.0.0',
            description: 'Exported from SciREPL v0.5.0',
            notebooks: [],
            files: [],
            search_paths: []
        };

        // Export each notebook as .ipynb
        for (const nb of notebooks) {
            const cells = nb.isActive ? (window._cells || []) : nb.cells;
            const filename = (nb.name.replace(/[^a-zA-Z0-9_-]/g, '_') || 'notebook') + '.ipynb';

            const ipynb = this._buildIpynb(cells, nb.kernelLanguage);
            zip.file(filename, JSON.stringify(ipynb, null, 1));

            manifest.notebooks.push({
                file: filename,
                name: nb.name,
                description: nb.description || '',
                kernel: nb.kernelLanguage || undefined
            });
        }

        // Export Prolog VFS files (target: "prolog")
        const km = window.kernelManager;
        if (km) {
            const kernel = km.getKernel('prolog');
            if (kernel && kernel.getVFS) {
                const vfs = kernel.getVFS();
                if (vfs) {
                    const mountedFiles = vfs.getMountedFiles();
                    for (const f of mountedFiles) {
                        if (f.path === '/user/prelude.pl') continue;
                        try {
                            const content = vfs.readFile(f.path);
                            const archivePath = 'prolog' + f.path; // e.g. prolog/user/kb.pl
                            zip.file(archivePath, content);
                            manifest.files.push({
                                src: archivePath,
                                dest: f.path,
                                target: 'prolog'
                            });
                        } catch (e) {
                            // Skip unreadable files
                        }
                    }

                    // Export search paths
                    const paths = vfs.getSearchPaths();
                    for (const p of paths) {
                        if (p.alias === 'user' && p.dir === '/user') continue;
                        manifest.search_paths.push(p);
                    }
                }
            }
        }

        // Export SharedVFS files (target: "shared")
        const sharedVFS = window.sharedVFS;
        if (sharedVFS) {
            this._exportSharedDir(sharedVFS, '/shared/data', zip, manifest);
            this._exportSharedDir(sharedVFS, '/shared/lib', zip, manifest);
            this._exportSharedDir(sharedVFS, '/shared/config', zip, manifest);
            this._exportSharedDir(sharedVFS, '/shared/bin', zip, manifest);
        }

        // Add manifest
        zip.file('scirepl.json', JSON.stringify(manifest, null, 2));

        // Generate and download
        const blob = await zip.generateAsync({ type: 'blob' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'scirepl_package.zip';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    /**
     * Build an .ipynb structure from cell array.
     */
    _buildIpynb(cells, defaultKernel) {
        const langCounts = {};
        (cells || []).forEach(c => {
            if (c.type === 'code') {
                const lang = c.language || 'python';
                langCounts[lang] = (langCounts[lang] || 0) + 1;
            }
        });
        const primaryLang = defaultKernel
            || Object.keys(langCounts).sort((a, b) => langCounts[b] - langCounts[a])[0]
            || 'python';

        const kernelMap = {
            python: { display_name: 'Python 3 (Pyodide)', language: 'python', name: 'python3' },
            prolog: { display_name: 'SWI-Prolog (WASM)', language: 'prolog', name: 'swipl' }
        };
        const langInfoMap = {
            python: { name: 'python', version: '3.12', mimetype: 'text/x-python', file_extension: '.py' },
            prolog: { name: 'prolog', version: '9.x', mimetype: 'text/x-prolog', file_extension: '.pl' }
        };

        return {
            nbformat: 4,
            nbformat_minor: 5,
            metadata: {
                kernelspec: kernelMap[primaryLang] || kernelMap.python,
                language_info: langInfoMap[primaryLang] || langInfoMap.python,
                scirepl: { version: 'pro', exported_at: new Date().toISOString() }
            },
            cells: (cells || []).map(cell => {
                const source = cell.code.split('\n').map((line, j, arr) =>
                    j < arr.length - 1 ? line + '\n' : line
                );
                if (cell.type === 'markdown') {
                    return { cell_type: 'markdown', metadata: {}, source };
                }
                const meta = {};
                const cellLang = cell.language || 'python';
                if (cellLang !== primaryLang) meta.scirepl_language = cellLang;
                return { cell_type: 'code', execution_count: cell.id || null, metadata: meta, outputs: [], source };
            })
        };
    }

    async downloadFile(filename, content, mimeType) {
        mimeType = mimeType || 'text/plain';

        // Try Capacitor native plugins (Android/iOS)
        if (window.Capacitor && Capacitor.Plugins) {
            try {
                const { Filesystem } = Capacitor.Plugins;
                const { Share } = Capacitor.Plugins;

                if (Filesystem && Share) {
                    // Write file to cache directory as UTF-8 text
                    const writeResult = await Filesystem.writeFile({
                        path: filename,
                        data: content,
                        directory: 'CACHE',
                        encoding: 'utf8'
                    });

                    // Share the file
                    await Share.share({
                        title: filename,
                        url: writeResult.uri,
                        dialogTitle: 'Export ' + filename
                    });
                    return;
                }
            } catch (e) {
                console.warn('Capacitor share failed:', e);
                // Fall through to web fallback
            }
        }

        // Fallback: blob URL download (desktop browsers)
        const blob = new Blob([content], { type: mimeType });
        const url = URL.createObjectURL(blob);
        const element = document.createElement('a');
        element.href = url;
        element.download = filename;
        element.style.display = 'none';
        document.body.appendChild(element);
        element.click();
        document.body.removeChild(element);
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    /**
     * Recursively export files from a SharedVFS directory into the zip.
     */
    _exportSharedDir(vfs, dirPath, zip, manifest) {
        const entries = vfs.listDir(dirPath);
        if (!entries) return;

        for (const name of entries) {
            const fullPath = dirPath + '/' + name;
            const stat = vfs.stat(fullPath);
            if (!stat) continue;

            if (stat.isDir) {
                this._exportSharedDir(vfs, fullPath, zip, manifest);
            } else {
                const content = vfs.readFile(fullPath);
                if (content == null) continue;
                // Archive path mirrors the SharedVFS path (e.g. shared/data/file.csv)
                const archivePath = fullPath.substring(1); // strip leading /
                const isBinary = content instanceof Uint8Array;
                zip.file(archivePath, isBinary ? content : content, { binary: isBinary });
                manifest.files.push({
                    src: archivePath,
                    dest: fullPath,
                    target: 'shared',
                    ...(isBinary ? { binary: true } : {})
                });
            }
        }
    }

    /**
     * Get current Prolog search paths for export.
     */
    _getExportPrologPaths() {
        const km = window.kernelManager;
        if (!km) return [];
        const kernel = km.getKernel('prolog');
        if (!kernel || !kernel.getVFS) return [];
        const vfs = kernel.getVFS();
        if (!vfs) return [];
        return vfs.getSearchPaths();
    }

    /**
     * Apply Prolog search paths from imported notebook metadata.
     */
    _applyPrologPaths(paths) {
        if (!Array.isArray(paths) || paths.length === 0) return;
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

    handleFileUpload(file) {
        if (!file) return;

        // Handle .zip files — smart detection: package vs VFS
        if (file.name.endsWith('.zip')) {
            this._handleSmartZip(file);
            return;
        }

        // Handle .tar.gz / .rar — always treat as package
        if (file.name.endsWith('.tar.gz') || file.name.endsWith('.tgz') || file.name.endsWith('.rar')) {
            this._handlePackageImport(file);
            return;
        }

        const reader = new FileReader();
        reader.onload = (e) => {
            const content = e.target.result;
            if (file.name.endsWith('.ipynb')) {
                this.importIpynb(content);
            } else if (file.name.endsWith('.pl') || file.name.endsWith('.pro')) {
                this.importProlog(content);
            } else {
                // Assume .py or text
                this.importPython(content);
            }
        };
        reader.readAsText(file);
    }

    /**
     * Smart .zip handling: peek for scirepl.json or .ipynb files.
     * If found, treat as package. Otherwise mount to VFS.
     */
    async _handleSmartZip(file) {
        try {
            const buffer = await file.arrayBuffer();
            const zip = await JSZip.loadAsync(buffer);
            const entries = Object.keys(zip.files);

            // Check for manifest
            const hasManifest = entries.some(p =>
                p === 'scirepl.json' || p.match(/^[^/]+\/scirepl\.json$/)
            );

            // Check for .ipynb files
            const hasNotebooks = entries.some(p => p.endsWith('.ipynb'));

            if (hasManifest || hasNotebooks) {
                // Treat as package
                await this._handlePackageImport(file);
            } else {
                // Plain VFS mount
                await this._handleZipForVFS(file);
            }
        } catch (err) {
            // Fallback to VFS mount
            await this._handleZipForVFS(file);
        }
    }

    /**
     * Handle a .zip file by extracting it into the Prolog VFS.
     */
    async _handleZipForVFS(file) {
        const km = window.kernelManager;
        if (!km) {
            alert('Kernel manager not loaded.');
            return;
        }

        // Ensure Prolog kernel is available
        const kernel = km.getKernel('prolog');
        if (!kernel || !kernel.getVFS || !kernel.getVFS()) {
            // Try to init Prolog first
            try {
                await km.ensureReady('prolog');
            } catch (err) {
                alert('Failed to load Prolog kernel: ' + err.message);
                return;
            }
        }

        const vfs = km.getKernel('prolog').getVFS();
        if (!vfs) {
            alert('Prolog VFS not available.');
            return;
        }

        try {
            const buffer = await file.arrayBuffer();
            const paths = await vfs.mountZip(buffer);
            alert('Extracted ' + paths.length + ' files from ' + file.name + ' into /user/');
        } catch (err) {
            alert('ZIP extraction failed: ' + err.message);
        }
    }

    /**
     * Import a .py file — put content into the input bar for the user to run.
     */
    importPython(content) {
        const input = document.getElementById('code-input');
        input.value = content;
        input.dispatchEvent(new Event('input', { bubbles: true }));
    }

    /**
     * Import a .pl file — create a single Prolog cell with the content.
     */
    importProlog(content) {
        if (window.importCells) {
            window.importCells([{ code: content, type: 'code', language: 'prolog' }]);
        } else {
            const input = document.getElementById('code-input');
            input.value = content;
            input.dispatchEvent(new Event('input', { bubbles: true }));
        }
    }

    /**
     * Import a .ipynb file — create cells and execute them.
     * If window.importCells is available (set by app.js), uses it to
     * create proper cells. Otherwise falls back to textarea.
     */
    importIpynb(jsonContent) {
        try {
            const nb = JSON.parse(jsonContent);
            const extractedCells = [];

            // Detect notebook-level language from kernelspec
            let notebookLang = 'python';
            if (nb.metadata && nb.metadata.kernelspec) {
                const ks = nb.metadata.kernelspec;
                if (ks.language === 'prolog' || ks.name === 'swipl') {
                    notebookLang = 'prolog';
                }
            }
            if (nb.metadata && nb.metadata.language_info) {
                const li = nb.metadata.language_info;
                if (li.name === 'prolog') {
                    notebookLang = 'prolog';
                }
            }

            if (nb.cells) {
                nb.cells.forEach(cell => {
                    let source = '';
                    if (Array.isArray(cell.source)) {
                        source = cell.source.join('');
                    } else {
                        source = cell.source || '';
                    }
                    if (source.trim()) {
                        // Per-cell language override via scirepl metadata
                        let cellLang = notebookLang;
                        if (cell.metadata && cell.metadata.scirepl_language) {
                            cellLang = cell.metadata.scirepl_language;
                        }
                        extractedCells.push({
                            code: source,
                            type: cell.cell_type === 'markdown' ? 'markdown' : 'code',
                            language: cellLang
                        });
                    }
                });
            }

            if (extractedCells.length === 0) {
                alert('No cells found in notebook.');
                return;
            }

            // Apply Prolog search paths from notebook metadata
            if (nb.metadata && nb.metadata.scirepl && nb.metadata.scirepl.prolog_paths) {
                this._applyPrologPaths(nb.metadata.scirepl.prolog_paths);
            }

            // Use the cell import API if available
            if (window.importCells) {
                window.importCells(extractedCells);
            } else {
                // Fallback: dump code cells into textarea
                const codeOnly = extractedCells
                    .filter(c => c.type === 'code')
                    .map(c => c.code);
                this.importPython(codeOnly.join('\n\n# -- Cell --\n\n'));
            }
        } catch (e) {
            console.error(e);
            alert('Failed to parse .ipynb file.');
        }
    }
}

// Initialize only after DOM ready (already ensured by script placement at end of body)
window.fileIO = new FileIO();
