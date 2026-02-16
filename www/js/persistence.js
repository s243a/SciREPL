/**
 * persistence.js — Handles saving/loading SciREPL state.
 */

class SessionManager {
    constructor() {
        this.STORAGE_KEY = 'scirepl_session_v1';
        this.session = this.load();
    }

    /**
     * Load session from localStorage.
     */
    load() {
        try {
            const raw = localStorage.getItem(this.STORAGE_KEY);
            if (!raw) return this.defaultSession();
            return JSON.parse(raw);
        } catch (e) {
            console.error('Failed to load session:', e);
            return this.defaultSession();
        }
    }

    defaultSession() {
        return {
            history: [],       // Command history
            historyIndex: -1,  // For up/down arrow navigation (runtime only)
            cellCounter: 0,    // Last cell index
            cells: [],         // Saved cells: [{code, type}]
            darkMode: true     // Theme preference (future)
        };
    }

    /**
     * Save current session state.
     */
    save() {
        try {
            // Don't save transient runtime state like historyIndex
            const toSave = {
                history: this.session.history.slice(-100), // Keep last 100 commands
                cellCounter: this.session.cellCounter,
                cells: this.session.cells || [],
                darkMode: this.session.darkMode
            };
            localStorage.setItem(this.STORAGE_KEY, JSON.stringify(toSave));
        } catch (e) {
            console.error('Failed to save session:', e);
        }
    }

    /**
     * Add a command to history and save.
     */
    addToHistory(code) {
        if (!code) return;
        // Remove duplicates if same as last command
        if (this.session.history.length > 0 &&
            this.session.history[this.session.history.length - 1] === code) {
            return;
        }
        this.session.history.push(code);
        this.save();
    }

    /**
     * Save the current cells list (code + type only, no DOM refs).
     */
    saveCells(cells) {
        this.session.cells = cells.map(c => ({ code: c.code, type: c.type }));
        this.save();
    }

    /**
     * Get saved cells for restoration.
     */
    getSavedCells() {
        return this.session.cells || [];
    }

    /**
     * Get executed command at index (allow negative for reverse indexing).
     */
    getHistory(index) {
        if (index < 0) index = this.session.history.length + index;
        if (index < 0 || index >= this.session.history.length) return null;
        return this.session.history[index];
    }
}

// Export singleton
window.sessionManager = new SessionManager();
