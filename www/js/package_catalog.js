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
        this._query = '';
        this._sessionPrimary = null;
        this._kernelFilter = null;
        this._remoteEntries = [];
        this._sourceResult = null;
        this._sourceGeneration = 0;
        this._sourceManager = (typeof CatalogSource !== 'undefined')
            ? new CatalogSource.CatalogSourceManager({
                beforeNetwork: () => this._ensureCatalogNetworkConsent(),
            })
            : null;
        this._prefs = (typeof CatalogFilter !== 'undefined')
            ? CatalogFilter.loadLocalePrefs()
            : { allowFallbacks: true, fallbacks: ['en'] };
        this._init();
    }

    _t(key, fallback, vars = {}) {
        const translated = typeof window.t === 'function' ? window.t(key, vars) : key;
        if (translated !== key) return translated;
        return String(fallback).replace(/\{(\w+)\}/g, (match, name) =>
            Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match);
    }

    _displayName(pkg) {
        return pkg.displayNameKey
            ? this._t(pkg.displayNameKey, pkg.name)
            : pkg.name;
    }

    _description(pkg) {
        return pkg.descriptionKey
            ? this._t(pkg.descriptionKey, pkg.description)
            : pkg.description;
    }

    _setTranslatedText(el, key, fallback, vars = {}) {
        if (!el) return;
        el.textContent = this._t(key, fallback, vars);
        if (typeof window.setI18nText === 'function') window.setI18nText(el, key, vars);
    }

    _setButtonLabel(btn, key, fallback, vars = {}) {
        this._setTranslatedText(btn, key, fallback, vars);
    }

    /**
     * The catalog.  Add entries here to make them available to users.
     * Each entry needs: id, name, description, and a type-specific source.
     * type: 'package' (default, .zip), 'bundle' (a set of catalog entries),
     * or 'workbook' (.ipynb/.srwb).
     */
    get builtinPackages() {
        return [
            {
                id: 'unifyweaver-scirepl',
                name: 'UnifyWeaver SciREPL',
                displayNameKey: 'packageCatalog.item.unifyweaverScirepl.name',
                description: 'Physics knowledge-base notebooks with Prolog inference, embedding search, and mindmap tools.',
                descriptionKey: 'packageCatalog.item.unifyweaverScirepl.description',
                type: 'package',
                version: 'v0.11.0',
                url: 'https://github.com/s243a/SciREPL/releases/download/v0.11.0/unifyweaver_scirepl.zip',
                pages_url: 'packages/unifyweaver_scirepl.zip',
                size: '~2 MB',
                kernels: ['prolog', 'python'],
                locales: ['en'],
            },
            {
                id: 'unifyweaver-workbooks',
                name: 'UnifyWeaver Tutorials & Compiler Demos',
                displayNameKey: 'packageCatalog.item.unifyweaverWorkbooks.name',
                description: 'The four workbooks declared by UnifyWeaver\'s SciREPL package builder: three tutorials and the Prolog-to-R compiler demo.',
                descriptionKey: 'packageCatalog.item.unifyweaverWorkbooks.description',
                type: 'bundle',
                size: '~50 KB',
                contents: '4 workbooks',
                contentsKey: 'packageCatalog.contentsWorkbooks',
                contentsVars: { count: 4 },
                kernels: ['prolog', 'r', 'bash'],
                locales: ['en'],
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
                displayNameKey: 'packageCatalog.item.unifyweaverFamilyTree.name',
                notebookName: 'Family Tree Tutorial with UnifyWeaver',
                description: 'Build and query a family-tree knowledge base while learning UnifyWeaver and Prolog fundamentals.',
                descriptionKey: 'packageCatalog.item.unifyweaverFamilyTree.description',
                type: 'workbook',
                revision: 2,
                pages_url: 'workbooks/01_family_tree_tutorial.ipynb',
                size: '~10 KB',
                kernels: ['prolog'],
                locales: ['en'],
                requires: ['unifyweaver-scirepl'],
            },
            {
                id: 'unifyweaver-recursion-patterns',
                name: 'Advanced Recursion Patterns in UnifyWeaver',
                displayNameKey: 'packageCatalog.item.unifyweaverRecursionPatterns.name',
                notebookName: 'Advanced Recursion Patterns in UnifyWeaver',
                description: 'Explore recursive predicates and the compilation patterns UnifyWeaver recognizes.',
                descriptionKey: 'packageCatalog.item.unifyweaverRecursionPatterns.description',
                type: 'workbook',
                revision: 2,
                pages_url: 'workbooks/02_recursion_patterns.ipynb',
                size: '~15 KB',
                kernels: ['prolog'],
                locales: ['en'],
                requires: ['unifyweaver-scirepl'],
            },
            {
                id: 'unifyweaver-call-graph',
                name: 'Call Graph Analysis and SCC Detection',
                displayNameKey: 'packageCatalog.item.unifyweaverCallGraph.name',
                notebookName: 'Call Graph Analysis and SCC Detection',
                description: 'Analyze predicate call graphs and strongly connected components with UnifyWeaver.',
                descriptionKey: 'packageCatalog.item.unifyweaverCallGraph.description',
                type: 'workbook',
                revision: 3,
                pages_url: 'workbooks/03_call_graph_analysis.ipynb',
                size: '~13 KB',
                kernels: ['prolog'],
                locales: ['en'],
                requires: ['unifyweaver-scirepl'],
            },
            {
                id: 'prolog-generates-r',
                name: 'Prolog Generates R',
                displayNameKey: 'packageCatalog.item.prologGeneratesR.name',
                notebookName: 'Prolog Generates R: Compiler Demo',
                description: 'Compile recursive Prolog predicates into executable R and inspect the generated program through notebook cells.',
                descriptionKey: 'packageCatalog.item.prologGeneratesR.description',
                type: 'workbook',
                revision: 1,
                format: 'srwb',
                pages_url: 'workbooks/prolog-generates-r.srwb',
                size: '~13 KB',
                kernels: ['prolog', 'r', 'bash'],
                locales: ['en'],
                requires: ['unifyweaver-scirepl'],
            },
            {
                id: 'prolog-generates-lua',
                name: 'Prolog Generates Lua',
                displayNameKey: 'packageCatalog.item.prologGeneratesLua.name',
                notebookName: 'Prolog Generates Lua: Compiler Demo',
                description: 'Compile a Prolog transitive closure to Lua using a named query source cell, embedded or notebook-VFS facts, and direct Lua cell I/O.',
                descriptionKey: 'packageCatalog.item.prologGeneratesLua.description',
                type: 'workbook',
                revision: 2,
                format: 'srwb',
                pages_url: 'workbooks/prolog-generates-lua.srwb',
                size: '~6 KB',
                kernels: ['prolog', 'lua'],
                locales: ['en'],
                requires: ['unifyweaver-scirepl'],
            },
            {
                id: 'prolog-generates-clojurescript',
                name: 'Prolog Generates ClojureScript',
                displayNameKey: 'packageCatalog.item.prologGeneratesClojureScript.name',
                notebookName: 'Prolog Generates ClojureScript: Compiler Demo',
                description: 'Compile a Prolog transitive closure to browser-runnable ClojureScript, then query the generated definitions in Scittle.',
                descriptionKey: 'packageCatalog.item.prologGeneratesClojureScript.description',
                type: 'workbook',
                revision: 1,
                format: 'srwb',
                pages_url: 'workbooks/prolog-generates-clojurescript.srwb',
                size: '~5 KB',
                kernels: ['prolog', 'clojurescript'],
                locales: ['en'],
                requires: ['unifyweaver-scirepl'],
            },
            {
                id: 'life-expectancy-analysis',
                name: 'Life Expectancy Analysis',
                displayNameKey: 'packageCatalog.item.lifeExpectancyAnalysis.name',
                description: 'Mixed Python/R workbook: Gapminder & WHO datasets with pandas, plotly, and R base graphics.',
                descriptionKey: 'packageCatalog.item.lifeExpectancyAnalysis.description',
                type: 'workbook',
                revision: 1,
                url: 'https://github.com/s243a/SciREPL/releases/download/v0.7.0/life_expectancy_csv_demo.ipynb',
                pages_url: 'workbooks/life_expectancy_csv_demo.ipynb',
                size: '~8 KB',
                kernels: ['python', 'r'],
                locales: ['en'],
            },
            {
                id: 'compute-pi-archimedean',
                name: 'Compute Pi with Archimedean Bounds',
                displayNameKey: 'packageCatalog.item.computePiArchimedean.name',
                notebookName: 'Compute Pi: Archimedean Bounds',
                description: 'Squeeze pi between inscribed and circumscribed polygon bounds using a stable, non-circular side-doubling recurrence.',
                descriptionKey: 'packageCatalog.item.computePiArchimedean.description',
                type: 'workbook',
                revision: 1,
                format: 'srwb',
                pages_url: 'workbooks/compute-pi-workbook.srwb',
                size: '~6 KB',
                kernels: ['python'],
                locales: ['en'],
            },
            {
                id: 'ggplot2-showcase',
                name: 'ggplot2 Showcase',
                displayNameKey: 'packageCatalog.item.ggplot2Showcase.name',
                description: 'Scatter, bar, density, box, and heatmap charts with ggplot2 dark theme. Uses built-in R datasets.',
                descriptionKey: 'packageCatalog.item.ggplot2Showcase.description',
                type: 'workbook',
                url: 'https://github.com/s243a/SciREPL/releases/download/v0.8.0/r_ggplot2_showcase.ipynb',
                pages_url: 'workbooks/r_ggplot2_showcase.ipynb',
                size: '~5 KB',
                kernels: ['r'],
                locales: ['en'],
            },
            {
                id: 'tidyverse-data-wrangling',
                name: 'Tidyverse Data Wrangling',
                displayNameKey: 'packageCatalog.item.tidyverseDataWrangling.name',
                description: 'dplyr/tidyr pipelines with cross-language CSV sharing: Python downloads, R processes, Python visualizes.',
                descriptionKey: 'packageCatalog.item.tidyverseDataWrangling.description',
                type: 'workbook',
                revision: 1,
                url: 'https://github.com/s243a/SciREPL/releases/download/v0.8.0/r_tidyverse_wrangling.ipynb',
                pages_url: 'workbooks/r_tidyverse_wrangling.ipynb',
                size: '~6 KB',
                kernels: ['python', 'r'],
                locales: ['en'],
            },
            {
                id: 'statistics-with-r',
                name: 'Statistics with R',
                displayNameKey: 'packageCatalog.item.statisticsWithR.name',
                description: 'Hypothesis testing (t-test, chi-squared, ANOVA), regression, confidence intervals, and diagnostic plots.',
                descriptionKey: 'packageCatalog.item.statisticsWithR.description',
                type: 'workbook',
                revision: 1,
                url: 'https://github.com/s243a/SciREPL/releases/download/v0.8.0/r_statistics.ipynb',
                pages_url: 'workbooks/r_statistics.ipynb',
                size: '~5 KB',
                kernels: ['r'],
                locales: ['en'],
            },
            {
                id: 'lua-tables-coroutines',
                name: 'Lua: Tables, Coroutines & Closures',
                displayNameKey: 'packageCatalog.item.luaTablesCoroutines.name',
                description: 'Tour of Lua\'s core features — tables as universal data structure, coroutines for cooperative multitasking, closures, custom iterators, and a lazy Stream library.',
                descriptionKey: 'packageCatalog.item.luaTablesCoroutines.description',
                type: 'workbook',
                format: 'srwb',
                pages_url: 'workbooks/lua-tables-coroutines.srwb',
                size: '~12 KB',
                kernels: ['lua'],
                locales: ['en'],
            },
            {
                id: 'lua-parsing-coroutines',
                name: 'Lua: Parsing with Coroutines',
                displayNameKey: 'packageCatalog.item.luaParsingCoroutines.name',
                description: 'Build a calculator from scratch — coroutine lexer, recursive descent parser, AST evaluator, parser combinators, and a CSV parser. No external libraries.',
                descriptionKey: 'packageCatalog.item.luaParsingCoroutines.description',
                type: 'workbook',
                revision: 1,
                format: 'srwb',
                pages_url: 'workbooks/lua-parsing-coroutines.srwb',
                size: '~14 KB',
                kernels: ['lua'],
                locales: ['en'],
            },
            {
                id: 'typr-introduction',
                name: 'TypR Introduction',
                displayNameKey: 'packageCatalog.item.typrIntroduction.name',
                notebookName: 'TypR Introduction',
                description: 'Typed R superset — variable binding, functions, type annotations, variadic calls, and source/type-check/transpiler directives. Compiles to R via WASM.',
                descriptionKey: 'packageCatalog.item.typrIntroduction.description',
                type: 'workbook',
                revision: 1,
                format: 'srwb',
                url: 'https://github.com/s243a/SciREPL/releases/download/v0.11.0/typr-intro.srwb',
                pages_url: 'workbooks/typr-intro.srwb',
                size: '~2 KB',
                kernels: ['typr', 'r'],
                locales: ['en'],
            },
            {
                id: 'prolog-generates-typr',
                name: 'Prolog Generates TypR',
                displayNameKey: 'packageCatalog.item.prologGeneratesTypr.name',
                notebookName: 'Prolog Generates TypR: Compiler Demo',
                description: 'Compile a Prolog transitive-closure predicate to typed TypR, then execute the generated code with native variadic output calls.',
                descriptionKey: 'packageCatalog.item.prologGeneratesTypr.description',
                type: 'workbook',
                format: 'srwb',
                revision: 4,
                pages_url: 'workbooks/prolog-generates-typr.srwb',
                size: '~5 KB',
                kernels: ['prolog', 'typr', 'r'],
                locales: ['en'],
                requires: ['unifyweaver-scirepl'],
            },
        ];
    }

    get packages() {
        return this.builtinPackages.concat(this._remoteEntries || []);
    }

    _init() {
        const browseBtn = document.getElementById('btn-browse-packages');
        if (browseBtn) {
            browseBtn.addEventListener('click', () => {
                document.getElementById('menu-modal')?.classList.add('hidden');
                this._open();
            });
        }

        if (this.modal) {
            this.modal.addEventListener('click', (e) => {
                if (e.target === this.modal || e.target.classList.contains('modal-close')) {
                    this.modal.classList.add('hidden');
                }
            });
        }

        const search = document.getElementById('catalog-search');
        if (search) {
            search.addEventListener('input', () => {
                this._query = search.value || '';
                this._render();
            });
        }

        const spoken = document.getElementById('catalog-spoken-language');
        if (spoken) {
            spoken.addEventListener('change', () => {
                this._sessionPrimary = spoken.value === 'all' ? null : spoken.value;
                this._syncFallbackControls();
                this._render();
            });
        }

        const kernel = document.getElementById('catalog-kernel');
        if (kernel) {
            kernel.addEventListener('change', () => {
                this._kernelFilter = kernel.value === 'all' ? null : kernel.value;
                this._render();
            });
        }

        const allow = document.getElementById('catalog-allow-fallbacks');
        const allowEdit = document.getElementById('catalog-allow-fallbacks-edit');
        const persistAllow = (checked) => {
            this._prefs.allowFallbacks = !!checked;
            this._persistPrefs();
            this._syncFallbackControls();
            this._render();
        };
        if (allow) allow.addEventListener('change', () => persistAllow(allow.checked));
        if (allowEdit) allowEdit.addEventListener('change', () => persistAllow(allowEdit.checked));

        const showBuiltins = document.getElementById('catalog-show-builtins');
        if (showBuiltins) {
            showBuiltins.addEventListener('change', () => {
                this._prefs.showBuiltins = !!showBuiltins.checked;
                this._persistPrefs();
                this._render();
            });
        }

        document.getElementById('catalog-edit-fallbacks')?.addEventListener('click', () => {
            this._showFallbackPanel(true);
            document.getElementById('catalog-fallback-back')?.focus();
        });
        document.getElementById('catalog-fallback-back')?.addEventListener('click', () => {
            this._showFallbackPanel(false);
            document.getElementById('catalog-edit-fallbacks')?.focus();
        });
        document.getElementById('catalog-fallback-add')?.addEventListener('change', (e) => {
            const code = e.target.value;
            e.target.value = '';
            if (!code) return;
            this._prefs.fallbacks = CatalogFilter.addFallback(
                this._prefs.fallbacks, code, this._sessionPrimary);
            this._persistPrefs();
            this._syncFallbackControls();
            this._renderFallbackList();
            this._render();
        });

        document.getElementById('catalog-edit-source')?.addEventListener('click', () => {
            this._showSourcePanel(true);
            document.getElementById('catalog-source-mode')?.focus();
        });
        document.getElementById('catalog-source-back')?.addEventListener('click', () => {
            this._showSourcePanel(false);
            document.getElementById('catalog-edit-source')?.focus();
        });
        document.getElementById('catalog-source-mode')?.addEventListener('change', () => {
            this._syncSourceForm();
        });
        document.getElementById('catalog-source-apply')?.addEventListener('click', () => {
            this._applySourceForm();
        });
        document.getElementById('catalog-source-reset')?.addEventListener('click', () => {
            this._resetSourceForm();
        });
        document.getElementById('catalog-source-clear-data')?.addEventListener('click', () => {
            this._clearSourceData();
        });
        document.getElementById('catalog-refresh-source')?.addEventListener('click', () => {
            this._loadSource({ refresh: true });
        });

        document.addEventListener('i18n:changed', () => this._translateVisibleCatalog());
    }

    _open() {
        this._query = '';
        const search = document.getElementById('catalog-search');
        if (search) search.value = '';
        this._kernelFilter = null;
        this._sessionPrimary = (window.i18n && window.i18n.current) ? window.i18n.current : 'en';
        this._prefs = CatalogFilter.loadLocalePrefs();
        this._showFallbackPanel(false);
        this._showSourcePanel(false);
        this._populateSpokenSelect();
        this._populateKernelSelect();
        this._syncFallbackControls();
        this._syncSourceForm();
        this._renderSourceSummary();
        this._render();
        this.modal?.classList.remove('hidden');
        if (window.i18n && typeof window.i18n.applyToDom === 'function' && this.modal) {
            window.i18n.applyToDom(this.modal);
        }
        this._loadSource();
    }

    _persistPrefs() {
        this._prefs = CatalogFilter.saveLocalePrefs(this._prefs);
    }

    /**
     * The "shown in any language" hint explains why foreign-language built-ins
     * are still listed. Visible only when that is actually happening: empty
     * search, a real primary locale, the exemption on, and at least one card
     * whose content is outside the user's chain.
     */
    _syncBuiltinsHint(rows) {
        const hint = document.getElementById('catalog-builtins-hint');
        if (!hint) return;
        const emptyQuery = String(this._query || '').trim() === '';
        const gated = CatalogFilter.isAllLocale(this._sessionPrimary);
        const exempt = this._prefs.showBuiltins !== false;
        let foreign = false;
        if (emptyQuery && !gated && exempt) {
            const chain = CatalogFilter.preferenceChain(
                this._sessionPrimary, this._prefs.allowFallbacks, this._prefs.fallbacks);
            foreign = (rows || []).some((row) =>
                row.builtin && !CatalogFilter.bestLocaleMatch(row.entry, chain));
        }
        hint.hidden = !foreign;
    }

    _showFallbackPanel(show) {
        document.getElementById('catalog-browse-panel')?.classList.toggle('hidden', !!show);
        document.getElementById('catalog-fallback-panel')?.classList.toggle('hidden', !show);
        document.getElementById('catalog-source-panel')?.classList.add('hidden');
        if (show) this._renderFallbackList();
    }

    _showSourcePanel(show) {
        document.getElementById('catalog-browse-panel')?.classList.toggle('hidden', !!show);
        document.getElementById('catalog-source-panel')?.classList.toggle('hidden', !show);
        document.getElementById('catalog-fallback-panel')?.classList.add('hidden');
        if (show) this._populateSourceForm();
    }

    async _ensureCatalogNetworkConsent() {
        if (!window.kernelManager) {
            throw new Error(this._t('packageCatalog.privacyRequired',
                'Accept the current network disclosure before refreshing the catalogue.'));
        }
        if (typeof window.kernelManager.ensureNetworkConsent === 'function') {
            await window.kernelManager.ensureNetworkConsent();
            return;
        }
        if (typeof window.kernelManager._ensurePrivacyConsent === 'function') {
            await window.kernelManager._ensurePrivacyConsent({ requireCurrentRevision: true });
            return;
        }
        throw new Error(this._t('packageCatalog.privacyRequired',
            'Accept the current network disclosure before refreshing the catalogue.'));
    }

    _sourceModeCopy(mode) {
        const copies = {
            stable: ['packageCatalog.sourceLatestStable', 'Latest stable'],
            release: ['packageCatalog.sourceSpecificRelease', 'Specific release'],
            commit: ['packageCatalog.sourceSpecificCommit', 'Specific commit'],
            development: ['packageCatalog.sourceDevelopmentBranch', 'Development branch'],
        };
        return copies[mode] || copies.stable;
    }

    _populateSourceForm() {
        if (!this._sourceManager) return;
        const config = this._sourceManager.getConfig();
        const mode = document.getElementById('catalog-source-mode');
        const value = document.getElementById('catalog-source-value');
        const host = document.getElementById('catalog-source-host');
        if (mode) mode.value = config.mode;
        if (value) value.value = config.value || (config.mode === 'development' ? 'main' : '');
        if (host) host.value = config.siteBase;
        const error = document.getElementById('catalog-source-form-error');
        if (error) error.textContent = '';
        this._syncSourceForm();
    }

    _syncSourceForm() {
        const mode = document.getElementById('catalog-source-mode')?.value || 'stable';
        const valueRow = document.getElementById('catalog-source-value-row');
        const value = document.getElementById('catalog-source-value');
        const valueLabel = document.getElementById('catalog-source-value-label');
        const hostRow = document.getElementById('catalog-source-host-row');
        const warning = document.getElementById('catalog-source-warning');
        const needsValue = mode === 'release' || mode === 'commit' || mode === 'development';
        if (valueRow) valueRow.hidden = !needsValue;
        if (hostRow) hostRow.hidden = !(mode === 'stable' || mode === 'release');
        if (value && mode === 'development' && !value.value) value.value = 'main';
        if (value) {
            value.placeholder = mode === 'release' ? 'v0.1.0'
                : mode === 'commit' ? '0123456789abcdef0123456789abcdef01234567'
                    : 'main';
        }
        if (valueLabel) {
            if (mode === 'release') this._setTranslatedText(valueLabel,
                'packageCatalog.sourceReleaseTag', 'Release tag');
            else if (mode === 'commit') this._setTranslatedText(valueLabel,
                'packageCatalog.sourceCommitSha', 'Full commit SHA');
            else this._setTranslatedText(valueLabel,
                'packageCatalog.sourceBranchName', 'Branch name');
        }
        if (warning) {
            warning.hidden = mode !== 'development';
            if (!warning.hidden) this._setTranslatedText(warning,
                'packageCatalog.sourceDevelopmentWarning',
                'Development branches are volatile. The app uses the GitHub API to resolve the branch to one exact commit before loading it.');
        }
    }

    async _applySourceForm() {
        if (!this._sourceManager) return;
        const error = document.getElementById('catalog-source-form-error');
        try {
            const mode = document.getElementById('catalog-source-mode')?.value || 'stable';
            const value = document.getElementById('catalog-source-value')?.value || '';
            const siteBase = document.getElementById('catalog-source-host')?.value
                || CatalogSource.PAGES_ROOT;
            this._sourceManager.setConfig({ mode, value, siteBase });
            if (error) error.textContent = '';
            this._remoteEntries = [];
            this._sourceResult = null;
            this._sourceGeneration++;
            this._showSourcePanel(false);
            this._render();
            await this._loadSource({ refresh: true });
            document.getElementById('catalog-edit-source')?.focus();
        } catch (cause) {
            if (error) error.textContent = cause.message;
        }
    }

    async _resetSourceForm() {
        if (!this._sourceManager || typeof CatalogSource === 'undefined') return;
        this._sourceManager.setConfig(CatalogSource.DEFAULT_CONFIG);
        this._populateSourceForm();
        this._remoteEntries = [];
        this._sourceResult = null;
        this._sourceGeneration++;
        this._showSourcePanel(false);
        this._render();
        await this._loadSource({ refresh: true });
        document.getElementById('catalog-edit-source')?.focus();
    }

    async _clearSourceData() {
        if (!this._sourceManager) return;
        const accepted = window.confirm(this._t(
            'packageCatalog.clearVerifiedDataConfirm',
            'Clear cached catalogue workbook artifact bytes, verified snapshots, and release trust pins? Installed catalogue notebook copies and built-in items remain available.'));
        if (!accepted) return;
        await this._sourceManager.clearCache();
        this._sourceGeneration++;
        this._remoteEntries = [];
        this._sourceResult = { status: 'cleared', entries: [] };
        this._renderSourceSummary();
        this._render();
    }

    _setSourceLoading() {
        const status = document.getElementById('catalog-source-status');
        if (status) this._setTranslatedText(status,
            'packageCatalog.sourceLoading', 'Checking the verified catalogue…');
        const refresh = document.getElementById('catalog-refresh-source');
        if (refresh) refresh.disabled = true;
    }

    _applySourceResult(result) {
        this._sourceResult = result;
        this._remoteEntries = Array.isArray(result && result.entries) ? result.entries : [];
        const refresh = document.getElementById('catalog-refresh-source');
        if (refresh) refresh.disabled = false;
        this._renderSourceSummary();
        this._render();
    }

    _renderSourceSummary() {
        if (!this._sourceManager) return;
        const config = this._sourceManager.getConfig();
        const result = this._sourceResult;
        const provenance = result && result.provenance;
        const summary = document.getElementById('catalog-source-summary');
        const status = document.getElementById('catalog-source-status');
        const pair = this._sourceModeCopy(config.mode);
        let summaryText = this._t(pair[0], pair[1]);
        if (provenance && provenance.tag) summaryText += ` · ${provenance.tag}`;
        else if (provenance && provenance.commit) summaryText += ` · ${provenance.commit.slice(0, 8)}`;
        else if (config.value) summaryText += ` · ${config.value}`;
        if (summary) summary.textContent = summaryText;
        if (!status) return;
        const count = this._remoteEntries.length;
        if (!result) {
            this._setTranslatedText(status, 'packageCatalog.sourceNotChecked', 'Not checked yet.');
        } else if (result.status === 'verified') {
            this._setTranslatedText(status, 'packageCatalog.sourceVerifiedItems',
                'Verified · {count} items', { count });
        } else if (result.status === 'cached') {
            this._setTranslatedText(status, 'packageCatalog.sourceCachedItems',
                'Verified cached copy · {count} items', { count });
        } else if (result.status === 'cached-stale' || result.status === 'refresh-failed') {
            this._setTranslatedText(status, 'packageCatalog.sourceStaleItems',
                'Using the last verified copy · {count} items; refresh unavailable.', { count });
        } else if (result.status === 'tag-moved') {
            this._setTranslatedText(status, 'packageCatalog.sourceMovedTagKept',
                'The release tag changed. The previous verified copy was kept.');
        } else if (result.status === 'unavailable') {
            this._setTranslatedText(status, 'packageCatalog.sourceUnavailable',
                'Remote catalogue unavailable; built-in items remain available.');
        } else if (result.status === 'cleared') {
            this._setTranslatedText(status, 'packageCatalog.clearVerifiedDataDone',
                'Cached verified catalogue data and release trust pins were cleared. Installed catalogue notebook copies and built-in items remain available.');
        } else {
            this._setTranslatedText(status, 'packageCatalog.sourceBundledOnly',
                'Built-in items only.');
        }
        status.title = result && result.error ? result.error : '';
    }

    async _loadSource({ refresh = false } = {}) {
        if (!this._sourceManager) return;
        const generation = ++this._sourceGeneration;
        this._setSourceLoading();
        const cached = await this._sourceManager.load({ allowNetwork: false });
        if (generation !== this._sourceGeneration) return;
        this._applySourceResult(cached);
        if (!refresh && !cached.needsRefresh) return;
        this._setSourceLoading();
        let result = await this._sourceManager.load({ allowNetwork: true, refresh });
        if (generation !== this._sourceGeneration) return;
        if (result.status === 'tag-moved') {
            const trusted = result.trusted || {};
            const candidate = result.candidate || {};
            const accepted = window.confirm(this._t('packageCatalog.sourceMovedTagPrompt',
                'Release tag {tag} changed from commit {oldCommit} to {newCommit}. Keep the trusted copy unless you intentionally want to accept the moved tag. Accept the new mapping?', {
                    tag: candidate.tag || '',
                    oldCommit: `${String(trusted.commit || '').slice(0, 12)} / ${String(trusted.indexSha256 || '').slice(0, 12)}`,
                    newCommit: `${String(candidate.commit || '').slice(0, 12)} / ${String(candidate.indexSha256 || '').slice(0, 12)}`,
                }));
            if (accepted) result = await this._sourceManager.acceptMovedTag();
        }
        if (generation !== this._sourceGeneration) return;
        this._applySourceResult(result);
    }

    _activatableLocales() {
        if (window.i18n && typeof window.i18n.available === 'function') {
            return window.i18n.available();
        }
        const locales = (window.i18n && window.i18n.LOCALES) || [];
        return locales.map((l) => ({ ...l }));
    }

    _endonymMap() {
        const map = {};
        for (const loc of this._activatableLocales()) {
            if (loc.code) map[loc.code] = loc.endonym || loc.code;
        }
        return map;
    }

    _endonym(code) {
        if (!code) return '';
        const map = this._endonymMap();
        return map[code] || code;
    }

    _populateSpokenSelect() {
        const select = document.getElementById('catalog-spoken-language');
        if (!select) return;
        const current = this._sessionPrimary || 'all';
        const allLabel = this._t('packageCatalog.filterAllSpoken', 'All spoken languages');
        select.innerHTML = '';
        const allOpt = document.createElement('option');
        allOpt.value = 'all';
        allOpt.textContent = allLabel;
        allOpt.setAttribute('data-i18n', 'packageCatalog.filterAllSpoken');
        select.appendChild(allOpt);
        for (const loc of this._activatableLocales()) {
            const opt = document.createElement('option');
            opt.value = loc.code;
            opt.textContent = loc.endonym || loc.code;
            select.appendChild(opt);
        }
        const hasCurrent = [...select.options].some((o) => o.value === current);
        select.value = hasCurrent ? current : (current === null ? 'all' : current);
        if (select.value !== current && current && current !== 'all') {
            const extra = document.createElement('option');
            extra.value = current;
            extra.textContent = this._endonym(current) || current;
            select.appendChild(extra);
            select.value = current;
        }
    }

    _kernelLabel(id) {
        const keys = {
            python: ['wbKernel.python', 'Python'],
            prolog: ['wbKernel.prolog', 'Prolog'],
            javascript: ['wbKernel.javascript', 'JavaScript'],
            bash: ['wbKernel.bash', 'Bash'],
            r: ['packageCatalog.kernel.r', 'R'],
            lua: ['inputControls.lua', 'Lua'],
            typr: ['packageCatalog.kernel.typr', 'TypR'],
            clojurescript: ['packageCatalog.kernel.clojurescript', 'ClojureScript'],
        };
        const pair = keys[id];
        return pair ? this._t(pair[0], pair[1]) : id;
    }

    _populateKernelSelect() {
        const select = document.getElementById('catalog-kernel');
        if (!select) return;
        const langSel = document.getElementById('lang-selector');
        const ids = langSel
            ? [...langSel.options].map((o) => o.value)
            : ['python', 'prolog', 'bash', 'javascript', 'r', 'lua', 'typr', 'clojurescript'];
        const wanted = this._kernelFilter || 'all';
        select.innerHTML = '';
        const allOpt = document.createElement('option');
        allOpt.value = 'all';
        allOpt.textContent = this._t('packageCatalog.filterKernelAll', 'All');
        allOpt.setAttribute('data-i18n', 'packageCatalog.filterKernelAll');
        select.appendChild(allOpt);
        for (const id of ids) {
            const opt = document.createElement('option');
            opt.value = id;
            opt.textContent = this._kernelLabel(id);
            select.appendChild(opt);
        }
        select.value = ids.includes(wanted) || wanted === 'all' ? wanted : 'all';
    }

    _syncFallbackControls() {
        const allow = !!this._prefs.allowFallbacks;
        const box = document.getElementById('catalog-allow-fallbacks');
        const boxEdit = document.getElementById('catalog-allow-fallbacks-edit');
        if (box) box.checked = allow;
        if (boxEdit) boxEdit.checked = allow;

        const builtinsBox = document.getElementById('catalog-show-builtins');
        if (builtinsBox) builtinsBox.checked = this._prefs.showBuiltins !== false;

        const summary = document.getElementById('catalog-fallback-summary');
        if (summary) {
            const primary = this._sessionPrimary;
            const rest = (this._prefs.fallbacks || []).filter((code) =>
                !primary || code.toLowerCase() !== String(primary).toLowerCase());
            const names = rest.map((code) => this._endonym(code) || code).join(', ');
            const allSpoken = CatalogFilter.isAllLocale(primary);
            if (allSpoken) {
                this._setTranslatedText(summary, 'packageCatalog.fallbacksRankingThen',
                    'ranking only: {languages}', { languages: names || this._t('packageCatalog.fallbackNone', 'none') });
            } else if (!names) {
                this._setTranslatedText(summary, 'packageCatalog.fallbackNone', 'none');
            } else {
                this._setTranslatedText(summary, 'packageCatalog.fallbackThen',
                    'then {languages}', { languages: names });
            }
        }

        const help = document.getElementById('catalog-fallback-help');
        if (help) {
            const language = CatalogFilter.isAllLocale(this._sessionPrimary)
                ? this._t('packageCatalog.filterAllSpoken', 'All spoken languages')
                : (this._endonym(this._sessionPrimary) || this._sessionPrimary || 'English');
            this._setTranslatedText(help, 'packageCatalog.fallbackHelp',
                'When a workbook is not in {language}, show the next language on this list. English is the starting fallback; you can add more or turn fallbacks off.',
                { language });
        }
        this._populateFallbackAdd();
    }

    _populateFallbackAdd() {
        const select = document.getElementById('catalog-fallback-add');
        if (!select) return;
        const used = new Set((this._prefs.fallbacks || []).map((c) => c.toLowerCase()));
        if (this._sessionPrimary) used.add(String(this._sessionPrimary).toLowerCase());
        select.innerHTML = '';
        const placeholder = document.createElement('option');
        placeholder.value = '';
        placeholder.textContent = this._t('packageCatalog.addLanguage', 'Add language…');
        placeholder.setAttribute('data-i18n', 'packageCatalog.addLanguage');
        select.appendChild(placeholder);
        for (const loc of this._activatableLocales()) {
            if (used.has(String(loc.code).toLowerCase())) continue;
            const opt = document.createElement('option');
            opt.value = loc.code;
            opt.textContent = loc.endonym || loc.code;
            select.appendChild(opt);
        }
        select.value = '';
    }

    _renderFallbackList() {
        const list = document.getElementById('catalog-fallback-list');
        if (!list) return;
        list.innerHTML = '';
        (this._prefs.fallbacks || []).forEach((code, index) => {
            const li = document.createElement('li');
            li.className = 'catalog-fallback-item';
            const label = document.createElement('span');
            label.textContent = `${index + 1}. ${this._endonym(code) || code}`;
            const up = document.createElement('button');
            up.type = 'button';
            up.className = 'vfs-btn';
            up.disabled = index === 0;
            this._setButtonLabel(up, 'packageCatalog.moveFallbackUp', 'Move up');
            up.addEventListener('click', () => {
                if (index === 0) return;
                const next = this._prefs.fallbacks.slice();
                [next[index - 1], next[index]] = [next[index], next[index - 1]];
                this._prefs.fallbacks = next;
                this._persistPrefs();
                this._syncFallbackControls();
                this._renderFallbackList();
                this._render();
            });
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.className = 'vfs-btn';
            this._setButtonLabel(remove, 'packageCatalog.removeFallback', 'Remove');
            remove.addEventListener('click', () => {
                this._prefs.fallbacks = this._prefs.fallbacks.filter((_, i) => i !== index);
                this._persistPrefs();
                this._syncFallbackControls();
                this._renderFallbackList();
                this._render();
            });
            li.append(label, up, remove);
            list.appendChild(li);
        });
        this._populateFallbackAdd();
    }

    _filterRows() {
        const all = this.packages;
        if (typeof CatalogFilter === 'undefined') {
            return all.map((entry, originalIndex) => ({
                entry, originalIndex, matchedLocale: null, builtin: true,
            }));
        }
        const withDisplay = all.map((entry) => Object.assign({}, entry, {
            displayName: this._displayName(entry),
        }));
        return CatalogFilter.filterCatalog({
            entries: withDisplay,
            query: this._query,
            primary: this._sessionPrimary,
            allowFallbacks: this._prefs.allowFallbacks,
            fallbacks: this._prefs.fallbacks,
            showBuiltins: this._prefs.showBuiltins,
            kernel: this._kernelFilter,
            endonyms: this._endonymMap(),
        });
    }

    _render() {
        if (!this.listEl) return;
        const rows = this._filterRows();
        const all = this.packages;
        this._syncBuiltinsHint(rows);

        if (rows.length === 0) {
            this.listEl.innerHTML = '<p class="catalog-empty"></p>';
            const empty = this.listEl.querySelector('.catalog-empty');
            this._setEmptyCopy(empty);
            return;
        }

        const packages = rows.filter((r) => (r.entry.type || 'package') === 'package');
        const bundles = rows.filter((r) => r.entry.type === 'bundle');
        const workbooks = rows.filter((r) => r.entry.type === 'workbook');

        let html = '';
        if (packages.length > 0) {
            html += `<h3 class="catalog-section-header" data-i18n="packageCatalog.sectionPackages">${this._esc(this._t('packageCatalog.sectionPackages', 'Packages'))}</h3>`;
            html += packages.map((row) => this._renderCard(row.entry, row)).join('');
        }
        if (bundles.length > 0) {
            html += `<h3 class="catalog-section-header" data-i18n="packageCatalog.sectionBundles">${this._esc(this._t('packageCatalog.sectionBundles', 'Bundles'))}</h3>`;
            html += bundles.map((row) => this._renderCard(row.entry, row)).join('');
        }
        if (workbooks.length > 0) {
            html += `<h3 class="catalog-section-header" data-i18n="packageCatalog.sectionWorkbooks">${this._esc(this._t('packageCatalog.sectionWorkbooks', 'Workbooks'))}</h3>`;
            html += workbooks.map((row) => this._renderCard(row.entry, row)).join('');
        }

        this.listEl.innerHTML = html;
        this._wireCatalogTranslations();
        this._syncInstallButtons();

        this.listEl.querySelectorAll('.pkg-install-btn').forEach(btn => {
            btn.addEventListener('click', () => this._install(btn));
        });
    }

    _setEmptyCopy(el) {
        if (!el) return;
        const q = String(this._query || '').trim();
        // An empty default view is only possible when the built-ins exemption
        // is off and the locale chain matched nothing — say that, not a
        // generic "no items", or the hidden list reads as data loss.
        const localeGatedEmpty = !q && this._prefs.showBuiltins === false
            && !CatalogFilter.isAllLocale(this._sessionPrimary);
        if (!q && !localeGatedEmpty) {
            this._setTranslatedText(el, 'packageCatalog.noItems', 'No items available.');
            return;
        }
        const language = CatalogFilter.isAllLocale(this._sessionPrimary)
            ? this._t('packageCatalog.filterAllSpoken', 'All spoken languages')
            : (this._endonym(this._sessionPrimary) || this._sessionPrimary || 'English');
        const rest = (this._prefs.fallbacks || []).filter((code) =>
            !this._sessionPrimary
            || code.toLowerCase() !== String(this._sessionPrimary).toLowerCase());
        const fallbacks = rest.map((code) => this._endonym(code) || code).join(', ');
        if (CatalogFilter.isAllLocale(this._sessionPrimary)) {
            this._setTranslatedText(el, 'packageCatalog.noMatchesAll',
                'No matching packages, bundles, or workbooks.');
        } else if (this._prefs.allowFallbacks && fallbacks) {
            this._setTranslatedText(el, 'packageCatalog.noMatches',
                'No matches in {language}, or in fallbacks {fallbacks}',
                { language, fallbacks });
        } else {
            this._setTranslatedText(el, 'packageCatalog.noMatchesPrimaryOnly',
                'No matches in {language}', { language });
        }
    }

    _renderCard(pkg, row) {
        const installed = this._isInstalled(pkg);
        const dependencyNames = (pkg.requires || [])
            .map(ref => {
                const dependency = this._findEntry(ref);
                return dependency ? this._displayName(dependency) : ref;
            })
            .join(', ');
        const contents = pkg.contentsKey
            ? this._t(pkg.contentsKey, pkg.contents, pkg.contentsVars)
            : pkg.contents;
        const appLocale = (window.i18n && window.i18n.current) || 'en';
        const badge = (typeof CatalogFilter !== 'undefined')
            ? CatalogFilter.localeBadge(pkg, this._sessionPrimary, appLocale,
                row && row.matchedLocale)
            : null;
        const badgeHtml = badge
            ? `<span class="pkg-locale-badge">${this._esc(badge)}</span>`
            : '';
        const sourceRef = pkg._catalog
            ? (pkg._catalog.tag || String(pkg._catalog.commit || '').slice(0, 8))
            : '';
        const sourceHtml = pkg.sourceId
            ? `<small class="pkg-source">${this._esc(pkg.sourceLabel || pkg.sourceId)}${sourceRef ? ` · ${this._esc(sourceRef)}` : ''}</small>`
            : '';
        const catalogKey = this._catalogId(pkg);
        return `
            <div class="pkg-card ${pkg.type === 'bundle' ? 'pkg-bundle-card' : ''}" data-catalog-key="${this._esc(catalogKey)}">
                <div class="pkg-info">
                    <strong class="pkg-display-name">${this._esc(this._displayName(pkg))}</strong>
                    ${pkg.version ? `<span class="pkg-version">${this._esc(pkg.version)}</span>` : ''}
                    ${pkg.size ? `<span class="pkg-size">${this._esc(pkg.sizeLabel || pkg.size)}</span>` : ''}
                    ${contents ? `<span class="pkg-contents">${this._esc(contents)}</span>` : ''}
                    ${pkg.kernels ? `<span class="pkg-kernels">${pkg.kernels.map(k => this._esc(k)).join(', ')}</span>` : ''}
                    ${badgeHtml}
                    <p class="pkg-description">${this._esc(this._description(pkg))}</p>
                    ${sourceHtml}
                    ${dependencyNames ? `<small class="pkg-requires">${this._esc(this._t('packageCatalog.requires', 'Requires: {dependencies}', { dependencies: dependencyNames }))}</small>` : ''}
                </div>
                <button class="pkg-install-btn${installed ? ' pkg-installed' : ''}" data-catalog-key="${this._esc(catalogKey)}"${installed ? ' disabled' : ''}></button>
            </div>
        `;
    }

    _wireCatalogTranslations() {
        if (!this.listEl) return;
        const all = this.packages;
        for (const card of this.listEl.querySelectorAll('.pkg-card')) {
            const pkg = all.find(item => this._catalogId(item) === card.dataset.catalogKey);
            if (!pkg) continue;
            if (pkg.displayNameKey) {
                this._setTranslatedText(card.querySelector('.pkg-display-name'),
                    pkg.displayNameKey, pkg.name);
            }
            if (pkg.descriptionKey) {
                this._setTranslatedText(card.querySelector('.pkg-description'),
                    pkg.descriptionKey, pkg.description);
            }
            if (pkg.contentsKey) {
                this._setTranslatedText(card.querySelector('.pkg-contents'),
                    pkg.contentsKey, pkg.contents, pkg.contentsVars);
            }
            const requires = card.querySelector('.pkg-requires');
            if (requires) {
                const dependencies = (pkg.requires || []).map(ref => {
                    const dependency = this._findEntry(ref);
                    return dependency ? this._displayName(dependency) : ref;
                }).join(', ');
                this._setTranslatedText(requires, 'packageCatalog.requires',
                    'Requires: {dependencies}', { dependencies });
            }
        }
    }

    _translateVisibleCatalog() {
        if (!this.modal || this.modal.classList.contains('hidden')) return;
        const spoken = document.getElementById('catalog-spoken-language');
        const keptPrimary = spoken ? spoken.value : this._sessionPrimary;
        this._populateSpokenSelect();
        if (spoken && keptPrimary) {
            spoken.value = keptPrimary;
            this._sessionPrimary = keptPrimary === 'all' ? null : keptPrimary;
        }
        this._populateKernelSelect();
        this._syncFallbackControls();
        this._render();
        if (window.i18n && typeof window.i18n.applyToDom === 'function') {
            window.i18n.applyToDom(this.modal);
        }
        // The source summary is dynamic (channel, tag, or commit), while its
        // initial DOM marker describes only the default Stable state. Restore
        // the selected source after the generic translation pass.
        this._syncSourceForm();
        this._renderSourceSummary();
    }

    _catalogId(pkg) {
        if (!pkg) return '';
        if (pkg.catalogKey) return pkg.catalogKey;
        if (typeof CatalogFilter !== 'undefined' && typeof CatalogFilter.namespacedId === 'function') {
            return CatalogFilter.namespacedId(pkg);
        }
        return pkg.sourceId ? `${pkg.sourceId}:${pkg.id}` : pkg.id;
    }

    _findEntry(ref) {
        return this.packages.find(p => this._catalogId(p) === ref || p.id === ref || p.name === ref);
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
            const catalogId = this._catalogId(pkg);
            let matches = notebooks.filter(nb => nb && nb.catalogId === catalogId);
            if (matches.length === 0) matches = notebooks.filter(nb => nb && nb.name === expectedName);
            if (matches.length === 0) return 'missing';
            if (pkg.revision == null) return 'current';
            return matches.some(nb =>
                nb.catalogId === catalogId
                && String(nb.catalogRevision) === String(pkg.revision)
                && (!pkg._catalog || nb.catalogSha256 === pkg._catalog.sha256)
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
            const pkg = all.find(item => this._catalogId(item) === btn.dataset.catalogKey);
            const state = this._installState(pkg);
            if (state === 'current') {
                this._setButtonLabel(btn, 'packageCatalog.installed', 'Installed');
            } else if (state === 'outdated') {
                this._setButtonLabel(btn, 'packageCatalog.update', 'Update');
            } else {
                this._setButtonLabel(btn, 'packageCatalog.install', 'Install');
            }
            btn.disabled = state === 'current';
            btn.classList.toggle('pkg-installed', state === 'current');
        });
    }

    async _fetchCatalogItem(pkg) {
        if (!pkg || pkg.type === 'bundle') return null;

        if (pkg.sourceId && this._sourceManager
            && typeof CatalogSource !== 'undefined'
            && pkg.sourceId === CatalogSource.SOURCE_ID) {
            return this._sourceManager.fetchArtifact(pkg);
        }

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
            throw lastError || new Error(this._t('packageCatalog.noDownloadSource',
                'No download source for {name}', { name: this._displayName(pkg) }));
        }
        return blob;
    }

    /**
     * Install a package, bundle, or workbook. Downloads start immediately,
     * but imports are queued so notebook state stays consistent.
     */
    async _install(btn) {
        const key = btn.dataset.catalogKey;
        const pkg = this.packages.find(item => this._catalogId(item) === key);
        if (!pkg) return;
        if (this._isInstalled(pkg)) {
            this._syncInstallButtons();
            return;
        }

        btn.disabled = true;
        if (pkg.type === 'bundle') {
            this._setButtonLabel(btn, 'packageCatalog.preparing', 'Preparing...');
        } else {
            this._setButtonLabel(btn, 'packageCatalog.downloading', 'Downloading...');
        }

        // 1. Download (concurrent — multiple downloads can run at once)
        //    Prefer the locally-bundled copy (reliable + offline, and on the
        //    Pro build it's the up-to-date one); fall back to the remote release
        //    URL only if there's no bundled copy or it fails.
        let blob = null;
        try {
            blob = await this._fetchCatalogItem(pkg);
        } catch (err) {
            console.error('[PackageCatalog] Download failed:', err);
            this._setButtonLabel(btn, 'packageCatalog.failed', 'Failed');
            btn.disabled = false;
            setTimeout(() => this._setButtonLabel(
                btn, 'packageCatalog.install', 'Install'), 3000);
            return;
        }

        // 2. Queue the import (sequential — avoids notebook state races)
        this._importQueue = this._importQueue || [];
        if (this._importRunning) {
            this._setButtonLabel(btn, 'packageCatalog.queued', 'Queued...');
        } else {
            this._setButtonLabel(btn, 'packageCatalog.importing', 'Importing...');
        }
        this._importQueue.push({ btn, pkg, blob });

        if (this._importRunning) return; // will be processed in order
        this._importRunning = true;

        while (this._importQueue.length > 0) {
            const job = this._importQueue.shift();
            this._setButtonLabel(job.btn, 'packageCatalog.importing', 'Importing...');
            try {
                await this._ensureDependencies(job.pkg);
                await this._doImport(job.pkg, job.blob);
                this._rememberInstalled(job.pkg);
                this._syncInstallButtons();
            } catch (err) {
                console.error('[PackageCatalog] Import failed:', err);
                this._setButtonLabel(job.btn, 'packageCatalog.failed', 'Failed');
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
                throw new Error(this._t('packageCatalog.unknownDependency',
                    'Unknown package dependency: {reference}', { reference: ref }));
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
                    throw new Error(this._t('packageCatalog.unknownWorkbook',
                        'Unknown workbook in bundle: {reference}', { reference: ref }));
                }
                if (this._isInstalled(item)) continue;

                await this._ensureDependencies(item);
                const itemBlob = await this._fetchCatalogItem(item);
                await this._doImport(item, itemBlob);
                this._syncInstallButtons();
            }
        } else if (pkg.type === 'workbook' && pkg.format === 'srwb') {
            const text = await blob.text();
            if (!window.fileIO) throw new Error(this._t(
                'packageCatalog.fileIoUnavailable', 'File IO not available'));
            if (pkg.sourceId && typeof window.fileIO.importWorkbook !== 'function') {
                throw new Error(this._t(
                    'packageCatalog.fileIoUnavailable', 'File IO not available'));
            }
            const importer = pkg.sourceId
                ? () => window.fileIO.importWorkbook(text, {
                    format: 'srwb', mode: 'create', sha256: pkg._catalog?.sha256,
                    size: pkg._catalog?.size,
                })
                : () => window.fileIO.importSrwb(text);
            await this._importWorkbook(pkg, importer);
        } else if (pkg.type === 'workbook') {
            const text = await blob.text();
            if (!window.fileIO) throw new Error(this._t(
                'packageCatalog.fileIoUnavailable', 'File IO not available'));
            // Verified remote workbooks use the atomic application importer,
            // which never auto-executes even when the user's ordinary file
            // import preference is enabled.
            if (pkg.sourceId && typeof window.fileIO.importWorkbook !== 'function') {
                throw new Error(this._t(
                    'packageCatalog.fileIoUnavailable', 'File IO not available'));
            }
            const importer = pkg.sourceId
                ? () => window.fileIO.importWorkbook(text, {
                    format: 'ipynb', mode: 'create', sha256: pkg._catalog?.sha256,
                    size: pkg._catalog?.size,
                })
                : () => window.fileIO.importIpynb(text);
            await this._importWorkbook(pkg, importer);
        } else {
            const sourceUrl = pkg.url || pkg.pages_url || 'package.zip';
            const urlParts = sourceUrl.split('/');
            const filename = urlParts[urlParts.length - 1] || 'package.zip';
            const file = new File([blob], filename, { type: blob.type });
            if (!window.packageLoader) throw new Error(this._t(
                'packageCatalog.packageLoaderUnavailable', 'Package loader not available'));
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
        if (!nm) throw new Error(this._t(
            'packageCatalog.notebookManagerUnavailable', 'NotebookManager not available'));

        const expectedName = pkg.notebookName || pkg.name;
        const catalogId = this._catalogId(pkg);
        const activeBeforeImport = nm.getActiveNotebook();
        const before = nm.getNotebooks().slice();
        const beforeSet = new Set(before);
        let previous = before.filter(nb => nb && nb.catalogId === catalogId);
        if (previous.length === 0) {
            // Migration path for catalog workbooks installed before source-aware
            // provenance existed. Name matching is never used once an id is set.
            previous = before.filter(nb => nb && !nb.catalogId && nb.name === expectedName);
        }
        await Promise.resolve(importer());

        const imported = [...nm.getNotebooks()].reverse().find(nb => nb && !beforeSet.has(nb));
        if (!imported) throw new Error(this._t('packageCatalog.workbookNotCreated',
            'Imported workbook was not created: {name}', { name: expectedName }));

        imported.catalogId = catalogId;
        imported.catalogRevision = pkg.revision ?? null;
        imported.catalogSourceId = pkg.sourceId || null;
        imported.catalogRef = pkg._catalog
            ? (pkg._catalog.tag || pkg._catalog.ref || null) : null;
        imported.catalogCommit = pkg._catalog ? pkg._catalog.commit : null;
        imported.catalogPath = pkg._catalog ? pkg._catalog.path : null;
        imported.catalogSha256 = pkg._catalog ? pkg._catalog.sha256 : null;

        // Import first, then preserve stale copies under unique backup names.
        // Catalog workbooks are editable, and older releases did not record
        // enough provenance to distinguish an untouched template from user
        // work. Never silently delete either kind during an update.
        const existingNames = new Set(nm.getNotebooks().map(nb => nb && nb.name).filter(Boolean));
        for (const oldNotebook of previous) {
            if (oldNotebook === imported) continue;
            const revision = oldNotebook.catalogRevision == null
                ? this._t('packageCatalog.unversioned', 'unversioned')
                : this._t('packageCatalog.revision', 'revision {revision}', {
                    revision: oldNotebook.catalogRevision,
                });
            const baseName = this._t('packageCatalog.backupName',
                '{name} (backup of {revision})', { name: expectedName, revision });
            let backupName = baseName;
            let suffix = 2;
            while (existingNames.has(backupName)) {
                backupName = baseName + ' ' + suffix++;
            }
            oldNotebook.catalogId = null;
            oldNotebook.catalogRevision = null;
            oldNotebook.catalogSourceId = null;
            oldNotebook.catalogRef = null;
            oldNotebook.catalogCommit = null;
            oldNotebook.catalogPath = null;
            oldNotebook.catalogSha256 = null;
            nm.renameNotebook(oldNotebook.id, backupName);
            existingNames.add(backupName);
        }
        nm.saveState();
        if (localStorage.getItem('scirepl_auto_switch_workbook') === '0'
            && activeBeforeImport && activeBeforeImport.id !== imported.id) {
            nm.switchTo(activeBeforeImport.id);
        }
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
            throw new Error(this._t('packageCatalog.fetchFailed',
                'Failed to fetch {url} (HTTP {status})', { url, status: response.status }));
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
            this._t('packageCatalog.manualDownloadHelp',
                'Download failed. If running locally, use `npm run serve` for proxy support. ' +
                'Otherwise, download the package manually and use Menu > Import Package.')
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
