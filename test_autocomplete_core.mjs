// Deterministic local-completion regressions. No browser, network, or kernel.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Local = require('./www/js/local_completion.js');
const Surface = require('./www/js/completion_surface.js');

let failures = 0;
let checks = 0;
function check(name, condition, detail = '') {
    checks++;
    if (!condition) failures++;
    console.log(`  [${condition ? 'PASS' : 'FAIL'}] ${name}${detail ? ': ' + detail : ''}`);
}

const snap = (value, extra = {}) => ({
    value,
    selectionStart: value.length,
    selectionEnd: value.length,
    revision: 1,
    context: { cellType: 'code', language: 'python', ...extra }
});

console.log('1. Safe end-of-text matching');
let result = Local.suggestPython(snap('pri'));
check('pri exposes only the common missing suffix', result?.text === 'nt', JSON.stringify(result));
check('range uses textarea UTF-16 offsets', result?.range.start === 3 && result?.range.end === 3);
result = Local.suggestPython(snap('😀 pri'));
check('astral text before the token keeps UTF-16 range exact',
    result?.range.start === '😀 pri'.length, JSON.stringify(result));
check('one-character identifiers are intentionally silent', !Local.suggestPython(snap('p')));
check('a noncollapsed selection is silent', !Local.suggestPython({
    ...snap('pri'), selectionStart: 1, selectionEnd: 3
}));
check('a caret before the end is silent', !Local.suggestPython({
    ...snap('pri tail'), selectionStart: 3, selectionEnd: 3
}));
check('Markdown is silent', !Local.suggestPython(snap('pri', { cellType: 'markdown' })));
check('other languages are silent', !Local.suggestPython(snap('pri', { language: 'javascript' })));
check('a non-Python cell with %%python uses Python completion',
    Local.suggestPython(snap('%%python\npri', { language: 'r' }))?.text === 'nt');
check('a Python-selected cell with another language magic is silent',
    !Local.suggestPython(snap('%%bash\npri')));
check('a %pip requirement line is not treated as Python source',
    !Local.suggestPython(snap('%pip install pri')));
check('comments are silent', !Local.suggestPython(snap('# pri')));
check('single-quoted strings are silent', !Local.suggestPython(snap("'pri")));
check('triple-quoted strings are silent', !Local.suggestPython(snap("'''pri")));
check('dotted lookup is deliberately absent', !Local.suggestPython(snap('obj.pri')));
check('a suffix cut from an invalid digit-prefixed token is silent', !Local.suggestPython(snap('1pri')));
check('a suffix cut from a Unicode identifier is silent', !Local.suggestPython(snap('\u03c0pri')));
check('very large cells fail closed before automatic lexical scanning',
    !Local.suggestPython(snap('x'.repeat(Local.MAX_AUTOMATIC_SOURCE_CHARS + 1) + ' pri')));

console.log('2. Ambiguity and namespace snapshots');
result = Local.suggestPython(snap('alp'), ['alphaValue', 'alphaThing']);
check('multiple candidates expose only their shared extension', result?.text === 'ha', JSON.stringify(result));
check('no arbitrary candidate is chosen once the common extension ends',
    !Local.suggestPython(snap('alpha'), ['alphaValue', 'alphaThing']));
check('exact names produce no empty ghost', !Local.suggestPython(snap('print')));
check('an exact live name suppresses longer static candidates',
    !Local.suggestPython(snap('pri'), ['pri']));
check('an exact live name suppresses longer dynamic candidates',
    !Local.suggestPython(snap('alpha'), ['alpha', 'alphaValue']));
const normalized = Local.normalizeNames(['beta', 'alpha', 'beta', '', 'bad-name', 'x'.repeat(129)]);
check('snapshot names are validated, deduplicated, and sorted',
    JSON.stringify(normalized) === JSON.stringify(['alpha', 'beta']), JSON.stringify(normalized));
check('valid Unicode Python names survive the snapshot and complete',
    Local.suggestPython(snap('rés'), ['résultat'])?.text === 'ultat');
check('multilingual identifiers use code-point prefixes',
    Local.suggestPython(snap('結果'), ['結果値'])?.text === '値');
check('divergent astral identifiers never produce a lone-surrogate suffix',
    !Local.suggestPython(snap('custom'), ['custom\u{10330}x', 'custom\u{10331}y']));
check('common built-in exception names are available offline',
    Local.suggestPython(snap('Valu'))?.text === 'eError'
    && Local.suggestPython(snap('Exce'))?.text === 'ption'
    && Local.suggestPython(snap('ZeroD'))?.text === 'ivisionError');

const maxNamespace = Array.from({ length: 4096 }, (_, index) =>
    `namespaceName${String(index).padStart(4, '0')}`);
const preparedMaxNamespace = Local.preparePythonNames(maxNamespace);
const benchmarkStarted = performance.now();
for (let index = 0; index < 200; index++) {
    Local.suggestPython(snap('namespaceN'), preparedMaxNamespace, { prepared: true });
}
const maxNamespaceAverageMs = (performance.now() - benchmarkStarted) / 200;
check('a prepared max-cardinality namespace stays within the 1 ms matcher budget',
    maxNamespaceAverageMs <= 1,
    `${maxNamespaceAverageMs.toFixed(3)} ms/call over ${preparedMaxNamespace.length} names`);

console.log('3. Typing never invokes a kernel');
let completionCalls = 0;
const provider = new Local.LocalCompletionProvider();
const oldLocalStorage = globalThis.localStorage;
globalThis.localStorage = { getItem: () => 'on' };
const oldWindow = globalThis.window;
let typingKernelReads = 0;
globalThis.window = {
    kernelManager: {
        isExecutionActive: () => false,
        getKernelGeneration: () => 7,
        getLatestExecutionId: () => 12,
        peekKernel: () => { typingKernelReads++; throw new Error('typing reached the kernel'); },
        getKernel: () => { typingKernelReads++; throw new Error('typing reached the kernel'); }
    },
    localCompletion: null
};
provider.snapshots.set('python', {
    kernelGeneration: 7,
    executionId: 12,
    names: ['resultValue'],
    searchNames: Local.preparePythonNames(['resultValue'])
});
for (let i = 0; i < 50; i++) provider.suggest(snap('pri'));
check('fifty suggestion reads make no kernel or completionSymbols call',
    typingKernelReads === 0 && completionCalls === 0,
    JSON.stringify({ typingKernelReads, completionCalls }));
check('a current idle namespace snapshot participates in matching',
    provider.suggest(snap('res'))?.text === 'ultValue');
globalThis.window.kernelManager.getLatestExecutionId = () => 13;
check('a snapshot from an older execution is ignored', !provider.suggest(snap('res')));
globalThis.window.kernelManager.getLatestExecutionId = () => 12;
globalThis.window.kernelManager.isExecutionActive = () => true;
check('dynamic names are suppressed while the language is executing', !provider.suggest(snap('res')));
globalThis.window.kernelManager.isExecutionActive = () => false;

console.log('4. Late refreshes cannot replace a newer generation');
let release;
const delayed = new Promise((resolve) => { release = resolve; });
const mockKernel = {
    isReady: () => true,
    completionSymbols: () => { completionCalls++; return delayed; }
};
const mockManager = {
    peekKernel: () => mockKernel,
    getKernelGeneration: () => 7,
    getLatestExecutionId: () => 12,
    isExecutionActive: () => false
};
globalThis.window = { kernelManager: mockManager, localCompletion: null };
const refresh = provider.refreshLanguage('python', { executionId: 12 });
provider.clearLanguage('python');
release(['staleName']);
await refresh;
check('an invalidated delayed refresh publishes nothing', !provider.snapshots.has('python'));

const failingProvider = new Local.LocalCompletionProvider();
failingProvider.snapshots.set('python', {
    kernelGeneration: 7, executionId: 12, names: ['staleResult']
});
globalThis.window = {
    kernelManager: {
        peekKernel: () => ({
            isReady: () => true,
            completionSymbols: () => { throw new Error('snapshot failed'); }
        }),
        getKernelGeneration: () => 7,
        getLatestExecutionId: () => 12,
        isExecutionActive: () => false
    },
    localCompletion: null
};
await failingProvider.refreshLanguage('python', { executionId: 12 });
check('a failed namespace refresh clears the previous dynamic snapshot',
    !failingProvider.snapshots.has('python'));

console.log('5. Out-of-order concurrent settles still publish the final namespace');
const finalProvider = new Local.LocalCompletionProvider();
globalThis.window = {
    kernelManager: {
        peekKernel: () => ({
            isReady: () => true,
            completionSymbols: () => ['newestName']
        }),
        getKernelGeneration: () => 8,
        // Execution 14 started after 13 but settled first. The event for 13
        // is the one that observes the language becoming idle.
        getLatestExecutionId: () => 14,
        isExecutionActive: () => false
    },
    localCompletion: null
};
await finalProvider.refreshLanguage('python', { executionId: 13 });
check('the idle refresh is tagged with the latest start, not the last settle event',
    finalProvider.snapshots.get('python')?.executionId === 14,
    JSON.stringify(finalProvider.snapshots.get('python')));

console.log('6. Context fingerprints are deterministic');
check('context key order cannot change identity',
    Surface.stableContext({ language: 'python', cellType: 'code' })
        === Surface.stableContext({ cellType: 'code', language: 'python' }));

console.log('7. Abort stops provider fall-through');
const controller = new Surface.CompletionController();
let releaseFirst;
let secondProviderCalls = 0;
controller.registerProvider({
    priority: 0,
    suggest: () => new Promise((resolve) => { releaseFirst = resolve; })
});
controller.registerProvider({
    priority: 1,
    suggest: () => { secondProviderCalls++; return { text: 'unsafe' }; }
});
const abort = new AbortController();
const abortedSuggestion = controller.suggest(snap('pri'), 'automatic', abort.signal);
abort.abort();
releaseFirst(null);
check('an abort-ignoring first provider cannot launch the next provider',
    await abortedSuggestion === null && secondProviderCalls === 0,
    JSON.stringify({ secondProviderCalls }));

if (oldWindow === undefined) delete globalThis.window;
else globalThis.window = oldWindow;
if (oldLocalStorage === undefined) delete globalThis.localStorage;
else globalThis.localStorage = oldLocalStorage;

console.log(`\n${checks - failures}/${checks} autocomplete core checks passed.`);
if (failures) process.exit(1);
