import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync, createReadStream, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

// Actual, keyless UI only. No generated controls, injected provider identities,
// native-engine state, credentials, saved profile, or provider request.
assert(Number(process.versions.node.split('.')[0]) >= 22, 'Use Node 22 or newer');
assert(process.env.SCIREPL_PRO_SOURCE, 'Set SCIREPL_PRO_SOURCE to a clean Pro checkout');
const pro = path.resolve(process.env.SCIREPL_PRO_SOURCE);
const dest = process.env.SCIREPL_CAPTURE_OUTPUT
  ? path.resolve(process.env.SCIREPL_CAPTURE_OUTPUT) : path.dirname(fileURLToPath(import.meta.url));
const expected = '38316dbb3d12cc628b57af392c9ede49f36d71d0';
const outputNames = ['assistant-key-setup.png', 'assistant-key-setup-overlay.svg', 'capture-pro-key-setup.json'];
for (const file of outputNames) assert(!existsSync(path.join(dest, file)), `Refusing to overwrite ${file}`);
const sourceState = () => {
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: pro, encoding: 'utf8' }).trim(), expected);
  assert.equal(execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: pro, encoding: 'utf8' }).trim(), '', 'Tracked Pro source must remain clean');
};
sourceState();
const dependencyRoot = process.env.SCIREPL_PLAYWRIGHT_ROOT ? path.resolve(process.env.SCIREPL_PLAYWRIGHT_ROOT) : pro;
const { chromium } = createRequire(path.join(dependencyRoot, 'package.json'))('playwright');
const origin = 'http://127.0.0.1:8108';
const www = path.join(pro, 'www');
const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf' };
let servedPathCount = 0;
const server = createServer((req, res) => {
  const url = new URL(req.url, origin);
  const pathname = decodeURIComponent(url.pathname);
  const file = path.resolve(www, '.' + (pathname === '/' ? '/index.html' : pathname));
  if (req.method !== 'GET' || pathname.startsWith('/proxy') || !file.startsWith(www + path.sep)
      || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404); res.end('Not found'); return;
  }
  servedPathCount++;
  res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  createReadStream(file).pipe(res);
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(8108, '127.0.0.1', resolve); });
let browser, context;
try {
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  context = await browser.newContext({ viewport: { width: 430, height: 1100 }, deviceScaleFactor: 1, serviceWorkers: 'block', locale: 'en-US', timezoneId: 'UTC' });
  const blockedRequests = [], externalResponses = [], pageErrors = [];
  await context.route('**/*', route => {
    const request = route.request(), url = new URL(request.url());
    if (request.method() === 'GET' && url.origin === origin && !url.pathname.startsWith('/proxy')) return route.continue();
    if (request.method() === 'GET' && ['data:', 'blob:'].includes(url.protocol)) return route.continue();
    blockedRequests.push({ method: request.method(), origin: url.origin, pathname: url.pathname, resourceType: request.resourceType() });
    return route.abort('blockedbyclient');
  });
  await context.addInitScript(() => {
    localStorage.setItem('scirepl_onboarding_seen', '1');
    localStorage.setItem('scirepl_auto_download', '0');
    addEventListener('DOMContentLoaded', () => localStorage.setItem('scirepl_whats_new_seen_version', window.KERNEL_CONFIG?.app?.version || ''), { once: true });
  });
  const page = await context.newPage();
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('response', response => { if (new URL(response.url()).origin !== origin) externalResponses.push(response.url()); });
  await page.goto(origin + '/index.html', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction(() => window.__SCIREPL_APP_READY === true && window.fileIO && window.aiAssistant, null, { timeout: 45000 });
  await page.click('#menu-btn');
  await page.click('#btn-ai-assistant');
  await page.click('#ai-settings-btn');
  await page.selectOption('#ai-settings-scope', 'assistant');
  await page.selectOption('#ai-settings-backend', 'openrouter');
  const modelOption = page.locator('#ai-settings-model option[value="z-ai/glm-5.3-flash"]');
  assert.equal(await modelOption.count(), 1, 'GLM must be an actual existing model option');
  assert.equal(await modelOption.evaluate(option => option.hidden), false, 'GLM must be available in the real picker');
  await page.selectOption('#ai-settings-model', 'z-ai/glm-5.3-flash');
  await page.locator('#ai-settings-modal h2').click();
  await page.locator('#ai-settings-modal .modal-content').evaluate(element => { element.scrollTop = 0; });
  assert.equal(await page.inputValue('#ai-settings-scope'), 'assistant');
  assert.equal(await page.inputValue('#ai-settings-backend'), 'openrouter');
  assert.equal(await page.inputValue('#ai-settings-model'), 'z-ai/glm-5.3-flash');
  assert.equal(await page.inputValue('#ai-settings-model-custom'), '');
  assert.equal(await page.inputValue('#ai-settings-key'), '', 'API key must stay empty');
  const providerStoreList = await page.evaluate(() => window.scireplProviderStore.list());
  assert.deepEqual(providerStoreList, [], 'No provider credentials may be present');

  const modal = await page.locator('#ai-settings-modal .modal-content').boundingBox();
  const key = await page.locator('#ai-settings-key').boundingBox();
  const save = await page.locator('#ai-settings-save').boundingBox();
  assert(modal && key && save, 'Real modal, key and Save controls must exist');
  const saveFits = save.y >= modal.y && save.y + save.height <= Math.min(modal.y + modal.height, 1100);
  const lastBottom = saveFits ? save.y + save.height : key.y + key.height;
  const clip = { x: Math.floor(modal.x), y: Math.floor(modal.y), width: Math.ceil(modal.width), height: Math.ceil(lastBottom + 12 - Math.floor(modal.y)) };
  assert(clip.x >= 0 && clip.y >= 0 && clip.x + clip.width <= 430 && clip.y + clip.height <= 1100, 'Capture must fit the real viewport');
  const targets = [
    { id: 'configure-target', selectors: ['#ai-settings-modal .ai-model-scope-row'] },
    { id: 'backend-setting', selectors: ['#ai-settings-assistant-section [data-i18n="aiSettings.backend"]', '#ai-settings-backend'] },
    { id: 'model-setting', selectors: ['#ai-settings-assistant-section [data-i18n="aiSettings.model"]', '#ai-settings-model'] },
    { id: 'api-key-setting', selectors: ['#ai-settings-assistant-section [data-i18n="aiSettings.apiKey"]', '#ai-settings-key'] },
  ];
  if (saveFits) targets.push({ id: 'save-setting', selectors: ['#ai-settings-save'] });
  const highlights = [];
  for (const target of targets) {
    const boxes = await Promise.all(target.selectors.map(selector => page.locator(selector).boundingBox()));
    assert(boxes.every(Boolean), `${target.id} must have actual measured bounds`);
    const left = Math.min(...boxes.map(box => box.x)), top = Math.min(...boxes.map(box => box.y));
    const right = Math.max(...boxes.map(box => box.x + box.width)), bottom = Math.max(...boxes.map(box => box.y + box.height));
    const bounds = { x: Math.round((left - clip.x - 3) * 100) / 100, y: Math.round((top - clip.y - 3) * 100) / 100,
      width: Math.round((right - left + 6) * 100) / 100, height: Math.round((bottom - top + 6) * 100) / 100 };
    assert(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= clip.width && bounds.y + bounds.height <= clip.height,
      `${target.id} must fit the unaltered screenshot`);
    highlights.push({ ...target, bounds });
  }
  const png = await page.screenshot({ clip, animations: 'disabled' });
  assert.equal(blockedRequests.length, 0, 'This capture must attempt zero external or non-GET requests');
  assert.equal(externalResponses.length, 0, 'No external response may be received');
  assert.deepEqual(pageErrors, [], 'No page errors are expected');
  sourceState();
  const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
  assert.equal(width, clip.width); assert.equal(height, clip.height);
  const desc = 'Yellow borders locate the real Configure model for, Backend, Model and blank API Key controls.'
    + (saveFits ? ' Save is visible below.' : ' Save is below the captured upper region and is not pictured.');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}">\n  <title>AI Assistant provider and key setup</title>\n  <desc>${desc}</desc>\n  <g fill="none" stroke="#ffd43b" stroke-width="3">\n`
    + highlights.map(({ id, bounds: b }) => `    <rect id="${id}" x="${b.x}" y="${b.y}" width="${b.width}" height="${b.height}" rx="6"/>`).join('\n')
    + '\n  </g>\n</svg>\n';
  const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
  const identity = JSON.parse(readFileSync(path.join(pro, 'package.json'), 'utf8'));
  const receipt = {
    schemaVersion: 1, sourceRepository: 'SciREPL-Pro', sourceSha: expected,
    sourceVersion: { version: identity.version, releaseChannel: identity.releaseChannel, androidVersionCode: identity.android.versionCode },
    sourceGuards: { exactShaBeforeAndAfter: true, trackedSourceCleanBeforeAndAfter: true },
    capturedAtUtc: new Date().toISOString(), browser: { engine: 'Chromium', version: browser.version(), headless: true },
    viewport: { width: 430, height: 1100, deviceScaleFactor: 1 }, sourceRoute: origin + '/index.html',
    routePolicy: 'Local same-origin GET static files only; server rejects proxy routes and non-GET. Abort every external and non-GET request. Service workers blocked. Fresh non-persistent, keyless context.',
    introductoryStorage: { scirepl_onboarding_seen: '1', scirepl_auto_download: '0', scirepl_whats_new_seen_version: 'current source version after DOMContentLoaded' },
    actualUi: { route: 'Menu → AI Assistant (Pro) → gear → AI Settings', configureModelFor: 'assistant', backend: 'openrouter', model: 'z-ai/glm-5.3-flash',
      modelSelectedFromActualPreset: true, customModelFieldEmpty: true, apiKeyEmpty: true, settingsSaved: false, saveVisibleInCapture: saveFits },
    providerStoreList, servedPathCount, blockedRequests, externalResponses, pageErrors,
    screenshot: { file: 'assistant-key-setup.png', width, height, sha256: sha256(png), clip,
      description: 'Unmodified real browser pixels of the upper AI Settings region; actual preset selected through UI, API key blank.' },
    overlay: { file: 'assistant-key-setup-overlay.svg', width, height, sha256: sha256(svg), highlights },
    limitations: ['Browser UI configuration capture only; not Android, provider/model execution, credential validation, Play delivery, or native-engine testing.',
      'The model/backend are staged dialog selections. No key was entered and Save was not pressed.',
      ...(saveFits ? [] : ['Save is below the cropped upper region; scroll farther in the real dialog to reach it.'])],
  };
  mkdirSync(dest, { recursive: true });
  writeFileSync(path.join(dest, 'assistant-key-setup.png'), png, { flag: 'wx' });
  writeFileSync(path.join(dest, 'assistant-key-setup-overlay.svg'), svg, { flag: 'wx' });
  writeFileSync(path.join(dest, 'capture-pro-key-setup.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ file: receipt.screenshot.file, width, height, sha256: receipt.screenshot.sha256,
    saveVisibleInCapture: saveFits, highlights, externalRequestsAttempted: blockedRequests.length, externalResponses: externalResponses.length, pageErrors }));
} finally {
  await context?.close();
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
