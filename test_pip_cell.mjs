// Playwright test: %pip CELL semantics in app.js — failed installs stop the
// cell (no Python tail runs), the lock heals dependencies of roots that are
// already installed, and none of it needs the CDN: three tiny fixture wheels
// are built locally and a fixture lockfile is injected as the "CDN" lock.
//
// Live complement (RUN_LIVE_CDN=1): the real partial-Bokeh scenario — load
// only bokeh's own wheel, then ensurePyodidePackage must pull jinja2/pandas/
// xyzservices etc. from the real lock and make bokeh.embed/io/plotting work.
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';

const TIMEOUT = 180_000;
const BASE = 'http://localhost:8085';
const FIXDIR = new URL('./www/test_fixtures/wheels/', import.meta.url).pathname;
const RUN_LIVE = process.env.RUN_LIVE_CDN === '1';

// ---- build fixture wheels (python3 zipfile; proper RECORD hashes) ----
function buildWheels() {
  mkdirSync(FIXDIR, { recursive: true });
  execFileSync('python3', ['-c', `
import os, zipfile, base64, hashlib, csv, io, sys
dest = sys.argv[1]
def build(dist, ver, mod, code):
    name = f"{dist.replace('-','_')}-{ver}"
    files = {
        f"{mod}/__init__.py": code,
        f"{name}.dist-info/METADATA": f"Metadata-Version: 2.1\\nName: {dist}\\nVersion: {ver}\\n",
        f"{name}.dist-info/WHEEL": "Wheel-Version: 1.0\\nGenerator: scirepl-test\\nRoot-Is-Purelib: true\\nTag: py3-none-any\\n",
    }
    rows = []
    with zipfile.ZipFile(os.path.join(dest, f"{name}-py3-none-any.whl"), "w", zipfile.ZIP_DEFLATED) as z:
        for path, content in files.items():
            z.writestr(path, content)
            digest = base64.urlsafe_b64encode(hashlib.sha256(content.encode()).digest()).rstrip(b"=").decode()
            rows.append((path, f"sha256={digest}", str(len(content.encode()))))
        rows.append((f"{name}.dist-info/RECORD", "", ""))
        buf = io.StringIO(); csv.writer(buf).writerows(rows)
        z.writestr(f"{name}.dist-info/RECORD", buf.getvalue())
build("fixture-depa", "1.0.0", "fixture_depa", "VALUE = 'depa'\\n")
build("fixture-depb", "1.0.0", "fixture_depb", "VALUE = 'depb'\\n")
build("fixture-root", "1.0.0", "fixture_root",
      "import fixture_depa, fixture_depb\\nVALUE = 'root'\\n")
build("fixture-badimport", "1.0.0", "fixture_badimport",
      "import fixture_missing_dep\\nVALUE = 'bad'\\n")
build("fixture-diffname", "1.0.0", "fdn_module", "VALUE = 'diffname'\\n")
`, FIXDIR]);
}

// Fixture "CDN" lock. The root's lock version (0.9.0) is DELIBERATELY older
// than the installed wheel (1.0.0): when the lock serves as a dependency
// graph for an installed root, its root version must not be re-applied.
const FIXTURE_LOCK = {
  packages: {
    'fixture-root': { name: 'fixture-root', version: '0.9.0', depends: ['fixture-depa', 'fixture-depb'],
      imports: ['fixture_root'], file_name: `${BASE}/test_fixtures/wheels/fixture_root-1.0.0-py3-none-any.whl` },
    'fixture-depa': { name: 'fixture-depa', version: '1.0.0', depends: [],
      imports: ['fixture_depa'], file_name: `${BASE}/test_fixtures/wheels/fixture_depa-1.0.0-py3-none-any.whl` },
    'fixture-depb': { name: 'fixture-depb', version: '1.0.0', depends: [],
      imports: ['fixture_depb'], file_name: `${BASE}/test_fixtures/wheels/fixture_depb-1.0.0-py3-none-any.whl` },
    'fixture-broken': { name: 'fixture-broken', version: '1.0.0', depends: [],
      imports: ['fixture_broken'], file_name: `${BASE}/test_fixtures/wheels/does_not_exist-1.0.0-py3-none-any.whl` },
  },
};

(async () => {
  buildWheels();
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
    results.push({ name, passed });
    console.log(`  [${mark}] ${name}${detail ? ': ' + String(detail).trim().slice(0, 160) : ''}`);
  };

  // every CDN request is a determinism failure in the fixture sections
  const cdnRequests = [];
  page.on('request', r => { if (r.url().includes('cdn.jsdelivr.net')) cdnRequests.push(r.url()); });

  try {
    console.log('1. Navigating to SciREPL...');
    const context = browser.contexts()[0];
    await context.addInitScript(() => {
      localStorage.setItem('scirepl_privacy_accepted', '1');
      localStorage.setItem('scirepl_onboarding_seen', '1');
      localStorage.setItem('scirepl_auto_download', '1');
      addEventListener('DOMContentLoaded', () => localStorage.setItem(
          'scirepl_whats_new_seen_version', window.KERNEL_CONFIG.app.version), { once: true });
    });
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
    console.log('   Waiting for Pyodide...');
    await page.evaluate(() => { window.kernelManager.ensureReady('python'); });
    await page.waitForFunction(() => {
      const km = window.kernelManager;
      return km && km.getKernel('python') && km.getKernel('python').isReady();
    }, null, { timeout: TIMEOUT });

    // Inject the fixture lock BEFORE anything asks for the CDN one.
    await page.evaluate((lock) => { window._pyodideCdnLock = lock; }, FIXTURE_LOCK);
    const cdnBaselineAfterBoot = cdnRequests.length;   // kernel boot may touch CDN; the tests below must not

    // helper: run one cell through the real input-bar %pip path
    const runCell = async (code, waitFor) => await page.evaluate(async ({ code, waitFor }) => {
      const input = document.getElementById('code-input');
      const runBtn = document.getElementById('run-btn');
      const langSel = document.getElementById('lang-selector');
      langSel.value = 'python';
      langSel.dispatchEvent(new Event('change'));
      const cellsBefore = window._cells.length;
      input.value = code;
      input.dispatchEvent(new Event('input'));
      runBtn.click();
      await new Promise((resolve) => {
        const t0 = Date.now();
        const check = () => {
          const cell = window._cells[window._cells.length - 1];
          const text = (window._cells.length > cellsBefore && cell.outputCard)
            ? cell.outputCard.textContent : '';
          if (text.includes(waitFor) || Date.now() - t0 > 60000) resolve();
          else setTimeout(check, 250);
        };
        check();
      });
      await new Promise(r => setTimeout(r, 1500));   // let any (wrong) tail output land
      const cell = window._cells[window._cells.length - 1];
      return cell.outputCard ? cell.outputCard.textContent : '';
    }, { code, waitFor });

    // ---- 2. Dependency healing for an ALREADY-INSTALLED root ----
    console.log('2. Partial install: root wheel only, deps healed from the lock...');
    const partial = await page.evaluate(async (rootUrl) => {
      const pyodide = window.kernelManager.getKernel('python').getPyodide();
      await pyodide.loadPackage(rootUrl);              // root ONLY — like a partial Bokeh
      pyodide.runPython('import importlib; importlib.invalidate_caches()');
      const before = {
        rootMeta: pyodide.runPython(`__import__('importlib.metadata', fromlist=['metadata']).version('fixture-root')`),
        depaLoaded: Object.keys(pyodide.loadedPackages).some(k => k.includes('depa')),
      };
      const r = await window.ensurePyodidePackage('fixture-root>=1.0');
      let imports = null;
      try {
        imports = pyodide.runPython(
          `import fixture_root, fixture_depa, fixture_depb; fixture_depa.VALUE + '/' + fixture_depb.VALUE`);
      } catch (e) { imports = 'IMPORT FAILED: ' + e.message; }
      return {
        before, ok: r.ok, message: r.message || '',
        rootVersion: pyodide.runPython(`__import__('importlib.metadata', fromlist=['metadata']).version('fixture-root')`),
        imports,
      };
    }, FIXTURE_LOCK.packages['fixture-root'].file_name);
    testLog('root wheel alone left deps missing (precondition)', partial.before.rootMeta === '1.0.0' && !partial.before.depaLoaded);
    testLog('ensurePyodidePackage(root>=1.0) succeeds for installed root', partial.ok === true, partial.message);
    testLog('missing lock deps were loaded and import', partial.imports === 'depa/depb', partial.imports);
    testLog("lock's older root version (0.9.0) NOT re-applied to installed 1.0.0", partial.rootVersion === '1.0.0');

    // ---- 3. Null-prototype lock indexes in the live path ----
    console.log('3. Requirement named like Object.prototype members...');
    const proto = await page.evaluate(async () => {
      const r = await window.ensurePyodidePackage('constructor');
      return { ok: r.ok, message: r.message || '' };
    });
    testLog("'constructor' fails cleanly (no inherited lock hit)", proto.ok === false && !proto.message.includes('undefined'), proto.message);

    // ---- 3b. Installed metadata is NOT verification ----
    console.log('3b. Installed-but-broken and differing-import-name distributions...');
    // both wheels are absent from the fixture lock: verification must rely
    // on INSTALLED metadata (packages_distributions/top_level.txt), and an
    // installed distribution whose module cannot import must FAIL.
    const metaPre = await page.evaluate(async (urls) => {
      const pyodide = window.kernelManager.getKernel('python').getPyodide();
      await pyodide.loadPackage(urls);
      pyodide.runPython('import importlib; importlib.invalidate_caches()');
      return pyodide.runPython(`__import__('importlib.metadata', fromlist=['metadata']).version('fixture-badimport')`);
    }, [
      `${BASE}/test_fixtures/wheels/fixture_badimport-1.0.0-py3-none-any.whl`,
      `${BASE}/test_fixtures/wheels/fixture_diffname-1.0.0-py3-none-any.whl`,
    ]);
    testLog('broken fixture installed, metadata says 1.0.0 (precondition)', metaPre === '1.0.0');
    const badEnsure = await page.evaluate(async () => await window.ensurePyodidePackage('fixture-badimport'));
    testLog('installed metadata + failing import -> ok:false (never "verified")',
      badEnsure.ok === false && /failed verification|No module named/.test(badEnsure.message || ''), badEnsure.message);
    const t6 = await runCell('%pip install fixture-badimport\nprint("AFTER_RAN6")', 'not executed');
    testLog('installed-but-broken distribution FAILS the cell', t6.includes('the rest of this cell was not executed'), t6.slice(-160));
    testLog('installed-but-broken: AFTER_RAN6 did not run', !t6.includes('AFTER_RAN6'));
    const diffName = await page.evaluate(async () => {
      const r = await window.ensurePyodidePackage('fixture-diffname');
      const pyodide = window.kernelManager.getKernel('python').getPyodide();
      let mod;
      try { mod = pyodide.runPython('import fdn_module; fdn_module.VALUE'); } catch (e) { mod = 'IMPORT FAILED'; }
      return { ok: r.ok, mod, message: r.message || '' };
    });
    testLog('import name differing from distribution name is DISCOVERED and verifies',
      diffName.ok === true && diffName.mod === 'diffname', JSON.stringify(diffName));

    // ---- 4. Failed verification stops the cell (AFTER_RAN family) ----
    console.log('4. Failed install must stop the cell...');
    const t1 = await runCell('%pip install matplotlib==0.0.1\nprint("AFTER_RAN")', 'not executed');
    testLog('unsatisfiable pin: cell reports failure', t1.includes('the rest of this cell was not executed'), t1.slice(-160));
    testLog('unsatisfiable pin: AFTER_RAN did not run', !t1.includes('AFTER_RAN'));

    const t2 = await runCell('%pip install fixture-root==0.0.1\nprint("AFTER_RAN2")', 'not executed');
    testLog('incompatible INSTALLED version (1.0.0 vs ==0.0.1): cell fails', t2.includes('the rest of this cell was not executed'), t2.slice(-160));
    testLog('incompatible installed version: AFTER_RAN2 did not run', !t2.includes('AFTER_RAN2'));

    const t3 = await runCell('%pip install -r requirements.txt\nprint("AFTER_RAN3")', 'not executed');
    testLog('malformed line (-r): cell fails', t3.includes('the rest of this cell was not executed'));
    testLog('malformed line: AFTER_RAN3 did not run', !t3.includes('AFTER_RAN3'));
    testLog('malformed line: nothing was installed from it', t3.includes('nothing on this line was installed'));

    const t4 = await runCell('%pip install pkg>=1,,<4\nprint("AFTER_RAN4")', 'not executed');
    testLog('empty specifier clause: cell fails', t4.includes('the rest of this cell was not executed'));
    testLog('empty specifier clause: AFTER_RAN4 did not run', !t4.includes('AFTER_RAN4'));

    const t5 = await runCell('%pip install fixture-broken\nprint("AFTER_RAN5")', 'not executed');
    testLog('dependency-verification failure (404 wheel): cell fails', t5.includes('the rest of this cell was not executed'), t5.slice(-160));
    testLog('dependency-verification failure: AFTER_RAN5 did not run', !t5.includes('AFTER_RAN5'));

    const tOk = await runCell('%pip install fixture-depa\nprint("TAIL_OK")', 'TAIL_OK');
    testLog('control: a SUCCESSFUL install still runs the tail', tOk.includes('TAIL_OK'), tOk.slice(-160));

    testLog('deterministic sections made ZERO CDN requests',
      cdnRequests.length === cdnBaselineAfterBoot,
      cdnRequests.slice(cdnBaselineAfterBoot).join(', ') || 'none');

    // ---- 5. Live partial-Bokeh regression (RUN_LIVE_CDN=1) ----
    if (RUN_LIVE) {
      console.log('5. LIVE: partial Bokeh heals from the real CDN lock (slow)...');
      const bokeh = await page.evaluate(async () => {
        const pyodide = window.kernelManager.getKernel('python').getPyodide();
        delete window._pyodideCdnLock;                 // use the real CDN lock
        const cdnBase = `https://cdn.jsdelivr.net/pyodide/v${pyodide.version}/full/`;
        const lock = await (await fetch(cdnBase + 'pyodide-lock.json')).json();
        const entry = lock.packages.bokeh;
        if (!entry) return { skip: 'bokeh not in this lock' };
        await pyodide.loadPackage(cdnBase + entry.file_name);   // ONLY bokeh's wheel
        pyodide.runPython('import importlib; importlib.invalidate_caches()');
        const r = await window.ensurePyodidePackage('bokeh');
        const loaded = Object.keys(pyodide.loadedPackages).map(s => s.toLowerCase());
        let imports = null;
        try {
          imports = pyodide.runPython(`import bokeh.embed, bokeh.io, bokeh.plotting; 'ok'`);
        } catch (e) { imports = 'IMPORT FAILED: ' + e.message.slice(0, 300); }
        return { ok: r.ok, message: r.message || '', loaded, imports };
      });
      if (bokeh.skip) {
        testLog('live bokeh: skipped', true, bokeh.skip);
      } else {
        testLog('live bokeh: ensurePyodidePackage ok', bokeh.ok === true, bokeh.message);
        for (const dep of ['jinja2', 'pandas', 'xyzservices']) {
          testLog(`live bokeh: lock dependency '${dep}' loaded`, bokeh.loaded.some(k => k.includes(dep)));
        }
        testLog('live bokeh: bokeh.embed/io/plotting import', bokeh.imports === 'ok', bokeh.imports);
      }
      console.log('   LIVE: matplotlib already loaded, then ==0.0.1 must still stop the cell...');
      const live2pre = await page.evaluate(async () => {
        const r = await window.ensurePyodidePackage('matplotlib');
        return r.ok;
      });
      testLog('live: real matplotlib installed (precondition)', live2pre === true);
      const live2 = await runCell('%pip install matplotlib==0.0.1\nprint("AFTER_RAN_LIVE")', 'not executed');
      testLog('live: loaded matplotlib + ==0.0.1 pin fails the cell',
        live2.includes('the rest of this cell was not executed') && !live2.includes('AFTER_RAN_LIVE'), live2.slice(-160));
    } else {
      console.log('5. LIVE section skipped (set RUN_LIVE_CDN=1 to enable).');
    }

    console.log('\n' + '='.repeat(50));
    const passCount = results.filter(r => r.passed).length;
    console.log(`Results: ${passCount}/${results.length} passed`);
    console.log(allPassed ? '\nPASS: All %pip cell tests passed!' : '\nFAIL: Some %pip cell tests failed');
  } catch (err) {
    console.error('FATAL:', err.message);
    console.error('Console logs:', consoleLogs.slice(-15).join('\n'));
    allPassed = false;
  } finally {
    rmSync(new URL('./www/test_fixtures/', import.meta.url).pathname, { recursive: true, force: true });
    await browser.close();
    process.exit(allPassed ? 0 : 1);
  }
})();
