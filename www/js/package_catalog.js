/**
 * package_catalog.js — Browse and install packages/workbooks from predefined URLs.
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
     * Each entry needs: name, description, url, and optionally version/size/type.
     * type: 'package' (default, .zip) or 'workbook' (.ipynb)
     */
    get packages() {
        return [
            {
                name: 'UnifyWeaver SciREPL',
                description: 'Physics knowledge-base notebooks with Prolog inference, embedding search, and mindmap tools.',
                type: 'package',
                version: 'v0.3.0',
                url: 'https://github.com/s243a/SciREPL/releases/download/v0.3.0/unifyweaver_scirepl.zip',
                pages_url: 'packages/unifyweaver_scirepl.zip',
                size: '~2 MB',
                kernels: ['prolog', 'python'],
            },
            {
                name: 'Life Expectancy Analysis',
                description: 'Mixed Python/R workbook: Gapminder & WHO datasets with pandas, plotly, and R base graphics.',
                type: 'workbook',
                url: 'https://github.com/s243a/SciREPL/releases/download/v0.7.0/life_expectancy_csv_demo.ipynb',
                pages_url: 'workbooks/life_expectancy_csv_demo.ipynb',
                size: '~8 KB',
                kernels: ['python', 'r'],
            },
            {
                name: 'ggplot2 Showcase',
                description: 'Scatter, bar, density, box, and heatmap charts with ggplot2 dark theme. Uses built-in R datasets.',
                type: 'workbook',
                url: 'https://github.com/s243a/SciREPL/releases/download/v0.8.0/r_ggplot2_showcase.ipynb',
                pages_url: 'workbooks/r_ggplot2_showcase.ipynb',
                size: '~5 KB',
                kernels: ['r'],
            },
            {
                name: 'Tidyverse Data Wrangling',
                description: 'dplyr/tidyr pipelines with cross-language CSV sharing: Python downloads, R processes, Python visualizes.',
                type: 'workbook',
                url: 'https://github.com/s243a/SciREPL/releases/download/v0.8.0/r_tidyverse_wrangling.ipynb',
                pages_url: 'workbooks/r_tidyverse_wrangling.ipynb',
                size: '~6 KB',
                kernels: ['python', 'r'],
            },
            {
                name: 'Statistics with R',
                description: 'Hypothesis testing (t-test, chi-squared, ANOVA), regression, confidence intervals, and diagnostic plots.',
                type: 'workbook',
                url: 'https://github.com/s243a/SciREPL/releases/download/v0.8.0/r_statistics.ipynb',
                pages_url: 'workbooks/r_statistics.ipynb',
                size: '~5 KB',
                kernels: ['r'],
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
        const workbooks = all.filter(p => p.type === 'workbook');

        let html = '';
        if (packages.length > 0) {
            html += '<h3 class="catalog-section-header">Packages</h3>';
            html += packages.map((pkg) => this._renderCard(pkg, all.indexOf(pkg))).join('');
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
        return `
            <div class="pkg-card">
                <div class="pkg-info">
                    <strong>${this._esc(pkg.name)}</strong>
                    ${pkg.version ? `<span class="pkg-version">${this._esc(pkg.version)}</span>` : ''}
                    ${pkg.size ? `<span class="pkg-size">${this._esc(pkg.size)}</span>` : ''}
                    ${pkg.kernels ? `<span class="pkg-kernels">${pkg.kernels.map(k => this._esc(k)).join(', ')}</span>` : ''}
                    <p>${this._esc(pkg.description)}</p>
                </div>
                <button class="pkg-install-btn" data-idx="${idx}">Install</button>
            </div>
        `;
    }

    async _install(btn) {
        const idx = parseInt(btn.dataset.idx, 10);
        const pkg = this.packages[idx];
        if (!pkg) return;

        btn.disabled = true;
        btn.textContent = 'Downloading...';

        try {
            let blob;
            // Try same-origin pages_url first (GitHub Pages deployment)
            if (pkg.pages_url) {
                try {
                    blob = await this._fetchPackage(pkg.pages_url);
                } catch (e) {
                    // pages_url not available — fall through to main URL
                }
            }
            // Fall back to main URL (direct fetch → CORS proxy)
            if (!blob) {
                blob = await this._fetchPackage(pkg.url);
            }

            btn.textContent = 'Importing...';

            if (pkg.type === 'workbook') {
                // Workbook: read as text and import via FileIO
                const text = await blob.text();
                if (window.fileIO) {
                    window.fileIO.importIpynb(text);
                } else {
                    throw new Error('File IO not available');
                }
            } else {
                // Package: extract archive via PackageLoader
                const urlParts = pkg.url.split('/');
                const filename = urlParts[urlParts.length - 1] || 'package.zip';
                const file = new File([blob], filename, { type: blob.type });

                if (window.packageLoader) {
                    await window.packageLoader.loadFromFile(file);
                } else {
                    throw new Error('Package loader not available');
                }
            }

            btn.textContent = 'Installed';
            btn.classList.add('pkg-installed');

            // Close modal after workbook import so user sees their cells
            // (unless auto-switch is disabled — user wants to keep browsing)
            const autoSwitch = localStorage.getItem('scirepl_auto_switch_workbook') !== '0';
            if (autoSwitch && pkg.type === 'workbook' && this.modal) {
                setTimeout(() => this.modal.classList.add('hidden'), 500);
            }
        } catch (err) {
            console.error('[PackageCatalog] Install failed:', err);
            btn.textContent = 'Failed';
            btn.disabled = false;
            setTimeout(() => { btn.textContent = 'Install'; }, 3000);
            alert('Package install failed: ' + err.message);
        }
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
        // Capacitor native path — download via native HTTP
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
