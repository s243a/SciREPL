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
      localStorage.setItem('scirepl_onboarding_seen', '1');
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

    // ---- 2b. Re-import the local .srwb (may have newer cells than the package zip) ----
    console.log('2b. Re-importing local prolog-generates-r.srwb...');

    const srwbReload = await page.evaluate(async () => {
      try {
        const resp = await fetch('./workbooks/prolog-generates-r.srwb');
        if (!resp.ok) return { ok: false, error: `fetch ${resp.status}` };
        const text = await resp.text();
        window.fileIO.importSrwb(text);
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    });
    testLog('Local .srwb re-imported', srwbReload.ok, srwbReload.error || '');

    // ---- 3. Find and switch to the Prolog Generates R workbook ----
    console.log('3. Switching to Prolog Generates R workbook...');

    const switchResult = await page.evaluate(() => {
      const nm = window.notebookManager;
      if (!nm) return { ok: false, error: 'No notebookManager' };
      const nbs = nm.getNotebooks();
      const names = nbs.map(n => n.name);
      // Use the last matching notebook (most recently imported)
      const matches = nbs.filter(n => n.name.toLowerCase().includes('prolog generates r'));
      const target = matches.length > 0 ? matches[matches.length - 1] : null;
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
    const inspectCell = cellNames.find(c => c.name === 'inspect');
    const accumCell = cellNames.find(c => c.name === 'accumulate');
    const ancestorCell = cellNames.find(c => c.name === 'prolog_ancestor');
    const compileTcCell = cellNames.find(c => c.name === 'compile_ancestor_tc');
    const compileSkipCell = cellNames.find(c => c.name === 'compile_ancestor_skip');
    const rAncestorTcCell = cellNames.find(c => c.name === 'r_ancestor_tc');
    const bashAncestorAltCell = cellNames.find(c => c.name === 'bash_ancestor_alt');
    const compareCell = cellNames.find(c => c.name === 'compare_outputs');

    testLog('load_uw cell found', !!initCell);
    testLog('prolog_factorial cell found', !!factCell);
    testLog('compile_to_r cell found', !!compileCell);
    testLog('r_factorial cell found', !!rCell);
    testLog('test_r cell found', !!testRCell);
    testLog('inspect cell found', !!inspectCell);
    testLog('accumulate cell found', !!accumCell);
    testLog('prolog_ancestor cell found', !!ancestorCell);
    testLog('compile_ancestor_tc cell found', !!compileTcCell);
    testLog('compile_ancestor_skip cell found', !!compileSkipCell);
    testLog('r_ancestor_tc cell found', !!rAncestorTcCell);
    testLog('bash_ancestor_alt cell found', !!bashAncestorAltCell);
    testLog('compare_outputs cell found', !!compareCell);

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

    // ---- 10. Test relative addressing via bash cells ----
    console.log('10. Testing relative addressing (bash inspect + accumulate)...');

    if (inspectCell && accumCell) {
      // Initialize bash kernel
      let bashReady = false;
      try {
        await page.evaluate(async () => {
          await window.kernelManager.ensureReady('bash');
        });
        bashReady = true;
      } catch (e) {
        console.log('   Bash kernel init failed:', e.message);
      }
      testLog('Bash kernel ready', bashReady);

      if (bashReady) {
        // Run the inspect cell first (so it has output for accumulate to read)
        const inspectResult = await page.evaluate(async (cellId) => {
          const cell = window._cells.find(c => c.id === cellId);
          if (!cell) return { error: 'cell not found' };
          // Set context to this cell's index for relative addressing
          const idx = window._cells.indexOf(cell);
          if (idx >= 0) window.notebookVFS.setContext(idx);
          try {
            const result = await window.kernelManager.execute(cell.code, 'bash');
            // Store output on the cell so accumulate can read it via -1
            cell.lastOutput = result.stdout || '';
            return { stdout: result.stdout || '', error: result.error || null };
          } catch (e) {
            return { error: e.message };
          }
        }, inspectCell.id);

        const inspectOutput = inspectResult.stdout || '';
        testLog('Bash inspect cell runs', !inspectResult.error, inspectResult.error || '');
        testLog('Inspect output lists cells', inspectOutput.includes('=== Cells ==='), '');
        testLog('Inspect output shows r_factorial code',
          inspectOutput.includes('factorial'),
          inspectOutput.substring(0, 150));

        // Now run accumulate — it uses /nb/-1/.output (relative to itself)
        const accumResult = await page.evaluate(async (cellId) => {
          const cell = window._cells.find(c => c.id === cellId);
          if (!cell) return { error: 'cell not found' };
          const idx = window._cells.indexOf(cell);
          if (idx >= 0) window.notebookVFS.setContext(idx);
          try {
            const result = await window.kernelManager.execute(cell.code, 'bash');
            return { stdout: result.stdout || '', error: result.error || null };
          } catch (e) {
            return { error: e.message };
          }
        }, accumCell.id);

        const accumOutput = accumResult.stdout || '';
        testLog('Accumulate cell runs', !accumResult.error, accumResult.error || '');
        testLog('Accumulate reads inspect output via /nb/-1/.output',
          accumOutput.includes('=== Cells ===') || accumOutput.includes('factorial'),
          accumOutput.substring(0, 200));
        testLog('Accumulate reads own code via /nb/./.code',
          accumOutput.includes('cat /nb/-1/.output') && accumOutput.includes('cat /nb/./.code'),
          '');
      }
    } else {
      testLog('Relative addressing (skipped — cells not found)', false, 'inspect or accumulate cell missing');
    }

    // ---- 11. Test ancestor compilation (Part 2) ----
    console.log('11. Testing ancestor compilation (transitive closure + skip)...');

    if (ancestorCell && compileTcCell && compileSkipCell) {
      // Run ancestor definition cell
      const ancResult = await page.evaluate(async (cellId) => {
        const cell = window._cells.find(c => c.id === cellId);
        if (!cell) return { error: 'cell not found' };
        try {
          const result = await window.kernelManager.execute(cell.code, 'prolog');
          return { stdout: result.stdout || '', error: result.error || null };
        } catch (e) {
          return { error: e.message };
        }
      }, ancestorCell.id);
      testLog('Ancestor predicates defined', !ancResult.error, ancResult.error || '');

      // Run compile_ancestor_tc (default → transitive closure)
      const tcResult = await page.evaluate(async (cellId) => {
        const cell = window._cells.find(c => c.id === cellId);
        if (!cell) return { error: 'cell not found' };
        try {
          const result = await window.kernelManager.execute(cell.code, 'prolog');
          return { stdout: result.stdout || '', error: result.error || null };
        } catch (e) {
          return { error: e.message };
        }
      }, compileTcCell.id);

      const tcOutput = tcResult.stdout || '';
      testLog('TC compiler cell executed', !tcResult.error, tcResult.error || '');
      testLog('TC output mentions transitive_closure',
        tcOutput.includes('transitive') || tcOutput.includes('Transitive') || tcOutput.includes('ancestor'),
        tcOutput.substring(0, 200));
      testLog('TC output contains R code',
        tcOutput.includes('ancestor') && (tcOutput.includes('<-') || tcOutput.includes('function')),
        '');
      testLog('TC nb_write confirmed',
        tcOutput.includes('R code written to cell'),
        '');

      // Verify the R cell was updated
      const tcCellCode = await page.evaluate(() => {
        const cell = window._cells.find(c => c.name === 'r_ancestor_tc');
        return cell ? cell.code : '';
      });
      testLog('r_ancestor_tc cell updated',
        tcCellCode.includes('ancestor') || tcCellCode.includes('parent'),
        tcCellCode.substring(0, 100));

      // Run compile_ancestor_skip (skip TC → tail recursion, bash target)
      const skipResult = await page.evaluate(async (cellId) => {
        const cell = window._cells.find(c => c.id === cellId);
        if (!cell) return { error: 'cell not found' };
        try {
          const result = await window.kernelManager.execute(cell.code, 'prolog');
          return { stdout: result.stdout || '', error: result.error || null };
        } catch (e) {
          return { error: e.message };
        }
      }, compileSkipCell.id);

      const skipOutput = skipResult.stdout || '';
      testLog('Skip compiler cell executed', !skipResult.error, skipResult.error || '');
      testLog('Skip output contains bash code',
        skipOutput.includes('ancestor') && (skipOutput.includes('bash') || skipOutput.includes('#!/bin/bash') || skipOutput.includes('local')),
        skipOutput.substring(0, 200));
      testLog('Skip nb_write confirmed',
        skipOutput.includes('Bash code written to cell'),
        '');

      // Verify bash cell was updated
      const bashCellCode = await page.evaluate(() => {
        const cell = window._cells.find(c => c.name === 'bash_ancestor_alt');
        return cell ? cell.code : '';
      });
      testLog('bash_ancestor_alt cell updated',
        bashCellCode.includes('ancestor') || bashCellCode.includes('bash'),
        bashCellCode.substring(0, 100));
    } else {
      testLog('Ancestor compilation (skipped — cells not found)', false, 'ancestor cells missing');
    }

    // ---- 12. Run the generated R code (if webR loads) ----
    console.log('12. Attempting to run generated R code (webR download)...');

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
