// Real cold Pyodide + app Run regressions. Never installs a plotting hook or
// pre-imports pyplot from the test. Network scenarios use the app's supported
// exact-version CDN source override, not partial-vendor package-response mocks.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = { window: {} };
runInNewContext(readFileSync(path.join(ROOT, 'www/js/kernel_config.js'), 'utf8'), config);
const python = config.window.KERNEL_CONFIG.languages.python;
const cdn = python.sources.find(source => source.type === 'cdn' && source.url.includes('cdn.jsdelivr.net/')).url;
const BASE = process.env.SCIREPL_TEST_BASE || `http://localhost:${process.env.PORT || 8085}/`;
const TIMEOUT = 180_000;
const focused = process.argv.includes('--focused');
const profiles = focused ? [{ width: 412, height: 915 }] : [{ width: 412, height: 915 }, { width: 915, height: 412 }];
const scenarios = focused ? ['ordinary', 'micropip'] : ['ordinary', 'micropip', 'pip'];
const plot = 'import os\nos.chdir("/tmp")\nimport matplotlib.pyplot as plt\nplt.plot([0,1,2,3,4,5], [0,1,4,9,16,25])\nplt.title("squares")\nplt.show()\nprint("SCIREPL_MPL_DONE")';
const failures = [];
let checks = 0;
const check = (name, condition, detail) => { checks++; assert.ok(condition, `${name}${detail === undefined ? '' : ': ' + JSON.stringify(detail)}`); };
const bounded = async (promise, label) => {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} exceeded ${TIMEOUT}ms`)), TIMEOUT); })]); }
  finally { clearTimeout(timer); }
};

for (const viewport of profiles) for (const scenario of scenarios) {
  const label = `${scenario} ${viewport.width}x${viewport.height}`;
  console.log(`Matplotlib cold Run: ${label}`);
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport, isMobile: true, hasTouch: true, locale: 'en-US' });
    await context.addInitScript(({ source }) => {
      localStorage.setItem('scirepl_privacy_accepted', '1');
      localStorage.setItem('scirepl_onboarding_seen', '1');
      localStorage.setItem('scirepl_auto_download', '1');
      if (source) localStorage.setItem('scirepl_python_source', source);
      addEventListener('DOMContentLoaded', () => localStorage.setItem('scirepl_whats_new_seen_version', window.KERNEL_CONFIG.app.version), { once: true });
    }, { source: scenario === 'pip' ? null : cdn });
    const page = await context.newPage();
    page.setDefaultTimeout(TIMEOUT);
    const errors = [];
    const matplotlibDownloads = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (/matplotlib.*\.(?:whl|tar)/i.test(request.url())) matplotlibDownloads.push(request.url()); });
    page.on('dialog', dialog => dialog.type() === 'confirm' ? dialog.accept() : dialog.dismiss());
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.i18n && window.kernelManager && window._appInternals);
    await bounded(page.evaluate(async () => {
      await window.i18n.init();
      localStorage.setItem(KernelManager.PRIVACY_POLICY_REVISION_KEY, KernelManager.PRIVACY_POLICY_REVISION);
      await window.kernelManager.ensureReady('python');
      // Do not return the kernel/Pyodide object across Playwright's transport.
    }), `${label} Python readiness`);
    const startup = await page.evaluate(() => {
      window._matplotlibStaticMedia = new Set(document.querySelectorAll('canvas,img'));
      const p = window.kernelManager.getKernel('python').getPyodide();
      return { version: p.version, imported: p.runPython('"matplotlib" in __import__("sys").modules'), pyplot: p.runPython('"matplotlib.pyplot" in __import__("sys").modules') };
    });
    check('startup uses pinned Pyodide', startup.version === python.version, startup);
    check('startup does not eagerly import matplotlib/pyplot', !startup.imported && !startup.pyplot, startup);
    check('startup does not download matplotlib', matplotlibDownloads.length === 0, matplotlibDownloads);
    console.log(`  PASS lazy startup ${label}: ${JSON.stringify(startup)}`);
    if (scenario === 'ordinary') {
      const install = await bounded(page.evaluate(async () => {
        const p = window.kernelManager.getKernel('python').getPyodide();
        // Full official distribution, real wheel installation only. The app's
        // healing helper imports lockfile module entries including pylab, which
        // would prewarm pyplot and invalidate this cold-import precondition.
        await p.loadPackage('matplotlib');
        return { loaded: !!p.loadedPackages.matplotlib, pyplot: p.runPython('"matplotlib.pyplot" in __import__("sys").modules') };
      }), `${label} plotting package delivery`);
      check('ordinary package delivery does not prewarm pyplot', install.loaded && !install.pyplot, install);
    }

    const inspect = async id => page.evaluate(id => {
      const card = document.querySelector(`.card-output[data-cell-id="${id}"]`);
      const images = [...(card?.querySelectorAll('.card-body img') || [])];
      const detached = [...document.querySelectorAll('canvas,img')].filter(element => !element.closest('.card-output') && !window._matplotlibStaticMedia.has(element));
      const p = window.kernelManager.getKernel('python').getPyodide();
      return {
        id, text: card?.querySelector('.card-body')?.textContent || '', error: card?.classList.contains('card-error') || false,
        images: images.map(img => ({ png: img.src.startsWith('data:image/png;base64,'), loaded: img.complete && img.naturalWidth > 0, left: img.getBoundingClientRect().left, right: img.getBoundingClientRect().right, owner: img.closest('.card-output')?.dataset.cellId })),
        detached: detached.map(element => ({ tag: element.tagName, id: element.id, width: element.getBoundingClientRect().width })),
        width: document.documentElement.scrollWidth, viewport: document.documentElement.clientWidth,
        figures: p.runPython('len(plt.get_fignums())'),
      };
    }, String(id));
    const assertOutput = async (id, count, name) => {
      await page.locator(`.card-output[data-cell-id="${id}"] img`).evaluateAll(async images => { await Promise.all(images.map(image => image.decode())); });
      const result = await inspect(id);
      check(`${name}: no execution error`, !result.error, result);
      check(`${name}: exact inline PNG count/ownership`, result.images.length === count && result.images.every(image => image.png && image.loaded && image.owner === String(id)), result);
      check(`${name}: no detached plot media`, result.detached.length === 0, result);
      check(`${name}: no viewport overflow`, result.width <= result.viewport + 1 && result.images.every(image => image.left >= -1 && image.right <= result.viewport + 1), result);
      check(`${name}: figures closed after show`, result.figures === 0, result);
      return result;
    };
    const run = async code => {
      const before = await page.evaluate(() => window._cells.length);
      await page.locator('#lang-selector').selectOption('python');
      await page.locator('#code-input').fill(code);
      await page.locator('#run-btn').click();
      await page.waitForFunction(before => window._cells.length === before + 1 && window._currentOutputCard === null && !document.getElementById('run-btn').disabled, before);
      return page.evaluate(() => window._cells.at(-1).id);
    };
    const firstCode = scenario === 'ordinary' ? plot : scenario === 'micropip'
      ? `import micropip\nawait micropip.install("matplotlib")\n${plot}`
      : `%pip install matplotlib\n${plot}`;
    const first = await run(firstCode);
    const firstResult = await assertOutput(first, 1, 'first cold Run');
    check('first Run reached the Python completion marker', firstResult.text.includes('SCIREPL_MPL_DONE'), firstResult);
    console.log(`  PASS cold first plot ${label}: ${JSON.stringify(firstResult)}`);

    const repeated = await run('plt.show()\nprint("SCIREPL_MPL_REPEAT_EMPTY")');
    await assertOutput(repeated, 0, 'repeat show without new figures');
    const multiple = await run('plt.figure()\nplt.plot([1,2],[3,4])\nplt.figure()\nplt.plot([1,2],[4,3])\nplt.show()\nprint("SCIREPL_MPL_MULTI")');
    await assertOutput(multiple, 2, 'multiple figures');
    const deferred = await run('plt.figure()\nplt.plot([1,2],[2,1])\nprint("SCIREPL_MPL_DEFERRED")');
    const deferredState = await inspect(deferred);
    check('no-show cell keeps its figure without an image/detached media', deferredState.images.length === 0 && deferredState.figures === 1 && deferredState.detached.length === 0, deferredState);
    const later = await run('plt.show()\nprint("SCIREPL_MPL_LATER_SHOW")');
    await assertOutput(later, 1, 'later explicit show');
    const savedFigure = await run('fig = plt.figure()\nplt.plot([1,2],[2,3])\nplt.show()\nfig.savefig("/tmp/scirepl-first-show.png")\nprint("SCIREPL_MPL_SAVEFIG_DONE")');
    await assertOutput(savedFigure, 1, 'savefig with retained Figure after show');
    const signature = await page.evaluate(() => Array.from(window.kernelManager.getKernel('python').getPyodide().FS.readFile('/tmp/scirepl-first-show.png').slice(0, 8)));
    check('retained Figure savefig writes an actual PNG', JSON.stringify(signature) === '[137,80,78,71,13,10,26,10]', signature);
    const direct = await bounded(page.evaluate(async code => {
      const id = 'matplotlib-direct-kernel';
      window._currentOutputCard = window._appInternals.createOutputCard(id, 'code');
      try {
        const result = await window.kernelManager.execute(code, 'python');
        return { id, error: result.error || null };
      } finally { window._currentOutputCard = null; }
    }, plot), `${label} direct Python kernel execution`);
    check('direct kernel execution succeeds', !direct.error, direct);
    await assertOutput(direct.id, 1, 'direct kernel execution');
    // Actual reload includes the app's normal beforeunload save. An early
    // in-memory storage snapshot is not evidence of a relaunch failure.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(code => window._cells?.some(cell => cell.code === code && cell.outputCard?.querySelector('img')), firstCode);
    const persisted = await page.evaluate(code => {
      const state = JSON.parse(localStorage.getItem(window.sessionManager.STORAGE_KEY));
      return (state?.cells || []).find(cell => cell.code === code)?.lastOutputHtml || '';
    }, firstCode);
    check('first plot is persisted by the ordinary Run/save flow', persisted.includes('data:image/png;base64,'));
    const restored = await page.evaluate(async code => {
      const card = window._cells.find(cell => cell.code === code).outputCard;
      const images = [...card.querySelectorAll('img')];
      await Promise.all(images.map(image => image.decode()));
      return { count: images.length, png: images.every(image => image.src.startsWith('data:image/png;base64,') && image.naturalWidth > 0), detached: [...document.querySelectorAll('canvas')].filter(element => !element.closest('.card-output')).length, width: document.documentElement.scrollWidth, viewport: document.documentElement.clientWidth };
    }, firstCode);
    check('saved first plot reloads as one inline PNG without rerunning Python', restored.count === 1 && restored.png && restored.detached === 0 && restored.width <= restored.viewport + 1, restored);
    check('no uncaught browser errors', errors.length === 0, errors);
    console.log(`  PASS repeat/multiple/deferred show ${label}`);
  } catch (error) {
    failures.push(`${label}: ${error.stack || error}`);
    console.error(`  FAIL ${label}: ${error.message}`);
  } finally { if (browser) await browser.close(); }
}
console.log(`Matplotlib first-show: ${checks} checks; ${scenarios.length * profiles.length} cold profiles; ${failures.length} failed.`);
if (failures.length) { console.error(failures.join('\n')); process.exitCode = 1; }
