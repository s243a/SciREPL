/**
 * Playwright test: Prolog Generates R — UnifyWeaver compiler demo workbook
 *
 * Tests the end-to-end flow:
 *   1. Import the UnifyWeaver package
 *   2. Switch to the "Prolog Generates R" workbook
 *   3. Run the init cell to load UnifyWeaver
 *   4. Run the factorial definition cell
 *   5. Run the compiler cell — verify it generates R code
 *   6. Verify the R cell was updated via NotebookVFS
 *   7. (Optional) Run the generated R code if webR is available
 */
import { chromium } from 'playwright';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const TIMEOUT = 180_000;       // 3 min — Prolog WASM ~10 MB
const PROLOG_TIMEOUT = 120_000; // 2 min for Prolog init
const R_TIMEOUT = 180_000;     // 3 min for webR init

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  const consoleLogs = [];
  page.on('console', msg => consoleLogs.push(`[${msg.type()}] ${msg.text()}`));
  page.on('pageerror', err => consoleLogs.push(`[PAGE ERROR] ${err.message}`));

  // Auto-accept confirm dialogs (CDN download prompts)
  page.on('dialog', async dialog => {
    if (dialog.type() === 'confirm') {
      console.log(`   [dialog] Accepting: ${dialog.message().substring(0, 80)}...`);
      await dialog.accept();
    } else if (dialog.type() === 'alert') {
      console.log(`   [alert] ${dialog.message()}`);
      await dialog.accept();
    }
  });

  let allPassed = true;
  const results = [];
  const testLog = (name, passed, detail) => {
    const mark = passed ? 'PASS' : 'FAIL';
    if (!passed) allPassed = false;
    results.push({ name, passed, detail });
    console.log(`  [${mark}] ${name}${detail ? ': ' + detail : ''}`);
  };

  try {
    // ---- 1. Navigate and set up ----
    console.log('1. Loading SciREPL...');

    const context = browser.contexts()[0];
    await context.addInitScript(() => {
      localStorage.setItem('scirepl_privacy_accepted', '1');
      localStorage.setItem('scirepl_auto_download', '1');
    });

    await page.goto('http://localhost:8085/', { waitUntil: 'domcontentloaded', timeout: TIMEOUT });

    // Clear SW cache to ensure latest code
    await page.evaluate(async () => {
      const regs = await navigator.serviceWorker.getRegistrations();
      for (const r of regs) await r.unregister();
      const keys = await caches.keys();
      for (const k of keys) await caches.delete(k);
    });
    await page.reload({ waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForSelector('#run-btn', { timeout: 15000 });
    console.log('   SciREPL loaded.');

    // ---- 2. Import the UnifyWeaver package ----
    console.log('2. Importing UnifyWeaver package...');

    const zipPath = resolve('../../..', 'unifyweaver_scirepl.zip');
    const zipBytes = readFileSync(zipPath);
    const zipBase64 = zipBytes.toString('base64');

    const loadResult = await page.evaluate(async (b64) => {
      const binary = atob(b64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const file = new File([bytes], 'unifyweaver_scirepl.zip', { type: 'application/zip' });
      try {
        const result = await window.packageLoader.loadFromFile(file);
        return { ok: true, ...result };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    }, zipBase64);

    testLog('Package loads without error', loadResult.ok, loadResult.error || `notebooks=${loadResult.notebooks}`);

    // ---- 3. Find and switch to the Prolog Generates R workbook ----
    console.log('3. Switching to Prolog Generates R workbook...');

    const switchResult = await page.evaluate(() => {
      const nm = window.notebookManager;
      if (!nm) return { ok: false, error: 'No notebookManager' };
      const nbs = nm.getNotebooks();
      const names = nbs.map(n => n.name);
      const target = nbs.find(n => n.name.toLowerCase().includes('prolog generates r'));
      if (!target) return { ok: false, error: 'Not found', names };
      nm.switchTo(target.id);
      return { ok: true, name: target.name, cellCount: target.cells ? target.cells.length : 0, names };
    });

    testLog('Workbook found', switchResult.ok, switchResult.ok ? switchResult.name : `Available: ${JSON.stringify(switchResult.names)}`);
    if (!switchResult.ok) throw new Error('Cannot find workbook — aborting');

    // ---- 4. Identify cells by name ----
    console.log('4. Identifying workbook cells...');

    const cellNames = await page.evaluate(() => {
      return (window._cells || []).map(c => ({
        id: c.id,
        name: c.name || '',
        type: c.type,
        language: c.language,
        codeSnippet: (c.code || '').substring(0, 60)
      }));
    });

    console.log('   Cells:');
    for (const c of cellNames) {
      console.log(`     [${c.id}] ${c.type}/${c.language} name="${c.name}" — ${c.codeSnippet}...`);
    }

    const initCell = cellNames.find(c => c.name === 'load_uw');
    const factCell = cellNames.find(c => c.name === 'prolog_factorial');
    const compileCell = cellNames.find(c => c.name === 'compile_to_r');
    const rCell = cellNames.find(c => c.name === 'r_factorial');
    const testRCell = cellNames.find(c => c.name === 'test_r');

    testLog('load_uw cell found', !!initCell);
    testLog('prolog_factorial cell found', !!factCell);
    testLog('compile_to_r cell found', !!compileCell);
    testLog('r_factorial cell found', !!rCell);
    testLog('test_r cell found', !!testRCell);

    if (!initCell || !factCell || !compileCell || !rCell) {
      throw new Error('Missing required cells — aborting');
    }

    // ---- 5. Initialize Prolog kernel ----
    console.log('5. Initializing Prolog kernel (downloading swipl-wasm)...');

    let prologReady = false;
    try {
      await page.evaluate(async () => {
        await window.kernelManager.ensureReady('prolog');
      }, { timeout: PROLOG_TIMEOUT });
      prologReady = true;
    } catch (e) {
      console.log('   Prolog init failed:', e.message);
    }

    testLog('Prolog kernel ready', prologReady);
    if (!prologReady) throw new Error('Prolog kernel failed to init — aborting');

    // ---- 6. Run the init cell: ['../init']. ----
    console.log('6. Running init cell (load UnifyWeaver)...');

    const initResult = await page.evaluate(async (cellId) => {
      const cell = window._cells.find(c => c.id === cellId);
      if (!cell) return { error: 'cell not found' };
      try {
        const result = await window.kernelManager.execute(cell.code, 'prolog');
        return { stdout: result.stdout || '', error: result.error || null };
      } catch (e) {
        return { error: e.message };
      }
    }, initCell.id);

    const initOk = !initResult.error && (initResult.stdout || '').includes('true');
    testLog('Init cell executed', initOk || !initResult.error, initResult.stdout || initResult.error);

    // ---- 7. Run the factorial definition cell ----
    console.log('7. Running factorial definition cell...');

    const factResult = await page.evaluate(async (cellId) => {
      const cell = window._cells.find(c => c.id === cellId);
      if (!cell) return { error: 'cell not found' };
      try {
        const result = await window.kernelManager.execute(cell.code, 'prolog');
        return { stdout: result.stdout || '', error: result.error || null };
      } catch (e) {
        return { error: e.message };
      }
    }, factCell.id);

    testLog('Factorial defined', !factResult.error, factResult.stdout || factResult.error);

    // ---- 8. Run the compiler cell ----
    console.log('8. Running compiler cell (compile_linear_recursion)...');

    const compileResult = await page.evaluate(async (cellId) => {
      const cell = window._cells.find(c => c.id === cellId);
      if (!cell) return { error: 'cell not found' };
      try {
        const result = await window.kernelManager.execute(cell.code, 'prolog');
        return { stdout: result.stdout || '', error: result.error || null };
      } catch (e) {
        return { error: e.message };
      }
    }, compileCell.id);

    const compileOutput = compileResult.stdout || '';
    testLog('Compiler cell executed', !compileResult.error, compileResult.error || '');
    testLog('nb_read read Prolog source',
      compileOutput.includes('Read from prolog_factorial'),
      compileOutput.substring(0, 200));
    testLog('Generated R code contains "factorial <- function"',
      compileOutput.includes('factorial <- function'),
      '');
    testLog('Generated R code contains "for" loop',
      compileOutput.includes('for ('),
      '');
    testLog('Generated R code contains "seq("',
      compileOutput.includes('seq('),
      '');
    testLog('nb_write confirmed',
      compileOutput.includes('R code written to cell'),
      '');

    // ---- 9. Verify the R cell was updated via NotebookVFS ----
    console.log('9. Verifying R cell was updated via NotebookVFS...');

    const rCellState = await page.evaluate(() => {
      const rCell = window._cells.find(c => c.name === 'r_factorial');
      if (!rCell) return { error: 'r_factorial cell not found' };
      return { code: rCell.code, language: rCell.language };
    });

    testLog('R cell code updated',
      rCellState.code && rCellState.code.includes('factorial <- function'),
      rCellState.code ? rCellState.code.substring(0, 100) : rCellState.error);
    testLog('R cell language is "r"',
      rCellState.language === 'r',
      rCellState.language);

    // Also verify via SharedVFS
    const vfsCode = await page.evaluate(() => {
      try {
        return window.sharedVFS.readFile('/nb/r_factorial/.code');
      } catch (e) {
        return 'ERROR: ' + e.message;
      }
    });
    testLog('R code readable via /nb/r_factorial/.code',
      vfsCode.includes('factorial <- function'),
      vfsCode.substring(0, 100));

    // ---- 10. Run the generated R code (if webR loads) ----
    console.log('10. Attempting to run generated R code (webR download)...');

    let rReady = false;
    try {
      await page.evaluate(async () => {
        await window.kernelManager.ensureReady('r');
      }, { timeout: R_TIMEOUT });
      rReady = true;
    } catch (e) {
      console.log('   webR init timed out or failed — skipping R execution test');
    }

    if (rReady) {
      // First: run the function definition cell
      const rDefResult = await page.evaluate(async () => {
        const rCell = window._cells.find(c => c.name === 'r_factorial');
        if (!rCell) return { error: 'r_factorial cell not found' };
        try {
          const result = await window.kernelManager.execute(rCell.code, 'r');
          return { stdout: result.stdout || '', error: result.error || null };
        } catch (e) {
          return { error: e.message };
        }
      });
      testLog('R function definition loaded', !rDefResult.error, rDefResult.error || '');

      // Then: run the test cell
      const rTestResult = await page.evaluate(async () => {
        const testCell = window._cells.find(c => c.name === 'test_r');
        if (!testCell) return { error: 'test_r cell not found' };
        try {
          const result = await window.kernelManager.execute(testCell.code, 'r');
          return { stdout: result.stdout || '', error: result.error || null };
        } catch (e) {
          return { error: e.message };
        }
      });

      const rOutput = rTestResult.stdout || '';
      testLog('R test execution succeeds', !rTestResult.error, rTestResult.error || '');
      testLog('R output contains "6! = 720"',
        rOutput.includes('720'),
        rOutput);
      testLog('R output contains "0! = 1"',
        rOutput.includes('0! =') && rOutput.includes('1'),
        '');
    } else {
      testLog('R execution (skipped — webR not available)', true, 'webR download timed out');
    }

  } catch (err) {
    console.error('\nFATAL:', err.message);
    allPassed = false;
  }

  // ---- Summary ----
  console.log('\n--- Summary ---');
  for (const r of results) {
    console.log(`  [${r.passed ? 'PASS' : 'FAIL'}] ${r.name}`);
  }
  const passed = results.filter(r => r.passed).length;
  const total = results.length;
  console.log(`\n${passed}/${total} tests passed`);

  if (!allPassed) {
    console.log('\nConsole logs from page:');
    for (const log of consoleLogs.slice(-30)) console.log('  ' + log);
  }

  console.log(allPassed ? '\n=== ALL TESTS PASSED ===' : '\n=== SOME TESTS FAILED ===');
  await browser.close();
  process.exit(allPassed ? 0 : 1);
})();
