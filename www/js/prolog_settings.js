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
        this._selectedFolder = null; // Currently selected folder path
        this._selectedSource = null; // VFS source of selected folder

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

        // Upload to SharedVFS
        const uploadSharedBtn = document.getElementById('vfs-upload-shared');
        const uploadSharedInput = document.getElementById('vfs-shared-input');
        if (uploadSharedBtn && uploadSharedInput) {
            uploadSharedBtn.addEventListener('click', () => uploadSharedInput.click());
            uploadSharedInput.addEventListener('change', (e) => {
                this._handleSharedUpload(e.target.files[0]);
                uploadSharedInput.value = '';
            });
        }

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

        // Kernel selector for VFS uploads
        this.kernelSelect = document.getElementById('vfs-kernel-select');
        if (this.kernelSelect) {
            this.kernelSelect.addEventListener('change', () => {
                this._onKernelSelectChange();
            });
        }

        // Show empty folders checkbox
        this.showEmptyDirs = document.getElementById('vfs-show-empty-dirs');
        this.showEmptyLabel = document.getElementById('vfs-show-empty-label');
        if (this.showEmptyDirs) {
            this.showEmptyDirs.addEventListener('change', () => this._refreshFileList());
        }

        // New Folder
        const newFolderBtn = document.getElementById('vfs-new-folder-btn');
        if (newFolderBtn) {
            newFolderBtn.addEventListener('click', () => this._createNewFolder());
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
        this._selectedFolder = null;
        this._selectedSource = null;
        this._refreshKernelSelect();
        this._refreshFileList();
        this._refreshPathTable();
        if (this.fetchStatus) this.fetchStatus.textContent = '';
    }

    /**
     * Update kernel selector: grey out unloaded kernels.
     */
    _refreshKernelSelect() {
        if (!this.kernelSelect) return;
        const km = window.kernelManager;
        if (!km) return;

        const labels = {
            unified: 'All Filesystems',
            shared: '/ (Persistent Storage)'
        };
        const mntLabels = { prolog: '/mnt/prolog', python: '/mnt/pyodide', r: '/mnt/r' };

        for (const option of this.kernelSelect.options) {
            const lang = option.value;
            if (labels[lang]) {
                option.classList.remove('kernel-not-loaded');
                option.textContent = labels[lang];
                continue;
            }
            const ready = km.isReady(lang);
            option.classList.toggle('kernel-not-loaded', !ready);
            option.textContent = (mntLabels[lang] || lang) + (ready ? '' : ' (not loaded)');
        }
    }

    /**
     * Handle kernel selector change — prompt to load if not ready.
     */
    async _onKernelSelectChange() {
        const lang = this.kernelSelect.value;
        const km = window.kernelManager;
        if (!km) return;

        const kernelsWithVFS = ['prolog', 'python'];
        if (!['shared', 'unified'].includes(lang) && !km.isReady(lang) && kernelsWithVFS.includes(lang)) {
            const load = confirm(
                lang.charAt(0).toUpperCase() + lang.slice(1) +
                ' kernel is not loaded. Download and initialize it now?'
            );
            if (load) {
                try {
                    this.kernelSelect.disabled = true;
                    await km.ensureReady(lang);
                    this._refreshKernelSelect();
                } catch (err) {
                    alert('Failed to load ' + lang + ': ' + err.message);
                } finally {
                    this.kernelSelect.disabled = false;
                }
            }
        }
        this._refreshFileList();
    }

    /**
     * Get the selected kernel's VFS instance (or SharedVFS).
     */
    _getVFS() {
        const lang = this.kernelSelect ? this.kernelSelect.value : 'prolog';
        if (lang === 'shared' || lang === 'unified') return window.sharedVFS || null;

        const km = window.kernelManager;
        if (!km) return null;
        const kernel = km._instances[lang];
        if (!kernel || !kernel.getVFS) return null;
        return kernel.getVFS();
    }

    /**
     * Resolve the correct VFS for a file based on its source tag.
     * Used by the unified view for preview/delete.
     */
    _resolveVFS(source) {
        if (source === 'persistent' || source === 'shared') return window.sharedVFS || null;
        const km = window.kernelManager;
        if (!km) return null;
        const kernel = km._instances[source];
        return (kernel && kernel.getVFS) ? kernel.getVFS() : null;
    }

    // ---- SharedVFS upload ----

    _handleSharedUpload(file) {
        if (!file) return;
        if (!window.sharedVFS) {
            alert('SharedVFS not available.');
            return;
        }

        const destInput = document.getElementById('shared-upload-path');
        let destDir = destInput ? destInput.value.trim() : '/shared/data/';
        if (!destDir.endsWith('/')) destDir += '/';

        // ZIP files: offer to extract or upload as whole file
        if (file.name.toLowerCase().endsWith('.zip')) {
            const choice = confirm(
                'Extract "' + file.name + '" into ' + destDir + '?\n\n' +
                'OK = Extract contents\nCancel = Upload as .zip file'
            );
            if (choice) {
                this._extractZipToSharedVFS(file, destDir);
                return;
            }
            // Fall through to upload as single file
        }

        const destPath = destDir + file.name;
        const isText = /\.(csv|tsv|txt|json|jsonl|xml|html|md|r|R|js|yaml|yml|toml|ini|cfg|conf|log|sql|sh|bash|py|pl|pro)$/i.test(file.name);

        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                if (isText) {
                    window.sharedVFS.writeFile(destPath, e.target.result, 'user');
                } else {
                    window.sharedVFS.writeFile(destPath, new Uint8Array(e.target.result), 'user');
                }
                this._refreshFileList();
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

    async _extractZipToSharedVFS(file, destDir) {
        if (typeof JSZip === 'undefined') {
            alert('JSZip not loaded.');
            return;
        }
        try {
            const buffer = await file.arrayBuffer();
            const zip = await JSZip.loadAsync(buffer);
            let count = 0;
            const textExts = /\.(csv|tsv|txt|json|jsonl|xml|html|md|r|R|js|yaml|yml|toml|ini|cfg|conf|log|sql|sh|bash|py|pl|pro)$/i;

            for (const [relativePath, entry] of Object.entries(zip.files)) {
                if (entry.dir) {
                    window.sharedVFS.mkdirTree(destDir + relativePath);
                    continue;
                }
                const fullPath = destDir + relativePath;
                if (textExts.test(relativePath)) {
                    window.sharedVFS.writeFile(fullPath, await entry.async('string'), 'user');
                } else {
                    window.sharedVFS.writeFile(fullPath, await entry.async('uint8array'), 'user');
                }
                count++;
            }
            this._refreshFileList();
            alert('Extracted ' + count + ' file(s) from ' + file.name);
        } catch (err) {
            alert('ZIP extraction failed: ' + err.message);
        }
    }

    // ---- Kernel Virtual Files section ----

    async _handleFileUpload(files) {
        const lang = this.kernelSelect ? this.kernelSelect.value : 'prolog';
        const vfs = this._getVFS();
        if (!vfs) {
            alert('For ' + lang + ' use SharedVFS instead (see above).');
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
        const lang = this.kernelSelect ? this.kernelSelect.value : 'prolog';

        // For SharedVFS or unified view, use the SharedVFS extract-or-upload flow
        if (lang === 'shared' || lang === 'unified') {
            const destInput = document.getElementById('shared-upload-path');
            let destDir = destInput ? destInput.value.trim() : '/shared/data/';
            if (!destDir.endsWith('/')) destDir += '/';

            const choice = confirm(
                'Extract "' + file.name + '" into ' + destDir + '?\n\n' +
                'OK = Extract contents\nCancel = Upload as .zip file'
            );
            if (choice) {
                this._extractZipToSharedVFS(file, destDir);
            } else {
                // Upload as whole file
                const buffer = await file.arrayBuffer();
                window.sharedVFS.writeFile(destDir + file.name, new Uint8Array(buffer), 'user');
                this._refreshFileList();
            }
            return;
        }

        const vfs = this._getVFS();
        if (!vfs) {
            alert('For ' + lang + ' use SharedVFS instead (see above).');
            return;
        }

        if (vfs.mountZip) {
            try {
                const buffer = await file.arrayBuffer();
                const paths = await vfs.mountZip(buffer);
                this._refreshFileList();
                alert('Extracted ' + paths.length + ' files from ' + file.name);
            } catch (err) {
                alert('ZIP extraction failed: ' + err.message);
            }
        } else {
            alert('This filesystem does not support ZIP extraction. Switch to SharedVFS.');
        }
    }

    _refreshFileList() {
        if (!this.fileList) return;
        const lang = this.kernelSelect ? this.kernelSelect.value : 'prolog';
        const km = window.kernelManager;

        if (lang === 'unified') {
            return this._refreshUnifiedView();
        }

        const isShared = lang === 'shared';
        const isLoaded = isShared || (km && km.isReady(lang));
        const vfs = this._getVFS();

        // Show/hide the "Show empty folders" checkbox
        if (this.showEmptyLabel) {
            this.showEmptyLabel.style.display = (isShared || lang === 'unified') ? '' : 'none';
        }

        if (!isLoaded) {
            this.fileList.innerHTML = '<div class="vfs-empty">' + lang + ' kernel is not loaded.</div>';
            return;
        }

        if (!vfs) {
            this.fileList.innerHTML = '<div class="vfs-empty">No VFS available for ' + lang + '.</div>';
            return;
        }

        // Each kernel can have multiple root directories to browse
        const basePathMap = {
            prolog: ['/user'],
            python: ['/home/pyodide'],
            shared: ['/shared'],
        };
        const roots = basePathMap[lang] || ['/shared'];
        const multiRoot = roots.length > 1;
        let tree = [];

        for (const root of roots) {
            const subtree = vfs.getTree(root);
            if (!subtree || subtree.length === 0) continue;

            if (isShared) {
                this._addSharedVFSEntries(tree, subtree, root, 'persistent');
            } else if (multiRoot) {
                tree.push({ path: root, name: root, type: 'dir', size: 0, depth: 0, source: lang });
                for (const e of subtree) {
                    tree.push({ ...e, depth: e.depth + 1, source: lang });
                }
            } else {
                for (const e of subtree) {
                    tree.push({ ...e, source: lang });
                }
            }
        }

        this._renderTree(tree, vfs);
    }

    /**
     * Unified view: shows persistent storage + mount points for each kernel.
     */
    _refreshUnifiedView() {
        if (!this.fileList) return;
        const km = window.kernelManager;

        if (this.showEmptyLabel) {
            this.showEmptyLabel.style.display = '';
        }

        let tree = [];

        // 1. Persistent storage: SharedVFS files at root
        const sharedVFS = window.sharedVFS;
        if (sharedVFS) {
            const subtree = sharedVFS.getTree('/shared');
            if (subtree && subtree.length > 0) {
                this._addSharedVFSEntries(tree, subtree, '/shared', 'persistent');
            }
        }

        // 2. Mount points for kernel-specific filesystems
        const mounts = [
            { lang: 'prolog', label: '/mnt/prolog', roots: ['/user'] },
            { lang: 'python', label: '/mnt/pyodide', roots: ['/home/pyodide'] },
        ];

        for (const mp of mounts) {
            const ready = km && km.isReady(mp.lang);

            // Mount point header
            tree.push({
                path: mp.label,
                name: mp.label,
                type: 'mount',
                size: 0,
                depth: 0,
                source: mp.lang,
                notLoaded: !ready
            });

            if (!ready) continue;

            const kernel = km._instances[mp.lang];
            if (!kernel || !kernel.getVFS) continue;
            const vfs = kernel.getVFS();
            if (!vfs) continue;

            for (const root of mp.roots) {
                const subtree = vfs.getTree(root);
                if (!subtree) continue;
                for (const e of subtree) {
                    tree.push({ ...e, depth: (e.depth || 0) + 1, source: mp.lang });
                }
            }
        }

        this._renderTree(tree, null);
    }

    /**
     * Normalize SharedVFS tree entries and add to the tree array.
     * Filters empty directories unless the checkbox is checked.
     */
    _addSharedVFSEntries(tree, subtree, root, source) {
        const baseDepth = root.split('/').filter(Boolean).length;
        const showEmpty = this.showEmptyDirs && this.showEmptyDirs.checked;

        let dirsWithFiles = null;
        if (!showEmpty) {
            const filePaths = new Set(subtree.filter(e => !e.isDir).map(e => e.path));
            dirsWithFiles = new Set();
            for (const fp of filePaths) {
                const parts = fp.split('/');
                for (let i = 2; i < parts.length; i++) {
                    dirsWithFiles.add(parts.slice(0, i).join('/'));
                }
            }
            // Always include the selected folder and its ancestors
            if (this._selectedFolder) {
                const parts = this._selectedFolder.split('/');
                for (let i = 2; i <= parts.length; i++) {
                    dirsWithFiles.add(parts.slice(0, i).join('/'));
                }
            }
        }

        for (const e of subtree) {
            if (e.path === root) continue;
            if (e.isDir && dirsWithFiles && !dirsWithFiles.has(e.path)) continue;
            tree.push({
                path: e.path,
                name: e.path.split('/').pop(),
                type: e.isDir ? 'dir' : 'file',
                size: e.size || 0,
                depth: e.path.split('/').filter(Boolean).length - baseDepth,
                origin: e.origin,
                source: source
            });
        }
    }

    /**
     * Render a tree of file entries into the file list element.
     * @param {Array} tree - normalized entries with {path, name, type, size, depth, source}
     * @param {Object|null} defaultVFS - VFS to use for preview/delete (null = resolve per entry)
     */
    _renderTree(tree, defaultVFS) {
        if (tree.length === 0) {
            this.fileList.innerHTML = '<div class="vfs-empty">No files mounted.</div>';
            return;
        }

        this.fileList.innerHTML = '';
        for (const entry of tree) {
            const div = document.createElement('div');
            div.className = 'vfs-entry vfs-' + entry.type;
            if (entry.notLoaded) div.classList.add('vfs-not-loaded');
            if (entry.type === 'file' && entry.path === this._previewPath) {
                div.classList.add('vfs-entry-active');
            }
            if (entry.type === 'dir' && entry.path === this._selectedFolder) {
                div.classList.add('vfs-dir-selected');
            }
            div.style.paddingLeft = (12 + entry.depth * 16) + 'px';

            const icons = { dir: '&#128193;', file: '&#128196;', mount: '&#128190;' };
            const icon = icons[entry.type] || '&#128196;';
            const size = entry.type === 'file' ? ` <span class="vfs-size">(${this._formatSize(entry.size)})</span>` : '';

            div.innerHTML = `<span class="vfs-icon">${icon}</span> <span class="vfs-name">${entry.name}</span>${size}`;

            // Make directories clickable for selection
            if (entry.type === 'dir') {
                div.style.cursor = 'pointer';
                div.title = 'Click to select folder';
                div.addEventListener('click', (e) => {
                    if (e.target.closest('.vfs-entry-actions')) return;
                    this._selectFolder(entry.path, entry.source);
                });
            }

            // Make files clickable to preview
            if (entry.type === 'file') {
                div.style.cursor = 'pointer';
                div.title = 'Click to view contents';
                div.addEventListener('click', (e) => {
                    if (e.target.closest('.vfs-entry-actions')) return;
                    const vfs = defaultVFS || this._resolveVFS(entry.source);
                    if (vfs) this._showFilePreview(entry.path, vfs);
                });
            }

            // Action buttons for files and dirs (not mount points or prelude.pl)
            if (entry.type === 'file' || entry.type === 'dir') {
                const btnGroup = document.createElement('span');
                btnGroup.className = 'vfs-entry-actions';

                // Download button
                const dlBtn = document.createElement('button');
                dlBtn.className = 'vfs-download-btn';
                dlBtn.innerHTML = '&#8681;';
                dlBtn.title = entry.type === 'dir' ? 'Download folder as .zip' : 'Download file';
                dlBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (entry.type === 'dir') {
                        this._downloadFolderAsZip(entry.path, entry.source, defaultVFS);
                    } else {
                        const vfs = defaultVFS || this._resolveVFS(entry.source);
                        if (!vfs) return;
                        try {
                            const content = vfs.readFile(entry.path);
                            if (content == null) { alert('Cannot read file.'); return; }
                            const filename = entry.path.split('/').pop();
                            const mimeType = content instanceof Uint8Array ? 'application/octet-stream' : 'text/plain';
                            if (window.fileIO) window.fileIO.downloadFile(filename, content, mimeType);
                        } catch (err) {
                            alert('Download failed: ' + err.message);
                        }
                    }
                });
                btnGroup.appendChild(dlBtn);

                // Delete button (not for prelude.pl)
                if (entry.path !== '/user/prelude.pl') {
                    const delBtn = document.createElement('button');
                    delBtn.className = 'vfs-delete-btn';
                    delBtn.textContent = '\u00D7';
                    delBtn.title = 'Remove';
                    delBtn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        const vfs = defaultVFS || this._resolveVFS(entry.source);
                        if (vfs) {
                            if (entry.type === 'file') {
                                vfs.removeFile(entry.path);
                            } else if (entry.type === 'dir' && vfs.rmdir) {
                                vfs.rmdir(entry.path);
                            }
                        }
                        if (this._previewPath === entry.path) {
                            this._previewPath = null;
                            this._clearPreview();
                        }
                        if (this._selectedFolder === entry.path) {
                            this._selectedFolder = null;
                            this._selectedSource = null;
                        }
                        this._refreshFileList();
                    });
                    btnGroup.appendChild(delBtn);
                }

                div.appendChild(btnGroup);
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

    // ---- Folder selection ----

    _selectFolder(path, source) {
        if (this._selectedFolder === path) {
            this._selectedFolder = null;
            this._selectedSource = null;
        } else {
            this._selectedFolder = path;
            this._selectedSource = source;
        }
        const destInput = document.getElementById('shared-upload-path');
        if (destInput && this._selectedFolder) {
            destInput.value = this._selectedFolder + '/';
        }
        this._refreshFileList();
    }

    _createNewFolder() {
        if (!window.sharedVFS) {
            alert('SharedVFS not available.');
            return;
        }
        const base = this._selectedFolder || '/shared';
        const name = prompt('New folder name:', '');
        if (!name || !name.trim()) return;
        const path = base + '/' + name.trim();
        try {
            window.sharedVFS.mkdir(path);
            // Auto-select the new folder so it's visible and ready for uploads
            this._selectedFolder = path;
            this._selectedSource = 'persistent';
            const destInput = document.getElementById('shared-upload-path');
            if (destInput) destInput.value = path + '/';
            this._refreshFileList();
        } catch (err) {
            alert('Failed to create folder: ' + err.message);
        }
    }

    // ---- Download ----

    async _downloadFolderAsZip(folderPath, source, defaultVFS) {
        if (typeof JSZip === 'undefined') {
            alert('JSZip not loaded.');
            return;
        }
        const vfs = defaultVFS || this._resolveVFS(source);
        if (!vfs) {
            alert('Cannot access filesystem.');
            return;
        }
        const zip = new JSZip();
        this._addFolderToZip(vfs, folderPath, folderPath, zip);
        if (Object.keys(zip.files).length === 0) {
            alert('Folder is empty.');
            return;
        }
        const blob = await zip.generateAsync({ type: 'blob' });
        const folderName = folderPath.split('/').filter(Boolean).pop() || 'folder';
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = folderName + '.zip';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    _addFolderToZip(vfs, dirPath, basePath, zip) {
        const entries = vfs.listDir ? vfs.listDir(dirPath) : null;
        if (!entries) return;
        for (const name of entries) {
            const fullPath = dirPath + '/' + name;
            const stat = vfs.stat ? vfs.stat(fullPath) : null;
            if (!stat) continue;
            const relPath = fullPath.substring(basePath.length + 1);
            if (stat.isDir) {
                this._addFolderToZip(vfs, fullPath, basePath, zip);
            } else {
                try {
                    const content = vfs.readFile(fullPath);
                    if (content == null) continue;
                    zip.file(relPath, content, { binary: content instanceof Uint8Array });
                } catch (_) { /* skip unreadable files */ }
            }
        }
    }

    // ---- Search Paths section ----

    _refreshPathTable() {
        if (!this.pathTable) return;
        const vfs = this._getVFS();

        if (!vfs || typeof vfs.getSearchPaths !== 'function') {
            this.pathTable.innerHTML = '<tr><td colspan="3" class="vfs-empty">Search paths are only available for the Prolog kernel.</td></tr>';
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
            alert('Kernel not loaded or has no VFS.');
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
            alert('Kernel not loaded or has no VFS.');
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
