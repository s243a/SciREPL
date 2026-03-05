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
            window._clearingSession = true; // Prevent beforeunload from re-saving
            localStorage.removeItem('scirepl_session_v2');
            localStorage.removeItem('scirepl_session_v1');
            // Also clear IndexedDB (VFS files, search paths, and SharedVFS)
            if (window.vfsStore && window.vfsStore.isReady()) {
                try {
                    await window.vfsStore.clearFiles();
                    await window.vfsStore.saveSearchPaths([]);
                    await window.vfsStore.clearSharedFiles();
                } catch (e) {
                    console.warn('Failed to clear IndexedDB:', e);
                }
            }
            location.reload();
        });

        // Reload App — unregister service worker and hard-reload
        const reloadBtn = document.getElementById('btn-reload-app');
        if (reloadBtn) {
            reloadBtn.addEventListener('click', async () => {
                reloadBtn.textContent = 'Reloading...';
                reloadBtn.disabled = true;
                try {
                    // Unregister service workers
                    const regs = await navigator.serviceWorker.getRegistrations();
                    await Promise.all(regs.map(r => r.unregister()));
                } catch (_) { }
                try {
                    // Clear all SW caches
                    const names = await caches.keys();
                    await Promise.all(names.map(n => caches.delete(n)));
                } catch (_) { }
                // Reload (browser will fetch fresh from server)
                location.reload();
            });
        }

        // Settings
        const settingsBtn = document.getElementById('btn-settings');
        const settingsModal = document.getElementById('settings-modal');
        if (settingsBtn && settingsModal) {
            settingsBtn.addEventListener('click', () => {
                this.menuModal.classList.add('hidden');
                // Load saved settings
                const autoExec = document.getElementById('setting-auto-execute');
                const confirmDel = document.getElementById('setting-confirm-delete');
                const autoDl = document.getElementById('setting-auto-download');
                const rPrewarm = document.getElementById('setting-r-prewarm');
                const largeTouch = document.getElementById('setting-large-touch');
                const defaultLang = document.getElementById('setting-default-language');

                if (autoExec) autoExec.checked = localStorage.getItem('scirepl_auto_execute') === '1';
                if (confirmDel) confirmDel.checked = localStorage.getItem('scirepl_confirm_delete') !== '0';
                if (autoDl) autoDl.checked = localStorage.getItem('scirepl_auto_download') === '1';
                if (rPrewarm) rPrewarm.checked = localStorage.getItem('scirepl_r_prewarm') === 'yes';
                if (largeTouch) largeTouch.checked = localStorage.getItem('scirepl_mobile_emulation') === '1';
                if (defaultLang) defaultLang.value = localStorage.getItem('scirepl_default_language') || 'python';

                settingsModal.classList.remove('hidden');
            });
            // Save on change
            settingsModal.addEventListener('change', (e) => {
                const id = e.target.id;
                if (id === 'setting-auto-execute') {
                    localStorage.setItem('scirepl_auto_execute', e.target.checked ? '1' : '0');
                } else if (id === 'setting-confirm-delete') {
                    localStorage.setItem('scirepl_confirm_delete', e.target.checked ? '1' : '0');
                } else if (id === 'setting-auto-download') {
                    localStorage.setItem('scirepl_auto_download', e.target.checked ? '1' : '0');
                } else if (id === 'setting-r-prewarm') {
                    localStorage.setItem('scirepl_r_prewarm', e.target.checked ? 'yes' : '');
                    if (!e.target.checked) localStorage.removeItem('scirepl_r_prewarm');
                } else if (id === 'setting-large-touch') {
                    localStorage.setItem('scirepl_mobile_emulation', e.target.checked ? '1' : '0');
                    document.body.classList.toggle('force-mobile', e.target.checked);
                } else if (id === 'setting-default-language') {
                    localStorage.setItem('scirepl_default_language', e.target.value);
                }
            });
            // Reset privacy consent button
            const resetPrivacy = document.getElementById('btn-reset-privacy');
            if (resetPrivacy) {
                resetPrivacy.addEventListener('click', () => {
                    localStorage.removeItem('scirepl_privacy_accepted');
                    resetPrivacy.textContent = 'Privacy consent reset';
                    setTimeout(() => { resetPrivacy.textContent = 'Reset Privacy Consent'; }, 2000);
                });
            }
            // Close modal
            settingsModal.addEventListener('click', (e) => {
                if (e.target === settingsModal || e.target.classList.contains('modal-close')) {
                    settingsModal.classList.add('hidden');
                }
            });
        }

        // Memory & Storage
        const memoryBtn = document.getElementById('btn-memory');
        const memoryModal = document.getElementById('memory-modal');
        if (memoryBtn && memoryModal) {
            memoryBtn.addEventListener('click', () => {
                this.menuModal.classList.add('hidden');
                this._refreshMemoryModal();
                memoryModal.classList.remove('hidden');
            });
            memoryModal.addEventListener('click', (e) => {
                if (e.target === memoryModal || e.target.classList.contains('modal-close')) {
                    memoryModal.classList.add('hidden');
                }
            });
            // Refresh button
            const refreshBtn = document.getElementById('memory-refresh');
            if (refreshBtn) {
                refreshBtn.addEventListener('click', () => this._refreshMemoryModal());
            }
            // Clear VFS button
            const clearVfsBtn = document.getElementById('memory-clear-vfs');
            if (clearVfsBtn) {
                clearVfsBtn.addEventListener('click', async () => {
                    clearVfsBtn.textContent = 'Clearing...';
                    try {
                        if (window.vfsStore && window.vfsStore.isReady()) {
                            await window.vfsStore.clearSharedFiles();
                        }
                    } catch (e) {
                        console.warn('Failed to clear VFS:', e);
                    }
                    clearVfsBtn.textContent = 'Clear VFS';
                    this._refreshMemoryModal();
                });
            }
            // Clear Cache button
            const clearCacheBtn = document.getElementById('memory-clear-cache');
            if (clearCacheBtn) {
                clearCacheBtn.addEventListener('click', async () => {
                    clearCacheBtn.textContent = 'Clearing...';
                    try {
                        const names = await caches.keys();
                        await Promise.all(names.map(n => caches.delete(n)));
                    } catch (e) {
                        console.warn('Failed to clear caches:', e);
                    }
                    clearCacheBtn.textContent = 'Clear Cache';
                    this._refreshMemoryModal();
                });
            }
        }

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

        // Files & Storage
        const prologSettingsBtn = document.getElementById('btn-prolog-settings');
        if (prologSettingsBtn) {
            prologSettingsBtn.addEventListener('click', () => {
                this.menuModal.classList.add('hidden');
                if (window.prologSettings) {
                    window.prologSettings.open();
                } else {
                    alert('Files & Storage panel not available.');
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

        // Export HTML
        const exportHtmlBtn = document.getElementById('btn-export-html');
        if (exportHtmlBtn) {
            exportHtmlBtn.addEventListener('click', async () => {
                this.menuModal.classList.add('hidden');
                if (window.exportManager) await window.exportManager.exportHTML();
            });
        }

        // Export Markdown
        const exportMdBtn = document.getElementById('btn-export-md');
        if (exportMdBtn) {
            exportMdBtn.addEventListener('click', async () => {
                this.menuModal.classList.add('hidden');
                if (window.exportManager) await window.exportManager.exportMarkdown();
            });
        }

        // Export PDF
        const exportPdfBtn = document.getElementById('btn-export-pdf');
        if (exportPdfBtn) {
            exportPdfBtn.addEventListener('click', async () => {
                this.menuModal.classList.add('hidden');
                if (window.exportManager) await window.exportManager.exportPDF();
            });
        }

        // Export DOCX
        const exportDocxBtn = document.getElementById('btn-export-docx');
        if (exportDocxBtn) {
            exportDocxBtn.addEventListener('click', async () => {
                this.menuModal.classList.add('hidden');
                if (window.exportManager) await window.exportManager.exportDOCX();
            });
        }

        // Export LaTeX
        const exportLatexBtn = document.getElementById('btn-export-latex');
        if (exportLatexBtn) {
            exportLatexBtn.addEventListener('click', async () => {
                this.menuModal.classList.add('hidden');
                if (window.exportManager) await window.exportManager.exportLatex();
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

        // Scrape live DOM outputs if export manager is available
        const scrapedCells = window.exportManager ? window.exportManager._scrapeCells() : [];
        const scrapedMap = {};
        for (const sc of scrapedCells) {
            scrapedMap[sc.id] = sc;
        }

        const nbCells = [];
        for (const cell of cells) {
            const source = cell.code.split('\n').map((line, j, arr) =>
                j < arr.length - 1 ? line + '\n' : line
            );
            const cellLang = cell.language || 'python';
            if (cell.type === 'markdown') {
                nbCells.push({
                    cell_type: 'markdown',
                    metadata: {},
                    source: source
                });
                continue;
            }
            const meta = {};
            // Tag cells with non-primary language
            if (cellLang !== primaryLang) {
                meta.scirepl_language = cellLang;
            }

            // Convert scraped DOM outputs to Jupyter format
            let outputs = [];
            const scraped = scrapedMap[cell.id];
            if (scraped && scraped.outputs.length > 0 && window.exportManager) {
                try {
                    outputs = await window.exportManager.scrapedOutputsToJupyter(scraped);
                } catch (e) {
                    console.warn('[FileIO] Failed to scrape outputs for cell', cell.id, e);
                }
            }

            nbCells.push({
                cell_type: 'code',
                execution_count: cell.id,
                metadata: meta,
                outputs: outputs,
                source: source
            });
        }

        const kernelMap = {
            python: { display_name: 'Python 3 (Pyodide)', language: 'python', name: 'python3' },
            prolog: { display_name: 'SWI-Prolog (WASM)', language: 'prolog', name: 'swipl' },
            javascript: { display_name: 'JavaScript (Browser)', language: 'javascript', name: 'javascript' }
        };

        const langInfoMap = {
            python: { name: 'python', version: '3.12', mimetype: 'text/x-python', file_extension: '.py' },
            prolog: { name: 'prolog', version: '9.x', mimetype: 'text/x-prolog', file_extension: '.pl' },
            javascript: { name: 'javascript', version: 'ES2022', mimetype: 'text/javascript', file_extension: '.js' }
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
            description: 'Exported from SciREPL v0.6.0',
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
            prolog: { display_name: 'SWI-Prolog (WASM)', language: 'prolog', name: 'swipl' },
            javascript: { display_name: 'JavaScript (Browser)', language: 'javascript', name: 'javascript' }
        };
        const langInfoMap = {
            python: { name: 'python', version: '3.12', mimetype: 'text/x-python', file_extension: '.py' },
            prolog: { name: 'prolog', version: '9.x', mimetype: 'text/x-prolog', file_extension: '.pl' },
            javascript: { name: 'javascript', version: 'ES2022', mimetype: 'text/javascript', file_extension: '.js' }
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

    /**
     * Format bytes as a human-readable string (e.g. "25.4 MB").
     */
    _formatBytes(bytes) {
        if (bytes == null || bytes < 0) return '—';
        if (bytes === 0) return '0 B';
        const units = ['B', 'KB', 'MB', 'GB'];
        let i = 0;
        let val = bytes;
        while (val >= 1024 && i < units.length - 1) { val /= 1024; i++; }
        return val.toFixed(i === 0 ? 0 : 1) + ' ' + units[i];
    }

    /**
     * Populate the Memory & Storage modal with current data.
     */
    async _refreshMemoryModal() {
        const km = window.kernelManager;
        if (!km) return;

        // -- Kernel Memory --
        const list = document.getElementById('memory-kernel-list');
        if (!list) return;

        const memInfo = km.getMemoryInfo();
        list.innerHTML = '';

        for (const k of memInfo.kernels) {
            const card = document.createElement('div');
            card.className = 'memory-kernel-card';

            const dot = document.createElement('span');
            dot.className = 'memory-dot' + (k.loaded && k.ready ? ' loaded' : '');
            card.appendChild(dot);

            const info = document.createElement('div');
            info.className = 'memory-kernel-info';
            const nameEl = document.createElement('div');
            nameEl.className = 'memory-kernel-name';
            nameEl.textContent = k.name;
            info.appendChild(nameEl);
            const statusEl = document.createElement('div');
            statusEl.className = 'memory-kernel-status';
            if (k.language === 'javascript') {
                statusEl.textContent = 'Always ready';
            } else if (k.ready) {
                statusEl.textContent = 'Ready';
            } else {
                statusEl.textContent = 'Not loaded';
            }
            info.appendChild(statusEl);
            card.appendChild(info);

            const sizeEl = document.createElement('span');
            sizeEl.className = 'memory-kernel-size';
            sizeEl.textContent = k.memory != null ? this._formatBytes(k.memory) : '—';
            card.appendChild(sizeEl);

            // Unload button for loaded CDN kernels (not JavaScript)
            if (k.loaded && k.ready && KernelManager.CDN_KERNELS.has(k.language)) {
                const btn = document.createElement('button');
                btn.className = 'memory-unload-btn';
                btn.textContent = 'Unload';
                btn.addEventListener('click', async () => {
                    btn.textContent = 'Unloading...';
                    btn.disabled = true;
                    await km.destroyKernel(k.language);
                    // Update status badge if this was current language
                    if (km.currentLanguage === k.language) {
                        const badge = document.getElementById('status-badge');
                        if (badge) {
                            badge.textContent = 'ready';
                            badge.className = 'ready';
                        }
                    }
                    this._refreshMemoryModal();
                });
                card.appendChild(btn);
            }

            list.appendChild(card);
        }

        // -- Storage --
        try {
            const estimate = await navigator.storage.estimate();
            const usage = estimate.usage || 0;
            const quota = estimate.quota || 0;
            document.getElementById('memory-storage-used').textContent = this._formatBytes(usage);
            document.getElementById('memory-storage-quota').textContent = this._formatBytes(quota);

            const pct = quota > 0 ? (usage / quota * 100) : 0;
            const fill = document.getElementById('memory-bar-fill');
            fill.style.width = Math.min(pct, 100).toFixed(1) + '%';
            fill.className = 'memory-bar-fill' + (pct > 80 ? ' critical' : pct > 50 ? ' warn' : '');
        } catch (_) { }

        // SW cache size
        try {
            let cacheSize = 0;
            const cacheNames = await caches.keys();
            for (const name of cacheNames) {
                const cache = await caches.open(name);
                const keys = await cache.keys();
                for (const req of keys) {
                    const resp = await cache.match(req);
                    if (resp) {
                        const blob = await resp.clone().blob();
                        cacheSize += blob.size;
                    }
                }
            }
            document.getElementById('memory-sw-size').textContent = this._formatBytes(cacheSize);
        } catch (_) {
            document.getElementById('memory-sw-size').textContent = '—';
        }

        // localStorage size
        try {
            let lsSize = 0;
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                lsSize += (key.length + localStorage.getItem(key).length) * 2; // UTF-16
            }
            document.getElementById('memory-ls-size').textContent = this._formatBytes(lsSize);
        } catch (_) {
            document.getElementById('memory-ls-size').textContent = '—';
        }

        // IndexedDB size (estimate from overall storage minus caches/localStorage)
        try {
            const estimate = await navigator.storage.estimate();
            const swEl = document.getElementById('memory-sw-size');
            const lsEl = document.getElementById('memory-ls-size');
            // Parse sizes back (rough estimate)
            const swText = swEl.textContent;
            const lsText = lsEl.textContent;
            const parseSize = (t) => {
                const m = t.match(/([\d.]+)\s*(B|KB|MB|GB)/);
                if (!m) return 0;
                const v = parseFloat(m[1]);
                const u = m[2];
                return v * (u === 'GB' ? 1073741824 : u === 'MB' ? 1048576 : u === 'KB' ? 1024 : 1);
            };
            const swSize = parseSize(swText);
            const lsSize = parseSize(lsText);
            const idbSize = Math.max(0, (estimate.usage || 0) - swSize - lsSize);
            document.getElementById('memory-idb-size').textContent = this._formatBytes(idbSize);
        } catch (_) {
            document.getElementById('memory-idb-size').textContent = '—';
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

        // Notebook/code files: import as cells
        if (file.name.endsWith('.ipynb')) {
            const reader = new FileReader();
            reader.onload = (e) => this.importIpynb(e.target.result);
            reader.readAsText(file);
            return;
        }
        if (file.name.endsWith('.pl') || file.name.endsWith('.pro')) {
            const reader = new FileReader();
            reader.onload = (e) => this.importProlog(e.target.result);
            reader.readAsText(file);
            return;
        }
        if (file.name.endsWith('.py')) {
            const reader = new FileReader();
            reader.onload = (e) => this.importPython(e.target.result);
            reader.readAsText(file);
            return;
        }

        // All other files: save to SharedVFS
        this._importToSharedVFS(file);
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
     * Import any file into SharedVFS at /shared/data/<filename>.
     * Binary files are written as Uint8Array, text files as strings.
     */
    _importToSharedVFS(file) {
        const destPath = '/shared/data/' + file.name;
        const isText = /\.(csv|tsv|txt|json|jsonl|xml|html|md|r|R|js|yaml|yml|toml|ini|cfg|conf|log|sql|sh|bash)$/i.test(file.name);

        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                if (window.sharedVFS) {
                    if (isText) {
                        window.sharedVFS.writeFile(destPath, e.target.result, 'user');
                    } else {
                        window.sharedVFS.writeFile(destPath, new Uint8Array(e.target.result), 'user');
                    }
                    alert('Uploaded to ' + destPath);
                } else {
                    alert('SharedVFS not available.');
                }
            } catch (err) {
                alert('Upload failed: ' + err.message);
            }
        };
        if (isText) {
            reader.readAsText(file);
        } else {
            reader.readAsArrayBuffer(file);
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
            const autoExec = localStorage.getItem('scirepl_auto_execute') === '1';
            window.importCells([{ code: content, type: 'code', language: 'prolog' }], { autoExecute: autoExec });
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
                        const cellDef = {
                            code: source,
                            type: cell.cell_type === 'markdown' ? 'markdown' : 'code',
                            language: cellLang
                        };
                        // Preserve outputs from .ipynb for display without re-execution
                        if (cell.cell_type === 'code' && Array.isArray(cell.outputs) && cell.outputs.length > 0) {
                            cellDef.outputs = cell.outputs;
                        }
                        extractedCells.push(cellDef);
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

            // Create a new notebook tab for the imported workbook
            const nm = window.notebookManager;
            if (nm && nm.createNotebook) {
                // Extract name from first markdown heading, or fall back
                let wbName = 'Imported Workbook';
                const firstMd = extractedCells.find(c => c.type === 'markdown');
                if (firstMd) {
                    const headingMatch = firstMd.code.match(/^#\s+(.+)/m);
                    if (headingMatch) wbName = headingMatch[1].trim();
                }
                const newNb = nm.createNotebook({ name: wbName });
                nm.switchTo(newNb.id);
            }

            // Use the cell import API if available
            if (window.importCells) {
                const autoExec = localStorage.getItem('scirepl_auto_execute') === '1';
                window.importCells(extractedCells, { autoExecute: autoExec });
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
