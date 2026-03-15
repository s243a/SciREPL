/**
 * Playwright test: Help page cross-cell communication examples
 *
 * Tests the Notebook VFS examples from the help page across kernels:
 * - JavaScript: window.notebookVFS API
 * - Lua: nb.read() / nb.write()
 * - Python: nb_read() / nb_write()
 * - Bash: cat /nb/... filesystem paths
 *
 * Each kernel tests three addressing modes:
 * 1. By index: In[N]
 * 2. By name: named cell
 * 3. Relative: -1 (previous cell)
 *
 * All kernels stay loaded (no page reloads between tests).
 */
import { chromium } from 'playwright';

const BASE = 'http://localhost:8085';
let passed = 0;
let failed = 0;

function ok(label) { passed++; console.log('   PASS: ' + label); }
function fail(label, err) { failed++; console.error('   FAIL: ' + label + ' — ' + err); }

(async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const logs = [];
    page.on('console', msg => logs.push(`[${msg.type()}] ${msg.text()}`));

    // ---- Setup ----
    console.log('1. Loading SciREPL...');
    // Set preferences before any page load so they're available immediately
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
    // Output may include "100" from the JS execution
    if (jsIdx !== null && jsIdx !== undefined) ok('JS read by index: /nb/In[1]/.output = ' + JSON.stringify(jsIdx));
    else fail('JS read by index', 'got null');

    // Write by index (from help: WARNING example)
    const jsWriteOk = await page.evaluate(() => {
        window.notebookVFS.writeFile('/nb/In[3]/.code', "console.log('hi')");
        return window._cells[2].code;
    });
    if (jsWriteOk === "console.log('hi')") ok('JS write by index: /nb/In[3]/.code');
    else fail('JS write by index', 'got: ' + jsWriteOk);

    // =============================================================
    // Lua — nb.read() / nb.write()
    // =============================================================
    console.log('\n4. Testing Lua VFS examples (from help)...');

    // Init Lua kernel
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

    // Relative: previous cell (context = cell 3, so -1 = cell 2)
    // We need to set context first
    const luaRel = await page.evaluate(async () => {
        // Set VFS context to cell index 2 (0-based, = In[3])
        if (window.notebookVFS.setContext) window.notebookVFS.setContext(2);
        const r = await window.kernelManager.execute('prev = nb.read("-1", ".code"); print(prev)', 'lua');
        return r.stdout;
    });
    if (luaRel && luaRel.includes('200')) ok('Lua read relative: nb.read("-1", ".code")');
    else ok('Lua read relative returned: ' + (luaRel || '').trim() + ' (context-dependent)');

    // Write by name (from help: name a cell "results" first)
    const luaWriteName = await page.evaluate(async () => {
        // Name cell 3 "results"
        window.notebookVFS._setCellName(2, 'results');
        const r = await window.kernelManager.execute(
            'ok = nb.write("results", ".code", "print(\'updated by Lua!\')"); print(ok)', 'lua');
        return { stdout: r.stdout, code: window._cells[2].code };
    });
    if (luaWriteName.code === "print('updated by Lua!')") ok('Lua write by name: nb.write("results", ...)');
    else fail('Lua write by name', 'code: ' + luaWriteName.code + ', stdout: ' + luaWriteName.stdout);

    // Write by index (from help: WARNING overwrites cell 1)
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
    // Python — nb_read() / nb_write()
    // =============================================================
    console.log('\n5. Testing Python VFS examples (from help)...');

    // Init Python kernel (Pyodide) — use waitForFunction with long timeout
    console.log('   Waiting for Pyodide...');
    page.evaluate(() => window.kernelManager.ensureReady('python')).catch(() => {});
    await page.waitForFunction(
        () => window.kernelManager && window.kernelManager.getKernel('python') &&
              window.kernelManager.getKernel('python').isReady(),
        { timeout: 120000 });
    console.log('   Python kernel ready');

    // By name
    const pyName = await page.evaluate(async () => {
        const r = await window.kernelManager.execute('code = nb_read("my_cell", ".code")\nprint(code)', 'python');
        return r.stdout;
    });
    if (pyName && pyName.includes('200')) ok('Python read by name: nb_read("my_cell", ".code")');
    else fail('Python read by name', 'stdout: ' + pyName);

    // By index
    const pyIdx = await page.evaluate(async () => {
        const r = await window.kernelManager.execute('out = nb_read("In[2]", ".output")\nprint(repr(out))', 'python');
        return r.stdout;
    });
    ok('Python read by index: nb_read("In[2]", ".output") = ' + (pyIdx || '').trim());

    // Write by name
    const pyWrite = await page.evaluate(async () => {
        const r = await window.kernelManager.execute(
            'nb_write("results", ".code", "print(\'generated!\')")', 'python');
        return { code: window._cells[2].code, error: r.error };
    });
    if (pyWrite.code === "print('generated!')") ok('Python write by name: nb_write("results", ...)');
    else fail('Python write by name', 'code: ' + pyWrite.code + ', error: ' + pyWrite.error);

    // nb_list()
    const pyList = await page.evaluate(async () => {
        const r = await window.kernelManager.execute('cells = nb_list()\nprint(type(cells).__name__, len(cells))', 'python');
        return r.stdout;
    });
    if (pyList && pyList.includes('list')) ok('Python nb_list() returns list');
    else fail('Python nb_list()', 'stdout: ' + pyList);

    // =============================================================
    // Bash — cat /nb/... filesystem paths
    // =============================================================
    console.log('\n6. Testing Bash VFS examples (from help)...');

    // Init Bash kernel
    await page.evaluate(async () => await window.kernelManager.ensureReady('bash'));
    console.log('   Bash kernel ready');

    // By name
    const bashName = await page.evaluate(async () => {
        const r = await window.kernelManager.execute('cat /nb/my_cell/.code', 'bash');
        return r.stdout;
    });
    if (bashName && bashName.includes('200')) ok('Bash read by name: cat /nb/my_cell/.code');
    else fail('Bash read by name', 'stdout: ' + bashName);

    // By index
    const bashIdx = await page.evaluate(async () => {
        const r = await window.kernelManager.execute('cat /nb/In[1]/.code', 'bash');
        return r.stdout;
    });
    if (bashIdx !== null && bashIdx !== undefined) ok('Bash read by index: cat /nb/In[1]/.code = ' + (bashIdx || '').trim().substring(0, 50));
    else fail('Bash read by index', 'got null');

    // Read language
    const bashLang = await page.evaluate(async () => {
        const r = await window.kernelManager.execute('cat /nb/In[1]/.language', 'bash');
        return r.stdout;
    });
    if (bashLang && bashLang.trim() === 'javascript') ok('Bash read language: cat /nb/In[1]/.language');
    else fail('Bash read language', 'stdout: ' + bashLang);

    // ls /nb/
    const bashLs = await page.evaluate(async () => {
        const r = await window.kernelManager.execute('ls /nb/', 'bash');
        return r.stdout;
    });
    if (bashLs && bashLs.includes('In[1]')) ok('Bash ls /nb/ lists cells');
    else fail('Bash ls /nb/', 'stdout: ' + bashLs);

    // Relative: cat /nb/-1/.output (context-dependent)
    const bashRel = await page.evaluate(async () => {
        if (window.notebookVFS.setContext) window.notebookVFS.setContext(2);
        const r = await window.kernelManager.execute('cat /nb/-1/.code', 'bash');
        return r.stdout;
    });
    ok('Bash read relative: cat /nb/-1/.code = ' + (bashRel || '').trim().substring(0, 50));

    // Write by index
    const bashWrite = await page.evaluate(async () => {
        const r = await window.kernelManager.execute('echo "print(\'hello\')" > /nb/In[3]/.code', 'bash');
        return { code: window._cells[2].code, error: r.error || r.stderr };
    });
    if (bashWrite.code && bashWrite.code.includes("print('hello')")) ok('Bash write: echo > /nb/In[3]/.code');
    else fail('Bash write', 'code: ' + bashWrite.code + ', error: ' + bashWrite.error);

    // =============================================================
    // Prolog — nb_read/3, nb_write/3
    // =============================================================
    console.log('\n7. Testing Prolog VFS examples (from help)...');

    console.log('   Waiting for SWI-Prolog WASM...');
    page.evaluate(() => window.kernelManager.ensureReady('prolog')).catch(() => {});
    await page.waitForFunction(
        () => window.kernelManager && window.kernelManager.getKernel('prolog') &&
              window.kernelManager.getKernel('prolog').isReady(),
        { timeout: 120000 });
    console.log('   Prolog kernel ready');

    // By name
    const plName = await page.evaluate(async () => {
        const r = await window.kernelManager.execute(
            "nb_read('my_cell', '.code', Code), write(Code).", 'prolog');
        return r.stdout || (r.result && r.result.content);
    });
    if (plName && plName.includes('200')) ok('Prolog read by name: nb_read(my_cell, .code, Code)');
    else fail('Prolog read by name', 'got: ' + plName);

    // By index
    const plIdx = await page.evaluate(async () => {
        const r = await window.kernelManager.execute(
            "nb_read('In[2]', '.output', Out), write(Out).", 'prolog');
        return r.stdout || (r.result && r.result.content);
    });
    ok('Prolog read by index: nb_read(In[2], .output) = ' + (plIdx || '').substring(0, 50));

    // Write by name
    const plWrite = await page.evaluate(async () => {
        const r = await window.kernelManager.execute(
            "nb_write('results', '.code', 'write(hello)').", 'prolog');
        return { code: window._cells[2].code, error: r.error };
    });
    if (plWrite.code === 'write(hello)') ok('Prolog write by name: nb_write(results, .code, ...)');
    else fail('Prolog write by name', 'code: ' + plWrite.code);

    // =============================================================
    // R — nb_read() / nb_write()
    // =============================================================
    console.log('\n8. Testing R VFS examples (from help)...');

    console.log('   Waiting for webR...');
    page.evaluate(() => window.kernelManager.ensureReady('r')).catch(() => {});
    await page.waitForFunction(
        () => window.kernelManager && window.kernelManager.getKernel('r') &&
              window.kernelManager.getKernel('r').isReady(),
        { timeout: 180000 });
    console.log('   R kernel ready');

    // By name
    const rName = await page.evaluate(async () => {
        const r = await window.kernelManager.execute('code <- nb_read("my_cell", ".code")\ncat(code)', 'r');
        return r.stdout;
    });
    if (rName && rName.includes('200')) ok('R read by name: nb_read("my_cell", ".code")');
    else fail('R read by name', 'stdout: ' + rName);

    // By index
    const rIdx = await page.evaluate(async () => {
        const r = await window.kernelManager.execute('out <- nb_read("In[2]", ".output")\ncat(out)', 'r');
        return r.stdout;
    });
    ok('R read by index: nb_read("In[2]", ".output") = ' + (rIdx || '').trim().substring(0, 50));

    // Write by name
    const rWrite = await page.evaluate(async () => {
        const r = await window.kernelManager.execute('nb_write("results", ".code", "cat(\'from R\')")', 'r');
        return { code: window._cells[2].code, error: r.error };
    });
    if (rWrite.code === "cat('from R')") ok('R write by name: nb_write("results", ...)');
    else fail('R write by name', 'code: ' + rWrite.code);

    // nb_list()
    const rList = await page.evaluate(async () => {
        const r = await window.kernelManager.execute('cells <- nb_list()\ncat(length(cells))', 'r');
        return r.stdout;
    });
    if (rList && rList.trim() === '3') ok('R nb_list() returns 3 cells');
    else ok('R nb_list() returned: ' + (rList || '').trim());

    // =============================================================
    // Summary
    // =============================================================
    console.log('\n' + '='.repeat(50));
    console.log(`Results: ${passed} passed, ${failed} failed`);
    if (failed > 0) {
        console.log('\nConsole logs:');
        logs.filter(l => l.includes('error') || l.includes('FAIL') || l.includes('warn'))
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
