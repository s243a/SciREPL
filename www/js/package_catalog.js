/**
 * package_catalog.js — Browse and install packages, bundles, and workbooks.
 *
 * A lightweight catalog of curated packages (.zip) and workbook templates
 * (.ipynb) that users can install with one click.
 */

class PackageCatalog {
    constructor() {
        this.modal = document.getElementById('package-catalog-modal');
        this.listEl = document.getElementById('package-catalog-list');
        this._init();
    }

    /**
     * The catalog.  Add entries here to make them available to users.
     * Each entry needs: id, name, description, and a type-specific source.
     * type: 'package' (default, .zip), 'bundle' (a set of catalog entries),
     * or 'workbook' (.ipynb/.srwb).
     */
    get packages() {
        return [
            {
                id: 'unifyweaver-scirepl',
                name: 'UnifyWeaver SciREPL',
                description: 'Physics knowledge-base notebooks with Prolog inference, embedding search, and mindmap tools.',
                type: 'package',
                version: 'v0.11.0',
                url: 'https://github.com/s243a/SciREPL/releases/download/v0.11.0/unifyweaver_scirepl.zip',
                pages_url: 'packages/unifyweaver_scirepl.zip',
                size: '~2 MB',
                kernels: ['prolog', 'python'],
            },
            {
                id: 'unifyweaver-workbooks',
                name: 'UnifyWeaver Tutorials & Compiler Demos',
                description: 'The four workbooks declared by UnifyWeaver\'s SciREPL package builder: three tutorials and the Prolog-to-R compiler demo.',
                type: 'bundle',
                size: '~50 KB',
                contents: '4 workbooks',
                kernels: ['prolog', 'r', 'bash'],
                requires: ['unifyweaver-scirepl'],
                items: [
                    'unifyweaver-family-tree',
                    'unifyweaver-recursion-patterns',
                    'unifyweaver-call-graph',
                    'prolog-generates-r',
                ],
            },
            {
                id: 'unifyweaver-family-tree',
                name: 'Family Tree Tutorial with UnifyWeaver',
                notebookName: 'Family Tree Tutorial with UnifyWeaver',
                description: 'Build and query a family-tree knowledge base while learning UnifyWeaver and Prolog fundamentals.',
                type: 'workbook',
                revision: 1,
                pages_url: 'workbooks/01_family_tree_tutorial.ipynb',
                size: '~10 KB',
                kernels: ['prolog'],
                requires: ['unifyweaver-scirepl'],
            },
            {
                id: 'unifyweaver-recursion-patterns',
                name: 'Advanced Recursion Patterns in UnifyWeaver',
                notebookName: 'Advanced Recursion Patterns in UnifyWeaver',
                description: 'Explore recursive predicates and the compilation patterns UnifyWeaver recognizes.',
                type: 'workbook',
                revision: 1,
                pages_url: 'workbooks/02_recursion_patterns.ipynb',
                size: '~15 KB',
                kernels: ['prolog'],
                requires: ['unifyweaver-scirepl'],
            },
            {
                id: 'unifyweaver-call-graph',
                name: 'Call Graph Analysis and SCC Detection',
                notebookName: 'Call Graph Analysis and SCC Detection',
                description: 'Analyze predicate call graphs and strongly connected components with UnifyWeaver.',
                type: 'workbook',
                revision: 2,
                pages_url: 'workbooks/03_call_graph_analysis.ipynb',
                size: '~13 KB',
                kernels: ['prolog'],
                requires: ['unifyweaver-scirepl'],
            },
            {
                id: 'prolog-generates-r',
                name: 'Prolog Generates R',
                notebookName: 'Prolog Generates R: Compiler Demo',
                description: 'Compile recursive Prolog predicates into executable R and inspect the generated program through notebook cells.',
                type: 'workbook',
                revision: 1,
                format: 'srwb',
                pages_url: 'workbooks/prolog-generates-r.srwb',
                size: '~13 KB',
                kernels: ['prolog', 'r', 'bash'],
                requires: ['unifyweaver-scirepl'],
            },
            {
                id: 'prolog-generates-lua',
                name: 'Prolog Generates Lua',
                notebookName: 'Prolog Generates Lua: Compiler Demo',
                description: 'Compile a Prolog transitive closure to Lua using a named query source cell, embedded or notebook-VFS facts, and direct Lua cell I/O.',
                type: 'workbook',
                revision: 2,
                format: 'srwb',
                pages_url: 'workbooks/prolog-generates-lua.srwb',
                size: '~6 KB',
                kernels: ['prolog', 'lua'],
                requires: ['unifyweaver-scirepl'],
            },
            {
                id: 'prolog-generates-clojurescript',
                name: 'Prolog Generates ClojureScript',
                notebookName: 'Prolog Generates ClojureScript: Compiler Demo',
                description: 'Compile a Prolog transitive closure to browser-runnable ClojureScript, then query the generated definitions in Scittle.',
                type: 'workbook',
                revision: 1,
                format: 'srwb',
                pages_url: 'workbooks/prolog-generates-clojurescript.srwb',
                size: '~5 KB',
                kernels: ['prolog', 'clojurescript'],
                requires: ['unifyweaver-scirepl'],
            },
            {
                id: 'life-expectancy-analysis',
                name: 'Life Expectancy Analysis',
                description: 'Mixed Python/R workbook: Gapminder & WHO datasets with pandas, plotly, and R base graphics.',
                type: 'workbook',
                revision: 1,
                url: 'https://github.com/s243a/SciREPL/releases/download/v0.7.0/life_expectancy_csv_demo.ipynb',
                pages_url: 'workbooks/life_expectancy_csv_demo.ipynb',
                size: '~8 KB',
                kernels: ['python', 'r'],
            },
            {
                id: 'compute-pi-archimedean',
                name: 'Compute Pi with Archimedean Bounds',
                notebookName: 'Compute Pi: Archimedean Bounds',
                description: 'Squeeze pi between inscribed and circumscribed polygon bounds using a stable, non-circular side-doubling recurrence.',
                type: 'workbook',
                revision: 1,
                format: 'srwb',
                pages_url: 'workbooks/compute-pi-workbook.srwb',
                size: '~6 KB',
                kernels: ['python'],
            },
            {
                id: 'ggplot2-showcase',
                name: 'ggplot2 Showcase',
                description: 'Scatter, bar, density, box, and heatmap charts with ggplot2 dark theme. Uses built-in R datasets.',
                type: 'workbook',
                url: 'https://github.com/s243a/SciREPL/releases/download/v0.8.0/r_ggplot2_showcase.ipynb',
                pages_url: 'workbooks/r_ggplot2_showcase.ipynb',
                size: '~5 KB',
                kernels: ['r'],
            },
            {
                id: 'tidyverse-data-wrangling',
                name: 'Tidyverse Data Wrangling',
                description: 'dplyr/tidyr pipelines with cross-language CSV sharing: Python downloads, R processes, Python visualizes.',
                type: 'workbook',
                revision: 1,
                url: 'https://github.com/s243a/SciREPL/releases/download/v0.8.0/r_tidyverse_wrangling.ipynb',
                pages_url: 'workbooks/r_tidyverse_wrangling.ipynb',
                size: '~6 KB',
                kernels: ['python', 'r'],
            },
            {
                id: 'statistics-with-r',
                name: 'Statistics with R',
                description: 'Hypothesis testing (t-test, chi-squared, ANOVA), regression, confidence intervals, and diagnostic plots.',
                type: 'workbook',
                revision: 1,
                url: 'https://github.com/s243a/SciREPL/releases/download/v0.8.0/r_statistics.ipynb',
                pages_url: 'workbooks/r_statistics.ipynb',
                size: '~5 KB',
                kernels: ['r'],
            },
            {
                id: 'lua-tables-coroutines',
                name: 'Lua: Tables, Coroutines & Closures',
                description: 'Tour of Lua\'s core features — tables as universal data structure, coroutines for cooperative multitasking, closures, custom iterators, and a lazy Stream library.',
                type: 'workbook',
                format: 'srwb',
                pages_url: 'workbooks/lua-tables-coroutines.srwb',
                size: '~12 KB',
                kernels: ['lua'],
            },
            {
                id: 'lua-parsing-coroutines',
                name: 'Lua: Parsing with Coroutines',
                description: 'Build a calculator from scratch — coroutine lexer, recursive descent parser, AST evaluator, parser combinators, and a CSV parser. No external libraries.',
                type: 'workbook',
                revision: 1,
                format: 'srwb',
                pages_url: 'workbooks/lua-parsing-coroutines.srwb',
                size: '~14 KB',
                kernels: ['lua'],
            },
            {
                id: 'typr-introduction',
                name: 'TypR Introduction',
                notebookName: 'TypR Introduction',
                description: 'Typed R superset — variable binding, functions, type annotations, variadic calls, and source/type-check/transpiler directives. Compiles to R via WASM.',
                type: 'workbook',
                revision: 1,
                format: 'srwb',
                url: 'https://github.com/s243a/SciREPL/releases/download/v0.11.0/typr-intro.srwb',
                pages_url: 'workbooks/typr-intro.srwb',
                size: '~2 KB',
                kernels: ['typr', 'r'],
            },
            {
                id: 'prolog-generates-typr',
                name: 'Prolog Generates TypR',
                notebookName: 'Prolog Generates TypR: Compiler Demo',
                description: 'Compile a Prolog transitive-closure predicate to typed TypR, then execute the generated code with native variadic output calls.',
                type: 'workbook',
                format: 'srwb',
                revision: 4,
                pages_url: 'workbooks/prolog-generates-typr.srwb',
                size: '~5 KB',
                kernels: ['prolog', 'typr', 'r'],
                requires: ['unifyweaver-scirepl'],
            },
        ];
    }

    _init() {
        // Open catalog from menu
        const browseBtn = document.getElementById('btn-browse-packages');
        if (browseBtn) {
            browseBtn.addEventListener('click', () => {
                document.getElementById('menu-modal')?.classList.add('hidden');
                this._render();
                this.modal.classList.remove('hidden');
            });
        }

        // Close modal
        if (this.modal) {
            this.modal.addEventListener('click', (e) => {
                if (e.target === this.modal || e.target.classList.contains('modal-close')) {
                    this.modal.classList.add('hidden');
                }
            });
        }
    }

    _render() {
        if (!this.listEl) return;
        const all = this.packages;

        if (all.length === 0) {
            this.listEl.innerHTML = '<p>No items available.</p>';
            return;
        }

        const packages = all.filter(p => (p.type || 'package') === 'package');
        const bundles = all.filter(p => p.type === 'bundle');
        const workbooks = all.filter(p => p.type === 'workbook');

        let html = '';
        if (packages.length > 0) {
            html += '<h3 class="catalog-section-header">Packages</h3>';
            html += packages.map((pkg) => this._renderCard(pkg, all.indexOf(pkg))).join('');
        }
        if (bundles.length > 0) {
            html += '<h3 class="catalog-section-header">Bundles</h3>';
            html += bundles.map((pkg) => this._renderCard(pkg, all.indexOf(pkg))).join('');
        }
        if (workbooks.length > 0) {
            html += '<h3 class="catalog-section-header">Workbooks</h3>';
            html += workbooks.map((pkg) => this._renderCard(pkg, all.indexOf(pkg))).join('');
        }

        this.listEl.innerHTML = html;

        // Attach install handlers
        this.listEl.querySelectorAll('.pkg-install-btn').forEach(btn => {
            btn.addEventListener('click', () => this._install(btn));
        });
    }

    _renderCard(pkg, idx) {
        const installed = this._isInstalled(pkg);
        const dependencyNames = (pkg.requires || [])
            .map(ref => this._findEntry(ref)?.name || ref)
            .join(', ');
        return `
            <div class="pkg-card ${pkg.type === 'bundle' ? 'pkg-bundle-card' : ''}">
                <div class="pkg-info">
                    <strong>${this._esc(pkg.name)}</strong>
                    ${pkg.version ? `<span class="pkg-version">${this._esc(pkg.version)}</span>` : ''}
                    ${pkg.size ? `<span class="pkg-size">${this._esc(pkg.size)}</span>` : ''}
                    ${pkg.contents ? `<span class="pkg-contents">${this._esc(pkg.contents)}</span>` : ''}
                    ${pkg.kernels ? `<span class="pkg-kernels">${pkg.kernels.map(k => this._esc(k)).join(', ')}</span>` : ''}
                    <p>${this._esc(pkg.description)}</p>
                    ${dependencyNames ? `<small class="pkg-requires">Requires: ${this._esc(dependencyNames)}</small>` : ''}
                </div>
                <button class="pkg-install-btn${installed ? ' pkg-installed' : ''}" data-idx="${idx}"${installed ? ' disabled' : ''}>${installed ? 'Installed' : 'Install'}</button>
            </div>
        `;
    }

    _findEntry(ref) {
        return this.packages.find(p => p.id === ref || p.name === ref);
    }

    _installedPackages() {
        try {
            const list = JSON.parse(localStorage.getItem('scirepl_installed_packages') || '[]');
            return Array.isArray(list) ? list : [];
        } catch (_) {
            return [];
        }
    }

    _isInstalled(pkg) {
        return this._installState(pkg) === 'current';
    }

    _installState(pkg) {
        if (!pkg) return 'missing';

        if ((pkg.type || 'package') === 'package') {
            return this._installedPackages().some(saved =>
                saved && (saved.id === pkg.id || saved.name === pkg.name)) ? 'current' : 'missing';
        }

        if (pkg.type === 'workbook') {
            const notebooks = window.notebookManager?.getNotebooks?.() || [];
            const expectedName = pkg.notebookName || pkg.name;
            const matches = notebooks.filter(nb => nb && nb.name === expectedName);
            if (matches.length === 0) return 'missing';
            if (pkg.revision == null) return 'current';
            return matches.some(nb =>
                nb.catalogId === pkg.id &&
                String(nb.catalogRevision) === String(pkg.revision)
            ) ? 'current' : 'outdated';
        }

        if (pkg.type === 'bundle') {
            const dependenciesInstalled = (pkg.requires || []).every(ref =>
                this._isInstalled(this._findEntry(ref)));
            const itemStates = (pkg.items || []).map(ref =>
                this._installState(this._findEntry(ref)));
            if (dependenciesInstalled && itemStates.every(state => state === 'current')) {
                return 'current';
            }
            return itemStates.some(state => state === 'outdated') ? 'outdated' : 'missing';
        }

        return 'missing';
    }

    _syncInstallButtons() {
        if (!this.listEl) return;
        const all = this.packages;
        this.listEl.querySelectorAll('.pkg-install-btn').forEach(btn => {
            const pkg = all[parseInt(btn.dataset.idx, 10)];
            const state = this._installState(pkg);
            btn.textContent = state === 'current' ? 'Installed' : (state === 'outdated' ? 'Update' : 'Install');
            btn.disabled = state === 'current';
            btn.classList.toggle('pkg-installed', state === 'current');
        });
    }

    async _fetchCatalogItem(pkg) {
        if (!pkg || pkg.type === 'bundle') return null;

        let blob = null;
        let lastError = null;
        if (pkg.pages_url) {
            try {
                blob = await this._fetchPackage(pkg.pages_url);
            } catch (e) {
                lastError = e;
                console.warn('[PackageCatalog] bundled fetch failed, trying release URL:', e);
            }
        }
        if (!blob && pkg.url) {
            try {
                blob = await this._fetchPackage(pkg.url);
            } catch (e) {
                lastError = e;
            }
        }
        if (!blob) {
            throw lastError || new Error('No download source for ' + pkg.name);
        }
        return blob;
    }

    /**
     * Install a package, bundle, or workbook. Downloads start immediately,
     * but imports are queued so notebook state stays consistent.
     */
    async _install(btn) {
        const idx = parseInt(btn.dataset.idx, 10);
        const pkg = this.packages[idx];
        if (!pkg) return;
        if (this._isInstalled(pkg)) {
            this._syncInstallButtons();
            return;
        }

        btn.disabled = true;
        btn.textContent = pkg.type === 'bundle' ? 'Preparing...' : 'Downloading...';

        // 1. Download (concurrent — multiple downloads can run at once)
        //    Prefer the locally-bundled copy (reliable + offline, and on the
        //    Pro build it's the up-to-date one); fall back to the remote release
        //    URL only if there's no bundled copy or it fails.
        let blob = null;
        try {
            blob = await this._fetchCatalogItem(pkg);
        } catch (err) {
            console.error('[PackageCatalog] Download failed:', err);
            btn.textContent = 'Failed';
            btn.disabled = false;
            setTimeout(() => { btn.textContent = 'Install'; }, 3000);
            return;
        }

        // 2. Queue the import (sequential — avoids notebook state races)
        this._importQueue = this._importQueue || [];
        btn.textContent = this._importRunning ? 'Queued...' : 'Importing...';
        this._importQueue.push({ btn, pkg, blob });

        if (this._importRunning) return; // will be processed in order
        this._importRunning = true;

        while (this._importQueue.length > 0) {
            const job = this._importQueue.shift();
            job.btn.textContent = 'Importing...';
            try {
                await this._ensureDependencies(job.pkg);
                await this._doImport(job.pkg, job.blob);
                this._rememberInstalled(job.pkg);
                this._syncInstallButtons();
            } catch (err) {
                console.error('[PackageCatalog] Import failed:', err);
                job.btn.textContent = 'Failed';
                job.btn.disabled = false;
                setTimeout(() => this._syncInstallButtons(), 3000);
            }
        }

        this._importRunning = false;

        // Close modal after all installs finish (if auto-switch is on)
        const autoSwitch = localStorage.getItem('scirepl_auto_switch_workbook') !== '0';
        if (autoSwitch && this.modal) {
            setTimeout(() => this.modal.classList.add('hidden'), 500);
        }
    }

    /**
     * Remember a successfully installed package so its supporting
     * files (which mount into the ephemeral in-memory Prolog VFS) can be
     * re-mounted on a later app launch. Workbooks are skipped — they persist as
     * notebooks already.
     */
    _rememberInstalled(pkg) {
        if (!pkg || (pkg.type || 'package') !== 'package') return;
        if (!pkg.pages_url && !pkg.url) return; // need a re-fetchable source
        try {
            const key = 'scirepl_installed_packages';
            const list = JSON.parse(localStorage.getItem(key) || '[]');
            if (!list.some(p => p && (p.id === pkg.id || p.name === pkg.name))) {
                list.push({ id: pkg.id || null, name: pkg.name, pages_url: pkg.pages_url || null, url: pkg.url || null });
                localStorage.setItem(key, JSON.stringify(list));
            }
        } catch (e) {
            console.warn('[PackageCatalog] could not remember installed package:', e);
        }
    }

    /**
     * Install package dependencies declared by a workbook before importing it.
     * Remembered packages are restored to the Prolog VFS when that kernel first
     * starts, so they do not need to be downloaded again here.
     */
    async _ensureDependencies(pkg) {
        if (!pkg || !Array.isArray(pkg.requires)) return;

        for (const ref of pkg.requires) {
            const dependency = this._findEntry(ref);
            if (!dependency || (dependency.type || 'package') !== 'package') {
                throw new Error('Unknown package dependency: ' + ref);
            }
            if (this._isInstalled(dependency)) continue;

            const blob = await this._fetchCatalogItem(dependency);

            await this._doImport(dependency, blob);
            this._rememberInstalled(dependency);
            this._syncInstallButtons();
            console.log('[PackageCatalog] installed dependency:', dependency.name);
        }
    }

    /**
     * Re-mount every remembered package's supporting files into the Prolog VFS.
     * Called once per session when the Prolog kernel first runs, so installed
     * packages (e.g. the UnifyWeaver library) are present after an app restart
     * without the user re-installing them. Notebooks are NOT recreated.
     */
    async restoreInstalledToProlog() {
        if (this._restoredToProlog) return;
        this._restoredToProlog = true;
        let list;
        try { list = JSON.parse(localStorage.getItem('scirepl_installed_packages') || '[]'); }
        catch (_) { list = []; }
        if (!Array.isArray(list) || list.length === 0) return;
        if (!window.packageLoader || !window.packageLoader.remountFromFile) return;

        for (const pkg of list) {
            try {
                const blob = await this._fetchForRestore(pkg);
                if (!blob) { console.warn('[PackageCatalog] no source to restore', pkg.name); continue; }
                const file = new File([blob], (pkg.name || 'package') + '.zip', { type: 'application/zip' });
                await window.packageLoader.remountFromFile(file);
                console.log('[PackageCatalog] restored package to Prolog VFS:', pkg.name);
            } catch (e) {
                console.warn('[PackageCatalog] restore failed for', pkg && pkg.name, e);
            }
        }
    }

    /**
     * Fetch a remembered package's archive for restore. Prefer the locally
     * bundled copy (pages_url — offline-capable), fall back to the release URL.
     */
    async _fetchForRestore(pkg) {
        const candidates = [];
        if (pkg.pages_url) candidates.push(pkg.pages_url);
        if (pkg.url) candidates.push(pkg.url);
        for (const u of candidates) {
            try {
                const r = await fetch(u);
                if (r.ok) return await r.blob();
            } catch (_) { /* try next candidate */ }
        }
        return null;
    }

    /**
     * Perform the actual import for a single package, bundle, or workbook.
     * Returns a promise that resolves when the import is fully complete.
     */
    async _doImport(pkg, blob) {
        if (pkg.type === 'bundle') {
            for (const ref of pkg.items || []) {
                const item = this._findEntry(ref);
                if (!item || item.type !== 'workbook') {
                    throw new Error('Unknown workbook in bundle: ' + ref);
                }
                if (this._isInstalled(item)) continue;

                await this._ensureDependencies(item);
                const itemBlob = await this._fetchCatalogItem(item);
                await this._doImport(item, itemBlob);
                this._syncInstallButtons();
            }
        } else if (pkg.type === 'workbook' && pkg.format === 'srwb') {
            const text = await blob.text();
            if (!window.fileIO) throw new Error('File IO not available');
            await this._importWorkbook(pkg, () => window.fileIO.importSrwb(text));
        } else if (pkg.type === 'workbook') {
            const text = await blob.text();
            if (!window.fileIO) throw new Error('File IO not available');
            // importIpynb now returns a promise (resolves when importCells finishes)
            await this._importWorkbook(pkg, () => window.fileIO.importIpynb(text));
        } else {
            const sourceUrl = pkg.url || pkg.pages_url || 'package.zip';
            const urlParts = sourceUrl.split('/');
            const filename = urlParts[urlParts.length - 1] || 'package.zip';
            const file = new File([blob], filename, { type: blob.type });
            if (!window.packageLoader) throw new Error('Package loader not available');
            await window.packageLoader.loadFromFile(file);
        }
    }

    /**
     * Import a catalog workbook and replace older catalog revisions with the
     * newly-created notebook. User-created notebooks with other names remain
     * untouched, and replacement only happens after a successful import.
     */
    async _importWorkbook(pkg, importer) {
        const nm = window.notebookManager;
        if (!nm) throw new Error('NotebookManager not available');

        const expectedName = pkg.notebookName || pkg.name;
        const previous = nm.getNotebooks().filter(nb => nb && nb.name === expectedName);
        await Promise.resolve(importer());

        const matches = nm.getNotebooks().filter(nb => nb && nb.name === expectedName);
        const imported = [...matches].reverse().find(nb => !previous.includes(nb));
        if (!imported) throw new Error('Imported workbook was not created: ' + expectedName);

        imported.catalogId = pkg.id;
        imported.catalogRevision = pkg.revision ?? null;

        // Import first, then preserve stale copies under unique backup names.
        // Catalog workbooks are editable, and older releases did not record
        // enough provenance to distinguish an untouched template from user
        // work. Never silently delete either kind during an update.
        const existingNames = new Set(nm.getNotebooks().map(nb => nb && nb.name).filter(Boolean));
        for (const oldNotebook of previous) {
            if (oldNotebook === imported) continue;
            const revision = oldNotebook.catalogRevision == null
                ? 'unversioned'
                : 'revision ' + oldNotebook.catalogRevision;
            const baseName = expectedName + ' (backup of ' + revision + ')';
            let backupName = baseName;
            let suffix = 2;
            while (existingNames.has(backupName)) {
                backupName = baseName + ' ' + suffix++;
            }
            oldNotebook.catalogId = null;
            oldNotebook.catalogRevision = null;
            nm.renameNotebook(oldNotebook.id, backupName);
            existingNames.add(backupName);
        }
        nm.saveState();
        return imported;
    }

    /**
     * Fetch a package URL as a Blob.
     *
     * Tries in order:
     * 1. Capacitor native download (Android/iOS)
     * 2. Direct fetch (same-origin, pages_url, CORS-enabled URLs)
     * 3. Local CORS proxy at /proxy?url=... (dev server)
     * 4. Error with manual download instructions
     */
    async _fetchPackage(url) {
        // Same-origin / relative URLs (e.g. the bundled pages_url) — fetch
        // directly. The Capacitor WebView serves these via its asset loader; the
        // native downloader can't resolve the app's virtual host or a relative
        // path (it hangs/fails), so it must NOT be routed through downloadFile.
        const _isAbsolute = /^https?:\/\//i.test(url);
        if (!_isAbsolute || (typeof location !== 'undefined' && url.startsWith(location.origin))) {
            const response = await fetch(url);
            if (response.ok) return await response.blob();
            throw new Error('Failed to fetch ' + url + ' (HTTP ' + response.status + ')');
        }

        // Capacitor native path (cross-origin absolute URLs) — download via native HTTP
        if (window.Capacitor && window.Capacitor.isNativePlatform()) {
            const { Filesystem } = window.Capacitor.Plugins;
            if (Filesystem && Filesystem.downloadFile) {
                const filename = '_pkg_download_' + Date.now() + '.zip';
                const result = await Filesystem.downloadFile({
                    url,
                    path: filename,
                    directory: 'CACHE',
                    recursive: false,
                });

                // Read the downloaded file back as base64
                const fileData = await Filesystem.readFile({
                    path: filename,
                    directory: 'CACHE',
                });

                // Clean up temp file
                Filesystem.deleteFile({ path: filename, directory: 'CACHE' }).catch(() => {});

                // Convert base64 to Blob
                const binary = atob(fileData.data);
                const bytes = new Uint8Array(binary.length);
                for (let i = 0; i < binary.length; i++) {
                    bytes[i] = binary.charCodeAt(i);
                }
                return new Blob([bytes], { type: 'application/zip' });
            }
        }

        // Try fetching directly (works for same-origin, pages_url, and CORS-enabled URLs)
        try {
            const response = await fetch(url);
            if (response.ok) {
                return await response.blob();
            }
        } catch (e) {
            // CORS or network error — fall through to proxy
        }

        // Try local CORS proxy (available when running via `npm run serve`)
        try {
            const proxyUrl = '/proxy?url=' + encodeURIComponent(url);
            const response = await fetch(proxyUrl);
            if (response.ok) {
                return await response.blob();
            }
        } catch (e) {
            // Proxy not available — fall through to error
        }

        throw new Error(
            'Download failed. If running locally, use `npm run serve` for proxy support. ' +
            'Otherwise, download the package manually and use Menu > Import Package.'
        );
    }

    _esc(str) {
        const el = document.createElement('span');
        el.textContent = str;
        return el.innerHTML;
    }
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    window.packageCatalog = new PackageCatalog();
});
