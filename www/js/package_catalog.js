/**
 * package_catalog.js — Browse and install packages from predefined URLs.
 *
 * A lightweight alternative to a full package manager: a curated list of
 * package URLs (typically GitHub release assets) that users can install
 * with one click.
 */

class PackageCatalog {
    constructor() {
        this.modal = document.getElementById('package-catalog-modal');
        this.listEl = document.getElementById('package-catalog-list');
        this._init();
    }

    /**
     * The package catalog.  Add entries here to make them available to users.
     * Each entry needs: name, description, url, and optionally version/size.
     */
    get packages() {
        return [
            {
                name: 'UnifyWeaver SciREPL',
                description: 'Physics knowledge-base notebooks with Prolog inference, embedding search, and mindmap tools.',
                version: 'v0.3.0',
                url: 'https://github.com/s243a/SciREPL/releases/download/v0.3.0/unifyweaver_scirepl.zip',
                size: '~2 MB',
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
        const pkgs = this.packages;

        if (pkgs.length === 0) {
            this.listEl.innerHTML = '<p>No packages available.</p>';
            return;
        }

        this.listEl.innerHTML = pkgs.map((pkg, i) => `
            <div class="pkg-card">
                <div class="pkg-info">
                    <strong>${this._esc(pkg.name)}</strong>
                    ${pkg.version ? `<span class="pkg-version">${this._esc(pkg.version)}</span>` : ''}
                    ${pkg.size ? `<span class="pkg-size">${this._esc(pkg.size)}</span>` : ''}
                    <p>${this._esc(pkg.description)}</p>
                </div>
                <button class="pkg-install-btn" data-idx="${i}">Install</button>
            </div>
        `).join('');

        // Attach install handlers
        this.listEl.querySelectorAll('.pkg-install-btn').forEach(btn => {
            btn.addEventListener('click', () => this._install(btn));
        });
    }

    async _install(btn) {
        const idx = parseInt(btn.dataset.idx, 10);
        const pkg = this.packages[idx];
        if (!pkg) return;

        btn.disabled = true;
        btn.textContent = 'Downloading...';

        try {
            const blob = await this._fetchPackage(pkg.url);

            btn.textContent = 'Importing...';

            // Derive filename from URL
            const urlParts = pkg.url.split('/');
            const filename = urlParts[urlParts.length - 1] || 'package.zip';
            const file = new File([blob], filename, { type: blob.type });

            if (window.packageLoader) {
                await window.packageLoader.loadFromFile(file);
                btn.textContent = 'Installed';
                btn.classList.add('pkg-installed');
            } else {
                throw new Error('Package loader not available');
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
     * On Capacitor (Android/iOS), uses the native Filesystem.downloadFile()
     * API to bypass WebView CORS restrictions.  On web, uses plain fetch().
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

        // Web fallback
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        return await response.blob();
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
