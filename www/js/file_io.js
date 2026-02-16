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

        // Clear Session
        document.getElementById('btn-clear-session').addEventListener('click', () => {
            if (confirm('Are you sure you want to clear all saved history?')) {
                localStorage.removeItem('scirepl_session_v1');
                location.reload();
            }
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

        const nbCells = cells.map((cell, i) => {
            const source = cell.code.split('\n').map((line, j, arr) =>
                j < arr.length - 1 ? line + '\n' : line
            );
            if (cell.type === 'markdown') {
                return {
                    cell_type: 'markdown',
                    metadata: {},
                    source: source
                };
            }
            return {
                cell_type: 'code',
                execution_count: cell.id,
                metadata: {},
                outputs: [],
                source: source
            };
        });

        const notebook = {
            nbformat: 4,
            nbformat_minor: 5,
            metadata: {
                kernelspec: {
                    display_name: 'Python 3 (Pyodide)',
                    language: 'python',
                    name: 'python3'
                },
                language_info: {
                    name: 'python',
                    version: '3.12',
                    mimetype: 'text/x-python',
                    file_extension: '.py'
                },
                scirepl: {
                    version: 'pro',
                    exported_at: new Date().toISOString()
                }
            },
            cells: nbCells
        };

        const json = JSON.stringify(notebook, null, 1);
        await this.downloadFile('scirepl_export.ipynb', json, 'application/json');
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

    handleFileUpload(file) {
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (e) => {
            const content = e.target.result;
            if (file.name.endsWith('.ipynb')) {
                this.importIpynb(content);
            } else {
                // Assume .py or text
                this.importPython(content);
            }
        };
        reader.readAsText(file);
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
     * Import a .ipynb file — create cells and execute them.
     * If window.importCells is available (set by app.js), uses it to
     * create proper cells. Otherwise falls back to textarea.
     */
    importIpynb(jsonContent) {
        try {
            const nb = JSON.parse(jsonContent);
            const extractedCells = [];

            if (nb.cells) {
                nb.cells.forEach(cell => {
                    let source = '';
                    if (Array.isArray(cell.source)) {
                        source = cell.source.join('');
                    } else {
                        source = cell.source || '';
                    }
                    if (source.trim()) {
                        extractedCells.push({
                            code: source,
                            type: cell.cell_type === 'markdown' ? 'markdown' : 'code'
                        });
                    }
                });
            }

            if (extractedCells.length === 0) {
                alert('No cells found in notebook.');
                return;
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
