// Run the tutorial through real saved-cell controls in a fresh browser profile.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assets = path.join(root, 'www/help/workbooks/named-cells/assets');
const file = path.join(assets, 'named-cell-interop.srwb');
const workbook = JSON.parse(readFileSync(file, 'utf8'));
const names = ['intro', 'numbers', 'inspect_cells', 'write_shared', 'read_shared', 'generate_report', 'bash_report', 'python_total'];
assert.deepEqual(workbook.notebook.cells.map(c => c.name), names);
assert(workbook.notebook.cells.every(c => !c.lastOutput && !c.lastOutputHtml));
const origin = process.env.SCIREPL_TEST_BASE || process.env.HELP_TEST_ORIGIN || 'http://localhost:8085';
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
  // Import must not execute any of this code even with the setting enabled.
  localStorage.setItem('scirepl_auto_execute', '1');
  addEventListener('DOMContentLoaded', () => {
    if (window.KERNEL_CONFIG?.app?.version) localStorage.setItem('scirepl_whats_new_seen_version', window.KERNEL_CONFIG.app.version);
  }, { once: true });
});
const page = await context.newPage();
page.on('pageerror', e => errors.push(e.message));
page.on('dialog', dialog => dialog.dismiss());
let count = 0;
const checks = [];
const check = (label, value) => { assert(value, label); count++; checks.push(label); console.log(`PASS: ${label}`); };
const currentCell = name => page.evaluate(name => {
  const c = window._cells.find(c => c.name === name);
  return c && { id: c.id, code: c.code, output: c.lastOutput || '', outputShown: !!c.outputCard };
}, name);
const card = async name => {
  const c = await currentCell(name);
  assert(c, `Missing cell ${name}`);
  return page.locator(`.repl-container:visible .card-input[data-cell-id="${c.id}"]`);
};
const run = async (name, expected, code) => {
  const input = await card(name);
  if (!await input.locator('.cell-editor').count()) await input.locator('.cell-edit-btn').click();
  if (code !== undefined) await input.locator('.cell-editor').fill(code);
  await input.locator('.cell-edit-actions .cell-run-btn').click();
  await page.waitForFunction(({ name, expected }) => {
    const cell = window._cells.find(c => c.name === name);
    return !!cell?.lastOutput?.includes(expected) && !document.getElementById('run-btn').disabled;
  }, { name, expected }, { timeout: 180000 });
  const result = await currentCell(name);
  assert(!await page.locator(`.repl-container:visible .card-output[data-cell-id="${result.id}"].card-error`).count(), `${name} failed`);
  return result;
};
const shots = [];
const capture = async (name, target) => {
  if (!process.argv.includes('--capture')) return;
  if (target) await page.evaluate(name => {
    document.activeElement?.blur();
    window.scrollTo({ top: 0, behavior: 'instant' });
    const repl = window.notebookManager.getActiveNotebook().replContainer;
    const cell = window._cells.find(c => c.name === name);
    repl.scrollTo({ top: repl.scrollTop + cell.inputCard.getBoundingClientRect().top
      - repl.getBoundingClientRect().top - 8, behavior: 'instant' });
  }, target);
  if (name === 'named-cell') await (await card('numbers')).hover();
  await page.waitForTimeout(250);
  const output = `browser-${name}.png`;
  await page.screenshot({ path: path.join(assets, output) });
  shots.push({ file: output, sha256: createHash('sha256').update(readFileSync(path.join(assets, output))).digest('hex') });
  if (name === 'named-cell') {
    const input = await card('numbers');
    const boxes = await Promise.all([input.locator('.prompt-icon').boundingBox(), input.locator('.cell-edit-btn').boundingBox()]);
    const rects = boxes.map(box => `<rect x="${(box.x - 3).toFixed(1)}" y="${(box.y - 3).toFixed(1)}" width="${(box.width + 6).toFixed(1)}" height="${(box.height + 6).toFixed(1)}" rx="3"/>`).join('\n');
    const overlay = 'browser-named-cell-overlay.svg';
    writeFileSync(path.join(assets, overlay), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 390 844"><g fill="none" stroke="#ffe36a" stroke-width="2">${rects}</g></svg>\n`);
    shots.push({ file: overlay, sha256: createHash('sha256').update(readFileSync(path.join(assets, overlay))).digest('hex'), kind: 'separate editable annotation, raw screenshot unchanged' });
  }
};
try {
  await page.goto(origin + '/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__SCIREPL_APP_READY && window.fileIO && window.notebookManager);
  const initialTabs = await page.evaluate(() => window.notebookManager.getNotebooks().length);
  await page.evaluate(w => window.fileIO.importSrwb(JSON.stringify(w)), workbook);
  check('SRWB import preserves existing tabs', await page.evaluate(() => window.notebookManager.getNotebooks().length) === initialTabs + 1);
  check('Every name and source imports exactly', await page.evaluate(w => window._cells.every((c, i) => c.name === w.notebook.cells[i].name && c.code === w.notebook.cells[i].code), workbook));
  check('No code runs on import, even with auto-execute on', await page.evaluate(() => window._cells.filter(c => c.type === 'code').every(c => !c.outputCard)));
  check('Import does not create the shared file', !await page.evaluate(() => window.sharedVFS.exists('/shared/data/named-cell-tutorial/values.json')));

  const numbers = await card('numbers');
  await numbers.locator('.prompt-icon').dblclick();
  await page.locator('#rename-cell-input').fill('measurements');
  await capture('name-dialog');
  await page.locator('#rename-cell-ok').click();
  check('Actual rename dialog changes the named path', await page.evaluate(() => window.notebookVFS.readFile('/nb/numbers/.code') === null
    && window.notebookVFS.readFile('/nb/measurements/.code').includes('values')));
  const renamed = await card('measurements');
  await renamed.locator('.prompt-icon').dblclick();
  await page.locator('#rename-cell-input').fill('numbers');
  await page.locator('#rename-cell-ok').click();
  check('Restoring the name restores readers without changing source', (await currentCell('numbers')).code === workbook.notebook.cells[1].code);

  await run('numbers', '{"values":[3,5,8]}');
  check('Producer stores exact JSON as last text output', (await currentCell('numbers')).output === '{"values":[3,5,8]}');
  await capture('named-cell', 'numbers');
  const inspected = await run('inspect_cells', 'python_total');
  check('Bash reads JavaScript source, output and language', inspected.output.includes(workbook.notebook.cells[1].code)
    && inspected.output.includes('{"values":[3,5,8]}') && inspected.output.includes('javascript'));
  check('Bash lists names and current positions', inspected.output.includes('numbers') && inspected.output.includes('In[2]'));
  check('Path inspection does not create shared files', !await page.evaluate(() => window.sharedVFS.exists('/shared/data/named-cell-tutorial/values.json')));
  await capture('cell-paths', 'inspect_cells');
  await run('write_shared', 'Saved JSON to /shared/data/named-cell-tutorial/values.json');
  check('Explicit writer stores exact JSON text in SharedVFS', await page.evaluate(() => window.sharedVFS.readFile('/shared/data/named-cell-tutorial/values.json', 'utf8')) === '{"values":[3,5,8]}');
  const bashFile = await page.evaluate(async () => window.kernelManager.execute('cat /shared/data/named-cell-tutorial/values.json', 'bash'));
  check('Bash reads the ordinary file written by JavaScript', bashFile.stdout === '{"values":[3,5,8]}' && !bashFile.error);
  await run('read_shared', '16');
  check('Another program reads the ordinary shared file', (await currentCell('read_shared')).output === '16');

  await page.locator('#menu-btn').click();
  await page.locator('#btn-prolog-settings').click();
  await page.locator('#vfs-kernel-select').selectOption('shared');
  await page.locator('#vfs-file-list .vfs-file').filter({ has: page.locator('.vfs-name', { hasText: /^values\.json$/ }) }).click();
  check('Files & Storage previews the shared JSON file', await page.locator('.vfs-preview-code').textContent() === '{"values":[3,5,8]}'
    && await page.locator('.vfs-preview-path').textContent() === '/shared/data/named-cell-tutorial/values.json');
  await page.locator('#vfs-file-preview').evaluate(element => element.scrollIntoView({ behavior: 'instant', block: 'center' }));
  await capture('shared-values');
  await page.locator('#prolog-settings-modal .modal-close').click();

  await run('generate_report', 'Updated bash_report source');
  check('Generator replaces only the existing Bash source', (await currentCell('bash_report')).code === 'echo "Total: 16"');
  check('Writing .code does not execute the target', !(await currentCell('bash_report')).outputShown);
  await run('bash_report', 'Total: 16');
  check('Manual Run executes generated code in its own language', (await currentCell('bash_report')).output.trim() === 'Total: 16');
  await capture('generated-report', 'bash_report');
  check('Output property is read-only', await page.evaluate(() => !window.notebookVFS.writeFile('/nb/bash_report/.output', 'fabricated'))
    && (await currentCell('bash_report')).output.trim() === 'Total: 16');
  check('Cross-notebook and programmatic execution permissions stay off', await page.evaluate(() => {
    const s = window.notebookVFS._getSettings();
    return !s.crossNotebookRead && !s.crossNotebookWrite && !s.programmaticExecution;
  }));

  // Validate the optional Python comparisons with the bundled runtime. No pip.
  await run('python_total', 'Shared file: 16');
  check('Python reads both named output and the shared file', (await currentCell('python_total')).output.includes('Cell output: 16')
    && (await currentCell('python_total')).output.includes('Shared file: 16'));

  await run('numbers', '{"values":[4,5,8]}', workbook.notebook.cells[1].code.replace('[3, 5, 8]', '[4, 5, 8]'));
  check('Producer change leaves copied file and target output unchanged', await page.evaluate(() => window.sharedVFS.readFile('/shared/data/named-cell-tutorial/values.json', 'utf8')) === '{"values":[3,5,8]}'
    && (await currentCell('bash_report')).output.trim() === 'Total: 16');
  await run('generate_report', 'Updated bash_report source');
  check('New source is 17 while the previous result is still 16', (await currentCell('bash_report')).code === 'echo "Total: 17"'
    && (await currentCell('bash_report')).output.trim() === 'Total: 16');
  await run('bash_report', 'Total: 17');
  check('Rerunning the target refreshes its result', (await currentCell('bash_report')).output.trim() === 'Total: 17');
  await run('write_shared', 'Saved JSON to /shared/data/named-cell-tutorial/values.json');
  await run('read_shared', '17');
  check('Rerunning the copy and reader refreshes the shared-file route', (await currentCell('read_shared')).output === '17');

  const beforeMove = await page.evaluate(() => window.notebookVFS.readFile('/nb/numbers/.code'));
  await (await card('numbers')).locator('.cell-move-down').click();
  check('Named paths keep their target after reordering', await page.evaluate(() => window.notebookVFS.readFile('/nb/numbers/.code')) === beforeMove);
  check('In[N] paths mean current position, not the printed cell ID', await page.evaluate(() => window.notebookVFS.readFile('/nb/In[2]/.name')) === 'inspect_cells');
  await (await card('numbers')).locator('.cell-move-up').click();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__SCIREPL_APP_READY && window._cells?.length === 8);
  check('Names and generated source persist locally', (await currentCell('bash_report')).code === 'echo "Total: 17"'
    && (await currentCell('numbers')).code.includes('[4, 5, 8]'));
  check('Shared file persists in this app profile', await page.evaluate(() => window.sharedVFS.readFile('/shared/data/named-cell-tutorial/values.json', 'utf8')) === '{"values":[4,5,8]}');

  const exported = await page.evaluate(async () => {
    let result;
    const original = window.fileIO.downloadFile;
    window.fileIO.downloadFile = async (name, content) => { result = content; };
    try { await window.fileIO._exportSrwb('current'); } finally { window.fileIO.downloadFile = original; }
    return JSON.parse(result);
  });
  check('SRWB export keeps all cell names and generated source', exported.notebook.cells.map(c => c.name).join(',') === names.join(',')
    && exported.notebook.cells.find(c => c.name === 'bash_report').code === 'echo "Total: 17"');
  // A new browser profile proves file bytes are not bundled by an SRWB export.
  const fresh = await context.browser().newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  await fresh.route('**/*', route => {
    if (new URL(route.request().url()).origin !== new URL(origin).origin) { external.push(route.request().url()); return route.abort(); }
    return route.continue();
  });
  await fresh.addInitScript(() => {
    localStorage.setItem('scirepl_privacy_accepted', '1');
    localStorage.setItem('scirepl_onboarding_seen', '1');
    localStorage.setItem('scirepl_default_language', 'javascript');
    addEventListener('DOMContentLoaded', () => localStorage.setItem('scirepl_whats_new_seen_version', window.KERNEL_CONFIG.app.version), { once: true });
  });
  const imported = await fresh.newPage();
  imported.on('pageerror', e => errors.push(e.message));
  await imported.goto(origin + '/index.html', { waitUntil: 'domcontentloaded' });
  await imported.waitForFunction(() => window.__SCIREPL_APP_READY && window.fileIO);
  await imported.evaluate(w => window.fileIO.importSrwb(JSON.stringify(w)), exported);
  check('Ordinary SRWB import keeps source but drops saved code output', await imported.evaluate(() => {
    const c = window._cells.find(c => c.name === 'numbers');
    return c.code.includes('[4, 5, 8]') && !c.lastOutput && !c.outputCard;
  }));
  check('SRWB does not carry the separate shared data file', !await imported.evaluate(() => window.sharedVFS.exists('/shared/data/named-cell-tutorial/values.json')));
  await fresh.close();
  check('No external network requests needed, including optional Python', external.length === 0);
  check('No page errors', errors.length === 0);
  if (process.argv.includes('--capture')) writeFileSync(path.join(assets, 'capture-receipt.json'), JSON.stringify({
    capturedAt: new Date().toISOString(), platform: 'Chromium browser, not Android',
    viewport: { width: 390, height: 844 }, app: await page.evaluate(() => window.KERNEL_CONFIG.app),
    workbookSha256: createHash('sha256').update(readFileSync(file)).digest('hex'),
    imagesUnmodified: true, limits: ['Free browser build only; no Android or Pro verification in these captures'],
    checks, files: shots
  }, null, 2) + '\n');
  console.log(`PASS: ${count} named-cell tutorial checks`);
} finally {
  await browser.close();
}
