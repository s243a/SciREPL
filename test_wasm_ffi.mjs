// Playwright test: verify WASM JSON FFI — load sci_math package, call from JS/Python/Prolog
import { chromium } from 'playwright';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const TIMEOUT = 120_000;

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  const consoleLogs = [];
  page.on('console', msg => consoleLogs.push(`[${msg.type()}] ${msg.text()}`));
  page.on('pageerror', err => consoleLogs.push(`[PAGE ERROR] ${err.message}`));

  let allPassed = true;
  const results = [];
  const testLog = (name, passed, detail) => {
    const mark = passed ? 'PASS' : 'FAIL';
    if (!passed) allPassed = false;
    results.push({ name, passed, detail });
    console.log(`  [${mark}] ${name}${detail ? ': ' + detail.trim() : ''}`);
  };

  try {
    console.log('1. Navigating to SciREPL...');

    const context = browser.contexts()[0];
    await context.addInitScript(() => {
      localStorage.setItem('scirepl_privacy_accepted', '1');
      localStorage.setItem('scirepl_onboarding_seen', '1');
      localStorage.setItem('scirepl_auto_download', '1');
    });

    await page.goto('http://localhost:8085/', { waitUntil: 'domcontentloaded', timeout: TIMEOUT });

    // Wait for app to be ready
    console.log('   Waiting for app...');
    await page.waitForFunction(() => {
      return window.kernelManager && document.getElementById('run-btn');
    }, { timeout: 30000 });

    // Trigger Python kernel load (needed for Python FFI tests)
    console.log('   Loading Python kernel...');
    await page.evaluate(async () => {
      await window.kernelManager.ensureReady('python');
    });
    await page.waitForFunction(() => {
      const km = window.kernelManager;
      return km._instances.python && km._instances.python.isReady();
    }, { timeout: TIMEOUT });

    // --- Load the WASM package ---

    console.log('2. Loading sci_math WASM package...');

    const zipPath = resolve('test_wasm_pkg.zip');
    const zipBytes = readFileSync(zipPath);
    const zipBase64 = zipBytes.toString('base64');

    const loadResult = await page.evaluate(async (b64) => {
      const binary = atob(b64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const file = new File([bytes], 'test_wasm_pkg.zip', { type: 'application/zip' });

      try {
        const result = await window.packageLoader.loadFromFile(file);
        return { ok: true, ...result };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    }, zipBase64);

    testLog('WASM package loads', loadResult.ok, loadResult.error || `name=${loadResult.name}`);

    // Check module is registered
    const moduleRegistered = await page.evaluate(() => {
      return window.wasmModules && window.wasmModules['sci_math'] ? true : false;
    });
    testLog('sci_math module registered at window.wasmModules', moduleRegistered);

    // --- Test: JavaScript calls WASM ---

    console.log('3. Testing JavaScript → WASM calls...');

    const jsAdd = await page.evaluate(async () => {
      const km = window.kernelManager;
      await km.ensureReady('javascript');
      return await km.execute(
        'window.wasmModules.sci_math.call("add", {a: 40, b: 2})',
        'javascript'
      );
    });
    const jsAddResult = jsAdd.result ? JSON.parse(jsAdd.result.content) : null;
    testLog('JS: add(40, 2) = 42',
      jsAddResult && jsAddResult.result === 42,
      jsAdd.result ? jsAdd.result.content : (jsAdd.error || 'no result'));

    const jsMultiply = await page.evaluate(async () => {
      const km = window.kernelManager;
      return await km.execute(
        'window.wasmModules.sci_math.call("multiply", {a: 6, b: 7})',
        'javascript'
      );
    });
    const jsMulResult = jsMultiply.result ? JSON.parse(jsMultiply.result.content) : null;
    testLog('JS: multiply(6, 7) = 42',
      jsMulResult && jsMulResult.result === 42,
      jsMultiply.result ? jsMultiply.result.content : (jsMultiply.error || 'no result'));

    const jsFib = await page.evaluate(async () => {
      const km = window.kernelManager;
      return await km.execute(
        'window.wasmModules.sci_math.call("fibonacci", {n: 10})',
        'javascript'
      );
    });
    const jsFibResult = jsFib.result ? JSON.parse(jsFib.result.content) : null;
    testLog('JS: fibonacci(10) = 55',
      jsFibResult && jsFibResult.result === 55,
      jsFib.result ? jsFib.result.content : (jsFib.error || 'no result'));

    const jsFact = await page.evaluate(async () => {
      const km = window.kernelManager;
      return await km.execute(
        'window.wasmModules.sci_math.call("factorial", {n: 10})',
        'javascript'
      );
    });
    const jsFactResult = jsFact.result ? JSON.parse(jsFact.result.content) : null;
    testLog('JS: factorial(10) = 3628800',
      jsFactResult && jsFactResult.result === 3628800,
      jsFact.result ? jsFact.result.content : (jsFact.error || 'no result'));

    const jsStats = await page.evaluate(async () => {
      const km = window.kernelManager;
      return await km.execute(
        'window.wasmModules.sci_math.call("stats", {data: [1, 2, 3, 4, 5]})',
        'javascript'
      );
    });
    const jsStatsResult = jsStats.result ? JSON.parse(jsStats.result.content) : null;
    testLog('JS: stats([1,2,3,4,5]) mean=3, count=5',
      jsStatsResult && jsStatsResult.mean === 3 && jsStatsResult.count === 5,
      jsStats.result ? jsStats.result.content : (jsStats.error || 'no result'));

    const jsListFuncs = await page.evaluate(async () => {
      const km = window.kernelManager;
      return await km.execute(
        'window.wasmModules.sci_math.call("list_functions", {})',
        'javascript'
      );
    });
    const jsListResult = jsListFuncs.result ? JSON.parse(jsListFuncs.result.content) : null;
    testLog('JS: list_functions returns array',
      jsListResult && jsListResult.functions && jsListResult.functions.includes('add'),
      jsListFuncs.result ? jsListFuncs.result.content : (jsListFuncs.error || 'no result'));

    // --- Test: Python calls WASM ---

    console.log('4. Testing Python → WASM calls...');

    const pyAdd = await page.evaluate(async () => {
      const km = window.kernelManager;
      await km.ensureReady('python');
      return await km.execute(`
result = wasm_call('sci_math', 'add', {'a': 100, 'b': 23})
print(result['result'])
`, 'python');
    });
    testLog('Python: wasm_call add(100, 23) = 123',
      (pyAdd.stdout || '').trim() === '123',
      (pyAdd.stdout || '').trim() || pyAdd.error);

    const pyStats = await page.evaluate(async () => {
      const km = window.kernelManager;
      return await km.execute(`
result = wasm_call('sci_math', 'stats', {'data': [10, 20, 30]})
print(f"mean={result['mean']}, count={result['count']}")
`, 'python');
    });
    testLog('Python: wasm_call stats([10,20,30])',
      (pyStats.stdout || '').includes('mean=20') && (pyStats.stdout || '').includes('count=3'),
      (pyStats.stdout || '').trim() || pyStats.error);

    // --- Test: Prolog calls WASM ---

    console.log('5. Testing Prolog → WASM calls...');

    const plAdd = await page.evaluate(async () => {
      const km = window.kernelManager;
      await km.ensureReady('prolog');
      return await km.execute(
        'wasm_call(sci_math, add, \'{"a": 50, "b": 7}\').',
        'prolog'
      );
    });
    testLog('Prolog: wasm_call add(50, 7) = 57',
      (plAdd.stdout || '').includes('"result":57') || (plAdd.stdout || '').includes('"result": 57'),
      (plAdd.stdout || '').trim() || plAdd.error);

    const plMultiply = await page.evaluate(async () => {
      const km = window.kernelManager;
      return await km.execute(
        'wasm_call(sci_math, multiply, \'{"a": 8, "b": 9}\').',
        'prolog'
      );
    });
    testLog('Prolog: wasm_call multiply(8, 9) = 72',
      (plMultiply.stdout || '').includes('"result":72') || (plMultiply.stdout || '').includes('"result": 72'),
      (plMultiply.stdout || '').trim() || plMultiply.error);

    const plFib = await page.evaluate(async () => {
      const km = window.kernelManager;
      return await km.execute(
        'wasm_call(sci_math, fibonacci, \'{"n": 8}\').',
        'prolog'
      );
    });
    testLog('Prolog: wasm_call fibonacci(8) = 21',
      (plFib.stdout || '').includes('"result":21') || (plFib.stdout || '').includes('"result": 21'),
      (plFib.stdout || '').trim() || plFib.error);

    const plStats = await page.evaluate(async () => {
      const km = window.kernelManager;
      return await km.execute(
        'wasm_call(sci_math, stats, \'{"data": [2, 4, 6, 8, 10]}\').',
        'prolog'
      );
    });
    testLog('Prolog: wasm_call stats([2,4,6,8,10]) mean=6',
      (plStats.stdout || '').includes('"mean":6') || (plStats.stdout || '').includes('"mean": 6'),
      (plStats.stdout || '').trim() || plStats.error);

    const plListFuncs = await page.evaluate(async () => {
      const km = window.kernelManager;
      return await km.execute(
        'wasm_call(sci_math, list_functions, \'{}\').',
        'prolog'
      );
    });
    testLog('Prolog: wasm_call list_functions returns add',
      (plListFuncs.stdout || '').includes('add'),
      (plListFuncs.stdout || '').trim() || plListFuncs.error);

    // --- Test: Cross-kernel WASM result sharing ---

    console.log('6. Testing cross-kernel WASM result sharing...');

    // JS calls WASM, writes result to SharedVFS, Bash reads it
    const crossKernel = await page.evaluate(async () => {
      const km = window.kernelManager;
      // JS writes WASM result to SharedVFS
      await km.execute(`
        const result = window.wasmModules.sci_math.call('factorial', {n: 7});
        window.sharedVFS.writeFile('/shared/data/wasm_result.txt', String(result.result), 'javascript');
      `, 'javascript');

      // Bash reads it
      await km.ensureReady('bash');
      return await km.execute('cat /shared/data/wasm_result.txt', 'bash');
    });
    testLog('Cross-kernel: JS WASM result → SharedVFS → Bash reads "5040"',
      (crossKernel.stdout || '').trim() === '5040',
      (crossKernel.stdout || '').trim() || crossKernel.error);

    // --- Test: Error handling ---

    console.log('7. Testing error handling...');

    const jsUnknown = await page.evaluate(async () => {
      const km = window.kernelManager;
      return await km.execute(
        'window.wasmModules.sci_math.call("nonexistent", {})',
        'javascript'
      );
    });
    const jsUnknownResult = jsUnknown.result ? JSON.parse(jsUnknown.result.content) : null;
    testLog('JS: unknown function returns error',
      jsUnknownResult && jsUnknownResult.error && jsUnknownResult.error.includes('unknown function'),
      jsUnknown.result ? jsUnknown.result.content : (jsUnknown.error || 'no result'));

    const plUnknownMod = await page.evaluate(async () => {
      const km = window.kernelManager;
      return await km.execute(
        'wasm_call(nonexistent_module, add, \'{}\').',
        'prolog'
      );
    });
    testLog('Prolog: unknown module returns error',
      (plUnknownMod.error || '').includes('not loaded'),
      plUnknownMod.error || (plUnknownMod.stdout || '').trim());

    // --- Summary ---
    console.log('\n' + '='.repeat(50));
    const passCount = results.filter(r => r.passed).length;
    console.log(`Results: ${passCount}/${results.length} passed`);
    console.log(allPassed ? '\nPASS: All WASM FFI tests passed!' : '\nFAIL: Some tests failed');

  } catch (err) {
    console.error('FATAL:', err.message);
    console.error('Console logs:', consoleLogs.slice(-15).join('\n'));
    allPassed = false;
  } finally {
    await browser.close();
    process.exit(allPassed ? 0 : 1);
  }
})();
