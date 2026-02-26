// Playwright test: verify package system v2 — target routing, SharedVFS, Python bridge
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

    // Pre-accept privacy policy so Pyodide script loads immediately
    const context = browser.contexts()[0];
    await context.addInitScript(() => {
      localStorage.setItem('scirepl_privacy_accepted', '1');
    });

    await page.goto('http://localhost:8085/', { waitUntil: 'domcontentloaded', timeout: TIMEOUT });

    // Wait for Pyodide to be available (loaded after privacy acceptance)
    console.log('   Waiting for Pyodide to load...');
    await page.waitForFunction(() => typeof window.loadPyodide !== 'undefined', { timeout: TIMEOUT });
    console.log('   Pyodide script available.');

    await page.waitForTimeout(3000);

    // Hide loading overlay if present
    await page.evaluate(() => {
      const overlay = document.getElementById('loading-overlay');
      if (overlay) overlay.style.display = 'none';
    });

    console.log('2. Loading test package v2...');

    // Read the test zip and load it via PackageLoader
    const zipPath = resolve('test_pkg_v2.zip');
    const zipBytes = readFileSync(zipPath);
    const zipBase64 = zipBytes.toString('base64');

    const loadResult = await page.evaluate(async (b64) => {
      // Convert base64 to File
      const binary = atob(b64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const file = new File([bytes], 'test_pkg_v2.zip', { type: 'application/zip' });

      try {
        const result = await window.packageLoader.loadFromFile(file);
        return { ok: true, ...result };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    }, zipBase64);

    testLog('Package loads without error', loadResult.ok, loadResult.error || `name=${loadResult.name}`);
    testLog('Package name parsed', loadResult.name === 'Test Package v2', loadResult.name);

    // --- Test Phase 1: SharedVFS target routing ---

    console.log('3. Testing SharedVFS target routing...');

    // Check greeting.txt in SharedVFS (target: "shared")
    const greetingExists = await page.evaluate(() => {
      return window.sharedVFS && window.sharedVFS.exists('/shared/data/greeting.txt');
    });
    testLog('greeting.txt exists in SharedVFS', greetingExists === true);

    const greetingContent = await page.evaluate(() => {
      return window.sharedVFS.readFile('/shared/data/greeting.txt', 'utf8');
    });
    testLog('greeting.txt content correct', greetingContent === 'Hello from test package v2!', greetingContent);

    // Check numbers.csv in SharedVFS
    const csvExists = await page.evaluate(() => {
      return window.sharedVFS.exists('/shared/data/numbers.csv');
    });
    testLog('numbers.csv exists in SharedVFS', csvExists === true);

    // Check Python module in SharedVFS
    const pyModExists = await page.evaluate(() => {
      return window.sharedVFS.exists('/shared/lib/python/testmod.py');
    });
    testLog('testmod.py exists in SharedVFS at /shared/lib/python/', pyModExists === true);

    // Check "all" target — both.txt should be in SharedVFS
    const bothInShared = await page.evaluate(() => {
      return window.sharedVFS.exists('/shared/data/both.txt');
    });
    testLog('both.txt (target:all) exists in SharedVFS', bothInShared === true);

    // Check convention directories exist
    const convDirs = await page.evaluate(() => {
      const vfs = window.sharedVFS;
      return {
        lib: vfs.exists('/shared/lib'),
        bin: vfs.exists('/shared/bin'),
        data: vfs.exists('/shared/data'),
        config: vfs.exists('/shared/config'),
        libPython: vfs.exists('/shared/lib/python'),
        libProlog: vfs.exists('/shared/lib/prolog'),
        libWasm: vfs.exists('/shared/lib/wasm'),
      };
    });
    testLog('Convention dirs exist (/shared/lib, /bin, /data)',
      convDirs.lib && convDirs.bin && convDirs.data && convDirs.config,
      JSON.stringify(convDirs));

    // --- Test: SharedVFS list directory ---
    const dataList = await page.evaluate(() => {
      const result = window.sharedVFS.vfs_list_dir('/shared/data');
      return result ? JSON.parse(result) : null;
    });
    testLog('/shared/data/ lists files',
      dataList && dataList.length >= 3,
      dataList ? dataList.map(e => e.name).join(', ') : 'null');

    // --- Test: Bash can read SharedVFS files ---

    console.log('4. Testing Bash reads SharedVFS files...');

    // Execute a bash command to cat the greeting file
    const bashResult = await page.evaluate(async () => {
      const km = window.kernelManager;
      if (!km) return { error: 'no kernel manager' };
      try {
        await km.ensureReady('bash');
        const result = await km.execute('cat /shared/data/greeting.txt', 'bash');
        return result;
      } catch (e) {
        return { error: e.message };
      }
    });
    const bashStdout = (bashResult.stdout || '').trim();
    testLog('Bash cat /shared/data/greeting.txt works',
      bashStdout === 'Hello from test package v2!',
      bashStdout || bashResult.error);

    // --- Test Phase 2: Python SharedVFS bridge ---

    console.log('5. Testing Python SharedVFS bridge...');

    // Test sharedfs module is available
    const pyBridgeTest = await page.evaluate(async () => {
      const km = window.kernelManager;
      if (!km) return { error: 'no kernel manager' };
      try {
        await km.ensureReady('python');
        const result = await km.execute(`
import sharedfs
text = sharedfs.read_text('/shared/data/greeting.txt')
print(text)
`, 'python');
        return result;
      } catch (e) {
        return { error: e.message };
      }
    });
    const pyBridgeStdout = (pyBridgeTest.stdout || '').trim();
    testLog('Python sharedfs.read_text() works',
      pyBridgeStdout === 'Hello from test package v2!',
      pyBridgeStdout || pyBridgeTest.error);

    // Test Python can write to SharedVFS and Bash can read it
    const pyWriteTest = await page.evaluate(async () => {
      const km = window.kernelManager;
      try {
        await km.execute(`
import sharedfs
sharedfs.write_text('/shared/data/from_python.txt', 'written by python')
`, 'python');
        // Now read from Bash
        const bashResult = await km.execute('cat /shared/data/from_python.txt', 'bash');
        return bashResult;
      } catch (e) {
        return { error: e.message };
      }
    });
    const pyWriteStdout = (pyWriteTest.stdout || '').trim();
    testLog('Python write → Bash read cross-kernel',
      pyWriteStdout === 'written by python',
      pyWriteStdout || pyWriteTest.error);

    // Test sharedfs.exists and sharedfs.listdir
    const pyUtilTest = await page.evaluate(async () => {
      const km = window.kernelManager;
      try {
        const result = await km.execute(`
import sharedfs
e = sharedfs.exists('/shared/data/greeting.txt')
d = sharedfs.listdir('/shared/data')
names = [entry['name'] for entry in d]
print(f"exists={e}, files={sorted(names)}")
`, 'python');
        return result;
      } catch (e) {
        return { error: e.message };
      }
    });
    const pyUtilStdout = (pyUtilTest.stdout || '').trim();
    testLog('Python sharedfs.exists() and listdir() work',
      pyUtilStdout.includes('exists=True') && pyUtilStdout.includes('greeting.txt'),
      pyUtilStdout || pyUtilTest.error);

    // Test Python can import module from /shared/lib/python/
    const pyImportTest = await page.evaluate(async () => {
      const km = window.kernelManager;
      try {
        const result = await km.execute(`
import testmod
msg = testmod.greet('SciREPL')
total = testmod.add(40, 2)
print(f"{msg} | sum={total}")
`, 'python');
        return result;
      } catch (e) {
        return { error: e.message };
      }
    });
    const pyImportStdout = (pyImportTest.stdout || '').trim();
    testLog('Python imports package module from /shared/lib/python/',
      pyImportStdout.includes('Hello, SciREPL!') && pyImportStdout.includes('sum=42'),
      pyImportStdout || pyImportTest.error);

    // --- Test: Bash write → Python read ---
    const bashWriteTest = await page.evaluate(async () => {
      const km = window.kernelManager;
      try {
        await km.execute('echo "from bash" > /shared/data/bash_output.txt', 'bash');
        const result = await km.execute(`
import sharedfs
print(sharedfs.read_text('/shared/data/bash_output.txt').strip())
`, 'python');
        return result;
      } catch (e) {
        return { error: e.message };
      }
    });
    const bashWriteStdout = (bashWriteTest.stdout || '').trim();
    testLog('Bash write → Python read cross-kernel',
      bashWriteStdout === 'from bash',
      bashWriteStdout || bashWriteTest.error);

    // --- Summary ---
    console.log('\n' + '='.repeat(50));
    const passCount = results.filter(r => r.passed).length;
    console.log(`Results: ${passCount}/${results.length} passed`);
    console.log(allPassed ? '\nPASS: All package system v2 tests passed!' : '\nFAIL: Some tests failed');

  } catch (err) {
    console.error('FATAL:', err.message);
    console.error('Console logs:', consoleLogs.slice(-10).join('\n'));
    allPassed = false;
  } finally {
    await browser.close();
    process.exit(allPassed ? 0 : 1);
  }
})();
