// Playwright test: matplotlib inline backend + R interactive plotly()
import { chromium } from 'playwright';

const TIMEOUT = 180_000;

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  const consoleLogs = [];
  page.on('console', msg => consoleLogs.push(`[${msg.type()}] ${msg.text()}`));
  page.on('pageerror', err => consoleLogs.push(`[PAGE ERROR] ${err.message}`));

  // Accept all confirm dialogs (webR download prompt)
  page.on('dialog', async dialog => {
    if (dialog.type() === 'confirm') {
      await dialog.accept();
    }
  });

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
    });

    await page.goto('http://localhost:8085/', { waitUntil: 'domcontentloaded', timeout: TIMEOUT });

    // Wait for Python
    console.log('   Waiting for Pyodide...');
    await page.waitForFunction(() => {
      const km = window.kernelManager;
      return km && km._instances && km._instances.python && km._instances.python.isReady();
    }, { timeout: TIMEOUT });

    // ── Test: renderImage() exists ──

    console.log('2. Testing renderImage bridge function...');

    const hasRenderImage = await page.evaluate(() => typeof window.renderImage === 'function');
    testLog('renderImage() function exists', hasRenderImage === true);

    // ── Test: Existing plot() still works ──

    console.log('3. Testing existing plot() bridge (no regression)...');

    const plotExists = await page.evaluate(async () => {
      const km = window.kernelManager;
      const pyodide = km.getKernel('python').getPyodide();
      const hasPlot = pyodide.runPython('callable(plot)');
      return hasPlot;
    });
    testLog('Python plot() function exists', plotExists === true);

    // ── Test: matplotlib hook function ──

    console.log('4. Testing matplotlib hook...');

    const hookExists = await page.evaluate(async () => {
      const km = window.kernelManager;
      const pyodide = km.getKernel('python').getPyodide();
      return pyodide.runPython('callable(_setup_matplotlib_hook)');
    });
    testLog('_setup_matplotlib_hook() defined', hookExists === true);

    // ── Test: Install and use matplotlib ──

    console.log('5. Testing matplotlib install + plt.show()...');

    // Install matplotlib via micropip
    const installResult = await page.evaluate(async () => {
      const km = window.kernelManager;
      const pyodide = km.getKernel('python').getPyodide();
      await pyodide.loadPackage('matplotlib');
      return true;
    });
    testLog('matplotlib loaded in Pyodide', installResult === true);

    // Run matplotlib code and check that renderImage was called
    const mplResult = await page.evaluate(async () => {
      // Track renderImage calls
      window._testImages = [];
      const origRenderImage = window.renderImage;
      window.renderImage = function(dataUrl) {
        window._testImages.push(dataUrl);
        origRenderImage(dataUrl);
      };

      const km = window.kernelManager;
      const pyodide = km.getKernel('python').getPyodide();

      // First import triggers hook setup
      await pyodide.runPythonAsync(`
import matplotlib
import matplotlib.pyplot as plt
`);

      // Setup the hook (simulating what executePythonLegacy does)
      pyodide.runPython(`
if 'matplotlib' in __import__('sys').modules and not getattr(__import__('sys').modules.get('matplotlib'), '_scirepl_hooked', False):
    _setup_matplotlib_hook()
    __import__('sys').modules['matplotlib']._scirepl_hooked = True
`);

      // Create a plot and call show()
      await pyodide.runPythonAsync(`
import matplotlib.pyplot as plt
plt.figure(figsize=(4, 3))
plt.plot([1, 2, 3, 4], [1, 4, 2, 3])
plt.title("Test Plot")
plt.show()
`);

      // Restore
      window.renderImage = origRenderImage;

      return {
        imageCount: window._testImages.length,
        hasDataUrl: window._testImages.length > 0 && window._testImages[0].startsWith('data:image/png;base64,')
      };
    });

    testLog('plt.show() generates image',
      mplResult.imageCount >= 1,
      `${mplResult.imageCount} image(s)`);
    testLog('Image is base64 PNG data URL',
      mplResult.hasDataUrl === true,
      mplResult.hasDataUrl ? 'yes' : 'no');

    // ── Test: Multiple figures ──

    console.log('6. Testing multiple matplotlib figures...');

    const multiFig = await page.evaluate(async () => {
      window._testImages = [];
      const origRenderImage = window.renderImage;
      window.renderImage = function(dataUrl) {
        window._testImages.push(dataUrl);
      };

      const km = window.kernelManager;
      const pyodide = km.getKernel('python').getPyodide();

      await pyodide.runPythonAsync(`
import matplotlib.pyplot as plt
plt.figure(1)
plt.plot([1, 2, 3])
plt.figure(2)
plt.plot([3, 2, 1])
plt.show()
`);

      window.renderImage = origRenderImage;
      return window._testImages.length;
    });

    testLog('Multiple figures rendered',
      multiFig >= 2,
      `${multiFig} figure(s)`);

    // ── Test: R kernel plotly() ──

    console.log('7. Testing R plotly() interactive charts...');

    // Init R kernel
    console.log('   Initializing R kernel...');
    await page.evaluate(async () => {
      await window.kernelManager.ensureReady('r');
    });

    // Track renderPlot calls
    const rPlotly = await page.evaluate(async () => {
      window._testPlotlyCalls = [];
      const origRenderPlot = window.renderPlot;
      window.renderPlot = function(jsonStr) {
        window._testPlotlyCalls.push(jsonStr);
        origRenderPlot(jsonStr);
      };

      const km = window.kernelManager;
      const result = await km.execute('plotly(1:10, (1:10)^2, title = "R Plotly Test")', 'r');

      window.renderPlot = origRenderPlot;

      return {
        plotlyCount: window._testPlotlyCalls.length,
        hasJson: window._testPlotlyCalls.length > 0,
        stdout: result.stdout,
        json: window._testPlotlyCalls.length > 0 ? window._testPlotlyCalls[0] : null
      };
    });

    testLog('R plotly() triggers renderPlot',
      rPlotly.plotlyCount >= 1,
      `${rPlotly.plotlyCount} call(s)`);

    if (rPlotly.json) {
      const parsed = JSON.parse(rPlotly.json);
      testLog('R plotly() JSON has x/y data',
        Array.isArray(parsed.x) && Array.isArray(parsed.y) && parsed.x.length === 10,
        `x=${parsed.x.length}, y=${parsed.y.length}`);
      testLog('R plotly() JSON has title',
        parsed.title === 'R Plotly Test',
        parsed.title);
    } else {
      testLog('R plotly() JSON has x/y data', false, 'no JSON captured');
      testLog('R plotly() JSON has title', false, 'no JSON captured');
    }

    testLog('R plotly() markers stripped from stdout',
      !(rPlotly.stdout || '').includes('__SCIREPL_PLOTLY__'),
      (rPlotly.stdout || '').substring(0, 100) || '(empty, correct)');

    // ── Test: R static plot still works ──

    console.log('8. Testing R static plot (no regression)...');

    const rStaticPlot = await page.evaluate(async () => {
      const km = window.kernelManager;
      return await km.execute('plot(1:5)', 'r');
    });
    testLog('R plot() still generates static images',
      rStaticPlot.images && rStaticPlot.images.length > 0,
      rStaticPlot.images ? `${rStaticPlot.images.length} image(s)` : (rStaticPlot.error || 'no images'));

    // ── Test: R mplotly() multi-trace ──

    console.log('9. Testing R mplotly() multi-trace...');

    const rMplotly = await page.evaluate(async () => {
      window._testPlotlyCalls = [];
      const origRenderPlot = window.renderPlot;
      window.renderPlot = function(jsonStr) {
        window._testPlotlyCalls.push(jsonStr);
      };

      const km = window.kernelManager;
      await km.execute(`
mplotly(
  traces = list(
    list(x = 1:5, y = c(1, 4, 9, 16, 25), name = "squares"),
    list(x = 1:5, y = c(1, 8, 27, 64, 125), name = "cubes")
  ),
  title = "Multi-trace"
)`, 'r');

      window.renderPlot = origRenderPlot;

      if (window._testPlotlyCalls.length > 0) {
        const parsed = JSON.parse(window._testPlotlyCalls[0]);
        return {
          called: true,
          traceCount: parsed.traces ? parsed.traces.length : 0,
          title: parsed.title
        };
      }
      return { called: false };
    });

    testLog('R mplotly() renders multi-trace',
      rMplotly.called && rMplotly.traceCount === 2,
      rMplotly.called ? `${rMplotly.traceCount} traces, title="${rMplotly.title}"` : 'not called');

    // --- Summary ---
    console.log('\n' + '='.repeat(50));
    const passCount = results.filter(r => r.passed).length;
    console.log(`Results: ${passCount}/${results.length} passed`);
    console.log(allPassed ? '\nPASS: All plotting tests passed!' : '\nFAIL: Some tests failed');

  } catch (err) {
    console.error('FATAL:', err.message);
    console.error('Console logs:', consoleLogs.slice(-15).join('\n'));
    allPassed = false;
  } finally {
    await browser.close();
    process.exit(allPassed ? 0 : 1);
  }
})();
