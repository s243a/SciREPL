/**
 * kernels/javascript.js — JavaScript kernel.
 * Executes code natively in the browser via AsyncFunction.
 * Captures console.log output and returns last expression value.
 */

class JavaScriptKernel {
    constructor() {
        this._ready = false;
    }

    static displayName = 'JavaScript';

    async init() {
        this._ready = true;
    }

    isReady() {
        return this._ready;
    }

    getName() {
        return 'JavaScript (Browser)';
    }

    getLanguage() {
        return 'javascript';
    }

    async execute(code) {
        if (!this._ready) {
            throw new Error('JavaScript kernel not initialized');
        }

        const trimmed = code.trim();
        if (!trimmed) {
            return { stdout: '', result: null, error: null };
        }

        // Capture console output
        const logs = [];
        const orig = {
            log: console.log,
            warn: console.warn,
            error: console.error,
            info: console.info,
        };

        const capture = (prefix) => (...args) => {
            const line = args.map(a => {
                if (a === undefined) return 'undefined';
                if (a === null) return 'null';
                if (typeof a === 'object') {
                    try { return JSON.stringify(a, null, 2); } catch (_) {}
                }
                return String(a);
            }).join(' ');
            logs.push(prefix ? `[${prefix}] ${line}` : line);
        };

        console.log = capture('');
        console.warn = capture('warn');
        console.error = capture('error');
        console.info = capture('');

        try {
            // Try to auto-return the last expression value.
            // If the code ends with an expression statement (not assignment,
            // declaration, control flow, etc.), prepend "return" to it.
            const execCode = this._autoReturn(trimmed);

            const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
            const fn = new AsyncFunction(execCode);
            const result = await fn();

            const stdout = logs.map(l => l.startsWith('[') ? l : l).join('\n');

            let formattedResult = null;
            if (result !== undefined && result !== null) {
                let text;
                if (typeof result === 'object') {
                    try { text = JSON.stringify(result, null, 2); } catch (_) { text = String(result); }
                } else {
                    text = String(result);
                }
                formattedResult = { type: 'text', content: text };
            }

            return { stdout, result: formattedResult, error: null };
        } catch (err) {
            return { stdout: logs.join('\n'), result: null, error: err.message };
        } finally {
            console.log = orig.log;
            console.warn = orig.warn;
            console.error = orig.error;
            console.info = orig.info;
        }
    }

    /**
     * If the last statement looks like a bare expression, prepend "return "
     * so the cell displays its value (like browser devtools).
     * Skips if the code already contains a return, or ends with a block,
     * declaration, assignment, or control-flow keyword.
     */
    _autoReturn(code) {
        // If the code explicitly returns, don't touch it
        if (/\breturn\b/.test(code)) return code;

        // Split into lines, find the last non-empty line
        const lines = code.split('\n');
        let lastIdx = lines.length - 1;
        while (lastIdx >= 0 && !lines[lastIdx].trim()) lastIdx--;
        if (lastIdx < 0) return code;

        const lastLine = lines[lastIdx].trim();

        // Don't auto-return statements that aren't expressions
        if (lastLine.endsWith(';')) {
            // Semicolon suppresses output (like Python)
            return code;
        }
        if (/^(let |const |var |function |class |if |for |while |switch |try |throw |import |export )/.test(lastLine)) {
            return code;
        }
        if (lastLine.endsWith('{') || lastLine.endsWith('}')) {
            return code;
        }

        // Prepend return to the last line
        lines[lastIdx] = 'return ' + lines[lastIdx];
        return lines.join('\n');
    }

    getMemoryUsage() {
        return 0; // Native browser JS, no WASM allocation
    }

    destroy() {
        this._ready = false;
    }
}

// Register with kernel manager
if (window.kernelManager) {
    window.kernelManager.register('javascript', JavaScriptKernel);
}
