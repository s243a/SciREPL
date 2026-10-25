// Browser/localized-public-HTML checks, with no API calls or app data access.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { ROOT, BASE, LOCALES, ROUTES } from '../scripts/tutorial_locale_lib.mjs';

const WWW = path.join(ROOT, 'www');
const mime = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json', '.srwb': 'application/json' };
const server = createServer((req, res) => {
  try {
    let requestPath = decodeURIComponent(new URL(req.url, 'http://fixture').pathname);
    if (requestPath.startsWith(BASE)) requestPath = requestPath.slice(BASE.length - 1);
    if (requestPath.endsWith('/')) requestPath += 'index.html';
    const file = path.resolve(WWW, '.' + requestPath);
    if (!file.startsWith(WWW + path.sep) || !statSync(file).isFile()) throw new Error('missing');
    res.writeHead(200, { 'content-type': mime[path.extname(file)] || 'application/octet-stream' }); res.end(readFileSync(file));
  } catch { res.writeHead(404); res.end('Not found'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
const args = process.argv.slice(2), selected = [];
for (let index = 0; index < args.length; index++) {
  if (args[index] === '--locale') { const locale = args[++index]; assert.ok(LOCALES.includes(locale), 'Unknown tutorial browser locale'); selected.push(locale); }
  else assert.equal(args[index], '--all', 'Unknown tutorial browser option');
}
const locales = args.includes('--all') ? LOCALES : selected.length ? selected : ['en'];
const report = { schema: 1, kind: 'public-tutorial-locale-browser', completeAllLocales: locales.length === LOCALES.length, profiles: [], externalRequests: [], failures: [] };
try {
  for (const locale of locales) for (const route of ROUTES) for (const [name, width, height] of [['portrait', 320, 800], ['landscape', 844, 390]]) {
    const context = await browser.newContext({ viewport: { width, height }, javaScriptEnabled: true });
    const page = await context.newPage();
    const pageErrors = [], missing = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    page.on('response', response => { if (response.status() >= 400) missing.push(response.url()); });
    page.on('requestfailed', request => missing.push(request.url()));
    await page.route('**/*', async request => {
      if (new URL(request.request().url()).origin !== origin) { report.externalRequests.push(request.request().url()); return request.abort(); }
      return request.continue();
    });
    const row = { locale, route, profile: name, width, height, checks: {} };
    try {
      await page.goto(`${origin}${BASE}help/${locale}/${route}/`, { waitUntil: 'networkidle' });
      row.checks.language = await page.locator('html').getAttribute('lang') === locale;
      row.checks.direction = await page.locator('html').getAttribute('dir') === (locale === 'ar' ? 'rtl' : 'ltr');
      row.checks.noHorizontalClip = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
      const summary = page.locator('.tutorial-language-menu summary');
      await summary.focus(); await page.keyboard.press('Enter');
      row.checks.keyboardPicker = await page.locator('.tutorial-language-menu').getAttribute('open') !== null;
      const links = page.locator('.tutorial-language-menu nav a');
      row.checks.thirteenLanguages = await links.count() === 13;
      row.checks.tapTargets = await links.evaluateAll(elements => elements.every(element => element.getBoundingClientRect().height >= 44));
      row.checks.nativeLanguageNames = await links.evaluateAll(elements => elements.every(element => element.lang && element.hreflang));
      row.checks.localeNotice = locale === 'en' ? await page.locator('.tutorial-translation-notice').count() === 0 : await page.locator('.tutorial-translation-notice').isVisible();
      row.checks.currentLanguage = await page.locator('.tutorial-language-menu nav a[aria-current="page"]').count() === 1;
      // No duplicate image trees: all source URLs resolve to the original help.
      row.checks.sharedImages = await page.locator('img[src]').evaluateAll(images => images.every(image => !/\/help\/(?:en|ar|bn|de|es|fr|hi|id|ja|ko|pt-BR|ru|zh)\/.*\/assets\//.test(image.src)));
      if (route === 'workbooks/tutorial') row.checks.catalogueLocale = await page.locator('#catalogue-workbooks-locale').inputValue() === locale;
      // Long walkthroughs use lazy screenshots. Load and decode every image,
      // including those below the viewport, before checking resources/layout.
      // Each image has a finite wait and failures remain explicit test failures.
      row.checks.allImagesDecoded = await page.locator('img[src]').evaluateAll(async images => (await Promise.all(images.map(async image => {
        image.loading = 'eager';
        let timer;
        try {
          await Promise.race([
            image.decode(),
            new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Image decode timed out')), 10000); }),
          ]);
          return image.complete && image.naturalWidth > 0 && image.naturalHeight > 0;
        } catch { return false; }
        finally { clearTimeout(timer); }
      }))).every(Boolean));
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      row.checks.noHorizontalClipWithPicker = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
      row.checks.noMissingResources = missing.length === 0;
      row.checks.noPageErrors = pageErrors.length === 0;
      for (const [check, value] of Object.entries(row.checks)) assert.ok(value, `${locale}/${route} ${name}: ${check}`);
      console.log(`PASS ${locale}/${route} ${name}`);
    } catch (error) { row.failure = error.message; report.failures.push(row.failure); console.error(`FAIL ${row.failure}`); }
    report.profiles.push(row); await context.close();
  }
} finally {
  await browser.close(); await new Promise(resolve => server.close(resolve));
  writeFileSync(process.env.TUTORIAL_LOCALE_REPORT || '/tmp/scirepl-tutorial-locale-browser.json', JSON.stringify(report, null, 2) + '\n');
}
assert.equal(report.externalRequests.length, 0, 'Tutorials must not request third-party resources');
assert.equal(report.failures.length, 0, 'Localized tutorial browser checks failed');
console.log(`Tutorial browser: ${report.profiles.length} route/locale/orientation profiles passed; no external requests.`);
