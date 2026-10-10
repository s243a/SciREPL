import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync, createReadStream, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

assert(process.env.SCIREPL_PRO_SOURCE, 'Set SCIREPL_PRO_SOURCE to a clean Pro checkout');
const pro = path.resolve(process.env.SCIREPL_PRO_SOURCE);
const dest = process.env.SCIREPL_CAPTURE_OUTPUT ? path.resolve(process.env.SCIREPL_CAPTURE_OUTPUT) : path.dirname(fileURLToPath(import.meta.url));
const expected = '38316dbb3d12cc628b57af392c9ede49f36d71d0';
assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: pro, encoding: 'utf8' }).trim(), expected);
assert.equal(execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: pro, encoding: 'utf8' }).trim(), '', 'Tracked Pro source must be clean');
const dependencyRoot = process.env.SCIREPL_PLAYWRIGHT_ROOT ? path.resolve(process.env.SCIREPL_PLAYWRIGHT_ROOT) : pro;
const { chromium } = createRequire(path.join(dependencyRoot, 'package.json'))('playwright');
const origin = 'http://127.0.0.1:8108';
const www = path.join(pro, 'www');
const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf' };
const served = [];
const server = createServer((req, res) => {
  const url = new URL(req.url, origin);
  const pathname = decodeURIComponent(url.pathname);
  const file = path.resolve(www, '.' + (pathname === '/' ? '/index.html' : pathname));
  if (req.method !== 'GET' || pathname.startsWith('/proxy') || !file.startsWith(www + path.sep) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404); res.end('Not found'); return;
  }
  served.push(pathname);
  res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  createReadStream(file).pipe(res);
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(8108, '127.0.0.1', resolve); });
mkdirSync(dest, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const context = await browser.newContext({ viewport: { width: 430, height: 1100 }, deviceScaleFactor: 1, serviceWorkers: 'block', locale: 'en-US', timezoneId: 'UTC' });
const blocked = [], externalResponses = [], errors = [], screenshots = [];
await context.route('**/*', route => {
  const request = route.request(), url = new URL(request.url());
  if (url.origin === origin && request.method() === 'GET' && !url.pathname.startsWith('/proxy')) return route.continue();
  if (['data:', 'blob:'].includes(url.protocol)) return route.continue();
  blocked.push({ method: request.method(), origin: url.origin, pathname: url.pathname, resourceType: request.resourceType() });
  return route.abort('blockedbyclient');
});
await context.addInitScript(() => {
  // Only dismiss introductory overlays in this disposable, keyless profile.
  localStorage.setItem('scirepl_onboarding_seen', '1');
  localStorage.setItem('scirepl_auto_download', '0');
  addEventListener('DOMContentLoaded', () => localStorage.setItem('scirepl_whats_new_seen_version', window.KERNEL_CONFIG?.app?.version || ''), { once: true });
});
const page = await context.newPage();
page.on('pageerror', e => errors.push(e.message));
page.on('response', response => { if (new URL(response.url()).origin !== origin) externalResponses.push(response.url()); });
async function shot(file, selector, description) {
  const locator = page.locator(selector);
  await locator.screenshot({ path: path.join(dest, file), animations: 'disabled' });
  screenshots.push({ file, description, selector, sha256: createHash('sha256').update(readFileSync(path.join(dest, file))).digest('hex') });
  console.log('Captured ' + file);
}
try {
  await page.goto(origin + '/index.html', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction(() => window.__SCIREPL_APP_READY === true && window.fileIO && window.completionMore, null, { timeout: 45000 });
  await page.click('#menu-btn');
  await page.click('#btn-completion');
  await page.selectOption('#setting-local-completion', 'on');
  assert.equal(await page.inputValue('#setting-local-completion'), 'on');
  await shot('completion-general.png', '#completion-modal .modal-content', 'Actual General Completion screen; Local code completion set to On using its dropdown.');
  await page.selectOption('#completion-section', 'ai');
  await page.selectOption('#setting-ai-model-mode', 'independent');
  assert.equal(await page.inputValue('#setting-ai-model-mode'), 'independent');
  assert.match(await page.locator('#setting-ai-provider-empty-note').textContent(), /No provider keys are saved/i);
  await shot('completion-online.png', '#completion-modal .modal-content', 'Actual online Completion screen; independent selection chosen with no saved provider keys.');
  await page.click('#completion-modal .modal-close');
  await page.click('#menu-btn');
  await page.click('#btn-ai-assistant');
  await page.click('#ai-settings-btn');
  await page.uncheck('#ai-settings-autorun');
  await page.uncheck('#ai-settings-fsread');
  await page.selectOption('#ai-settings-write-scope', 'active');
  await page.selectOption('#ai-settings-security', 'open');
  await page.locator('#ai-settings-security').scrollIntoViewIfNeeded();
  assert.equal(await page.inputValue('#ai-settings-security'), 'open');
  assert.equal(await page.isChecked('#ai-settings-autorun'), false);
  assert.equal(await page.isChecked('#ai-settings-fsread'), false);
  assert.equal(await page.inputValue('#ai-settings-write-scope'), 'active');
  await shot('assistant-open.png', '#ai-settings-modal .modal-content', 'Actual AI Assistant Settings scrolled to Security Level; Open selected, Auto-run off, source browsing off, Active worksheet scope, disposable keyless profile.');
  const storageKeys = await page.evaluate(() => Object.keys(localStorage));
  const keys = await page.evaluate(() => window.scireplProviderStore.list?.() || null);
  assert.deepEqual(keys, [], 'No provider credentials may be injected or saved');
  assert.equal(await page.inputValue('#ai-settings-key'), '', 'API key remains empty');
  assert.equal(execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: pro, encoding: 'utf8' }).trim(), '', 'Tracked Pro source remains clean');
  assert.equal(externalResponses.length, 0, 'No external response may be received');
  assert.equal(blocked.length, 0, 'This capture must attempt no external requests');
  assert(!blocked.some(item => item.method !== 'GET' || /chat\/completions|\/messages|generate|model-pack/i.test(item.pathname)), 'No provider/model request may be attempted');
  assert(!errors.length, 'App script errors are not expected');
  const identity = JSON.parse(readFileSync(path.join(pro, 'package.json'), 'utf8'));
  const receipt = { sourceRepository: 'SciREPL-Pro', sourceSha: expected, sourceVersion: { version: identity.version, releaseChannel: identity.releaseChannel, androidVersionCode: identity.android.versionCode }, capturedAtUtc: new Date().toISOString(), browser: { engine: 'Chromium', version: browser.version(), headless: true }, viewport: { width: 430, height: 1100, deviceScaleFactor: 1 }, sourceRoute: origin + '/index.html', routePolicy: 'Allow only same-origin GET static files; server rejects proxy path. Abort every external request and every non-GET. Service workers disabled. Fresh non-persistent context; no keys, providers, fake engine state, generated UI, or completion requests.', introductoryStorage: { scirepl_onboarding_seen: '1', scirepl_auto_download: '0', scirepl_whats_new_seen_version: 'current source version after DOMContentLoaded' }, assistantSettings: { autoRunCellsCreatedByAI: false, sourceBrowsing: false, agentWrites: 'active', securityLevel: 'open' }, storageKeys, providerStoreList: keys, servedPathCount: served.length, blockedRequests: blocked, externalResponses, pageErrors: errors, screenshots, limitations: ['Browser UI capture only; no Android device, native engine, provider request, or model installation was tested.', 'AI Assistant Settings screenshot is scrolled; Backend/Model/API Key controls above it are not pictured.', 'Independent completion has no saved keys: provider/model choices are not populated; the app intentionally refuses requests.'] };
  writeFileSync(path.join(dest, 'capture-pro-ui.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ screenshotCount: screenshots.length, blockedRequests: blocked, externalResponses: externalResponses.length, errors }));
} finally { await context.close(); await browser.close(); await new Promise(resolve => server.close(resolve)); }
