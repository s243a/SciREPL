/**
 * local_completion.js — offline keyword and cached Python namespace completion.
 *
 * Matching is synchronous and never calls a kernel. Python globals are copied
 * only after a tracked execution settles; dotted attribute lookup is
 * deliberately absent from v1.
 */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.LocalCompletion = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    const PYTHON_KEYWORDS = Object.freeze((
        'False None True and as assert async await break case class continue def del elif else ' +
        'except finally for from global if import in is lambda match nonlocal not or pass raise ' +
        'return try while with yield'
    ).split(' '));

    const PYTHON_BUILTINS = Object.freeze((
        'abs aiter all anext any ascii bin bool breakpoint bytearray bytes callable chr classmethod ' +
        'compile complex delattr dict dir divmod enumerate eval exec filter float format frozenset ' +
        'getattr globals hasattr hash help hex id input int isinstance issubclass iter len list locals ' +
        'map max memoryview min next object oct open ord pow print property range repr reversed round ' +
        'set setattr slice sorted staticmethod str sum super tuple type vars zip __import__ ' +
        'Ellipsis NotImplemented __debug__ ArithmeticError AssertionError AttributeError BaseException ' +
        'BaseExceptionGroup BlockingIOError BrokenPipeError BufferError BytesWarning ChildProcessError ' +
        'ConnectionAbortedError ConnectionError ConnectionRefusedError ConnectionResetError ' +
        'DeprecationWarning EOFError EncodingWarning EnvironmentError Exception ExceptionGroup ' +
        'FileExistsError FileNotFoundError FloatingPointError FutureWarning GeneratorExit IOError ' +
        'ImportError ImportWarning IndentationError IndexError InterruptedError IsADirectoryError ' +
        'KeyError KeyboardInterrupt LookupError MemoryError ModuleNotFoundError NameError ' +
        'NotADirectoryError NotImplementedError OSError OverflowError PendingDeprecationWarning ' +
        'PermissionError ProcessLookupError RecursionError ReferenceError ResourceWarning RuntimeError ' +
        'RuntimeWarning StopAsyncIteration StopIteration SyntaxError SyntaxWarning SystemError ' +
        'SystemExit TabError TimeoutError TypeError UnboundLocalError UnicodeDecodeError ' +
        'UnicodeEncodeError UnicodeError UnicodeTranslateError UnicodeWarning UserWarning ValueError ' +
        'Warning ZeroDivisionError'
    ).split(' '));
    const PYTHON_IDENTIFIER = /^[\p{ID_Start}_][\p{ID_Continue}]*$/u;
    const PYTHON_IDENTIFIER_TAIL = /([\p{ID_Start}_][\p{ID_Continue}]*)$/u;
    const MAX_AUTOMATIC_SOURCE_CHARS = 50_000;

    function pythonStateAtEnd(source) {
        let state = 'code';
        let quote = '';
        for (let i = 0; i < source.length; i++) {
            const char = source[i];
            if (state === 'comment') {
                if (char === '\n') state = 'code';
                continue;
            }
            if (state === 'string') {
                if (char === '\\') { i++; continue; }
                if (char === quote) state = 'code';
                continue;
            }
            if (state === 'triple') {
                if (char === '\\') { i++; continue; }
                if (char === quote && source.slice(i, i + 3) === quote.repeat(3)) {
                    state = 'code';
                    i += 2;
                }
                continue;
            }
            if (char === '#') {
                state = 'comment';
            } else if (char === '"' || char === "'") {
                quote = char;
                if (source.slice(i, i + 3) === char.repeat(3)) {
                    state = 'triple';
                    i += 2;
                } else {
                    state = 'string';
                }
            }
        }
        return state;
    }

    function identifierPrefix(snapshot) {
        if (!snapshot || snapshot.context?.cellType !== 'code') return null;
        if (typeof snapshot.value !== 'string'
            || snapshot.value.length > MAX_AUTOMATIC_SOURCE_CHARS) return null;
        const magic = snapshot.value.match(/^%%(\w+)\s*\n/);
        const effectiveLanguage = magic ? magic[1].toLowerCase() : snapshot.context?.language;
        if (effectiveLanguage !== 'python') return null;
        if (snapshot.selectionStart !== snapshot.selectionEnd
            || snapshot.selectionEnd !== snapshot.value.length) return null;
        if (pythonStateAtEnd(snapshot.value) !== 'code') return null;
        const currentLine = snapshot.value.slice(snapshot.value.lastIndexOf('\n') + 1);
        if (/^\s*[%!]/.test(currentLine)) return null;
        const match = PYTHON_IDENTIFIER_TAIL.exec(snapshot.value);
        if (!match || Array.from(match[1]).length < 2) return null;
        const start = snapshot.value.length - match[1].length;
        if (start > 0) {
            const before = Array.from(snapshot.value.slice(Math.max(0, start - 2), start)).pop() || '';
            // A suffix cut from a wider ASCII/Unicode identifier (or an
            // attribute) is not an independently replaceable token.
            if (before === '.' || /[\p{ID_Continue}]/u.test(before)) return null;
        }
        return { text: match[1], start, end: snapshot.value.length };
    }

    function commonPrefix(values) {
        if (!values.length) return '';
        let prefix = Array.from(values[0]);
        for (let i = 1; i < values.length && prefix.length; i++) {
            const value = Array.from(values[i]);
            let at = 0;
            while (at < prefix.length && at < value.length && prefix[at] === value[at]) at++;
            prefix = prefix.slice(0, at);
        }
        return prefix.join('');
    }

    function normalizeNames(values) {
        const names = [];
        const seen = new Set();
        for (const raw of values || []) {
            const value = typeof raw === 'string' ? raw : '';
            if (!value || value.length > 128 || !PYTHON_IDENTIFIER.test(value)
                || seen.has(value)) continue;
            seen.add(value);
            names.push(value);
            if (names.length >= 4096) break;
        }
        return Object.freeze(names.sort());
    }

    const STATIC_PYTHON_NAMES = normalizeNames([...PYTHON_KEYWORDS, ...PYTHON_BUILTINS]);

    function preparePythonNames(dynamicNames = []) {
        if (!dynamicNames.length) return STATIC_PYTHON_NAMES;
        return normalizeNames([...STATIC_PYTHON_NAMES, ...dynamicNames]);
    }

    function matchingNameRange(names, prefix) {
        let low = 0;
        let high = names.length;
        while (low < high) {
            const middle = (low + high) >>> 1;
            if (names[middle] < prefix) low = middle + 1;
            else high = middle;
        }
        const start = low;
        if (start >= names.length || !names[start].startsWith(prefix)) {
            return { start, end: start };
        }
        high = names.length;
        while (low < high) {
            const middle = (low + high) >>> 1;
            if (names[middle].startsWith(prefix)) low = middle + 1;
            else high = middle;
        }
        return { start, end: low };
    }

    function suggestPython(snapshot, dynamicNames = [], options = {}) {
        const prefix = identifierPrefix(snapshot);
        if (!prefix) return null;
        const names = options.prepared === true
            ? dynamicNames : preparePythonNames(dynamicNames);
        const range = matchingNameRange(names, prefix.text);
        if (range.start === range.end) return null;
        // For a sorted interval, the common prefix of the first and last item
        // is the common prefix of the entire interval. This avoids rescanning
        // all 4,096 cached globals on every keystroke.
        const shared = range.end - range.start === 1
            ? names[range.start]
            : commonPrefix([names[range.start], names[range.end - 1]]);
        if (shared.length <= prefix.text.length) return null;
        return Object.freeze({
            text: shared.slice(prefix.text.length),
            completionLabel: shared,
            source: 'local',
            range: Object.freeze({ start: prefix.end, end: prefix.end })
        });
    }

    class LocalCompletionProvider {
        constructor(options = {}) {
            this.priority = options.priority || 0;
            this.automatic = true;
            this.snapshots = new Map();
            this.refreshGeneration = new Map();
        }

        currentDynamicNames(language) {
            const cached = this.snapshots.get(language);
            if (!cached) return [];
            if (typeof window === 'undefined') return cached.names || [];
            const km = window.kernelManager;
            if (!km) return [];
            if (typeof km.isExecutionActive === 'function' && km.isExecutionActive(language)) return [];
            if (typeof km.getKernelGeneration === 'function'
                && km.getKernelGeneration(language) !== cached.kernelGeneration) return [];
            if (typeof km.getLatestExecutionId === 'function'
                && km.getLatestExecutionId(language) !== cached.executionId) return [];
            return cached.names || [];
        }

        currentSearchNames(language) {
            const cached = this.snapshots.get(language);
            const dynamicNames = this.currentDynamicNames(language);
            if (!dynamicNames.length) return STATIC_PYTHON_NAMES;
            if (cached?.names === dynamicNames && cached.searchNames) return cached.searchNames;
            return preparePythonNames(dynamicNames);
        }

        suggest(snapshot) {
            if (!isLocalCompletionEnabled()) return null;
            return suggestPython(snapshot, this.currentSearchNames('python'), { prepared: true });
        }

        clearLanguage(language) {
            this.refreshGeneration.set(language, (this.refreshGeneration.get(language) || 0) + 1);
            this.snapshots.delete(language);
        }

        async refreshLanguage(language, detail = {}) {
            if (language !== 'python' || typeof window === 'undefined') return;
            const km = window.kernelManager;
            const kernel = km && typeof km.peekKernel === 'function' ? km.peekKernel(language) : null;
            if (!kernel || !kernel.isReady() || typeof kernel.completionSymbols !== 'function') {
                this.clearLanguage(language);
                return;
            }
            const generation = (this.refreshGeneration.get(language) || 0) + 1;
            this.refreshGeneration.set(language, generation);
            const kernelGeneration = typeof km.getKernelGeneration === 'function'
                ? km.getKernelGeneration(language) : 0;
            // Always identify the snapshot with the newest execution that has
            // started, not necessarily the event that happened to settle last.
            // Concurrent runs can settle out of order; once none remain active,
            // the namespace represents their combined final state.
            const executionId = typeof km.getLatestExecutionId === 'function'
                ? km.getLatestExecutionId(language) : (detail.executionId || 0);
            if (typeof km.isExecutionActive === 'function' && km.isExecutionActive(language)) return;
            let names;
            try {
                names = await kernel.completionSymbols();
            } catch (_) {
                if (this.refreshGeneration.get(language) === generation) {
                    this.snapshots.delete(language);
                    if (window.localCompletion?.controller) {
                        window.localCompletion.controller.refreshAll();
                    }
                }
                return;
            }
            if (this.refreshGeneration.get(language) !== generation) return;
            if (typeof km.getKernelGeneration === 'function'
                && km.getKernelGeneration(language) !== kernelGeneration) return;
            if (typeof km.getLatestExecutionId === 'function'
                && km.getLatestExecutionId(language) !== executionId) return;
            const normalizedNames = normalizeNames(names);
            this.snapshots.set(language, Object.freeze({
                language,
                kernelGeneration,
                executionId,
                capturedAt: Date.now(),
                names: normalizedNames,
                searchNames: preparePythonNames(normalizedNames)
            }));
            if (window.localCompletion?.controller) window.localCompletion.controller.refreshAll();
        }
    }

    function localCompletionPreference() {
        if (typeof localStorage === 'undefined') return 'auto';
        const value = localStorage.getItem('scirepl_local_completion');
        return value === 'on' || value === 'off' ? value : 'auto';
    }

    function likelyTouchDevice() {
        if (typeof window === 'undefined') return false;
        const native = !!(window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function'
            && window.Capacitor.isNativePlatform());
        const coarse = typeof window.matchMedia === 'function'
            && window.matchMedia('(any-pointer: coarse)').matches;
        return native || coarse || !!document.body?.classList.contains('force-mobile');
    }

    function isLocalCompletionEnabled() {
        const preference = localCompletionPreference();
        if (preference === 'on') return true;
        if (preference === 'off') return false;
        return !likelyTouchDevice();
    }

    function installBrowserController() {
        if (typeof window === 'undefined' || !window.CompletionSurface) return null;
        const provider = new LocalCompletionProvider();
        const controller = new window.CompletionSurface.CompletionController({
            enabled: isLocalCompletionEnabled
        });
        controller.registerProvider(provider);
        const api = {
            provider,
            controller,
            attach: (textarea, options) => controller.attach(textarea, {
                maxAutomaticChars: MAX_AUTOMATIC_SOURCE_CHARS,
                ...(options || {})
            }),
            detach: (textarea) => controller.detach(textarea),
            destroyWithin: (root) => controller.destroyWithin(root),
            refreshAll: () => controller.refreshAll(),
            clearLanguage: (language) => {
                provider.clearLanguage(language);
                controller.refreshAll();
            },
            setPreference: (value) => {
                if (value === 'on' || value === 'off') localStorage.setItem('scirepl_local_completion', value);
                else localStorage.removeItem('scirepl_local_completion');
                controller.refreshAll();
            },
            getPreference: localCompletionPreference,
            isEnabled: isLocalCompletionEnabled
        };
        window.addEventListener('scirepl:kernel-execution-settled', (event) => {
            const detail = event.detail || {};
            if (detail.language === 'python') provider.refreshLanguage('python', detail);
        });
        window.addEventListener('scirepl:kernel-execution-started', (event) => {
            if (event.detail?.language === 'python') controller.refreshAll();
        });
        window.addEventListener('scirepl:kernel-invalidated', (event) => {
            const language = event.detail?.language;
            if (language) api.clearLanguage(language);
        });
        document.addEventListener('scirepl:composer-context-changed', () => controller.refreshAll());
        window.addEventListener('scirepl:notebook-changed', () => {
            controller.dismissAll();
            controller.refreshAll();
        });
        return api;
    }

    const api = {
        PYTHON_KEYWORDS,
        PYTHON_BUILTINS,
        MAX_AUTOMATIC_SOURCE_CHARS,
        pythonStateAtEnd,
        identifierPrefix,
        commonPrefix,
        normalizeNames,
        preparePythonNames,
        matchingNameRange,
        suggestPython,
        LocalCompletionProvider,
        localCompletionPreference,
        likelyTouchDevice,
        isLocalCompletionEnabled,
        installBrowserController
    };

    if (typeof window !== 'undefined') window.localCompletion = installBrowserController();
    return api;
});
