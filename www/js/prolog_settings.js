/**
 * prolog_settings.js — Prolog kernel settings modal.
 * Provides UI for managing VFS files, search paths, and URL fetching.
 */

class PrologSettings {
    constructor() {
        this.modal = document.getElementById('prolog-settings-modal');
        this.fileList = document.getElementById('vfs-file-list');
        this.filePreview = document.getElementById('vfs-file-preview');
        this.pathTable = document.getElementById('search-path-tbody');
        this.fetchStatus = document.getElementById('fetch-status');
        this._previewPath = null; // Currently previewed file

        if (!this.modal) return;
        this._initEvents();
    }

    _initEvents() {
        // Close modal
        this.modal.addEventListener('click', (e) => {
            if (e.target === this.modal || e.target.classList.contains('modal-close')) {
                this.modal.classList.add('hidden');
            }
        });

        // Upload .pl file
        const uploadPlBtn = document.getElementById('vfs-upload-pl');
        const uploadPlInput = document.getElementById('vfs-file-input');
        if (uploadPlBtn && uploadPlInput) {
            uploadPlBtn.addEventListener('click', () => uploadPlInput.click());
            uploadPlInput.addEventListener('change', (e) => {
                this._handleFileUpload(e.target.files);
                uploadPlInput.value = '';
            });
        }

        // Upload .zip
        const uploadZipBtn = document.getElementById('vfs-upload-zip');
        const uploadZipInput = document.getElementById('vfs-zip-input');
        if (uploadZipBtn && uploadZipInput) {
            uploadZipBtn.addEventListener('click', () => uploadZipInput.click());
            uploadZipInput.addEventListener('change', (e) => {
                this._handleZipUpload(e.target.files[0]);
                uploadZipInput.value = '';
            });
        }

        // Add search path
        const addPathBtn = document.getElementById('add-search-path-btn');
        if (addPathBtn) {
            addPathBtn.addEventListener('click', () => this._addSearchPath());
        }

        // Fetch from URL
        const fetchBtn = document.getElementById('fetch-url-btn');
        if (fetchBtn) {
            fetchBtn.addEventListener('click', () => this._fetchFromUrl());
        }
    }

    /**
     * Open the settings modal and refresh all displays.
     */
    open() {
        this.modal.classList.remove('hidden');
        this._refreshFileList();
        this._refreshPathTable();
        if (this.fetchStatus) this.fetchStatus.textContent = '';
    }

    /**
     * Get the Prolog kernel's VFS instance.
     */
    _getVFS() {
        const km = window.kernelManager;
        if (!km) return null;
        const kernel = km.getKernel('prolog');
        if (!kernel || !kernel.getVFS) return null;
        return kernel.getVFS();
    }

    // ---- Virtual Files section ----

    async _handleFileUpload(files) {
        const vfs = this._getVFS();
        if (!vfs) {
            alert('Prolog kernel not loaded. Switch to Prolog first.');
            return;
        }

        for (const file of files) {
            const reader = new FileReader();
            reader.onload = (e) => {
                const content = e.target.result;
                vfs.writeFile('/user/' + file.name, content);
                this._refreshFileList();
            };
            reader.readAsText(file);
        }
    }

    async _handleZipUpload(file) {
        if (!file) return;
        const vfs = this._getVFS();
        if (!vfs) {
            alert('Prolog kernel not loaded. Switch to Prolog first.');
            return;
        }

        try {
            const buffer = await file.arrayBuffer();
            const paths = await vfs.mountZip(buffer);
            this._refreshFileList();
            alert('Extracted ' + paths.length + ' files from ' + file.name);
        } catch (err) {
            alert('ZIP extraction failed: ' + err.message);
        }
    }

    _refreshFileList() {
        if (!this.fileList) return;
        const vfs = this._getVFS();

        if (!vfs) {
            this.fileList.innerHTML = '<div class="vfs-empty">Prolog kernel not loaded.</div>';
            return;
        }

        const tree = vfs.getTree('/user');
        if (tree.length === 0) {
            this.fileList.innerHTML = '<div class="vfs-empty">No files mounted.</div>';
            return;
        }

        this.fileList.innerHTML = '';
        for (const entry of tree) {
            const div = document.createElement('div');
            div.className = 'vfs-entry vfs-' + entry.type;
            if (entry.type === 'file' && entry.path === this._previewPath) {
                div.classList.add('vfs-entry-active');
            }
            div.style.paddingLeft = (12 + entry.depth * 16) + 'px';

            const icon = entry.type === 'dir' ? '&#128193;' : '&#128196;';
            const size = entry.type === 'file' ? ` <span class="vfs-size">(${this._formatSize(entry.size)})</span>` : '';

            div.innerHTML = `<span class="vfs-icon">${icon}</span> <span class="vfs-name">${entry.name}</span>${size}`;

            // Make files clickable to preview
            if (entry.type === 'file') {
                div.style.cursor = 'pointer';
                div.title = 'Click to view contents';
                div.addEventListener('click', (e) => {
                    // Don't trigger if clicking delete button
                    if (e.target.classList.contains('vfs-delete-btn')) return;
                    this._showFilePreview(entry.path, vfs);
                });
            }

            // Add delete button for files (not prelude.pl)
            if (entry.type === 'file' && entry.path !== '/user/prelude.pl') {
                const delBtn = document.createElement('button');
                delBtn.className = 'vfs-delete-btn';
                delBtn.textContent = '\u00D7';
                delBtn.title = 'Remove file';
                delBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    vfs.removeFile(entry.path);
                    if (this._previewPath === entry.path) {
                        this._previewPath = null;
                        this._clearPreview();
                    }
                    this._refreshFileList();
                });
                div.appendChild(delBtn);
            }

            this.fileList.appendChild(div);
        }
    }

    _formatSize(bytes) {
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    }

    /**
     * Show file contents in the preview pane with edit capability.
     */
    _showFilePreview(path, vfs) {
        this._previewPath = path;

        if (!this.filePreview) return;

        try {
            const content = vfs.readFile(path);
            this.filePreview.innerHTML = '';
            this.filePreview.classList.remove('hidden');

            // Header with path and action buttons
            const header = document.createElement('div');
            header.className = 'vfs-preview-header';
            header.innerHTML = `<span class="vfs-preview-path">${path}</span>`;

            const actions = document.createElement('div');
            actions.className = 'vfs-preview-actions';

            const saveBtn = document.createElement('button');
            saveBtn.className = 'vfs-preview-save hidden';
            saveBtn.textContent = 'Save';
            saveBtn.title = 'Save changes';

            const editBtn = document.createElement('button');
            editBtn.className = 'vfs-preview-edit';
            editBtn.textContent = 'Edit';
            editBtn.title = 'Edit file';

            const closeBtn = document.createElement('button');
            closeBtn.className = 'vfs-preview-close';
            closeBtn.textContent = '\u00D7';
            closeBtn.title = 'Close preview';

            actions.appendChild(saveBtn);
            actions.appendChild(editBtn);
            actions.appendChild(closeBtn);
            header.appendChild(actions);

            // Read-only view
            const pre = document.createElement('pre');
            pre.className = 'vfs-preview-code';
            pre.textContent = content;

            // Editable textarea (hidden initially)
            const textarea = document.createElement('textarea');
            textarea.className = 'vfs-preview-editor hidden';
            textarea.value = content;
            textarea.spellcheck = false;
            textarea.setAttribute('autocapitalize', 'off');
            textarea.setAttribute('autocomplete', 'off');

            this.filePreview.appendChild(header);
            this.filePreview.appendChild(pre);
            this.filePreview.appendChild(textarea);

            // Edit button — switch to edit mode
            editBtn.addEventListener('click', () => {
                pre.classList.add('hidden');
                textarea.classList.remove('hidden');
                textarea.value = vfs.readFile(path);
                editBtn.classList.add('hidden');
                saveBtn.classList.remove('hidden');
                textarea.focus();
                // Auto-size
                textarea.style.height = 'auto';
                textarea.style.height = Math.min(textarea.scrollHeight, 300) + 'px';
            });

            // Save button — write back to VFS
            saveBtn.addEventListener('click', () => {
                vfs.writeFile(path, textarea.value);
                pre.textContent = textarea.value;
                pre.classList.remove('hidden');
                textarea.classList.add('hidden');
                saveBtn.classList.add('hidden');
                editBtn.classList.remove('hidden');
                this._refreshFileList();
            });

            // Close button
            closeBtn.addEventListener('click', () => {
                this._previewPath = null;
                this._clearPreview();
                this._refreshFileList();
            });

            // Auto-resize textarea on input
            textarea.addEventListener('input', () => {
                textarea.style.height = 'auto';
                textarea.style.height = Math.min(textarea.scrollHeight, 300) + 'px';
            });

            // Ctrl+S / Cmd+S to save while editing
            textarea.addEventListener('keydown', (e) => {
                if ((e.ctrlKey || e.metaKey) && e.key === 's') {
                    e.preventDefault();
                    saveBtn.click();
                }
                if (e.key === 'Tab') {
                    e.preventDefault();
                    const start = textarea.selectionStart;
                    const end = textarea.selectionEnd;
                    textarea.value = textarea.value.substring(0, start) + '    ' + textarea.value.substring(end);
                    textarea.selectionStart = textarea.selectionEnd = start + 4;
                }
            });

        } catch (e) {
            this.filePreview.innerHTML = '<div class="vfs-empty">Cannot read file (binary or inaccessible)</div>';
            this.filePreview.classList.remove('hidden');
        }

        // Update active highlight in file list
        this._refreshFileList();
    }

    _clearPreview() {
        if (this.filePreview) {
            this.filePreview.innerHTML = '';
            this.filePreview.classList.add('hidden');
        }
    }

    // ---- Search Paths section ----

    _refreshPathTable() {
        if (!this.pathTable) return;
        const vfs = this._getVFS();

        if (!vfs) {
            this.pathTable.innerHTML = '<tr><td colspan="3" class="vfs-empty">Prolog kernel not loaded.</td></tr>';
            return;
        }

        const paths = vfs.getSearchPaths();
        this.pathTable.innerHTML = '';

        if (paths.length === 0) {
            this.pathTable.innerHTML = '<tr><td colspan="3" class="vfs-empty">No user search paths.</td></tr>';
            return;
        }

        for (const p of paths) {
            const tr = document.createElement('tr');
            tr.innerHTML = `<td>${p.alias}</td><td>${p.dir}</td><td></td>`;

            // Don't allow removing the default 'user' path
            if (p.alias !== 'user' || p.dir !== '/user') {
                const delBtn = document.createElement('button');
                delBtn.className = 'vfs-delete-btn';
                delBtn.textContent = '\u00D7';
                delBtn.title = 'Remove path';
                delBtn.addEventListener('click', () => {
                    vfs.removeSearchPath(p.alias, p.dir);
                    this._refreshPathTable();
                });
                tr.lastElementChild.appendChild(delBtn);
            }

            this.pathTable.appendChild(tr);
        }
    }

    _addSearchPath() {
        const aliasInput = document.getElementById('path-alias-input');
        const dirInput = document.getElementById('path-dir-input');
        if (!aliasInput || !dirInput) return;

        const alias = aliasInput.value.trim();
        const dir = dirInput.value.trim();

        if (!alias || !dir) {
            alert('Both alias and directory are required.');
            return;
        }

        const vfs = this._getVFS();
        if (!vfs) {
            alert('Prolog kernel not loaded.');
            return;
        }

        vfs.addSearchPath(alias, dir);
        aliasInput.value = '';
        dirInput.value = '';
        this._refreshPathTable();
    }

    // ---- Fetch from URL section ----

    async _fetchFromUrl() {
        const urlInput = document.getElementById('fetch-url-input');
        const pathInput = document.getElementById('fetch-path-input');
        if (!urlInput) return;

        const url = urlInput.value.trim();
        const localPath = pathInput ? pathInput.value.trim() : '';

        if (!url) {
            alert('URL is required.');
            return;
        }

        const vfs = this._getVFS();
        if (!vfs) {
            alert('Prolog kernel not loaded.');
            return;
        }

        if (this.fetchStatus) this.fetchStatus.textContent = 'Fetching...';

        try {
            const path = await vfs.fetchFile(url, localPath || undefined);
            if (this.fetchStatus) this.fetchStatus.textContent = 'Fetched: ' + path;
            urlInput.value = '';
            if (pathInput) pathInput.value = '';
            this._refreshFileList();
        } catch (err) {
            if (this.fetchStatus) this.fetchStatus.textContent = 'Error: ' + err.message;
        }
    }
}

// Initialize after DOM ready
window.prologSettings = new PrologSettings();
