/**
 * file_io.js — Handles File Import/Export and Menu interactions.
 * Export format is Jupyter Notebook (.ipynb).
 */

class FileIO {
    constructor() {
        this.menuModal = document.getElementById('menu-modal');
        this.menuBtn = document.getElementById('menu-btn');
        this.fileInput = document.getElementById('file-input');
        this._latestRuntimeMetadata = new Map();
        this._latestRuntimeRequests = new Map();

        // A runtime may finish loading while the Languages modal is open.
        // Refresh its factual session source immediately, and rebuild translated
        // dynamic labels when the UI locale changes.
        this._onRuntimeSourceLoaded = (event) => {
            if (event?.detail?.language) this._refreshRuntimeVersionStatus(event.detail.language);
        };
        this._onRuntimeLocaleChanged = () => this._refreshRuntimeVersionStatuses();
        window.addEventListener('scirepl:runtime-source-loaded', this._onRuntimeSourceLoaded);
        window.addEventListener('i18n:changed', this._onRuntimeLocaleChanged);

        this.init();
    }

    /** Translate with an English fallback while catalogues are being upgraded. */
    _t(key, fallback, vars = {}) {
        let value = (typeof window.t === 'function') ? window.t(key, vars) : key;
        if (!value || value === key) value = fallback;
        return String(value).replace(/\{(\w+)\}/g, (match, name) =>
            Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match);
    }

    /** Bind generated DOM so the central i18n retranslation pass can update it. */
    _setText(element, key, fallback, vars = {}) {
        if (!element) return;
        if (typeof window.setI18nText === 'function') {
            window.setI18nText(element, key, vars);
            if (element.textContent === '' || element.textContent === key) {
                element.textContent = this._t(key, fallback, vars);
            }
        } else {
            element.textContent = this._t(key, fallback, vars);
        }
    }

    _setTitle(element, key, fallback, vars = {}) {
        if (!element) return;
        if (typeof window.setI18nAttr === 'function') {
            window.setI18nAttr(element, 'title', key, vars);
            if (!element.title || element.title === key) {
                element.title = this._t(key, fallback, vars);
            }
        } else {
            element.title = this._t(key, fallback, vars);
        }
    }

    init() {
        // Language selectors: abbreviation when closed, full name when open.
        this._wireLanguageSelectorNames();

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
                alert(this._t('fileIo.sessionSaved', 'Session saved to local storage.'));
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
                this._setText(clearBtn, 'fileIo.confirmClearAgain', '⚠ Click again to confirm clear');
                clearBtn.style.background = 'rgba(248, 81, 73, 0.2)';
                clearTimer = setTimeout(() => {
                    clearPending = false;
                    this._setText(clearBtn, 'fileIo.clearHistory', '🗑 Clear History');
                    clearBtn.style.background = '';
                }, 3000);
                return;
            }
            // Second click: actually clear
            clearTimeout(clearTimer);
            this._setText(clearBtn, 'fileIo.clearing', 'Clearing...');
            window._clearingSession = true; // Prevent beforeunload from re-saving
            localStorage.removeItem('scirepl_session_v2');
            localStorage.removeItem('scirepl_session_v1');
            // Package installation state belongs to the cleared app history too.
            // Leaving this behind makes the catalog claim a package is installed
            // after its session/VFS state has been removed.
            localStorage.removeItem('scirepl_installed_packages');
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

        // Open in Browser — open app URL in system browser (useful on Android)
        const openBrowserBtn = document.getElementById('btn-open-browser');
        if (openBrowserBtn) {
            if (window.Capacitor && Capacitor.Plugins && Capacitor.Plugins.Browser) {
                openBrowserBtn.addEventListener('click', async () => {
                    this.menuModal.classList.add('hidden');
                    try {
                        await Capacitor.Plugins.Browser.open({ url: window.location.href });
                    } catch (e) {
                        console.warn('Failed to open browser:', e);
                    }
                });
            } else {
                // Not on Capacitor — hide the button
                openBrowserBtn.style.display = 'none';
            }
        }

        // Reload App — clear app cache and reload (preserves CDN cache for Pyodide etc.)
        const reloadBtn = document.getElementById('btn-reload-app');
        if (reloadBtn) {
            reloadBtn.addEventListener('click', async () => {
                this._setText(reloadBtn, 'fileIo.reloading', 'Reloading...');
                reloadBtn.disabled = true;
                try {
                    // Clear app caches but preserve CDN cache (Pyodide, swipl-wasm, etc.)
                    const names = await caches.keys();
                    await Promise.all(names.filter(n => !n.includes('-cdn-')).map(n => caches.delete(n)));
                } catch (_) { }
                try {
                    // Unregister the old SW so the reload gets fresh assets
                    const reg = await navigator.serviceWorker.getRegistration();
                    if (reg) await reg.unregister();
                } catch (_) { }
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
                const autoSwitch = document.getElementById('setting-auto-switch');
                const confirmDel = document.getElementById('setting-confirm-delete');
                const autoDl = document.getElementById('setting-auto-download');
                const rPrewarm = document.getElementById('setting-r-prewarm');
                const largeTouch = document.getElementById('setting-large-touch');
                const defaultLang = document.getElementById('setting-default-language');
                const exportFmt = document.getElementById('setting-export-format');

                if (autoExec) autoExec.checked = localStorage.getItem('scirepl_auto_execute') === '1';
                if (autoSwitch) autoSwitch.checked = localStorage.getItem('scirepl_auto_switch_workbook') !== '0';
                if (confirmDel) confirmDel.checked = localStorage.getItem('scirepl_confirm_delete') !== '0';
                if (autoDl) autoDl.checked = localStorage.getItem('scirepl_auto_download') === '1';
                if (rPrewarm) rPrewarm.checked = localStorage.getItem('scirepl_r_prewarm') === 'yes';
                if (largeTouch) largeTouch.checked = localStorage.getItem('scirepl_mobile_emulation') === '1';
                if (defaultLang) defaultLang.value = localStorage.getItem('scirepl_default_language') || 'python';
                if (exportFmt) exportFmt.value = localStorage.getItem('scirepl_export_format') || 'zip';

                // Load Notebook VFS settings
                const nbvfsSettings = window.notebookVFS ? window.notebookVFS._getSettings() : {};
                const nbSameWrite = document.getElementById('setting-nbvfs-same-write');
                const nbCrossRead = document.getElementById('setting-nbvfs-cross-read');
                const nbCrossWrite = document.getElementById('setting-nbvfs-cross-write');
                const nbExec = document.getElementById('setting-nbvfs-exec');
                const nbAllowJs = document.getElementById('setting-nbvfs-allow-js');
                if (nbSameWrite) nbSameWrite.checked = nbvfsSettings.sameNotebookWrite !== false;
                if (nbCrossRead) nbCrossRead.checked = !!nbvfsSettings.crossNotebookRead;
                if (nbCrossWrite) nbCrossWrite.checked = !!nbvfsSettings.crossNotebookWrite;
                if (nbExec) nbExec.checked = !!nbvfsSettings.programmaticExecution;
                if (nbAllowJs) nbAllowJs.checked = nbvfsSettings.allowJavaScript !== false;

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
                } else if (id === 'setting-export-format') {
                    localStorage.setItem('scirepl_export_format', e.target.value);
                } else if (id === 'setting-auto-switch') {
                    localStorage.setItem('scirepl_auto_switch_workbook', e.target.checked ? '1' : '0');
                } else if (id.startsWith('setting-nbvfs-') && window.notebookVFS) {
                    const s = window.notebookVFS._getSettings();
                    if (id === 'setting-nbvfs-same-write') s.sameNotebookWrite = e.target.checked;
                    else if (id === 'setting-nbvfs-cross-read') s.crossNotebookRead = e.target.checked;
                    else if (id === 'setting-nbvfs-cross-write') s.crossNotebookWrite = e.target.checked;
                    else if (id === 'setting-nbvfs-exec') s.programmaticExecution = e.target.checked;
                    else if (id === 'setting-nbvfs-allow-js') s.allowJavaScript = e.target.checked;
                    window.notebookVFS._saveSettings(s);
                }
            });
            // Reset privacy consent button
            const resetPrivacy = document.getElementById('btn-reset-privacy');
            if (resetPrivacy) {
                resetPrivacy.addEventListener('click', () => {
                    localStorage.removeItem('scirepl_privacy_accepted');
                    localStorage.removeItem('scirepl_privacy_accepted_revision');
                    this._setText(resetPrivacy, 'fileIo.privacyConsentReset', 'Privacy consent reset');
                    setTimeout(() => {
                        this._setText(resetPrivacy, 'fileIo.resetPrivacyConsent', 'Reset Privacy Consent');
                    }, 2000);
                });
            }
            // Close modal
            settingsModal.addEventListener('click', (e) => {
                if (e.target === settingsModal || e.target.classList.contains('modal-close')) {
                    settingsModal.classList.add('hidden');
                }
            });
        }

        // Languages
        const langBtn = document.getElementById('btn-languages');
        const langModal = document.getElementById('languages-modal');
        if (langBtn && langModal) {
            langBtn.addEventListener('click', () => {
                this.menuModal.classList.add('hidden');
                this._populateLanguagesModal();
                langModal.classList.remove('hidden');
            });
            langModal.addEventListener('click', (e) => {
                if (e.target === langModal || e.target.classList.contains('modal-close')) {
                    langModal.classList.add('hidden');
                }
            });
            langModal.addEventListener('change', (e) => {
                if (e.target.matches('.lang-toggle')) {
                    this._onLanguageToggle(e.target.dataset.lang, e.target.checked);
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
                    this._setText(clearVfsBtn, 'fileIo.clearing', 'Clearing...');
                    try {
                        if (window.vfsStore && window.vfsStore.isReady()) {
                            await window.vfsStore.clearSharedFiles();
                        }
                    } catch (e) {
                        console.warn('Failed to clear VFS:', e);
                    }
                    this._setText(clearVfsBtn, 'fileIo.clearVfs', 'Clear VFS');
                    this._refreshMemoryModal();
                });
            }
            // Clear Cache button
            const clearCacheBtn = document.getElementById('memory-clear-cache');
            if (clearCacheBtn) {
                clearCacheBtn.addEventListener('click', async () => {
                    this._setText(clearCacheBtn, 'fileIo.clearing', 'Clearing...');
                    try {
                        const names = await caches.keys();
                        await Promise.all(names.map(n => caches.delete(n)));
                    } catch (e) {
                        console.warn('Failed to clear caches:', e);
                    }
                    this._setText(clearCacheBtn, 'fileIo.clearCache', 'Clear Cache');
                    this._refreshMemoryModal();
                });
            }
        }

        // Run All Cells
        document.getElementById('btn-run-all').addEventListener('click', () => {
            this.menuModal.classList.add('hidden');
            if (window.runAllCells) window.runAllCells();
        });

        // Export Workbooks & Packages modal
        const exportWbBtn = document.getElementById('btn-export-workbook');
        if (exportWbBtn) {
            exportWbBtn.addEventListener('click', () => {
                this.menuModal.classList.add('hidden');
                this._openExportWorkbookModal();
            });
        }

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
                    alert(this._t('fileIo.filesPanelUnavailable',
                        'Files & Storage panel not available.'));
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
                        name: this._t('fileIo.defaultNotebookName', 'Notebook {number}',
                            { number: nm.getNotebooks().length + 1 })
                    });
                    nm.switchTo(nb.id);
                }
            });
        }

        // (Export Package removed — merged into Export Workbooks & Packages modal)

        // Export Modal
        const exportBtn = document.getElementById('btn-export');
        const exportModal = document.getElementById('export-modal');
        const exportImageSection = document.getElementById('export-image-section');
        const exportThemeSection = document.getElementById('export-theme-section');
        const exportPageBgSection = document.getElementById('export-pagebg-section');
        const exportMarginsSection = document.getElementById('export-margins-section');
        const doExportBtn = document.getElementById('btn-do-export');

        if (exportBtn && exportModal) {
            exportBtn.addEventListener('click', () => {
                this.menuModal.classList.add('hidden');
                const htmlRadio = exportModal.querySelector('input[name="export-format"][value="html"]');
                if (htmlRadio) htmlRadio.checked = true;
                const embedRadio = exportModal.querySelector('input[name="export-images"][value="embed"]');
                if (embedRadio) embedRadio.checked = true;
                const keepRadio = exportModal.querySelector('input[name="export-theme"][value="keep"]');
                if (keepRadio) keepRadio.checked = true;
                const whiteRadio = exportModal.querySelector('input[name="export-pagebg"][value="white"]');
                if (whiteRadio) whiteRadio.checked = true;
                this._updateExportSections(exportModal, exportImageSection, exportThemeSection,
                    exportPageBgSection, exportMarginsSection);
                exportModal.classList.remove('hidden');
            });

            exportModal.addEventListener('click', (e) => {
                if (e.target === exportModal || e.target.classList.contains('modal-close')) {
                    exportModal.classList.add('hidden');
                }
            });

            exportModal.addEventListener('change', (e) => {
                if (e.target.name === 'export-format') {
                    this._updateExportSections(exportModal, exportImageSection, exportThemeSection, exportPageBgSection, exportMarginsSection);
                }
            });

            if (doExportBtn) {
                doExportBtn.addEventListener('click', async () => {
                    const format = exportModal.querySelector('input[name="export-format"]:checked');
                    const imageMode = exportModal.querySelector('input[name="export-images"]:checked');
                    const theme = exportModal.querySelector('input[name="export-theme"]:checked');
                    const pageBg = exportModal.querySelector('input[name="export-pagebg"]:checked');
                    const marginTop = document.getElementById('export-margin-top');
                    const marginRight = document.getElementById('export-margin-right');
                    const marginBottom = document.getElementById('export-margin-bottom');
                    const marginLeft = document.getElementById('export-margin-left');
                    const marginUnit = document.getElementById('export-margin-unit');
                    const marginType = document.getElementById('export-margin-type');
                    const margins = {
                        top: marginTop ? parseFloat(marginTop.value) || 0 : 10,
                        right: marginRight ? parseFloat(marginRight.value) || 0 : 10,
                        bottom: marginBottom ? parseFloat(marginBottom.value) || 0 : 10,
                        left: marginLeft ? parseFloat(marginLeft.value) || 0 : 10,
                        unit: marginUnit ? marginUnit.value : 'mm',
                        type: marginType ? marginType.value : 'virtual'
                    };
                    exportModal.classList.add('hidden');
                    await this._dispatchExport(
                        format ? format.value : 'html',
                        imageMode ? imageMode.value : 'embed',
                        theme ? theme.value : 'keep',
                        pageBg ? pageBg.value : 'white',
                        margins
                    );
                });
            }
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
        // Redirect .srwb files to the workbook importer
        if (file.name.endsWith('.srwb')) {
            const reader = new FileReader();
            reader.onload = (e) => this.importSrwb(e.target.result);
            reader.readAsText(file);
            return;
        }
        if (window.packageLoader) {
            try {
                await window.packageLoader.loadFromFile(file);
            } catch (err) {
                alert(this._t('fileIo.packageImportFailed',
                    'Package import failed: {error}', { error: err.message }));
            }
        } else {
            alert(this._t('fileIo.packageLoadingUnavailable',
                'Package loading is not yet available.'));
        }
    }

    /**
     * Export current cells as a Jupyter Notebook (.ipynb).
     */
    async exportNotebook() {
        const cells = window._cells || [];
        if (cells.length === 0) {
            alert(this._t('fileIo.noCellsToExport', 'No cells to export.'));
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

        const notebook = {
            nbformat: 4,
            nbformat_minor: 5,
            metadata: {
                kernelspec: FileIO.IPYNB_KERNELSPEC[primaryLang] || FileIO.IPYNB_KERNELSPEC.python,
                language_info: FileIO.IPYNB_LANGUAGE_INFO[primaryLang] || FileIO.IPYNB_LANGUAGE_INFO.python,
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
     * Collect all package files (notebooks, VFS, manifest) into a flat array.
     * Returns { manifest, files: [{path, content}] } or null.
     */
    _collectPackageFiles() {
        const nm = window.notebookManager;
        const notebooks = nm ? nm.getNotebooks() : [];

        if (notebooks.length === 0) {
            alert(this._t('fileIo.noNotebooksToExport', 'No notebooks to export.'));
            return null;
        }

        const manifest = {
            format_version: '2.0',
            name: 'SciREPL Package',
            version: '1.0.0',
            description: 'Exported from SciREPL',
            notebooks: [],
            files: [],
            search_paths: []
        };

        const files = [];

        // Export each notebook as .ipynb
        for (const nb of notebooks) {
            const cells = nb.isActive ? (window._cells || []) : nb.cells;
            const filename = (nb.name.replace(/[^a-zA-Z0-9_-]/g, '_') || 'notebook') + '.ipynb';
            const ipynb = this._buildIpynb(cells, nb.kernelLanguage);
            files.push({ path: filename, content: JSON.stringify(ipynb, null, 1) });
            manifest.notebooks.push({
                file: filename,
                name: nb.name,
                description: nb.description || '',
                kernel: nb.kernelLanguage || undefined
            });
        }

        // Export Prolog VFS files
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
                            const archivePath = 'prolog' + f.path;
                            files.push({ path: archivePath, content });
                            manifest.files.push({ src: archivePath, dest: f.path, target: 'prolog' });
                        } catch (e) { /* skip */ }
                    }
                    const paths = vfs.getSearchPaths();
                    for (const p of paths) {
                        if (p.alias === 'user' && p.dir === '/user') continue;
                        manifest.search_paths.push(p);
                    }
                }
            }
        }

        // Export SharedVFS files
        const sharedVFS = window.sharedVFS;
        if (sharedVFS) {
            // Scan all subdirectories under /shared
            try {
                const topEntries = sharedVFS.listDir('/shared');
                for (const name of topEntries) {
                    const dirPath = '/shared/' + name;
                    const stat = sharedVFS.stat(dirPath);
                    if (stat && stat.isDir) {
                        this._collectSharedDir(sharedVFS, dirPath, files, manifest);
                    }
                }
            } catch (_) {
                // Fallback to known directories
                for (const dir of ['/shared/data', '/shared/lib', '/shared/config', '/shared/bin', '/shared/notebooks']) {
                    this._collectSharedDir(sharedVFS, dir, files, manifest);
                }
            }
        }

        return { manifest, files };
    }

    /**
     * Recursively collect files from a SharedVFS directory.
     */
    _collectSharedDir(vfs, dirPath, files, manifest) {
        const entries = vfs.listDir(dirPath);
        if (!entries) return;

        for (const name of entries) {
            const fullPath = dirPath + '/' + name;
            const stat = vfs.stat(fullPath);
            if (!stat) continue;

            if (stat.isDir) {
                this._collectSharedDir(vfs, fullPath, files, manifest);
            } else {
                const content = vfs.readFile(fullPath);
                if (content == null) continue;
                const archivePath = fullPath.substring(1); // strip leading /
                const isBinary = content instanceof Uint8Array;
                files.push({ path: archivePath, content });
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
     * Export all notebooks and VFS files as a package.
     * @param {Set|null} includedPaths - If provided, only include files with these paths.
     * @param {string} archiveFormat - 'zip', 'tar', or 'tar.gz'. Falls back to settings.
     */
    async exportPackage(includedPaths, archiveFormat) {
        const collected = this._collectPackageFiles();
        if (!collected) return;

        // Filter files if a selection was provided
        if (includedPaths && includedPaths.size > 0) {
            collected.files = collected.files.filter(f => includedPaths.has(f.path));
            // Update manifest to match
            const includedSet = new Set(collected.files.map(f => f.path));
            collected.manifest.notebooks = collected.manifest.notebooks.filter(n => includedSet.has(n.file));
            collected.manifest.files = collected.manifest.files.filter(n => includedSet.has(n.src));
        }

        if (collected.files.length === 0) {
            alert(this._t('fileIo.noFilesSelected', 'No files selected for export.'));
            return;
        }

        const format = archiveFormat || localStorage.getItem('scirepl_export_format') || 'zip';

        if (format === 'tar' || format === 'tar.gz') {
            await this._exportAsTar(collected, format === 'tar.gz');
        } else {
            await this._exportAsZip(collected);
        }
    }

    /**
     * Serialize collected files as .zip and trigger download.
     */
    async _exportAsZip(collected) {
        if (typeof JSZip === 'undefined') {
            alert(this._t('fileIo.jsZipNotLoaded', 'JSZip not loaded.'));
            return;
        }
        const zip = new JSZip();
        for (const { path, content } of collected.files) {
            const isBinary = content instanceof Uint8Array;
            zip.file(path, content, { binary: isBinary });
        }
        zip.file('scirepl.json', JSON.stringify(collected.manifest, null, 2));

        const blob = await zip.generateAsync({ type: 'blob' });
        this._downloadBlob(blob, 'scirepl_package.zip');
    }

    /**
     * Serialize collected files as .tar or .tar.gz and trigger download.
     */
    async _exportAsTar(collected, gzip) {
        if (typeof TarWriter === 'undefined') {
            alert(this._t('fileIo.tarWriterUnavailable', 'TarWriter not available.'));
            return;
        }
        const tar = new TarWriter();
        for (const { path, content } of collected.files) {
            tar.addFile(path, content);
        }
        tar.addFile('scirepl.json', JSON.stringify(collected.manifest, null, 2));

        let data = tar.build();
        let filename = 'scirepl_package.tar';

        if (gzip) {
            data = await this._gzipCompress(data);
            filename = 'scirepl_package.tar.gz';
        }

        const blob = new Blob([data], { type: 'application/octet-stream' });
        this._downloadBlob(blob, filename);
    }

    /**
     * Compress a Uint8Array using the browser's CompressionStream API.
     */
    async _gzipCompress(data) {
        const cs = new CompressionStream('gzip');
        const writer = cs.writable.getWriter();
        writer.write(data);
        writer.close();
        const reader = cs.readable.getReader();
        const chunks = [];
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
        }
        const total = chunks.reduce((s, c) => s + c.length, 0);
        const result = new Uint8Array(total);
        let offset = 0;
        for (const c of chunks) { result.set(c, offset); offset += c.length; }
        return result;
    }

    /**
     * Download a Blob as a file.
     */
    async _downloadBlob(blob, filename) {
        // Try Capacitor native plugins (Android/iOS)
        if (window.Capacitor && Capacitor.Plugins) {
            try {
                const { Filesystem } = Capacitor.Plugins;
                const { Share } = Capacitor.Plugins;
                if (Filesystem && Share) {
                    const buffer = await blob.arrayBuffer();
                    const bytes = new Uint8Array(buffer);
                    let binary = '';
                    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
                    const b64 = btoa(binary);
                    const writeResult = await Filesystem.writeFile({
                        path: filename,
                        data: b64,
                        directory: 'CACHE'
                    });
                    await Share.share({
                        title: filename,
                        url: writeResult.uri,
                        dialogTitle: this._t('fileIo.downloadDialogTitle',
                            'Download {filename}', { filename })
                    });
                    return;
                }
            } catch (e) {
                console.warn('Capacitor blob download failed:', e);
            }
        }

        // Fallback: blob URL download (desktop browsers)
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    /**
     * Show/hide image and theme sections based on selected export format.
     */
    _updateExportSections(modal, imageSection, themeSection, pageBgSection, marginsSection) {
        const format = modal.querySelector('input[name="export-format"]:checked');
        const fmt = format ? format.value : 'html';

        // Images: show for HTML and Markdown
        if (imageSection) {
            const showImages = (fmt === 'html' || fmt === 'markdown');
            if (showImages) {
                imageSection.classList.remove('hidden');
                const defaultVal = fmt === 'markdown' ? 'separate' : 'embed';
                const radio = modal.querySelector(`input[name="export-images"][value="${defaultVal}"]`);
                if (radio) radio.checked = true;
            } else {
                imageSection.classList.add('hidden');
            }
        }

        const showStyled = (fmt === 'html' || fmt === 'pdf');

        // Theme: show for HTML and PDF
        if (themeSection) {
            if (showStyled) {
                themeSection.classList.remove('hidden');
            } else {
                themeSection.classList.add('hidden');
            }
        }

        // Page Background: show for HTML and PDF
        if (pageBgSection) {
            if (showStyled) {
                pageBgSection.classList.remove('hidden');
            } else {
                pageBgSection.classList.add('hidden');
            }
        }

        // Page Margins: show for PDF only
        if (marginsSection) {
            if (fmt === 'pdf') {
                marginsSection.classList.remove('hidden');
            } else {
                marginsSection.classList.add('hidden');
            }
        }
    }

    /**
     * Dispatch export based on format, image mode, and theme selections.
     */
    async _dispatchExport(format, imageMode, theme, pageBg, margins) {
        const em = window.exportManager;
        const opts = { embedImages: imageMode === 'embed', theme: theme || 'keep', pageBg: pageBg || 'white' };
        if (margins) opts.margins = margins;
        switch (format) {
            case 'html':
                if (em) await em.exportHTML(opts);
                break;
            case 'markdown':
                if (em) await em.exportMarkdown({ embedImages: opts.embedImages });
                break;
            case 'pdf':
                if (em) await em.exportPDF(opts);
                break;
            case 'docx':
                if (em) await em.exportDOCX();
                break;
            case 'latex':
                if (em) await em.exportLatex();
                break;
            default:
                alert(this._t('fileIo.unknownExportFormat',
                    'Unknown export format: {format}', { format }));
        }
    }

    /**
     * Open the Export Workbooks & Packages modal.
     */
    _openExportWorkbookModal() {
        const modal = document.getElementById('export-workbook-modal');
        if (!modal) return;

        // Reset to defaults
        const srwbRadio = modal.querySelector('input[name="wb-export-format"][value="srwb"]');
        if (srwbRadio) srwbRadio.checked = true;
        const currentRadio = modal.querySelector('input[name="wb-export-scope"][value="current"]');
        if (currentRadio) currentRadio.checked = true;

        // Set archive format from settings
        const archiveSelect = document.getElementById('wb-export-archive');
        if (archiveSelect) archiveSelect.value = localStorage.getItem('scirepl_export_format') || 'zip';

        // Clear file tree so it rebuilds with fresh data
        const filetree = document.getElementById('wb-filetree');
        if (filetree) filetree.innerHTML = '';

        this._updateWbExportSections();

        // Wire up format/scope change to show/hide sections
        modal.addEventListener('change', (e) => {
            if (e.target.name === 'wb-export-format' || e.target.name === 'wb-export-scope') {
                this._updateWbExportSections();
            }
        });

        // Wire up export button
        const doBtn = document.getElementById('btn-do-export-workbook');
        if (doBtn) {
            const handler = async () => {
                doBtn.removeEventListener('click', handler);
                modal.classList.add('hidden');
                await this._doExportWorkbook();
            };
            doBtn.addEventListener('click', handler);
        }

        // Close on backdrop/X click
        modal.addEventListener('click', (e) => {
            if (e.target === modal || e.target.classList.contains('modal-close')) {
                modal.classList.add('hidden');
            }
        });

        modal.classList.remove('hidden');
    }

    /**
     * Show/hide sections in the workbook export modal based on format.
     */
    _updateWbExportSections() {
        const modal = document.getElementById('export-workbook-modal');
        if (!modal) return;
        const format = modal.querySelector('input[name="wb-export-format"]:checked');
        const fmt = format ? format.value : 'srwb';

        const scopeSection = document.getElementById('wb-scope-section');
        const kernelSection = document.getElementById('wb-kernel-section');
        const archiveSection = document.getElementById('wb-archive-section');

        const scope = modal.querySelector('input[name="wb-export-scope"]:checked');
        const scp = scope ? scope.value : 'current';

        // Scope: show for srwb and ipynb, hide for package (always exports all)
        if (scopeSection) scopeSection.classList.toggle('hidden', fmt === 'package');
        // Kernel: show for ipynb only
        if (kernelSection) kernelSection.classList.toggle('hidden', fmt !== 'ipynb');
        // Archive format: show for package, or ipynb with all tabs
        const showArchive = fmt === 'package' || (fmt === 'ipynb' && scp === 'all');
        if (archiveSection) archiveSection.classList.toggle('hidden', !showArchive);

        // File tree: show for package only
        const filetreeSection = document.getElementById('wb-filetree-section');
        if (filetreeSection) {
            const showTree = fmt === 'package';
            filetreeSection.classList.toggle('hidden', !showTree);
            if (showTree) {
                this._populatePackageTree();
            } else {
                // Clear so it rebuilds fresh next time
                const tree = document.getElementById('wb-filetree');
                if (tree) tree.innerHTML = '';
            }
        }
    }

    /**
     * Populate the package file tree with checkboxes.
     */
    _populatePackageTree() {
        const container = document.getElementById('wb-filetree');
        if (!container) return;

        // Only rebuild if empty (avoid flicker on repeated calls)
        if (container.children.length > 0) return;

        const collected = this._collectPackageFiles();
        if (!collected) {
            const empty = document.createElement('div');
            empty.style.cssText = 'color:var(--text-muted);padding:8px';
            this._setText(empty, 'fileIo.noFilesToExport', 'No files to export.');
            container.replaceChildren(empty);
            return;
        }

        // Group files by directory
        const groups = new Map();
        for (const f of collected.files) {
            const parts = f.path.split('/');
            const dir = parts.length > 1 ? parts.slice(0, -1).join('/') : '.';
            const name = parts[parts.length - 1];
            if (!groups.has(dir)) groups.set(dir, []);
            groups.get(dir).push({ name, path: f.path, size: f.content ? f.content.length : 0 });
        }

        container.innerHTML = '';
        const AUTO_COLLAPSE_THRESHOLD = 5;
        // Folders unchecked by default (redundant with notebooks/ .ipynb exports)
        const UNCHECKED_DIRS = new Set(['shared/notebooks']);

        for (const [dir, files] of groups) {
            const defaultChecked = !UNCHECKED_DIRS.has(dir);
            const group = document.createElement('div');
            group.className = 'pkg-tree-group';

            // Folder header row
            const folderRow = document.createElement('div');
            folderRow.className = 'pkg-tree-folder';

            // Toggle arrow
            const arrow = document.createElement('span');
            arrow.className = 'pkg-tree-arrow';
            arrow.textContent = '▼';
            folderRow.appendChild(arrow);

            // Checkbox
            const folderCb = document.createElement('input');
            folderCb.type = 'checkbox';
            folderCb.checked = defaultChecked;
            folderCb.dataset.dir = dir;
            folderRow.appendChild(folderCb);

            // Folder name + file count
            const nameSpan = document.createElement('span');
            nameSpan.textContent = (dir === '.' ? 'notebooks/' : dir + '/');
            folderRow.appendChild(nameSpan);
            const countSpan = document.createElement('span');
            countSpan.className = 'pkg-tree-size';
            countSpan.textContent = `(${files.length})`;
            folderRow.appendChild(countSpan);

            group.appendChild(folderRow);

            // Collapsible file list container
            const fileList = document.createElement('div');
            fileList.className = 'pkg-tree-files';
            const collapsed = !defaultChecked || files.length > AUTO_COLLAPSE_THRESHOLD;
            if (collapsed) {
                fileList.classList.add('collapsed');
                arrow.textContent = '▶';
            }

            // Toggle collapse on arrow or folder name click
            const toggleCollapse = (e) => {
                // Don't toggle when clicking the checkbox
                if (e.target === folderCb) return;
                e.preventDefault();
                const isCollapsed = fileList.classList.toggle('collapsed');
                arrow.textContent = isCollapsed ? '▶' : '▼';
            };
            arrow.addEventListener('click', toggleCollapse);
            nameSpan.addEventListener('click', toggleCollapse);

            // File entries
            const fileCbs = [];
            for (const f of files) {
                const fileLabel = document.createElement('label');
                fileLabel.className = 'pkg-tree-file';
                const cb = document.createElement('input');
                cb.type = 'checkbox';
                cb.checked = defaultChecked;
                cb.dataset.path = f.path;
                fileLabel.appendChild(cb);
                fileLabel.appendChild(document.createTextNode(f.name));
                const sizeSpan = document.createElement('span');
                sizeSpan.className = 'pkg-tree-size';
                sizeSpan.textContent = this._formatSize(f.size);
                fileLabel.appendChild(sizeSpan);
                fileList.appendChild(fileLabel);
                fileCbs.push(cb);
            }

            group.appendChild(fileList);

            // Folder checkbox toggles all children
            folderCb.addEventListener('change', () => {
                for (const cb of fileCbs) cb.checked = folderCb.checked;
            });
            // Child unchecked → update folder state
            for (const cb of fileCbs) {
                cb.addEventListener('change', () => {
                    const allChecked = fileCbs.every(c => c.checked);
                    const someChecked = fileCbs.some(c => c.checked);
                    folderCb.checked = allChecked;
                    folderCb.indeterminate = !allChecked && someChecked;
                });
            }

            container.appendChild(group);
        }
    }

    /**
     * Format byte size for display.
     */
    _formatSize(bytes) {
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    }

    /**
     * Dispatch the workbook export based on modal selections.
     */
    async _doExportWorkbook() {
        const modal = document.getElementById('export-workbook-modal');
        const format = modal.querySelector('input[name="wb-export-format"]:checked').value;
        const scope = modal.querySelector('input[name="wb-export-scope"]:checked').value;

        if (format === 'srwb') {
            await this._exportSrwb(scope);
        } else if (format === 'ipynb') {
            const kernelSelect = document.getElementById('wb-export-kernel');
            const kernel = kernelSelect ? kernelSelect.value : 'auto';
            const archiveSelect = document.getElementById('wb-export-archive');
            const archiveFmt = archiveSelect ? archiveSelect.value : 'zip';
            await this._exportIpynb(scope, kernel, archiveFmt);
        } else if (format === 'package') {
            // Get checked files from the tree
            const tree = document.getElementById('wb-filetree');
            let includedPaths = null;
            if (tree) {
                const checked = tree.querySelectorAll('input[type="checkbox"][data-path]:checked');
                includedPaths = new Set(Array.from(checked).map(cb => cb.dataset.path));
            }
            const archiveSelect = document.getElementById('wb-export-archive');
            const archiveFmt = archiveSelect ? archiveSelect.value : 'zip';
            await this.exportPackage(includedPaths, archiveFmt);
        }
    }

    /**
     * Export as .srwb (SciREPL Workbook).
     */
    async _exportSrwb(scope) {
        const nm = window.notebookManager;
        if (!nm) {
            alert(this._t('fileIo.noNotebooksAvailable', 'No notebooks available.'));
            return;
        }

        if (scope === 'current') {
            const active = nm.getActiveNotebook();
            if (!active) {
                alert(this._t('fileIo.noActiveNotebook', 'No active notebook.'));
                return;
            }
            // Grab live cells for the active notebook
            active.cells = window._cells ? [...window._cells] : [];
            active.cellCounter = window._cellCounter || 0;
            const nb = active.toJSON();
            const srwb = {
                format: 'srwb',
                format_version: '1.0',
                exported_at: new Date().toISOString(),
                notebook: nb
            };
            const safeName = (nb.name || 'notebook').replace(/[^a-zA-Z0-9_\- ]/g, '_');
            await this.downloadFile(safeName + '.srwb', JSON.stringify(srwb, null, 2), 'application/json');
        } else {
            // All tabs
            const notebooks = nm.getNotebooks().map(nb => {
                if (nb.isActive) {
                    nb.cells = window._cells ? [...window._cells] : [];
                    nb.cellCounter = window._cellCounter || 0;
                }
                return nb.toJSON();
            });
            const srwb = {
                format: 'srwb',
                format_version: '1.0',
                exported_at: new Date().toISOString(),
                workbook: {
                    activeNotebookId: nm.getActiveNotebook() ? nm.getActiveNotebook().id : null,
                    notebooks: notebooks
                }
            };
            await this.downloadFile('workbook.srwb', JSON.stringify(srwb, null, 2), 'application/json');
        }
    }

    /**
     * Export as .ipynb with %%magic commands for non-default kernel cells.
     */
    async _exportIpynb(scope, kernelOverride, archiveFormat) {
        const nm = window.notebookManager;
        if (!nm) {
            alert(this._t('fileIo.noNotebooksAvailable', 'No notebooks available.'));
            return;
        }

        const exportOne = (nb) => {
            const cells = nb.isActive ? (window._cells || []) : (nb.cells || []);
            if (cells.length === 0) return null;

            // Determine default kernel
            let defaultKernel;
            if (kernelOverride && kernelOverride !== 'auto') {
                defaultKernel = kernelOverride;
            } else {
                // Use first code cell's language
                const firstCode = cells.find(c => c.type === 'code');
                defaultKernel = firstCode ? (firstCode.language || 'python') : 'python';
            }

            // Build cells with %%magic for non-default languages
            const nbCells = [];
            for (const cell of cells) {
                const source = cell.code.split('\n').map((line, j, arr) =>
                    j < arr.length - 1 ? line + '\n' : line
                );
                if (cell.type === 'markdown') {
                    nbCells.push({ cell_type: 'markdown', metadata: {}, source });
                    continue;
                }
                const cellLang = cell.language || 'python';
                const meta = {};
                let cellSource = source;
                if (cellLang !== defaultKernel) {
                    meta.scirepl_language = cellLang;
                    // Prepend %%magic command for Jupyter compatibility
                    cellSource = ['%%' + cellLang + '\n', ...source];
                }
                nbCells.push({
                    cell_type: 'code',
                    execution_count: null,
                    metadata: meta,
                    outputs: [],
                    source: cellSource
                });
            }

            const notebook = {
                nbformat: 4, nbformat_minor: 5,
                metadata: {
                    kernelspec: FileIO.IPYNB_KERNELSPEC[defaultKernel] || FileIO.IPYNB_KERNELSPEC.python,
                    language_info: FileIO.IPYNB_LANGUAGE_INFO[defaultKernel] || FileIO.IPYNB_LANGUAGE_INFO.python,
                    scirepl: { version: 'pro', exported_at: new Date().toISOString() }
                },
                cells: nbCells
            };

            return notebook;
        };

        if (scope === 'current') {
            const active = nm.getActiveNotebook();
            if (active) {
                const result = exportOne(active);
                if (result) {
                    const safeName = (active.name || 'notebook').replace(/[^a-zA-Z0-9_\- ]/g, '_');
                    await this.downloadFile(safeName + '.ipynb', JSON.stringify(result, null, 1), 'application/json');
                }
            }
        } else {
            // All tabs — bundle into a zip archive
            const notebooks = nm.getNotebooks();
            const files = [];
            for (const nb of notebooks) {
                const result = exportOne(nb);
                if (result) {
                    const safeName = (nb.name || 'notebook').replace(/[^a-zA-Z0-9_\- ]/g, '_');
                    files.push({ name: safeName + '.ipynb', content: JSON.stringify(result, null, 1) });
                }
            }
            if (files.length === 0) {
                alert(this._t('fileIo.noNotebooksWithCells',
                    'No notebooks with cells to export.'));
                return;
            }
            if (files.length === 1) {
                // Single tab — no need for archive
                await this.downloadFile(files[0].name, files[0].content, 'application/json');
            } else {
                const fmt = archiveFormat || 'zip';
                const workbookName = (nm.getActiveNotebook()?.name || 'notebooks').replace(/[^a-zA-Z0-9_\- ]/g, '_');

                if (fmt === 'tar' || fmt === 'tar.gz') {
                    if (typeof TarWriter === 'undefined') {
                        alert(this._t('fileIo.tarWriterArchiveUnavailable',
                            'TarWriter not available. Cannot create tar archive.'));
                        return;
                    }
                    const tar = new TarWriter();
                    for (const f of files) {
                        tar.addFile(f.name, f.content);
                    }
                    let data = tar.build();
                    let ext = '.tar';
                    if (fmt === 'tar.gz') {
                        data = await this._gzipCompress(data);
                        ext = '.tar.gz';
                    }
                    const blob = new Blob([data], { type: 'application/octet-stream' });
                    await this._downloadBlob(blob, workbookName + '_notebooks' + ext);
                } else {
                    // Default: zip
                    if (typeof JSZip === 'undefined') {
                        alert(this._t('fileIo.jsZipArchiveUnavailable',
                            'JSZip not loaded. Cannot create archive.'));
                        return;
                    }
                    const zip = new JSZip();
                    for (const f of files) {
                        zip.file(f.name, f.content);
                    }
                    const blob = await zip.generateAsync({ type: 'blob' });
                    await this._downloadBlob(blob, workbookName + '_notebooks.zip');
                }
            }
        }
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

        return {
            nbformat: 4,
            nbformat_minor: 5,
            metadata: {
                kernelspec: FileIO.IPYNB_KERNELSPEC[primaryLang] || FileIO.IPYNB_KERNELSPEC.python,
                language_info: FileIO.IPYNB_LANGUAGE_INFO[primaryLang] || FileIO.IPYNB_LANGUAGE_INFO.python,
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
        const isBinary = content instanceof Blob || content instanceof ArrayBuffer || content instanceof Uint8Array;

        // Try Capacitor native plugins (Android/iOS)
        if (window.Capacitor && Capacitor.Plugins) {
            try {
                const { Filesystem } = Capacitor.Plugins;
                const { Share } = Capacitor.Plugins;

                if (Filesystem && Share) {
                    let writeOpts;
                    if (isBinary) {
                        // Convert blob/arraybuffer to base64 for Capacitor
                        let base64;
                        if (content instanceof Blob) {
                            const ab = await content.arrayBuffer();
                            const bytes = new Uint8Array(ab);
                            let binary = '';
                            for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
                            base64 = btoa(binary);
                        } else {
                            const bytes = content instanceof Uint8Array ? content : new Uint8Array(content);
                            let binary = '';
                            for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
                            base64 = btoa(binary);
                        }
                        writeOpts = { path: filename, data: base64, directory: 'CACHE' };
                    } else {
                        writeOpts = { path: filename, data: content, directory: 'CACHE', encoding: 'utf8' };
                    }
                    const writeResult = await Filesystem.writeFile(writeOpts);

                    // Share the file
                    await Share.share({
                        title: filename,
                        url: writeResult.uri,
                        dialogTitle: this._t('fileIo.exportDialogTitle',
                            'Export {filename}', { filename })
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
            const isCDN = km.isNetworkRuntime(k.language);
            dot.className = 'memory-dot' + (!isCDN || (k.loaded && k.ready) ? ' loaded' : '');
            card.appendChild(dot);

            const info = document.createElement('div');
            info.className = 'memory-kernel-info';
            const nameEl = document.createElement('div');
            nameEl.className = 'memory-kernel-name';
            nameEl.textContent = k.name;
            info.appendChild(nameEl);
            const statusEl = document.createElement('div');
            statusEl.className = 'memory-kernel-status';
            const isBundled = !isCDN;
            if (isBundled) {
                this._setText(statusEl, 'fileIo.memoryBundled', 'Bundled');
            } else if (k.ready) {
                this._setText(statusEl, 'fileIo.memoryReady', 'Ready');
            } else {
                this._setText(statusEl, 'fileIo.memoryNotLoaded', 'Not loaded');
            }
            info.appendChild(statusEl);
            card.appendChild(info);

            const sizeEl = document.createElement('span');
            sizeEl.className = 'memory-kernel-size';
            sizeEl.textContent = k.memory != null ? this._formatBytes(k.memory) : '—';
            card.appendChild(sizeEl);

            // Load/Unload buttons for CDN kernels (not JavaScript/Bash)
            if (isCDN) {
                const runtimeInfo = KernelManager.RUNTIME_INFO[k.language];
                const btnWrap = document.createElement('div');
                btnWrap.className = 'memory-btn-wrap';

                if (k.loaded && k.ready) {
                    const btn = document.createElement('button');
                    btn.className = 'memory-unload-btn';
                    this._setText(btn, 'fileIo.unload', 'Unload');
                    btn.addEventListener('click', async () => {
                        this._setText(btn, 'fileIo.unloading', 'Unloading...');
                        btn.disabled = true;
                        await km.destroyKernel(k.language);
                        if (km.currentLanguage === k.language) {
                            const badge = document.getElementById('status-badge');
                            if (badge) {
                                this._setText(badge, 'fileIo.ready', 'ready');
                                badge.className = 'ready';
                            }
                        }
                        this._refreshMemoryModal();
                    });
                    btnWrap.appendChild(btn);
                } else {
                    const btn = document.createElement('button');
                    btn.className = 'memory-load-btn';
                    this._setText(btn, 'fileIo.load', 'Load');
                    btn.addEventListener('click', async () => {
                        this._setText(btn, 'fileIo.loading', 'Loading...');
                        btn.disabled = true;
                        try {
                            await km.ensureReady(k.language);
                        } catch (err) {
                            console.warn('Failed to load ' + k.language + ':', err);
                        }
                        this._refreshMemoryModal();
                    });
                    btnWrap.appendChild(btn);

                    // Show "Clear Cache" only for entries belonging to this
                    // runtime. Several runtimes share jsDelivr, so clearing by
                    // hostname would silently erase unrelated downloads.
                    if (runtimeInfo) {
                        try {
                            const hasCached = await km.hasRuntimeCacheEntries(k.language);
                            if (hasCached) {
                                const clearBtn = document.createElement('button');
                                clearBtn.className = 'memory-unload-btn';
                                this._setText(clearBtn, 'fileIo.clearCache', 'Clear Cache');
                                clearBtn.addEventListener('click', async () => {
                                    this._setText(clearBtn, 'fileIo.clearing', 'Clearing...');
                                    clearBtn.disabled = true;
                                    try {
                                        await km.clearRuntimeCache(k.language);
                                    } catch (e) {
                                        console.warn('Failed to clear cache for ' + k.language + ':', e);
                                    }
                                    this._refreshMemoryModal();
                                });
                                btnWrap.appendChild(clearBtn);
                            }
                        } catch (_) { }
                    }
                }

                card.appendChild(btnWrap);
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
        let swCacheBytes = 0;
        try {
            const cacheNames = await caches.keys();
            for (const name of cacheNames) {
                const cache = await caches.open(name);
                const keys = await cache.keys();
                for (const req of keys) {
                    const resp = await cache.match(req);
                    if (resp) {
                        const blob = await resp.clone().blob();
                        swCacheBytes += blob.size;
                    }
                }
            }
            document.getElementById('memory-sw-size').textContent = this._formatBytes(swCacheBytes);
        } catch (_) {
            document.getElementById('memory-sw-size').textContent = '—';
        }

        // localStorage size
        let lsBytes = 0;
        try {
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                lsBytes += (key.length + localStorage.getItem(key).length) * 2; // UTF-16
            }
            document.getElementById('memory-ls-size').textContent = this._formatBytes(lsBytes);
        } catch (_) {
            document.getElementById('memory-ls-size').textContent = '—';
        }

        // IndexedDB size (total storage minus SW cache and localStorage)
        try {
            const estimate = await navigator.storage.estimate();
            const idbSize = Math.max(0, (estimate.usage || 0) - swCacheBytes - lsBytes);
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

        // SciREPL workbook files
        if (file.name.endsWith('.srwb')) {
            const reader = new FileReader();
            reader.onload = (e) => this.importSrwb(e.target.result);
            reader.readAsText(file);
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
                    alert(this._t('fileIo.uploadedTo', 'Uploaded to {path}', { path: destPath }));
                } else {
                    alert(this._t('fileIo.sharedVfsUnavailable', 'SharedVFS not available.'));
                }
            } catch (err) {
                alert(this._t('fileIo.uploadFailed',
                    'Upload failed: {error}', { error: err.message }));
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
            alert(this._t('fileIo.kernelManagerUnavailable', 'Kernel manager not loaded.'));
            return;
        }

        // Ensure Prolog kernel is available
        const kernel = km.getKernel('prolog');
        if (!kernel || !kernel.getVFS || !kernel.getVFS()) {
            // Try to init Prolog first
            try {
                await km.ensureReady('prolog');
            } catch (err) {
                alert(this._t('fileIo.failedToLoadProlog',
                    'Failed to load Prolog kernel: {error}', { error: err.message }));
                return;
            }
        }

        const vfs = km.getKernel('prolog').getVFS();
        if (!vfs) {
            alert(this._t('fileIo.prologVfsUnavailable', 'Prolog VFS not available.'));
            return;
        }

        try {
            const buffer = await file.arrayBuffer();
            const paths = await vfs.mountZip(buffer);
            alert(this._t('fileIo.extractedFilesIntoUser',
                'Extracted {count} files from {filename} into /user/',
                { count: paths.length, filename: file.name }));
        } catch (err) {
            alert(this._t('fileIo.zipExtractionFailed',
                'ZIP extraction failed: {error}', { error: err.message }));
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

    /** Maximum UTF-8 payload accepted by the atomic workbook importer (8 MiB). */
    static WORKBOOK_IMPORT_MAX_BYTES = 8 * 1024 * 1024;

    async _workbookSha256(bytes) {
        if (!globalThis.crypto || !globalThis.crypto.subtle) {
            throw new Error('SHA-256 is unavailable in this browser.');
        }
        const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
        return Array.from(new Uint8Array(digest), byte =>
            byte.toString(16).padStart(2, '0')).join('');
    }

    _normalizeWorkbookLanguage(value, fallback = 'python') {
        const language = String(value || '').trim().toLowerCase();
        const supported = new Set([
            'python', 'prolog', 'javascript', 'bash', 'r', 'lua',
            'typr', 'clojurescript', 'markdown',
        ]);
        return supported.has(language) ? language : fallback;
    }

    _parseSrwbWorkbook(content) {
        const srwb = JSON.parse(content);
        if (!srwb || srwb.format !== 'srwb') {
            throw new Error('Serialized content is not a valid .srwb notebook.');
        }
        if (srwb.workbook) {
            throw new Error('Atomic import accepts one notebook; use the interactive importer for multi-tab .srwb files.');
        }
        if (!srwb.notebook || typeof srwb.notebook !== 'object'
            || !Array.isArray(srwb.notebook.cells)) {
            throw new Error('The .srwb file does not contain a notebook cell array.');
        }

        const data = srwb.notebook;
        const kernelLanguage = this._normalizeWorkbookLanguage(
            data.kernelLanguage, 'python');
        const usedCellIds = new Set();
        let nextCellId = 1;
        const claimCellId = value => {
            const requested = Number(value);
            if (Number.isSafeInteger(requested) && requested > 0
                && requested <= 1_000_000_000
                && !usedCellIds.has(requested)) {
                usedCellIds.add(requested);
                nextCellId = Math.max(nextCellId, requested + 1);
                return requested;
            }
            while (usedCellIds.has(nextCellId)) nextCellId++;
            const generated = nextCellId++;
            usedCellIds.add(generated);
            return generated;
        };

        return {
            data: {
                ...data,
                name: String(data.name || this._t(
                    'fileIo.importedNotebookName', 'Imported Notebook')),
                description: String(data.description || ''),
                kernelLanguage,
            },
            cells: data.cells.map(cell => ({
                id: claimCellId(cell && cell.id),
                code: String((cell && cell.code) || ''),
                type: cell && cell.type === 'markdown' ? 'markdown' : 'code',
                language: cell && cell.type === 'markdown' ? 'markdown'
                    : this._normalizeWorkbookLanguage(
                        cell && cell.language, kernelLanguage),
                name: String((cell && cell.name) || ''),
                lastOutput: String((cell && cell.lastOutput) || ''),
                lastOutputHtml: this._sanitizeImportedHtml(
                    (cell && cell.lastOutputHtml) || ''),
            })),
        };
    }

    _parseIpynbWorkbook(content) {
        const notebook = JSON.parse(content);
        if (!notebook || Number(notebook.nbformat) !== 4
            || !Array.isArray(notebook.cells)) {
            throw new Error('Serialized content is not a valid nbformat 4 .ipynb notebook.');
        }

        let notebookLanguage = 'python';
        const kernelspec = notebook.metadata && notebook.metadata.kernelspec;
        const languageInfo = notebook.metadata && notebook.metadata.language_info;
        const candidates = [kernelspec && kernelspec.language, languageInfo && languageInfo.name]
            .filter(Boolean).map(value => String(value).toLowerCase());
        if (kernelspec && kernelspec.name === 'swipl') candidates.unshift('prolog');
        const recognized = candidates
            .map(value => this._normalizeWorkbookLanguage(value, null)).find(Boolean);
        if (recognized) notebookLanguage = recognized;

        const cells = notebook.cells.map(cell => {
            const metadata = cell && cell.metadata && typeof cell.metadata === 'object'
                ? cell.metadata : {};
            let source = Array.isArray(cell && cell.source)
                ? cell.source.join('') : String((cell && cell.source) || '');
            let language = cell && cell.cell_type === 'markdown' ? 'markdown'
                : this._normalizeWorkbookLanguage(
                    metadata.scirepl_language, notebookLanguage);
            if (!cell || cell.cell_type !== 'markdown') {
                const magic = source.match(/^%%([a-z][\w-]*)\s*\r?\n/i);
                const magicLanguage = magic
                    ? this._normalizeWorkbookLanguage(magic[1], null) : null;
                if (magicLanguage) {
                    language = magicLanguage;
                    source = source.slice(magic[0].length);
                }
            }
            return {
                code: source,
                type: cell && cell.cell_type === 'markdown' ? 'markdown' : 'code',
                language,
                name: String(metadata.scirepl_name || ''),
                outputs: Array.isArray(cell && cell.outputs) ? cell.outputs : [],
            };
        });

        let name = this._t('fileIo.importedWorkbookName', 'Imported Workbook');
        const headingCell = cells.find(cell => cell.type === 'markdown');
        const heading = headingCell && headingCell.code.match(/^#\s+(.+)/m);
        if (heading) name = heading[1].trim();
        return {
            data: {
                name,
                description: '',
                kernelLanguage: notebookLanguage,
                cellCounter: cells.length,
            },
            cells,
        };
    }

    _clearNotebookForImport(notebook) {
        if (!notebook) return;
        const cells = notebook.isActive ? (window._cells || []) : (notebook.cells || []);
        for (const cell of cells) {
            if (cell.inputCard && cell.inputCard.remove) cell.inputCard.remove();
            if (cell.outputCard && cell.outputCard.remove) cell.outputCard.remove();
        }
        notebook.cells = [];
        notebook.cellCounter = 0;
        if (notebook.isActive) {
            window._cells = notebook.cells;
            window._cellCounter = 0;
        }
    }

    _snapshotWorkbook(notebook) {
        if (!notebook) return null;
        const cells = notebook.isActive ? (window._cells || []) : (notebook.cells || []);
        return {
            data: {
                name: notebook.name,
                autoNameNumber: notebook.autoNameNumber,
                description: notebook.description,
                kernelLanguage: notebook.kernelLanguage,
                catalogId: notebook.catalogId,
                catalogRevision: notebook.catalogRevision,
                catalogSourceId: notebook.catalogSourceId,
                catalogRef: notebook.catalogRef,
                catalogCommit: notebook.catalogCommit,
                catalogPath: notebook.catalogPath,
                catalogSha256: notebook.catalogSha256,
                cellCounter: notebook.isActive
                    ? (window._cellCounter || 0) : (notebook.cellCounter || 0),
            },
            cells: cells.map(cell => ({
                id: cell.id,
                code: cell.code,
                type: cell.type,
                language: cell.language,
                name: cell.name,
                lastOutput: cell.lastOutput,
                lastOutputHtml: cell.lastOutputHtml,
            })),
        };
    }

    /**
     * Keep imported rich output inert while retaining ordinary formatting,
     * local SVG fragment references, and embedded raster data images.
     */
    _sanitizeImportedHtml(value) {
        const template = document.createElement('template');
        template.innerHTML = String(value || '');
        template.content.querySelectorAll(
            'script,style,iframe,object,embed,link,meta,base,form,input,button,textarea,select,'
            + 'template,animate,set,animateMotion,animateTransform,discard'
        ).forEach(element => element.remove());
        template.content.querySelectorAll('*').forEach(element => {
            for (const attribute of [...element.attributes]) {
                const name = attribute.name.toLowerCase();
                const raw = attribute.value.toLowerCase()
                    .replace(/[\u0000-\u0020\u007f]+/g, '');
                const tag = element.localName.toLowerCase();
                const isSvg = element.namespaceURI === 'http://www.w3.org/2000/svg';
                const safeRasterDataImage = /^data:image\/(?:png|jpe?g|gif|webp|avif|bmp);base64,/i
                    .test(raw);
                const networkActiveSource = name === 'src'
                    && !(tag === 'img' && safeRasterDataImage);
                const networkActiveSvgReference = isSvg
                    && (name === 'href' || name === 'xlink:href')
                    && !raw.startsWith('#')
                    && !(tag === 'image' && safeRasterDataImage);
                if (name.startsWith('on') || name === 'srcdoc'
                    || name === 'srcset'
                    || name === 'poster'
                    || name === 'background'
                    || name === 'ping'
                    || networkActiveSource
                    || networkActiveSvgReference
                    || /url\s*\(/i.test(attribute.value)
                    || ((name === 'href' || name === 'src' || name === 'xlink:href')
                        && (raw.startsWith('javascript:') || raw.startsWith('vbscript:')
                            || raw.startsWith('data:text/html')
                            || raw.startsWith('data:image/svg+xml')))
                    || (name === 'style'
                        && /(?:javascript:|expression\s*\(|url\s*\(|@import|behavior\s*:)/i
                            .test(attribute.value))) {
                    element.removeAttribute(attribute.name);
                }
            }
        });
        return template.innerHTML;
    }

    _sanitizeJupyterOutputs(outputs) {
        return (outputs || []).map(output => {
            if (!output || typeof output !== 'object') return output;
            const clean = { ...output };
            if (output.data && typeof output.data === 'object') {
                clean.data = { ...output.data };
                for (const mimeType of ['text/html', 'image/svg+xml']) {
                    if (!Object.prototype.hasOwnProperty.call(clean.data, mimeType)) continue;
                    const html = Array.isArray(clean.data[mimeType])
                        ? clean.data[mimeType].join('') : clean.data[mimeType];
                    clean.data[mimeType] = [this._sanitizeImportedHtml(html)];
                }
            }
            return clean;
        });
    }

    _renderImportedNotebook(notebook, data, cellDefs, options = {}) {
        const trustedSnapshot = options.trustedSnapshot === true;
        const preserveIds = trustedSnapshot || options.preserveIds === true;
        const nm = window.notebookManager;
        const app = window._appInternals;
        if (!nm || !app || !app.createInputCard || !app.createOutputCard) {
            throw new Error('SciREPL is not ready to import a notebook.');
        }
        if (!notebook.isActive) nm.switchTo(notebook.id);

        this._clearNotebookForImport(notebook);
        notebook.name = String(data.name
            || this._t('fileIo.importedNotebookName', 'Imported Notebook'));
        notebook.autoNameNumber = data.autoNameNumber ?? null;
        notebook.description = String(data.description || '');
        notebook.kernelLanguage = this._normalizeWorkbookLanguage(
            data.kernelLanguage, null);

        // Catalogue provenance is trusted only when restoring the app's own
        // pre-import snapshot. Remote serialized content cannot claim it.
        notebook.catalogId = trustedSnapshot ? (data.catalogId || null) : null;
        notebook.catalogRevision = trustedSnapshot ? (data.catalogRevision ?? null) : null;
        notebook.catalogSourceId = trustedSnapshot ? (data.catalogSourceId || null) : null;
        notebook.catalogRef = trustedSnapshot ? (data.catalogRef || null) : null;
        notebook.catalogCommit = trustedSnapshot ? (data.catalogCommit || null) : null;
        notebook.catalogPath = trustedSnapshot ? (data.catalogPath || null) : null;
        notebook.catalogSha256 = trustedSnapshot ? (data.catalogSha256 || null) : null;

        for (const def of cellDefs) {
            const snapshotId = preserveIds && Number.isSafeInteger(def.id) && def.id > 0
                ? def.id : null;
            const cellId = snapshotId || (window._cellCounter + 1);
            window._cellCounter = Math.max(window._cellCounter, cellId);
            const type = def.type === 'markdown' ? 'markdown' : 'code';
            const language = type === 'markdown' ? 'markdown'
                : this._normalizeWorkbookLanguage(
                    def.language, notebook.kernelLanguage || 'python');
            const code = String(def.code || '');
            const outputHtml = trustedSnapshot
                ? String(def.lastOutputHtml || '')
                : this._sanitizeImportedHtml(def.lastOutputHtml || '');
            const inputCard = app.createInputCard(code, cellId, type, language);
            const outputCard = app.createOutputCard(cellId, type);
            const cell = {
                id: cellId,
                code,
                type,
                language,
                name: String(def.name || ''),
                lastOutput: String(def.lastOutput || ''),
                lastOutputHtml: outputHtml,
                inputCard,
                outputCard,
            };
            window._cells.push(cell);

            if (cell.name && window.notebookVFS && window.notebookVFS._setCellName) {
                window.notebookVFS._setCellName(window._cells.length - 1, cell.name);
            }
            if (type === 'markdown') {
                const body = outputCard.querySelector('.card-body');
                if (body) body.innerHTML = this._sanitizeImportedHtml(app.renderMarkdown(code));
                const pre = inputCard.querySelector('pre');
                if (pre) pre.style.display = 'none';
            } else if (Array.isArray(def.outputs) && def.outputs.length
                && window.renderJupyterOutputs) {
                window.renderJupyterOutputs(
                    this._sanitizeJupyterOutputs(def.outputs), outputCard);
                const body = outputCard.querySelector('.card-body');
                if (body) {
                    cell.lastOutput = body.textContent || '';
                    cell.lastOutputHtml = body.innerHTML || '';
                }
            } else if (cell.lastOutputHtml || cell.lastOutput) {
                const body = outputCard.querySelector('.card-body');
                if (body) {
                    if (cell.lastOutputHtml) body.innerHTML = cell.lastOutputHtml;
                    else body.textContent = cell.lastOutput;
                }
            } else {
                outputCard.remove();
                cell.outputCard = null;
            }
        }

        const requestedCounter = Number(data.cellCounter);
        if (Number.isSafeInteger(requestedCounter) && requestedCounter > 0
            && requestedCounter <= 1_000_000_000) {
            window._cellCounter = Math.max(window._cellCounter, requestedCounter);
        }
        notebook.cells = window._cells;
        notebook.cellCounter = window._cellCounter;
        nm.renderSelector();
    }

    /**
     * Import one serialized notebook without executing any cell. Size, hash,
     * parsing, and structural checks complete before notebook state changes.
     */
    async importWorkbook(content, options = {}) {
        if (typeof content !== 'string') {
            throw new Error('Workbook content must be a UTF-8 JSON string.');
        }
        const format = String(options.format || '').toLowerCase();
        const mode = String(options.mode || 'replace').toLowerCase();
        if (!['srwb', 'ipynb'].includes(format)) {
            throw new Error(`Unsupported workbook format: ${format || '(missing)'}`);
        }
        if (!['create', 'replace'].includes(mode)) {
            throw new Error(`Unsupported import mode: ${mode}`);
        }

        const bytes = new TextEncoder().encode(content);
        if (bytes.byteLength > FileIO.WORKBOOK_IMPORT_MAX_BYTES) {
            throw new Error(`Workbook is ${bytes.byteLength} bytes; the import limit is ${FileIO.WORKBOOK_IMPORT_MAX_BYTES} bytes.`);
        }
        if (options.size !== undefined) {
            const expectedSize = Number(options.size);
            if (!Number.isSafeInteger(expectedSize) || expectedSize < 0) {
                throw new Error('Workbook expected size must be a non-negative integer.');
            }
            if (expectedSize !== bytes.byteLength) {
                throw new Error('Workbook size does not match the supplied size.');
            }
        }

        const sha256 = await this._workbookSha256(bytes);
        if (options.sha256) {
            const expectedSha256 = String(options.sha256).toLowerCase();
            if (!/^[0-9a-f]{64}$/.test(expectedSha256)) {
                throw new Error('Workbook SHA-256 must be a 64-character hexadecimal digest.');
            }
            if (expectedSha256 !== sha256) {
                throw new Error('Workbook SHA-256 does not match the supplied digest.');
            }
        }

        // Parsing and structural validation happen before any mutation.
        const prepared = format === 'srwb'
            ? this._parseSrwbWorkbook(content) : this._parseIpynbWorkbook(content);
        const nm = window.notebookManager;
        if (!nm) throw new Error('NotebookManager is not available.');

        const previous = nm.getActiveNotebook();
        const snapshot = this._snapshotWorkbook(previous);
        let target = previous;
        let created = false;

        try {
            if (mode === 'create' || !target) {
                target = nm.createNotebook({ name: prepared.data.name });
                created = true;
            }
            this._renderImportedNotebook(
                target, prepared.data, prepared.cells,
                { preserveIds: format === 'srwb' });
            nm.saveState();
        } catch (error) {
            try {
                if (created && target) {
                    if (previous) nm.switchTo(previous.id);
                    if (nm.getNotebooks().length > 1) nm.removeNotebook(target.id);
                } else if (snapshot && previous) {
                    this._renderImportedNotebook(
                        previous, snapshot.data, snapshot.cells,
                        { trustedSnapshot: true });
                    nm.saveState();
                }
            } catch (rollbackError) {
                console.error('[importWorkbook] rollback failed:', rollbackError);
            }
            throw error;
        }

        return {
            ok: true,
            format,
            mode: created ? 'create' : 'replace',
            notebookId: target.id,
            name: target.name,
            cells: prepared.cells.length,
            size: bytes.byteLength,
            sha256,
        };
    }

    /**
     * Import a .ipynb file — create cells and execute them.
     * If window.importCells is available (set by app.js), uses it to
     * create proper cells. Otherwise falls back to textarea.
     */
    /**
     * Import a .srwb file — create notebook tab(s) and load cells.
     * Supports both single-notebook and multi-notebook (workbook) format.
     */
    importSrwb(jsonContent) {
        try {
            const srwb = JSON.parse(jsonContent);
            if (srwb.format !== 'srwb') {
                alert(this._t('fileIo.invalidSrwb', 'Not a valid .srwb file.'));
                return;
            }

            const nm = window.notebookManager;
            if (!nm) {
                alert(this._t('fileIo.notebookManagerUnavailable',
                    'NotebookManager not available.'));
                return;
            }

            const autoExec = localStorage.getItem('scirepl_auto_execute') === '1';
            const autoSwitch = localStorage.getItem('scirepl_auto_switch_workbook') !== '0';

            const app = window._appInternals;
            if (!app || !app.createInputCard || !app.createOutputCard) {
                console.error('[importSrwb] window._appInternals not available');
                alert(this._t('fileIo.appNotReady',
                    'App not fully initialized. Please try again.'));
                return;
            }

            // Render cells into a notebook using the same approach as restoreSession
            const renderCells = (nb, cellDefs) => {
                nm.switchTo(nb.id);

                window._cells.length = 0;
                window._cellCounter = 0;

                for (const def of cellDefs) {
                    window._cellCounter++;
                    const cellId = window._cellCounter;
                    const language = def.language || nb.kernelLanguage || 'python';

                    const inputCard = app.createInputCard(def.code, cellId, def.type, language);
                    const outputCard = app.createOutputCard(cellId, def.type);

                    const cell = {
                        id: cellId,
                        code: def.code,
                        type: def.type || 'code',
                        language: language,
                        name: def.name || '',
                        inputCard: inputCard,
                        outputCard: outputCard
                    };
                    window._cells.push(cell);

                    // Register cell name with NotebookVFS
                    if (def.name && window.notebookVFS && window.notebookVFS._setCellName) {
                        window.notebookVFS._setCellName(window._cells.length - 1, def.name);
                    }

                    if (def.type === 'markdown') {
                        const body = outputCard.querySelector('.card-body');
                        if (body) body.innerHTML = app.renderMarkdown(def.code);
                        const pre = inputCard.querySelector('pre');
                        if (pre) pre.style.display = 'none';
                    } else {
                        // Code cell — remove empty output card
                        outputCard.remove();
                        cell.outputCard = null;
                    }
                }

                nb.cells = [...window._cells];
                nb.cellCounter = window._cellCounter;
            };

            const loadNotebook = (nbData) => {
                const nb = nm.createNotebook({
                    name: nbData.name || this._t(
                        'fileIo.importedNotebookName', 'Imported Notebook'),
                    description: nbData.description || '',
                    kernelLanguage: nbData.kernelLanguage || null
                });

                const cellDefs = (nbData.cells || []).map(c => ({
                    code: c.code,
                    type: c.type || 'code',
                    language: c.language || nbData.kernelLanguage || 'python',
                    name: c.name || ''
                }));

                renderCells(nb, cellDefs);
                return nb;
            };

            if (srwb.notebook) {
                const nb = loadNotebook(srwb.notebook);
                if (autoSwitch) nm.switchTo(nb.id);
            } else if (srwb.workbook && srwb.workbook.notebooks) {
                let targetNb = null;
                for (const nbData of srwb.workbook.notebooks) {
                    const nb = loadNotebook(nbData);
                    // Switch to the originally active notebook, or first one
                    if (nbData.id === srwb.workbook.activeNotebookId) targetNb = nb;
                    if (!targetNb) targetNb = nb;
                }
                if (autoSwitch && targetNb) nm.switchTo(targetNb.id);
            }

            nm.saveState();
        } catch (e) {
            console.error('[importSrwb] Error:', e.message, e.stack);
            alert(this._t('fileIo.srwbImportFailed',
                'Failed to import .srwb file: {error}', { error: e.message }));
        }
    }

    importIpynb(jsonContent) {
        try {
            const nb = JSON.parse(jsonContent);
            const extractedCells = [];

            // Detect notebook-level language from kernelspec
            let notebookLang = 'python';
            const knownLangs = new Set(['python', 'prolog', 'javascript', 'bash', 'r', 'lua', 'clojurescript']);
            if (nb.metadata && nb.metadata.kernelspec) {
                const ks = nb.metadata.kernelspec;
                if (ks.language && knownLangs.has(ks.language)) {
                    notebookLang = ks.language;
                } else if (ks.name === 'swipl') {
                    notebookLang = 'prolog';
                }
            }
            if (nb.metadata && nb.metadata.language_info) {
                const li = nb.metadata.language_info;
                if (li.name && knownLangs.has(li.name)) {
                    notebookLang = li.name;
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
                alert(this._t('fileIo.noCellsInNotebook', 'No cells found in notebook.'));
                return;
            }

            // Apply Prolog search paths from notebook metadata
            if (nb.metadata && nb.metadata.scirepl && nb.metadata.scirepl.prolog_paths) {
                this._applyPrologPaths(nb.metadata.scirepl.prolog_paths);
            }

            // Create a new notebook tab for the imported workbook
            const nm = window.notebookManager;
            const autoSwitch = localStorage.getItem('scirepl_auto_switch_workbook') !== '0';
            let prevNbId = null;
            if (nm && nm.createNotebook) {
                // Extract name from first markdown heading, or fall back
                let wbName = this._t('fileIo.importedWorkbookName', 'Imported Workbook');
                const firstMd = extractedCells.find(c => c.type === 'markdown');
                if (firstMd) {
                    const headingMatch = firstMd.code.match(/^#\s+(.+)/m);
                    if (headingMatch) wbName = headingMatch[1].trim();
                }
                if (!autoSwitch) {
                    const prev = nm.getActiveNotebook && nm.getActiveNotebook();
                    if (prev) prevNbId = prev.id;
                }
                const newNb = nm.createNotebook({ name: wbName });
                // Must switch so importCells targets the right notebook
                nm.switchTo(newNb.id);
            }

            // Use the cell import API if available; return the promise
            // so callers (e.g. package catalog) can await completion.
            if (window.importCells) {
                const autoExec = localStorage.getItem('scirepl_auto_execute') === '1';
                const p = window.importCells(extractedCells, { autoExecute: autoExec });
                // Switch back to previous notebook after import completes
                if (prevNbId && nm) {
                    return p.then(() => nm.switchTo(prevNbId));
                }
                return p;
            } else {
                // Fallback: dump code cells into textarea
                const codeOnly = extractedCells
                    .filter(c => c.type === 'code')
                    .map(c => c.code);
                this.importPython(codeOnly.join('\n\n# -- Cell --\n\n'));
                if (prevNbId && nm) nm.switchTo(prevNbId);
            }
        } catch (e) {
            console.error(e);
            alert(this._t('fileIo.ipynbParseFailed', 'Failed to parse .ipynb file.'));
        }
    }

    // ---- Language Settings ----

    /**
     * Language metadata: id → {label, abbrev}.
     * Order determines display order in dropdowns and the Languages modal.
     */
    static LANGUAGE_META = [
        { id: 'python',     label: 'Python',     abbrev: 'Py' },
        { id: 'r',          label: 'R',           abbrev: 'R' },
        { id: 'prolog',     label: 'Prolog',      abbrev: 'PL' },
        { id: 'bash',       label: 'Bash',        abbrev: 'Sh' },
        { id: 'javascript', label: 'JavaScript',  abbrev: 'JS' },
        { id: 'lua',        label: 'Lua',         abbrev: 'Lua' },
        { id: 'typr',       label: 'TypR',        abbrev: 'TyR' },
        { id: 'clojurescript', label: 'ClojureScript', abbrev: 'CLJS' },
    ];

    /**
     * Canonical ipynb export metadata for every supported language.
     * Single source of truth for the kernelspec / language_info written by
     * exportNotebook, the package exporter, and _buildIpynb — keep complete:
     * a language missing here silently exports with a python3 kernelspec.
     */
    static IPYNB_KERNELSPEC = {
        python:     { display_name: 'Python 3 (Pyodide)', language: 'python', name: 'python3' },
        r:          { display_name: 'R (webR)', language: 'r', name: 'ir' },
        prolog:     { display_name: 'SWI-Prolog (WASM)', language: 'prolog', name: 'swipl' },
        bash:       { display_name: 'Bash', language: 'bash', name: 'bash' },
        javascript: { display_name: 'JavaScript (Browser)', language: 'javascript', name: 'javascript' },
        lua:        { display_name: 'Lua (Fengari)', language: 'lua', name: 'lua' },
        typr:       { display_name: 'TypR', language: 'typr', name: 'typr' },
        clojurescript: { display_name: 'ClojureScript (Scittle)', language: 'clojurescript', name: 'clojurescript' },
    };

    static IPYNB_LANGUAGE_INFO = {
        python:     { name: 'python', version: '3.12', mimetype: 'text/x-python', file_extension: '.py' },
        r:          { name: 'R', version: '4.x', mimetype: 'text/x-r', file_extension: '.r' },
        prolog:     { name: 'prolog', version: '9.x', mimetype: 'text/x-prolog', file_extension: '.pl' },
        bash:       { name: 'bash', version: '5.x', mimetype: 'text/x-sh', file_extension: '.sh' },
        javascript: { name: 'javascript', version: 'ES2022', mimetype: 'text/javascript', file_extension: '.js' },
        lua:        { name: 'lua', version: '5.3', mimetype: 'text/x-lua', file_extension: '.lua' },
        typr:       { name: 'typr', version: '0.x', mimetype: 'text/x-typr', file_extension: '.ty' },
        clojurescript: { name: 'clojurescript', version: '1.x', mimetype: 'text/x-clojure', file_extension: '.cljs' },
    };

    /**
     * Per-kernel version override metadata for the Languages modal.
     * Each entry's settingKey is read by the kernel at init time;
     * leaving the input blank uses the kernel's pinned default.  Version values
     * are validated separately from the custom source URL setting.
     */
    static KERNEL_VERSION_META = {
        r: {
            settingKey: 'scirepl_webr_version',
            example: 'v0.5.4',
        },
        prolog: {
            settingKey: 'scirepl_swipl_version',
            example: '3/8/2',
        },
    };

    _testedRuntimeVersion(langId) {
        const cfg = window.KERNEL_CONFIG?.languages?.[langId] || {};
        return String(cfg.versionTag || cfg.versionSelector || cfg.version || '');
    }

    _normalizeRuntimeVersion(langId, value) {
        const version = String(value || '').trim();
        if (!version) return version;
        if (langId === 'r') {
            if (version === 'latest') return version;
            if (/^v?\d+\.\d+\.\d+$/.test(version)) {
                return version.startsWith('v') ? version : 'v' + version;
            }
        }
        if (langId === 'prolog') {
            if (/^3\.\d+\.\d+$/.test(version)) return version.replaceAll('.', '/');
            if (/^\d+\/\d+$/.test(version)) return '3/' + version;
            if (/^3\/\d+\/\d+$/.test(version)) return version;
        }
        const example = FileIO.KERNEL_VERSION_META[langId]?.example || '1.2.3';
        const key = langId === 'prolog'
            ? 'fileIo.runtimeInvalidPrologVersion'
            : 'fileIo.runtimeInvalidVersion';
        const fallback = langId === 'prolog'
            ? 'Invalid version. Use a selector such as {example}; use Check latest for the newest compatible 3.x release, or the separate source override for a custom URL.'
            : 'Invalid version. Use {example} or "latest"; use the separate source override for a custom URL.';
        throw new Error(this._t(key, fallback,
            { example }));
    }

    _latestRuntimeSpec(langId) {
        return window.KERNEL_CONFIG?.languages?.[langId]?.versionMetadata || null;
    }

    _versionFromMetadata(langId, spec, data) {
        if (spec.strategy === 'dist-tag-latest') {
            const version = String(data?.tags?.latest || '');
            if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('latest tag is not a stable semantic version');
            return this._normalizeRuntimeVersion(langId, version);
        }
        if (spec.strategy === 'highest-stable-compatible-major') {
            const major = Number(spec.compatibleMajor);
            const versions = (Array.isArray(data?.versions) ? data.versions : [])
                .filter(version => /^\d+\.\d+\.\d+$/.test(version))
                .map(version => ({
                    version,
                    parts: version.split('.').map(Number),
                }))
                .filter(item => item.parts[0] === major)
                .sort((a, b) => b.parts[0] - a.parts[0]
                    || b.parts[1] - a.parts[1]
                    || b.parts[2] - a.parts[2]);
            if (!versions.length) throw new Error(`no stable compatible ${major}.x release`);
            return this._normalizeRuntimeVersion(langId, versions[0].version);
        }
        throw new Error(`unknown metadata strategy: ${spec.strategy || '<missing>'}`);
    }

    async _checkLatestRuntime(langId, { requestConsent = false, force = false } = {}) {
        const spec = this._latestRuntimeSpec(langId);
        if (!spec?.url) return;

        if (!window.kernelManager?.hasCurrentPrivacyConsent?.()) {
            if (!requestConsent) return;
            try {
                if (!window.kernelManager?._ensurePrivacyConsent) return;
                await window.kernelManager._ensurePrivacyConsent({ requireCurrentRevision: true });
            } catch (_) {
                return; // Dismissing consent must not make a registry request.
            }
        }

        if (this._latestRuntimeRequests.has(langId)) {
            return this._latestRuntimeRequests.get(langId);
        }
        const existing = this._latestRuntimeMetadata.get(langId);
        if (!force && (existing?.status === 'available' || existing?.status === 'unavailable')) return;

        this._latestRuntimeMetadata.set(langId, { status: 'checking' });
        this._refreshRuntimeVersionStatus(langId);
        const request = (async () => {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 8000);
            try {
                const response = await fetch(spec.url, {
                    signal: controller.signal,
                    cache: 'no-store',
                    credentials: 'omit',
                    referrerPolicy: 'no-referrer',
                });
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                const version = this._versionFromMetadata(langId, spec, await response.json());
                this._latestRuntimeMetadata.set(langId, { status: 'available', version });
            } catch (error) {
                console.warn(`[RuntimeMetadata] ${langId}: latest lookup failed`, error);
                this._latestRuntimeMetadata.set(langId, { status: 'unavailable' });
            } finally {
                clearTimeout(timer);
                this._latestRuntimeRequests.delete(langId);
                this._refreshRuntimeVersionStatus(langId);
            }
        })();
        this._latestRuntimeRequests.set(langId, request);
        return request;
    }

    _refreshRuntimeVersionStatuses() {
        for (const langId of Object.keys(FileIO.KERNEL_VERSION_META)) {
            this._refreshRuntimeVersionStatus(langId);
        }
    }

    _refreshRuntimeVersionStatus(langId) {
        const wrap = document.querySelector(`[data-runtime-status="${langId}"]`);
        if (!wrap) return;

        const versionMeta = FileIO.KERNEL_VERSION_META[langId];
        const testedVersion = this._testedRuntimeVersion(langId);
        const sourceOverride = localStorage.getItem(`scirepl_${langId}_source`);
        const versionOverride = localStorage.getItem(versionMeta.settingKey);
        let selected = sourceOverride || versionOverride || testedVersion;
        if (selected === 'latest') {
            selected = this._t('fileIo.runtimeRollingUnverified',
                '{version} (rolling/unverified)', { version: selected });
        }

        this._setText(wrap.querySelector('[data-runtime-tested]'),
            'fileIo.runtimeTestedVersion', 'Tested: {version}', { version: testedVersion });
        this._setText(wrap.querySelector('[data-runtime-selected]'),
            'fileIo.runtimeSelectedVersion', 'Selected: {version}', { version: selected });

        const latest = this._latestRuntimeMetadata.get(langId) || { status: 'not-checked' };
        const latestNode = wrap.querySelector('[data-runtime-latest]');
        if (latest.status === 'available') {
            this._setText(latestNode, 'fileIo.runtimeLatestAvailable',
                'Latest available: {version}', { version: latest.version });
        } else if (latest.status === 'checking') {
            this._setText(latestNode, 'fileIo.runtimeLatestChecking', 'Latest available: checking…');
        } else if (latest.status === 'unavailable') {
            this._setText(latestNode, 'fileIo.runtimeLatestUnavailable', 'Latest available: unavailable');
        } else {
            this._setText(latestNode, 'fileIo.runtimeLatestNotChecked', 'Latest available: not checked');
        }

        const loaded = window.kernelManager?.getRuntimeSessionSource?.(langId);
        const loadedVersionNode = wrap.querySelector('[data-runtime-loaded-version]');
        const loadedSourceNode = wrap.querySelector('[data-runtime-loaded-source]');
        if (loaded) {
            const loadedVersion = loaded.version || this._t(
                'fileIo.runtimeVersionUnknown', 'Unknown');
            this._setText(loadedVersionNode, 'fileIo.runtimeLoadedVersion',
                'Loaded version: {version}', { version: loadedVersion });
            this._setText(loadedSourceNode, 'fileIo.runtimeLoadedSource',
                'Loaded source: {source}', { source: loaded.source });
        } else {
            const notLoaded = this._t('fileIo.runtimeNotLoaded', 'Not loaded this session');
            this._setText(loadedVersionNode, 'fileIo.runtimeLoadedVersion',
                'Loaded version: {version}', { version: notLoaded });
            this._setText(loadedSourceNode, 'fileIo.runtimeLoadedSource',
                'Loaded source: {source}', { source: notLoaded });
        }

        const reset = wrap.querySelector('[data-runtime-use-tested]');
        if (reset) reset.disabled = !sourceOverride && !versionOverride;
        const check = wrap.querySelector('[data-runtime-check-latest]');
        if (check) {
            check.hidden = latest.status === 'available';
            check.disabled = latest.status === 'checking';
        }
        const useLatest = wrap.querySelector('[data-runtime-use-latest]');
        if (useLatest) {
            useLatest.hidden = latest.status !== 'available';
            useLatest.disabled = latest.status !== 'available';
        }
        const latestRisk = wrap.querySelector('[data-runtime-latest-risk]');
        if (latestRisk) {
            latestRisk.hidden = latest.status !== 'available' || latest.version === testedVersion;
        }
    }

    /**
     * Whether a language is enabled BY DEFAULT in the active build profile.
     * Reads window.KERNEL_CONFIG (generated by the build). This is only the
     * default on/off + bundling state — a language the profile doesn't enable
     * by default is NOT forbidden; the user can turn it on in the Languages
     * modal and it loads from the CDN on first use. Read lazily — the config
     * script loads after file_io.js, so never cache this at construction.
     */
    _isLanguageAvailable(langId) {
        const cfg = (typeof window !== 'undefined' && window.KERNEL_CONFIG
            && window.KERNEL_CONFIG.languages && window.KERNEL_CONFIG.languages[langId]);
        return !cfg || cfg.enabled !== false;
    }

    /**
     * LANGUAGE_META for the languages the build profile enables BY DEFAULT
     * (and bundles). Used only for the default enabled set — NOT a hard filter,
     * so e.g. `mini` ships a lean default selector without permanently hiding
     * python/r/prolog (the user can still enable them → loaded via CDN).
     */
    _availableLanguageMeta() {
        return FileIO.LANGUAGE_META.filter(l => this._isLanguageAvailable(l.id));
    }

    /**
     * Get the set of enabled language IDs. A saved user choice is respected
     * as-is (any language, including ones the profile doesn't enable by default
     * — those load via CDN). With no saved choice, defaults to the profile's
     * default-on set.
     */
    _getEnabledLanguages() {
        const allIds = new Set(FileIO.LANGUAGE_META.map(l => l.id));
        const stored = localStorage.getItem('scirepl_enabled_languages');
        if (stored) {
            try {
                const set = new Set([...JSON.parse(stored)].filter(id => allIds.has(id)));
                if (set.size > 0) return set;
            } catch (_) {}
        }
        return new Set(this._availableLanguageMeta().map(l => l.id));
    }

    _saveEnabledLanguages(enabledSet) {
        localStorage.setItem('scirepl_enabled_languages', JSON.stringify([...enabledSet]));
    }

    /**
     * Populate the Languages modal with checkboxes for each registered language.
     */
    _populateLanguagesModal() {
        const list = document.getElementById('languages-list');
        if (!list) return;

        const enabled = this._getEnabledLanguages();
        list.innerHTML = '';

        // Show every language so the user can enable any of them — including ones
        // the build profile doesn't ship by default (those load from the CDN).
        for (const lang of FileIO.LANGUAGE_META) {
            const row = document.createElement('div');
            row.className = 'settings-item';

            const label = document.createElement('label');
            label.className = 'language-toggle-label';
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.className = 'lang-toggle';
            cb.dataset.lang = lang.id;
            cb.checked = enabled.has(lang.id);
            label.appendChild(cb);
            label.appendChild(document.createTextNode(lang.label));

            // Show runtime size hint for CDN kernels
            const info = KernelManager.RUNTIME_INFO[lang.id];
            if (info) {
                const hint = document.createElement('span');
                hint.className = 'export-format-desc';
                hint.textContent = ' ' + info.size;
                label.appendChild(hint);
            }
            row.appendChild(label);

            // Version override input for kernels that support it.
            // Setting key + default version per kernel.
            const versionMeta = FileIO.KERNEL_VERSION_META[lang.id];
            if (versionMeta) {
                row.classList.add('language-runtime-item');
                const versionWrap = document.createElement('span');
                versionWrap.className = 'kernel-version-wrap';
                versionWrap.dataset.runtimeStatus = lang.id;

                const testedVersion = this._testedRuntimeVersion(lang.id);
                const controls = document.createElement('span');
                controls.className = 'kernel-version-controls';

                const input = document.createElement('input');
                input.type = 'text';
                input.className = 'kernel-version-input';
                input.dataset.lang = lang.id;
                input.dataset.settingKey = versionMeta.settingKey;
                input.placeholder = testedVersion;
                const inputTitleKey = lang.id === 'prolog'
                    ? 'fileIo.prologVersionInputTitle'
                    : 'fileIo.versionInputTitle';
                const inputTitleFallback = lang.id === 'prolog'
                    ? 'Package selector (tested: {defaultVersion}). Use Check latest for the newest compatible 3.x release. Reload after changing.'
                    : 'Version (default: {defaultVersion}). Use "latest" for the rolling release. Reload page after changing.';
                this._setTitle(input, inputTitleKey, inputTitleFallback,
                    { defaultVersion: testedVersion });
                input.value = (typeof localStorage !== 'undefined'
                    && localStorage.getItem(versionMeta.settingKey)) || '';
                input.addEventListener('change', (e) => {
                    const previous = localStorage.getItem(versionMeta.settingKey) || '';
                    try {
                        const v = this._normalizeRuntimeVersion(lang.id, e.target.value);
                        e.target.setCustomValidity('');
                        e.target.value = v;
                        if (v) localStorage.setItem(versionMeta.settingKey, v);
                        else localStorage.removeItem(versionMeta.settingKey);
                    } catch (error) {
                        e.target.value = previous;
                        e.target.setCustomValidity(error.message);
                        e.target.reportValidity();
                    }
                    this._refreshRuntimeVersionStatus(lang.id);
                });

                const useTested = document.createElement('button');
                useTested.type = 'button';
                useTested.className = 'vfs-btn';
                useTested.dataset.runtimeUseTested = '';
                this._setText(useTested, 'fileIo.runtimeUseTestedVersion', 'Use tested version');
                useTested.addEventListener('click', () => {
                    localStorage.removeItem(versionMeta.settingKey);
                    localStorage.removeItem(`scirepl_${lang.id}_source`);
                    input.value = '';
                    input.setCustomValidity('');
                    sourceInput.value = '';
                    sourceInput.setCustomValidity('');
                    this._refreshRuntimeVersionStatus(lang.id);
                    const message = versionWrap.querySelector('[data-runtime-reset-message]');
                    this._setText(message, 'fileIo.runtimeUseTestedVersionReload',
                        'Tested version selected. Reload the app to apply it.');
                });

                controls.appendChild(input);
                controls.appendChild(useTested);
                versionWrap.appendChild(controls);

                const sourceDetails = document.createElement('details');
                sourceDetails.className = 'kernel-source-details';
                sourceDetails.dataset.runtimeSourceDetails = '';
                const sourceSummary = document.createElement('summary');
                this._setText(sourceSummary, 'fileIo.runtimeAdvancedSourceOverride',
                    'Advanced source override');
                sourceDetails.appendChild(sourceSummary);
                const sourceWarning = document.createElement('small');
                sourceWarning.className = 'export-format-desc kernel-source-warning';
                sourceWarning.style.display = 'block';
                this._setText(sourceWarning, 'fileIo.runtimeCustomSourceWarning',
                    'A custom runtime is executable code with access to notebook data. Use only sources you trust.');
                sourceDetails.appendChild(sourceWarning);

                const sourceLabel = document.createElement('label');
                sourceLabel.className = 'export-format-desc kernel-source-label';
                const sourceLabelText = document.createElement('span');
                this._setText(sourceLabelText, 'fileIo.runtimeSourceOverride', 'Custom source');
                sourceLabel.appendChild(sourceLabelText);

                const sourceInput = document.createElement('input');
                sourceInput.type = 'text';
                sourceInput.className = 'kernel-source-input';
                sourceInput.dataset.lang = lang.id;
                sourceInput.dataset.settingKey = `scirepl_${lang.id}_source`;
                const hasLocalSource = (window.KERNEL_CONFIG?.languages?.[lang.id]?.sources || [])
                    .some(source => source?.type === 'local' && source.url);
                const sourcePlaceholderKey = hasLocalSource
                    ? 'fileIo.runtimeSourceInputPlaceholder'
                    : 'fileIo.runtimeSourceInputPlaceholderUrl';
                const sourcePlaceholderFallback = hasLocalSource
                    ? 'Custom source URL or local'
                    : 'Custom source URL';
                sourceInput.placeholder = this._t(sourcePlaceholderKey, sourcePlaceholderFallback);
                sourceInput.dataset.i18nPlaceholder = sourcePlaceholderKey;
                const sourceTitleKey = hasLocalSource
                    ? 'fileIo.runtimeSourceInputTitle'
                    : 'fileIo.runtimeSourceInputTitleUrl';
                const sourceTitleFallback = hasLocalSource
                    ? 'Custom runtime source URL or "local". Leave blank to use the selected version. Reload after changing.'
                    : 'Custom runtime source URL. Leave blank to use the selected version. Reload after changing.';
                this._setTitle(sourceInput, sourceTitleKey, sourceTitleFallback);
                sourceInput.value = localStorage.getItem(sourceInput.dataset.settingKey) || '';
                const electronCustomSourceAllowlist = window.sciREPLPlatform?.runtimeSourceAllowlist;
                const customSourceUiAllowed = !window.sciREPLPlatform
                    || (Array.isArray(electronCustomSourceAllowlist)
                        && Object.isFrozen(electronCustomSourceAllowlist));
                sourceInput.disabled = !customSourceUiAllowed;
                if (!customSourceUiAllowed) {
                    sourceDetails.open = true;
                    sourceDetails.classList.add('is-disabled');
                    sourceDetails.dataset.runtimeSourcePolicyNotice = '';
                    sourceSummary.setAttribute('aria-disabled', 'true');
                    sourceSummary.addEventListener('click', (event) => event.preventDefault());
                    this._setText(sourceWarning, 'kernelManager.runtimeSourceElectronBlocked',
                        'Custom runtime sources are disabled by the Electron host policy.');
                }
                sourceInput.addEventListener('change', (event) => {
                    const previous = localStorage.getItem(sourceInput.dataset.settingKey) || '';
                    const value = event.target.value.trim();
                    try {
                        const normalized = window.kernelManager.validateRuntimeSourceOverride(
                            lang.id, value);
                        event.target.setCustomValidity('');
                        event.target.value = normalized;
                        if (normalized) localStorage.setItem(
                            sourceInput.dataset.settingKey, normalized);
                        else localStorage.removeItem(sourceInput.dataset.settingKey);
                    } catch (error) {
                        event.target.value = previous;
                        event.target.setCustomValidity(error.message
                            || this._t(sourceTitleKey, sourceTitleFallback));
                        event.target.reportValidity();
                    }
                    this._refreshRuntimeVersionStatus(lang.id);
                });
                sourceLabel.appendChild(sourceInput);
                if (customSourceUiAllowed) sourceDetails.appendChild(sourceLabel);
                versionWrap.appendChild(sourceDetails);

                for (const attribute of ['tested', 'latest', 'selected', 'loadedVersion', 'loadedSource']) {
                    const status = document.createElement('small');
                    status.className = 'export-format-desc kernel-runtime-status-line';
                    status.dataset[`runtime${attribute[0].toUpperCase()}${attribute.slice(1)}`] = '';
                    versionWrap.appendChild(status);
                }

                const latestActions = document.createElement('span');
                latestActions.className = 'kernel-latest-actions';
                const checkLatest = document.createElement('button');
                checkLatest.type = 'button';
                checkLatest.className = 'vfs-btn';
                checkLatest.dataset.runtimeCheckLatest = '';
                this._setText(checkLatest, 'fileIo.runtimeCheckLatest', 'Check latest');
                checkLatest.addEventListener('click', () => {
                    void this._checkLatestRuntime(lang.id, { requestConsent: true, force: true });
                });
                const useLatest = document.createElement('button');
                useLatest.type = 'button';
                useLatest.className = 'vfs-btn';
                useLatest.dataset.runtimeUseLatest = '';
                useLatest.hidden = true;
                this._setText(useLatest, 'fileIo.runtimeUseLatestAvailable', 'Use latest available');
                useLatest.addEventListener('click', () => {
                    const latest = this._latestRuntimeMetadata.get(lang.id);
                    if (latest?.status !== 'available') return;
                    localStorage.setItem(versionMeta.settingKey, latest.version);
                    localStorage.removeItem(`scirepl_${lang.id}_source`);
                    input.value = latest.version;
                    input.setCustomValidity('');
                    sourceInput.value = '';
                    sourceInput.setCustomValidity('');
                    this._refreshRuntimeVersionStatus(lang.id);
                    const message = versionWrap.querySelector('[data-runtime-reset-message]');
                    this._setText(message, 'fileIo.runtimeUseLatestReload',
                        'Latest available version selected. Reload the app to apply it.');
                });
                latestActions.appendChild(checkLatest);
                latestActions.appendChild(useLatest);
                versionWrap.appendChild(latestActions);

                const latestRisk = document.createElement('small');
                latestRisk.className = 'export-format-desc kernel-runtime-status-line';
                latestRisk.dataset.runtimeLatestRisk = '';
                this._setText(latestRisk, 'fileIo.runtimeLatestRisk',
                    'Latest available is not tested with this SciREPL release and may break runtimes, packages, or workbooks.');
                versionWrap.appendChild(latestRisk);

                const resetMessage = document.createElement('small');
                resetMessage.className = 'export-format-desc kernel-runtime-status-line';
                resetMessage.dataset.runtimeResetMessage = '';
                versionWrap.appendChild(resetMessage);
                row.appendChild(versionWrap);
            }

            list.appendChild(row);
            if (versionMeta) {
                this._refreshRuntimeVersionStatus(lang.id);
                if (window.kernelManager?.hasCurrentPrivacyConsent?.()) {
                    void this._checkLatestRuntime(lang.id);
                }
            }
        }

        // Hint about reloading
        const note = document.createElement('p');
        note.className = 'export-format-desc';
        note.style.marginTop = '0.75em';
        this._setText(note, 'fileIo.versionChangesNote',
            'Version changes apply on next page reload. Leave blank to use the tested default. For R, "latest" selects a rolling unverified release; for Prolog, use Check latest to select the newest compatible 3.x release.');
        list.appendChild(note);
    }

    /**
     * Handle language enable/disable toggle.
     */
    _onLanguageToggle(langId, checked) {
        const enabled = this._getEnabledLanguages();
        if (checked) {
            enabled.add(langId);
        } else {
            // Don't allow disabling all languages
            if (enabled.size <= 1) {
                const cb = document.querySelector(`.lang-toggle[data-lang="${langId}"]`);
                if (cb) cb.checked = true;
                return;
            }
            enabled.delete(langId);
        }
        this._saveEnabledLanguages(enabled);
        this._rebuildLanguageDropdowns();
    }

    /**
     * Language selectors show the abbreviation when closed and
     * "Py - Python" once the list is open.
     *
     * A native <select> renders the same text in its closed control and in
     * its open list, so there is no markup that says one thing in each. The
     * option text is therefore swapped as the list opens and restored when it
     * closes. Wiring is delegated from the document so selects built later —
     * every new cell builds its own — need no registration, and the full name
     * is looked up from LANGUAGE_META by option value, so it does not matter
     * which of the construction paths produced the option.
     */
    _languageSelectFrom(target) {
        return (target && target.closest)
            ? target.closest('#lang-selector, .cell-lang-switch')
            : null;
    }

    _expandLanguageSelect(sel) {
        // Pin the closed width first. The control is sized to its widest
        // option, so widening the text would push the composer controls
        // sideways for as long as the list is open.
        if (!sel.dataset.collapsedWidth) {
            const w = Math.ceil(sel.getBoundingClientRect().width);
            if (w > 0) sel.dataset.collapsedWidth = String(w);
        }
        if (sel.dataset.collapsedWidth) sel.style.width = `${sel.dataset.collapsedWidth}px`;

        for (const opt of sel.options) {
            const meta = FileIO.LANGUAGE_META.find(l => l.id === opt.value);
            if (!meta) continue;                       // unknown id: leave alone
            if (!opt.dataset.abbrev) opt.dataset.abbrev = opt.textContent;
            // "R - R" and "Lua - Lua" read as a mistake, so a language whose
            // abbreviation is already its name is shown once.
            opt.textContent = meta.abbrev === meta.label
                ? meta.label
                : `${meta.abbrev} - ${meta.label}`;
        }
    }

    _collapseLanguageSelect(sel) {
        for (const opt of sel.options) {
            if (opt.dataset.abbrev) opt.textContent = opt.dataset.abbrev;
        }
        sel.style.width = '';
    }

    _wireLanguageSelectorNames() {
        const expand = (e) => {
            const sel = this._languageSelectFrom(e.target);
            if (sel) this._expandLanguageSelect(sel);
        };
        const collapse = (e) => {
            const sel = this._languageSelectFrom(e.target);
            if (sel) this._collapseLanguageSelect(sel);
        };
        document.addEventListener('mousedown', expand, true);
        document.addEventListener('touchstart', expand, { capture: true, passive: true });
        document.addEventListener('keydown', (e) => {
            // Escape and Tab close the list rather than open it.
            if (e.key === 'Escape' || e.key === 'Tab') { collapse(e); return; }
            expand(e);
        }, true);
        document.addEventListener('change', collapse, true);
        document.addEventListener('focusout', collapse, true);
    }

    /**
     * Rebuild all language selector dropdowns based on enabled set.
     */
    _rebuildLanguageDropdowns() {
        const enabled = this._getEnabledLanguages();
        const meta = FileIO.LANGUAGE_META.filter(l => enabled.has(l.id));
        if (meta.length === 0) return; // nothing to show (shouldn't happen — js/bash always ship)

        // Main footer selector
        const mainSel = document.getElementById('lang-selector');
        if (mainSel) {
            const curVal = mainSel.value;
            mainSel.innerHTML = '';
            for (const l of meta) {
                const opt = document.createElement('option');
                opt.value = l.id;
                opt.textContent = l.abbrev;
                mainSel.appendChild(opt);
            }
            // Restore selection if still enabled, else pick first
            if (enabled.has(curVal)) {
                mainSel.value = curVal;
            } else {
                mainSel.value = meta[0].id;
                if (window.kernelManager) window.kernelManager.setLanguage(meta[0].id);
            }
            if (window.notifyComposerContextChanged) window.notifyComposerContextChanged();
        }

        // Cell-level dropdowns (existing cells in the DOM)
        document.querySelectorAll('.cell-lang-switch').forEach(sel => {
            const curVal = sel.value;
            sel.innerHTML = '';
            for (const l of meta) {
                const opt = document.createElement('option');
                opt.value = l.id;
                opt.textContent = l.abbrev;
                sel.appendChild(opt);
            }
            if (enabled.has(curVal)) {
                sel.value = curVal;
            } else {
                sel.value = meta[0].id;
            }
        });
    }
}

// Initialize only after DOM ready (already ensured by script placement at end of body)
window.fileIO = new FileIO();
