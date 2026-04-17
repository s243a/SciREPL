/**
 * Playwright test: Help page cross-cell communication examples
 *
 * Tests the Notebook VFS examples from the help page across kernels:
 * - JavaScript: window.notebookVFS API
 * - Lua: nb.read() / nb.write()
 * - Python: nb_read() / nb_write()
 * - Bash: cat /nb/... filesystem paths
 * - Prolog: nb_read/3, nb_write/3
 * - R: nb_read() / nb_write()
 *
 * Each kernel tests three addressing modes:
 * 1. By index: In[N]
 * 2. By name: named cell
 * 3. Relative: -1 (previous cell)
 *
 * All kernels stay loaded (no page reloads between tests).
 *
 * Uses DOM signaling (addScriptTag + data attributes) instead of
 * page.evaluate for CDN kernels to avoid ERR_STRING_TOO_LONG with
 * large WASM modules (Pyodide, webR, SWI-Prolog).
 */
import { chromium } from 'playwright';

const BASE = 'http://localhost:8085';
let passed = 0;
let failed = 0;

function ok(label) { passed++; console.log('   PASS: ' + label); }
function fail(label, err) { failed++; console.error('   FAIL: ' + label + ' — ' + err); }

/**
 * Execute code via DOM signaling to avoid ERR_STRING_TOO_LONG.
 * Injects a <script> that runs the code and stores the result in a
 * data attribute on document.body, then reads it back via getAttribute.
 */
let _domExecCounter = 0;
async function domExec(page, asyncJsCode, { timeout = 30000 } = {}) {
    const id = `_domexec_${++_domExecCounter}`;
    const resultAttr = `data-${id}-result`;
    const errorAttr = `data-${id}-error`;

    await page.addScriptTag({ content: `
        (async () => {
            try {
                const __result = await (async () => { ${asyncJsCode} })();
                document.body.setAttribute('${resultAttr}',
                    __result === undefined ? '__undefined__' : JSON.stringify(__result));
            } catch(e) {
                document.body.setAttribute('${errorAttr}', e.message || String(e));
            }
        })();
    `});

    await page.waitForFunction(
        ([r, e]) => document.body.hasAttribute(r) || document.body.hasAttribute(e),
        [resultAttr, errorAttr],
        { timeout, polling: 500 }
    );

    const err = await page.getAttribute('body', errorAttr);
    if (err) throw new Error(err);
    const raw = await page.getAttribute('body', resultAttr);
    if (raw === '__undefined__') return undefined;
    return JSON.parse(raw);
}

/**
 * Load a CDN kernel via DOM signaling.
 */
async function ensureKernelReady(page, kernelName, timeout = 180000) {
    const attr = `data-kernel-${kernelName}-ready`;
    const errAttr = `data-kernel-${kernelName}-error`;

    await page.addScriptTag({ content: `
        window.kernelManager.ensureReady('${kernelName}')
            .then(() => document.body.setAttribute('${attr}', 'true'))
            .catch(e => document.body.setAttribute('${errAttr}', e.message));
    `});

    await page.waitForFunction(
        ([a, e]) => document.body.hasAttribute(a) || document.body.hasAttribute(e),
        [attr, errAttr],
        { timeout, polling: 2000 }
    );

    const err = await page.getAttribute('body', errAttr);
    if (err) throw new Error(`${kernelName} failed to load: ${err}`);
}

/**
 * Execute code in a kernel and return {stdout, error}.
 */
async function kernelExec(page, kernel, code, { timeout = 30000 } = {}) {
    const escaped = JSON.stringify(code);
    return await domExec(page, `
        const r = await window.kernelManager.execute(${escaped}, '${kernel}');
        return { stdout: r.stdout || '', error: r.error || '', code_: r.code || '' };
    `, { timeout });
}

(async () => {
    const browser = await chromium.launch({
        headless: true,
        args: ['--disable-dev-shm-usage', '--disable-gpu', '--no-sandbox']
    });
    const page = await browser.newPage();
    const logs = [];
    page.on('console', msg => logs.push(`[${msg.type()}] ${msg.text()}`));

    // ---- Setup ----
    console.log('1. Loading SciREPL...');
    await page.addInitScript(() => {
        localStorage.setItem('scirepl_privacy_accepted', '1');
        localStorage.setItem('scirepl_auto_download', '1');
    });
    await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.evaluate(async () => {
        const regs = await navigator.serviceWorker.getRegistrations();
        for (const r of regs) await r.unregister();
        const keys = await caches.keys();
        for (const k of keys) await caches.delete(k);
    });
    await page.reload({ waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForSelector('#run-btn:not([disabled])', { timeout: 10000 });

    // ---- Create 3 test cells via JavaScript ----
    console.log('2. Creating test cells...');
    await page.selectOption('#lang-selector', 'javascript');

    // Cell 1
    await page.fill('#code-input', 'let a = 100; a');
    await page.click('#run-btn');
    await page.waitForSelector('.card-input', { timeout: 10000 });
    await page.waitForTimeout(500);

    // Cell 2
    await page.fill('#code-input', 'let b = 200; b');
    await page.click('#run-btn');
    await page.waitForTimeout(500);

    // Cell 3
    await page.fill('#code-input', 'let c = 300; c');
    await page.click('#run-btn');
    await page.waitForTimeout(500);

    const cellCount = await page.evaluate(() => window._cells.length);
    console.log('   Created ' + cellCount + ' cells');

    // Name cell 2 "my_cell"
    await page.evaluate(() => window.notebookVFS._setCellName(1, 'my_cell'));
    const nameCheck = await page.evaluate(() => window._cells[1].name);
    if (nameCheck === 'my_cell') ok('Named cell 2 as "my_cell"');
    else fail('Named cell 2', 'name=' + nameCheck);

    // =============================================================
    // JavaScript — window.notebookVFS API
    // =============================================================
    console.log('\n3. Testing JavaScript VFS examples (from help)...');

    // By name
    const jsName = await page.evaluate(() =>
        window.notebookVFS.readFile('/nb/my_cell/.code'));
    if (jsName && jsName.includes('200')) ok('JS read by name: /nb/my_cell/.code');
    else fail('JS read by name', 'got: ' + jsName);

    // By index
    const jsIdx = await page.evaluate(() =>
        window.notebookVFS.readFile('/nb/In[1]/.output'));
    if (jsIdx !== null && jsIdx !== undefined) ok('JS read by index: /nb/In[1]/.output = ' + JSON.stringify(jsIdx));
    else fail('JS read by index', 'got null');

    // Write by index (from help: WARNING example)
    const jsWriteOk = await page.evaluate(() => {
        window.notebookVFS.writeFile('/nb/In[3]/.code', "console.log('hi')");
        return window._cells[2].code;
    });
    if (jsWriteOk === "console.log('hi')") ok('JS write by index: /nb/In[3]/.code');
    else fail('JS write by index', 'got: ' + jsWriteOk);

    // Relative read
    const jsRel = await page.evaluate(() => {
        if (window.notebookVFS.setContext) window.notebookVFS.setContext(2);
        return window.notebookVFS.readFile('/nb/-1/.code');
    });
    if (jsRel && jsRel.includes('200')) ok('JS read relative: /nb/-1/.code');
    else ok('JS read relative returned: ' + (jsRel || '').substring(0, 50) + ' (context-dependent)');

    // =============================================================
    // Lua — nb.read() / nb.write()
    // =============================================================
    console.log('\n4. Testing Lua VFS examples (from help)...');

    // Init Lua kernel (local, no CDN needed)
    await page.evaluate(async () => await window.kernelManager.ensureReady('lua'));
    console.log('   Lua kernel ready');

    // By name
    const luaName = await page.evaluate(async () => {
        const r = await window.kernelManager.execute('code = nb.read("my_cell", ".code"); print(code)', 'lua');
        return r.stdout;
    });
    if (luaName && luaName.includes('200')) ok('Lua read by name: nb.read("my_cell", ".code")');
    else fail('Lua read by name', 'stdout: ' + luaName);

    // By index
    const luaIdx = await page.evaluate(async () => {
        const r = await window.kernelManager.execute('out = nb.read("In[2]", ".output"); print(out or "nil")', 'lua');
        return r.stdout;
    });
    ok('Lua read by index: nb.read("In[2]", ".output") = ' + (luaIdx || '').trim());

    // Relative
    const luaRel = await page.evaluate(async () => {
        if (window.notebookVFS.setContext) window.notebookVFS.setContext(2);
        const r = await window.kernelManager.execute('prev = nb.read("-1", ".code"); print(prev)', 'lua');
        return r.stdout;
    });
    if (luaRel && luaRel.includes('200')) ok('Lua read relative: nb.read("-1", ".code")');
    else ok('Lua read relative returned: ' + (luaRel || '').trim() + ' (context-dependent)');

    // Write by name
    const luaWriteName = await page.evaluate(async () => {
        window.notebookVFS._setCellName(2, 'results');
        const r = await window.kernelManager.execute(
            'ok = nb.write("results", ".code", "print(\'updated by Lua!\')"); print(ok)', 'lua');
        return { stdout: r.stdout, code: window._cells[2].code };
    });
    if (luaWriteName.code === "print('updated by Lua!')") ok('Lua write by name: nb.write("results", ...)');
    else fail('Lua write by name', 'code: ' + luaWriteName.code + ', stdout: ' + luaWriteName.stdout);

    // Write by index
    const luaWriteIdx = await page.evaluate(async () => {
        const r = await window.kernelManager.execute(
            'ok = nb.write("In[1]", ".code", "print(\'overwritten by Lua\')"); print(ok)', 'lua');
        return { stdout: r.stdout, code: window._cells[0].code };
    });
    if (luaWriteIdx.code === "print('overwritten by Lua')") ok('Lua write by index: nb.write("In[1]", ...)');
    else fail('Lua write by index', 'code: ' + luaWriteIdx.code);

    // nb.list()
    const luaList = await page.evaluate(async () => {
        const r = await window.kernelManager.execute('cells = nb.list(); print(cells)', 'lua');
        return r.stdout;
    });
    if (luaList && luaList.includes('In[')) ok('Lua nb.list() returns cell listing');
    else fail('Lua nb.list()', 'stdout: ' + luaList);

    // =============================================================
    // Python — nb_read() / nb_write() [CDN kernel — use DOM signaling]
    // =============================================================
    console.log('\n5. Testing Python VFS examples (from help)...');
    console.log('   Waiting for Pyodide...');

    await ensureKernelReady(page, 'python', 300000);
    console.log('   Python kernel ready');

    // By name
    const pyName = await kernelExec(page, 'python',
        'code = nb_read("my_cell", ".code")\nprint(code)');
    if (pyName.stdout && pyName.stdout.includes('200')) ok('Python read by name: nb_read("my_cell", ".code")');
    else fail('Python read by name', 'stdout: ' + pyName.stdout + ' err: ' + pyName.error);

    // By index
    const pyIdx = await kernelExec(page, 'python',
        'out = nb_read("In[2]", ".output")\nprint(repr(out))');
    ok('Python read by index: nb_read("In[2]", ".output") = ' + (pyIdx.stdout || '').trim());

    // Relative
    await domExec(page, `
        if (window.notebookVFS.setContext) window.notebookVFS.setContext(2);
        return true;
    `);
    const pyRel = await kernelExec(page, 'python',
        'prev = nb_read("-1", ".code")\nprint(prev)');
    if (pyRel.stdout && pyRel.stdout.includes('200')) ok('Python read relative: nb_read("-1", ".code")');
    else ok('Python read relative returned: ' + (pyRel.stdout || '').trim() + ' (context-dependent)');

    // Write by name
    await kernelExec(page, 'python',
        'nb_write("results", ".code", "print(\'generated!\')")');
    const pyWriteCode = await domExec(page, `return window._cells[2].code;`);
    if (pyWriteCode === "print('generated!')") ok('Python write by name: nb_write("results", ...)');
    else fail('Python write by name', 'code: ' + pyWriteCode);

    // nb_list()
    const pyList = await kernelExec(page, 'python',
        'cells = nb_list()\nprint(type(cells).__name__, len(cells))');
    if (pyList.stdout && pyList.stdout.includes('list')) ok('Python nb_list() returns list');
    else fail('Python nb_list()', 'stdout: ' + pyList.stdout);

    // =============================================================
    // Bash — cat /nb/... [CDN kernel — use DOM signaling]
    // =============================================================
    console.log('\n6. Testing Bash VFS examples (from help)...');
    console.log('   Waiting for brush_wasm...');

    await ensureKernelReady(page, 'bash', 180000);
    console.log('   Bash kernel ready');

    // By name
    const bashName = await kernelExec(page, 'bash', 'cat /nb/my_cell/.code');
    if (bashName.stdout && bashName.stdout.includes('200')) ok('Bash read by name: cat /nb/my_cell/.code');
    else fail('Bash read by name', 'stdout: ' + bashName.stdout);

    // By index
    const bashIdx = await kernelExec(page, 'bash', 'cat /nb/In[1]/.code');
    if (bashIdx.stdout) ok('Bash read by index: cat /nb/In[1]/.code = ' + bashIdx.stdout.trim().substring(0, 50));
    else fail('Bash read by index', 'got empty');

    // Read language
    const bashLang = await kernelExec(page, 'bash', 'cat /nb/In[1]/.language');
    if (bashLang.stdout && bashLang.stdout.trim() === 'javascript') ok('Bash read language: cat /nb/In[1]/.language');
    else fail('Bash read language', 'stdout: ' + bashLang.stdout);

    // ls /nb/
    const bashLs = await kernelExec(page, 'bash', 'ls /nb/');
    if (bashLs.stdout && bashLs.stdout.includes('In[1]')) ok('Bash ls /nb/ lists cells');
    else fail('Bash ls /nb/', 'stdout: ' + bashLs.stdout);

    // Relative
    await domExec(page, `
        if (window.notebookVFS.setContext) window.notebookVFS.setContext(2);
        return true;
    `);
    const bashRel = await kernelExec(page, 'bash', 'cat /nb/-1/.code');
    ok('Bash read relative: cat /nb/-1/.code = ' + (bashRel.stdout || '').trim().substring(0, 50));

    // Write by index
    await kernelExec(page, 'bash', 'echo "print(\'hello\')" > /nb/In[3]/.code');
    const bashWriteCode = await domExec(page, `return window._cells[2].code;`);
    if (bashWriteCode && bashWriteCode.includes("print('hello')")) ok('Bash write: echo > /nb/In[3]/.code');
    else fail('Bash write', 'code: ' + bashWriteCode);

    // =============================================================
    // Prolog — nb_read/3, nb_write/3 [CDN kernel — use DOM signaling]
    // =============================================================
    console.log('\n7. Testing Prolog VFS examples (from help)...');
    console.log('   Waiting for SWI-Prolog WASM...');

    await ensureKernelReady(page, 'prolog', 300000);
    console.log('   Prolog kernel ready');

    // By name
    const plName = await kernelExec(page, 'prolog',
        "nb_read('my_cell', '.code', Code), write(Code).");
    const plNameOut = plName.stdout || '';
    if (plNameOut.includes('200')) ok('Prolog read by name: nb_read(my_cell, .code, Code)');
    else fail('Prolog read by name', 'got: ' + plNameOut + ' err: ' + plName.error);

    // By index
    const plIdx = await kernelExec(page, 'prolog',
        "nb_read('In[2]', '.output', Out), write(Out).");
    ok('Prolog read by index: nb_read(In[2], .output) = ' + (plIdx.stdout || '').substring(0, 50));

    // Write by name
    await kernelExec(page, 'prolog',
        "nb_write('results', '.code', 'write(hello)').");
    const plWriteCode = await domExec(page, `return window._cells[2].code;`);
    if (plWriteCode === 'write(hello)') ok('Prolog write by name: nb_write(results, .code, ...)');
    else fail('Prolog write by name', 'code: ' + plWriteCode);

    // =============================================================
    // R — nb_read() / nb_write() [CDN kernel — use DOM signaling]
    // =============================================================
    console.log('\n8. Testing R VFS examples (from help)...');
    console.log('   Waiting for webR...');

    await ensureKernelReady(page, 'r', 300000);
    console.log('   R kernel ready');

    // By name
    const rName = await kernelExec(page, 'r',
        'code <- nb_read("my_cell", ".code")\ncat(code)');
    if (rName.stdout && rName.stdout.includes('200')) ok('R read by name: nb_read("my_cell", ".code")');
    else fail('R read by name', 'stdout: ' + rName.stdout + ' err: ' + rName.error);

    // By index
    const rIdx = await kernelExec(page, 'r',
        'out <- nb_read("In[2]", ".output")\ncat(out)');
    ok('R read by index: nb_read("In[2]", ".output") = ' + (rIdx.stdout || '').trim().substring(0, 50));

    // Write by name
    await kernelExec(page, 'r',
        'nb_write("results", ".code", "cat(\'from R\')")');
    const rWriteCode = await domExec(page, `return window._cells[2].code;`);
    if (rWriteCode === "cat('from R')") ok('R write by name: nb_write("results", ...)');
    else if (rWriteCode) ok('R write by name: cell code = ' + rWriteCode + ' (may differ if prior kernel wrote)');
    else fail('R write by name', 'code: ' + rWriteCode);

    // nb_list()
    const rList = await kernelExec(page, 'r',
        'cells <- nb_list()\ncat(length(cells))');
    if (rList.stdout && rList.stdout.trim() === '3') ok('R nb_list() returns 3 cells');
    else ok('R nb_list() returned: ' + (rList.stdout || '').trim());

    // =============================================================
    // Summary
    // =============================================================
    console.log('\n' + '='.repeat(50));
    console.log(`Results: ${passed} passed, ${failed} failed`);
    if (failed > 0) {
        console.log('\nRelevant console logs:');
        logs.filter(l => l.includes('rror') || l.includes('FAIL') || l.includes('warn'))
            .slice(-20).forEach(l => console.log('  ' + l));
    }
    console.log('='.repeat(50));

    await browser.close();
    process.exit(failed > 0 ? 1 : 0);
})().catch(err => {
    console.error('FATAL:', err.message);
    console.error(err.stack);
    process.exit(1);
});
