import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync, createReadStream, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

// Actual keyless UI, using real controls only. No provider request or Save.
assert(Number(process.versions.node.split('.')[0]) >= 22, 'Use Node 22 or newer');
assert(process.env.SCIREPL_PRO_SOURCE, 'Set SCIREPL_PRO_SOURCE to a clean Pro checkout');
const pro = path.resolve(process.env.SCIREPL_PRO_SOURCE);
const dest = process.env.SCIREPL_CAPTURE_OUTPUT
  ? path.resolve(process.env.SCIREPL_CAPTURE_OUTPUT) : path.dirname(fileURLToPath(import.meta.url));
const expected = '6dbc4d0793e04f0ea051d2e464032bf8fcab09d5';
const customId = 'anthropic/claude-haiku-5.5';
const outputNames = ['assistant-custom-model.png', 'assistant-custom-model-overlay.svg', 'capture-pro-custom-model.json'];
for (const file of outputNames) assert(!existsSync(path.join(dest, file)), `Refusing to overwrite ${file}`);
const sourceState = () => {
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: pro, encoding: 'utf8' }).trim(), expected);
  assert.equal(execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: pro, encoding: 'utf8' }).trim(), '', 'Tracked Pro source must remain clean');
};
sourceState();
const dependencyRoot = process.env.SCIREPL_PLAYWRIGHT_ROOT ? path.resolve(process.env.SCIREPL_PLAYWRIGHT_ROOT) : pro;
const { chromium } = createRequire(path.join(dependencyRoot, 'package.json'))('playwright');
const origin = 'http://127.0.0.1:8187';
const www = path.join(pro, 'www');
const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf' };
let servedPathCount = 0;
const server = createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, origin).pathname);
  const file = path.resolve(www, '.' + (pathname === '/' ? '/index.html' : pathname));
  if (req.method !== 'GET' || pathname.startsWith('/proxy') || !file.startsWith(www + path.sep)
      || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404); res.end('Not found'); return;
  }
  servedPathCount++;
  res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  createReadStream(file).pipe(res);
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(8187, '127.0.0.1', resolve); });
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
  await page.selectOption('#ai-settings-model', 'z-ai/glm-5.3-flash');
  assert.equal(await page.locator(`#ai-settings-model option[value="${customId}"]`).count(), 0, 'Example custom ID must really be absent from this picker');
  await page.fill('#ai-settings-model-custom', customId);
  await page.locator('#ai-settings-modal h2').click();
  await page.locator('#ai-settings-modal .modal-content').evaluate(element => { element.scrollTop = 0; });
  assert.equal(await page.inputValue('#ai-settings-scope'), 'assistant');
  assert.equal(await page.inputValue('#ai-settings-backend'), 'openrouter');
  assert.equal(await page.inputValue('#ai-settings-model'), 'z-ai/glm-5.3-flash');
  assert.equal(await page.inputValue('#ai-settings-model-custom'), customId);
  assert.equal(await page.inputValue('#ai-settings-key'), '', 'API key must stay empty');
  const providerStoreList = await page.evaluate(() => window.scireplProviderStore.list());
  assert.deepEqual(providerStoreList, [], 'No provider credentials may be present');
  const modal = await page.locator('#ai-settings-modal .modal-content').boundingBox();
  const custom = await page.locator('#ai-settings-model-custom').boundingBox();
  const key = await page.locator('#ai-settings-key').boundingBox();
  assert(modal && custom && key, 'Real modal and fields must exist');
  const clip = { x: Math.floor(modal.x), y: Math.floor(modal.y), width: Math.ceil(modal.width), height: Math.ceil(custom.y + custom.height + 12 - Math.floor(modal.y)) };
  assert(clip.x >= 0 && clip.y >= 0 && clip.x + clip.width <= 430 && clip.y + clip.height <= 1100, 'Crop must fit the real viewport');
  assert(clip.y + clip.height <= key.y, 'API Key input must remain outside this crop');
  const highlights = [];
  for (const target of [
    { id: 'backend-setting', selectors: ['#ai-settings-assistant-section [data-i18n="aiSettings.backend"]', '#ai-settings-backend'] },
    { id: 'custom-model-setting', selectors: ['#ai-settings-model-custom'] },
  ]) {
    const boxes = await Promise.all(target.selectors.map(selector => page.locator(selector).boundingBox()));
    assert(boxes.every(Boolean), 'Targets must have actual measured bounds');
    const left = Math.min(...boxes.map(box => box.x)), top = Math.min(...boxes.map(box => box.y));
    const right = Math.max(...boxes.map(box => box.x + box.width)), bottom = Math.max(...boxes.map(box => box.y + box.height));
    const bounds = { x: Math.round((left - clip.x - 3) * 100) / 100, y: Math.round((top - clip.y - 3) * 100) / 100,
      width: Math.round((right - left + 6) * 100) / 100, height: Math.round((bottom - top + 6) * 100) / 100 };
    assert(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= clip.width && bounds.y + bounds.height <= clip.height);
    highlights.push({ ...target, bounds });
  }
  const png = await page.screenshot({ clip, animations: 'disabled' });
  assert.equal(blockedRequests.length, 0, 'Zero external or non-GET requests may be attempted');
  assert.equal(externalResponses.length, 0);
  assert.deepEqual(pageErrors, []);
  sourceState();
  const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
  assert.equal(width, clip.width); assert.equal(height, clip.height);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}">\n  <title>Custom Assistant model ID</title>\n  <desc>Yellow borders locate the real Backend and custom model ID fields. The original browser pixels are unchanged.</desc>\n  <g fill="none" stroke="#ffd43b" stroke-width="3">\n`
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
    routePolicy: 'Same-origin GET static files only; proxy and non-GET denied; external requests aborted; service workers blocked; fresh non-persistent keyless context.',
    introductoryStorage: { scirepl_onboarding_seen: '1', scirepl_auto_download: '0', scirepl_whats_new_seen_version: 'current source version after DOMContentLoaded' },
    actualUi: { route: 'Menu → AI Assistant (Pro) → gear → AI Settings', configureModelFor: 'assistant', backend: 'openrouter', listedModel: 'z-ai/glm-5.3-flash',
      customModelId: customId, customIdAbsentFromPicker: true, customIdEnteredThroughUi: true, apiKeyEmpty: true, settingsSaved: false, apiKeyOutsideCrop: true },
    providerModelVerification: { url: 'https://openrouter.ai/anthropic/claude-haiku-5.5', apiReference: 'https://openrouter.ai/docs/api_reference/overview', checkedOnClientDate: '2026-10-08',
      statement: 'Provider page names anthropic/claude-haiku-5.5; API reference requires the organization prefix. Availability and prices may change. No inference request was made.' },
    providerStoreList, servedPathCount, blockedRequests, externalResponses, pageErrors,
    screenshot: { file: outputNames[0], width, height, sha256: sha256(png), clip, description: 'Unmodified keyless browser pixels, cropped through the custom model ID field; provider chosen before ID entered; no Save.' },
    overlay: { file: outputNames[1], width, height, sha256: sha256(svg), highlights },
    limitations: ['Configuration capture only, not Android rendering, an API availability/tool-call test, billing verification, Play delivery or engine testing.',
      'The custom ID is a staged UI entry. No key was entered and Save was not pressed.', 'API key and Save controls are below this crop.'],
  };
  mkdirSync(dest, { recursive: true });
  writeFileSync(path.join(dest, outputNames[0]), png, { flag: 'wx' });
  writeFileSync(path.join(dest, outputNames[1]), svg, { flag: 'wx' });
  writeFileSync(path.join(dest, outputNames[2]), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ file: outputNames[0], width, height, sourceSha: expected, externalRequestsAttempted: blockedRequests.length, externalResponses: externalResponses.length, pageErrors }));
} finally {
  await context?.close();
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
