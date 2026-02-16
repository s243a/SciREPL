/**
 * file_io.js — Handles File Import/Export and Menu interactions.
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
                window.sessionManager.save();
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

        // Export .py
        document.getElementById('btn-export-py').addEventListener('click', () => {
            this.exportPython();
            this.menuModal.classList.add('hidden');
        });

        // Import
        document.getElementById('btn-import-ipynb').addEventListener('click', () => {
            this.fileInput.click();
        });

        this.fileInput.addEventListener('change', (e) => {
            this.handleFileUpload(e.target.files[0]);
            this.fileInput.value = ''; // Reset
            this.menuModal.classList.add('hidden');
        });
    }

    exportPython() {
        if (!window.sessionManager) return;
        const history = window.sessionManager.session.history || [];
        if (history.length === 0) {
            alert('No history to export.');
            return;
        }

        const content = "# Exported from SciREPL\n\n" + history.join('\n\n');
        this.downloadFile('scirepl_export.py', content);
    }

    downloadFile(filename, content) {
        const element = document.createElement('a');
        element.setAttribute('href', 'data:text/plain;charset=utf-8,' + encodeURIComponent(content));
        element.setAttribute('download', filename);
        element.style.display = 'none';
        document.body.appendChild(element);
        element.click();
        document.body.removeChild(element);
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

    importPython(content) {
        if (window.sessionManager) {
            // Split by newlines, filter empty
            const lines = content.split('\n').filter(line => line.trim() !== '');
            // This is naive; it breaks multiline blocks.
            // Better: Just import as one big block? Or try to "execute" it?
            // For now, let's just append the whole thing to history so user can run it?
            // Actually, "loading" a script usually means running it.
            // But we can't easily run it safely without user intent.
            // Let's put it into the code input so user can run it.

            const input = document.getElementById('code-input');
            input.value = content;
            // autoResize() if available globally? 
            // It's inside a closure in app.js. We need to trigger input event.
            input.dispatchEvent(new Event('input', { bubbles: true }));
        }
    }

    importIpynb(jsonContent) {
        try {
            const nb = JSON.parse(jsonContent);
            let extractedCode = [];

            if (nb.cells) {
                nb.cells.forEach(cell => {
                    if (cell.cell_type === 'code') {
                        // Source is usually array of strings
                        let source = "";
                        if (Array.isArray(cell.source)) {
                            source = cell.source.join('');
                        } else {
                            source = cell.source;
                        }
                        if (source.trim()) extractedCode.push(source);
                    }
                });
            }

            if (extractedCode.length > 0) {
                const combined = "# Imported Notebook\n\n" + extractedCode.join('\n\n# -- Cell --\n\n');
                this.importPython(combined);
            } else {
                alert('No code cells found in notebook.');
            }
        } catch (e) {
            console.error(e);
            alert('Failed to parse .ipynb file.');
        }
    }
}

// Initialize only after DOM ready (already ensured by script placement at end of body)
window.fileIO = new FileIO();
