// Integration proof for the public graphics lesson, using a fresh workbook.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assets = path.join(root, 'www/help/workbooks/graphics/assets');
const workbook = JSON.parse(readFileSync(path.join(assets, 'workbook-graphics.srwb'), 'utf8'));
const origin = process.env.SCIREPL_TEST_BASE || process.env.HELP_TEST_ORIGIN || 'http://localhost:8085';
assert.deepEqual(workbook.notebook.cells.map(c => c.name), ['static_axes', 'embedded_png', 'canvas_axes', 'math_axes']);
assert(workbook.notebook.cells.every(c => !c.lastOutputHtml && !c.lastOutput));
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
const external = [], errors = [];
await context.route('**/*', route => {
  if (new URL(route.request().url()).origin !== new URL(origin).origin) {
    external.push(route.request().url());
    return route.abort();
  }
  return route.continue();
});
await context.addInitScript(() => {
  localStorage.setItem('scirepl_privacy_accepted', '1');
  localStorage.setItem('scirepl_onboarding_seen', '1');
  localStorage.setItem('scirepl_default_language', 'javascript');
  // Deliberately enable it: SRWB still must not execute the code on import.
  localStorage.setItem('scirepl_auto_execute', '1');
  addEventListener('DOMContentLoaded', () => {
    if (window.KERNEL_CONFIG?.app?.version) localStorage.setItem('scirepl_whats_new_seen_version', window.KERNEL_CONFIG.app.version);
  }, { once: true });
});
const page = await context.newPage();
page.on('pageerror', e => errors.push(e.message));
page.on('dialog', dialog => dialog.dismiss());
let count = 0;
const check = (label, value) => { assert(value, label); count++; console.log(`PASS: ${label}`); };
try {
  await page.goto(origin + '/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__SCIREPL_APP_READY && window.fileIO && window.notebookManager);
  const before = await page.evaluate(() => window.notebookManager.getNotebooks().length);
  await page.evaluate(w => window.fileIO.importSrwb(JSON.stringify(w)), workbook);
  check('Import preserves existing tabs', await page.evaluate(() => window.notebookManager.getNotebooks().length) === before + 1);
  check('Four cells import in order', await page.evaluate(() => window._cells.map(c => c.name).join(',')) === workbook.notebook.cells.map(c => c.name).join(','));
  check('Static SVG appears without executing code', await page.locator('.repl-container:visible .card-body svg[role="img"]').count() === 1);
  const png = page.locator('.repl-container:visible img[alt="Paper axes"]');
  await png.evaluate(img => img.decode());
  check('Embedded Markdown PNG loads at its intended dimensions', await png.evaluate(img => img.naturalWidth === 360 && img.naturalHeight === 220));
  await page.setViewportSize({ width: 320, height: 844 });
  check('Embedded PNG fits the Markdown cell at 320 CSS pixels', await png.evaluate(img => img.getBoundingClientRect().right <= img.parentElement.getBoundingClientRect().right));
  check('Static SVG fits the Markdown cell at 320 CSS pixels', await page.locator('.repl-container:visible .card-body svg[role="img"]').evaluate(svg => svg.getBoundingClientRect().right <= svg.parentElement.getBoundingClientRect().right));
  await page.setViewportSize({ width: 390, height: 844 });
  check('Both equations render without errors', await page.locator('.repl-container:visible .katex').count() === 2 && await page.locator('.repl-container:visible .katex-error').count() === 0);
  check('Code is not run on SRWB import, even with auto-execute on', await page.evaluate(() => !window._cells[2].outputCard));
  // Exercise the real saved-cell pencil and Run controls rather than a stub.
  await page.locator('.repl-container:visible .card-input[data-cell-id="3"] .cell-edit-btn').click();
  await page.locator('.repl-container:visible .card-input[data-cell-id="3"] .cell-edit-actions .cell-run-btn').click();
  await page.waitForFunction(() => !!window._cells[2].outputCard?.querySelector('img'));
  check('JavaScript Run generates a PNG output', await page.evaluate(() => window._cells[2].outputCard.querySelector('img').src.startsWith('data:image/png;base64,')));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__SCIREPL_APP_READY && window._cells?.length === 4);
  check('Current local persistence restores a saved JavaScript picture on relaunch', await page.evaluate(() => !!window._cells[2].outputCard?.querySelector('img')));
  check('Local persistence retains all source cells unchanged', await page.evaluate(() => window._cells.map(c => c.code)).then(codes => codes.every((code, i) => code === workbook.notebook.cells[i].code)));
  if (process.argv.includes('--capture')) {
    const shots = [['static', 0], ['canvas', 2], ['equations', 3]];
    for (const [name, index] of shots) {
      await page.evaluate(index => {
        document.activeElement?.blur();
        window.scrollTo({ top: 0, behavior: 'instant' });
        const repl = window.notebookManager.getActiveNotebook().replContainer;
        const target = window._cells[index].type === 'markdown'
          ? window._cells[index].inputCard : window._cells[index].outputCard;
        repl.scrollTo({ top: repl.scrollTop + target.getBoundingClientRect().top
          - repl.getBoundingClientRect().top - 8, behavior: 'instant' });
      }, index);
      await page.waitForTimeout(150);
      await page.screenshot({ path: path.join(assets, `browser-graphics-${name}.png`) });
    }
    // This is generated capture metadata, not a hand-written test result.
    writeFileSync(path.join(assets, 'capture-receipt.json'), JSON.stringify({
      capturedAt: new Date().toISOString(), platform: 'Chromium browser, not Android',
      viewport: { width: 390, height: 844 },
      app: await page.evaluate(() => window.KERNEL_CONFIG.app),
      workbookSha256: createHash('sha256').update(readFileSync(path.join(assets, 'workbook-graphics.srwb'))).digest('hex'),
      imagesUnmodified: true, limits: ['Free browser build only; no Android or Pro verification in these captures'],
      files: shots.map(([name]) => ({ file: `browser-graphics-${name}.png`,
        sha256: createHash('sha256').update(readFileSync(path.join(assets, `browser-graphics-${name}.png`))).digest('hex') }))
    }, null, 2) + '\n');
  }
  const exported = await page.evaluate(async () => {
    let result;
    const original = window.fileIO.downloadFile;
    window.fileIO.downloadFile = async (name, content) => { result = content; };
    try { await window.fileIO._exportSrwb('current'); } finally { window.fileIO.downloadFile = original; }
    return JSON.parse(result);
  });
  check('Current SRWB export includes generated image output', exported.notebook.cells[2].lastOutputHtml.includes('data:image/png;base64,'));
  check('Export keeps every source byte', exported.notebook.cells.every((c, i) => c.code === workbook.notebook.cells[i].code));
  await page.evaluate(w => window.fileIO.importSrwb(JSON.stringify(w)), exported);
  check('Ordinary reimport drops code output but not its source', await page.evaluate(() => !window._cells[2].outputCard && !!window._cells[2].code));
  check('Reimport restores static SVG from Markdown', await page.locator('.repl-container:visible .card-body svg[role="img"]').count() === 1);
  await page.locator('.repl-container:visible img[alt="Paper axes"]').evaluate(img => img.decode());
  check('Reimport restores embedded PNG from Markdown', await page.locator('.repl-container:visible img[alt="Paper axes"]').count() === 1);
  check('Reimport restores both equations from Markdown', await page.locator('.repl-container:visible .katex').count() === 2);
  check('No external network request needed', external.length === 0);
  check('No page errors', errors.length === 0);
  console.log(`PASS: ${count} workbook graphics checks`);
} finally {
  await browser.close();
}
