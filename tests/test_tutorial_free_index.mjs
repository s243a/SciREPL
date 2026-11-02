// The app's explicit Free view must not advertise Pro-only walkthroughs.
// The shared index remains complete; no translated source data is modified.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { chromium } from 'playwright';
import { ROOT, BASE, LOCALES, ROUTES } from '../scripts/tutorial_locale_lib.mjs';

const WWW = path.join(ROOT, 'www');
const script = readFileSync(path.join(WWW, 'help/tutorial-edition.js'), 'utf8');
const css = readFileSync(path.join(WWW, 'help/tutorial-locales.css'), 'utf8');
const attrs = new Map();
let onReady;
runInNewContext(script, {
  URL,
  window: { location: { href: 'https://example.test/SciREPL/help/en/tutorials/?edition=free' } },
  document: {
    readyState: 'loading',
    currentScript: { src: 'https://example.test/SciREPL/help/tutorial-edition.js' },
    documentElement: { setAttribute: (key, value) => attrs.set(key, value) },
    addEventListener: (name, callback, options) => {
      assert.equal(name, 'DOMContentLoaded');
      assert.equal(options.once, true);
      onReady = callback;
    },
    querySelectorAll: () => { throw new Error('Edition filtering must wait for the body'); },
  },
});
assert.equal(attrs.get('data-tutorial-edition'), 'free', 'Free view is selected synchronously before body parsing');
assert.equal(typeof onReady, 'function');
assert.match(css, /html\[data-tutorial-edition="free"\]\s+\[data-tutorial-editions="pro"\]\s*\{\s*display:\s*none;\s*\}/);

const mime = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript' };
const server = createServer((req, res) => {
  try {
    let requestPath = decodeURIComponent(new URL(req.url, 'http://fixture').pathname);
    if (requestPath.startsWith(BASE)) requestPath = requestPath.slice(BASE.length - 1);
    if (requestPath.endsWith('/')) requestPath += 'index.html';
    const file = path.resolve(WWW, '.' + requestPath);
    if (!file.startsWith(WWW + path.sep) || !statSync(file).isFile()) throw new Error('missing');
    res.writeHead(200, { 'content-type': mime[path.extname(file)] || 'application/octet-stream' });
    res.end(readFileSync(file));
  } catch { res.writeHead(404); res.end('Not found'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
let profiles = 0;
try {
  browser = await chromium.launch({ headless: true });
  for (const locale of LOCALES) {
    const generated = readFileSync(path.join(WWW, 'help', locale, 'tutorials/index.html'), 'utf8');
    assert.match(generated, /<script src="\.\.\/\.\.\/tutorial-edition\.js"><\/script>/);
    assert.match(generated, /<section aria-labelledby="ai-tutorials" data-tutorial-editions="pro">/);
    for (const route of ROUTES) {
      const lesson = readFileSync(path.join(WWW, 'help', locale, route, 'index.html'), 'utf8');
      assert.equal(lesson.includes('tutorial-edition.js'), route !== 'pro/ai/tutorial', `${locale}/${route}: only shared tutorials use edition presentation`);
    }
    const page = await browser.newPage({ viewport: { width: 320, height: 800 } });
    const failures = [];
    page.on('pageerror', error => failures.push(error.message));
    page.on('response', response => { if (response.status() >= 400) failures.push(response.url()); });
    await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    try {
      const indexUrl = `${origin}${BASE}help/${locale}/tutorials/`;
      await page.goto(indexUrl, { waitUntil: 'load' });
      assert.equal(await page.locator('a.card').count(), 8, `${locale}: shared index retains every tutorial`);
      assert.equal(await page.locator('#ai-tutorials').isVisible(), true, `${locale}: shared index retains Pro`);
      assert.equal(await page.locator('html').getAttribute('data-tutorial-edition'), null);
      assert.equal(await page.locator('a.card[href*="interface/tutorial/"]').evaluate(link => new URL(link.href).searchParams.has('edition')), false);
      profiles++;

      await page.goto(indexUrl + '?edition=free', { waitUntil: 'load' });
      assert.equal(await page.locator('a.card').count(), 7, `${locale}: Free index has all seven supported lessons`);
      assert.equal(await page.locator('#ai-tutorials').count(), 0, `${locale}: Pro-only section is removed`);
      assert.equal(await page.locator('a.card[href*="/pro/"]').count(), 0, `${locale}: no Pro guide card`);
      assert.equal(await page.locator('[data-tutorial-editions="pro"]').count(), 0, `${locale}: no Pro-only coverage chip`);
      assert.equal(await page.locator('html').getAttribute('dir'), locale === 'ar' ? 'rtl' : 'ltr');
      await page.locator('.tutorial-language-menu summary').click();
      const languageLinks = page.locator('.tutorial-language-menu a');
      assert.equal(await languageLinks.count(), 13);
      assert.ok(await languageLinks.evaluateAll(links => links.every(link => new URL(link.href).searchParams.get('edition') === 'free')));
      assert.ok(await page.locator('.site-header nav a[aria-current="page"]').evaluate(link => new URL(link.href).searchParams.get('edition') === 'free'));
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), `${locale}: Free portrait fits`);
      profiles++;
      await page.setViewportSize({ width: 844, height: 390 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), `${locale}: Free landscape fits`);
      profiles++;
      // Follow a real locale link, rather than checking its text alone.
      const other = locale === 'ar' ? 'en' : 'ar';
      // A real index -> lesson -> another language -> index roundtrip retains
      // Free-only navigation instead of exposing the shared Pro card again.
      await page.locator('a.card[href*="interface/tutorial/"]').click();
      await page.waitForLoadState('load');
      assert.equal(new URL(page.url()).searchParams.get('edition'), 'free');
      assert.equal(await page.locator('html').getAttribute('lang'), locale);
      await page.locator('.tutorial-language-menu summary').click();
      await page.locator(`.tutorial-language-menu a[lang="${other}"]`).click();
      await page.waitForLoadState('load');
      assert.equal(new URL(page.url()).searchParams.get('edition'), 'free');
      assert.equal(await page.locator('html').getAttribute('lang'), other);
      assert.ok(new URL(page.url()).pathname.endsWith('/interface/tutorial/'));
      await page.locator('.site-header nav a[href*="/tutorials/"]').click();
      await page.waitForLoadState('load');
      assert.ok(new URL(page.url()).pathname.endsWith('/tutorials/'));
      assert.equal(new URL(page.url()).searchParams.get('edition'), 'free');
      assert.equal(await page.locator('#ai-tutorials').count(), 0);
      assert.equal(await page.locator('a.card').count(), 7);
      assert.deepEqual(failures, [], `${locale}: no script or missing-resource failures`);
    } finally { await page.close(); }
  }
  const page = await browser.newPage();
  await page.goto(`${origin}${BASE}help/en/workbooks/import/?edition=free`, { waitUntil: 'load' });
  assert.ok(await page.locator('a[href]').evaluateAll(links => links.every(link => {
    const target = new URL(link.href);
    if (target.origin !== window.location.origin || target.pathname.includes('/pro/') || /\.(?:srwb|ipynb|png|svg|zip)$/.test(target.pathname)) return !target.searchParams.has('edition');
    return true;
  })), 'External URLs, Pro links and companion downloads do not inherit edition');
  await page.evaluate(() => {
    const fixtures = [
      ['external', 'https://example.test/SciREPL/help/en/tutorials/'],
      ['pro', '/SciREPL/help/en/pro/ai/tutorial/'],
      ['reference', '/SciREPL/help/workbooks/'],
      ['download', '/SciREPL/help/en/tutorials/'],
    ];
    fixtures.forEach(([id, href]) => {
      const link = document.createElement('a');
      link.id = `edition-fixture-${id}`; link.href = href;
      if (id === 'download') link.setAttribute('download', 'index.html');
      document.body.append(link);
    });
    const repeat = document.createElement('script');
    repeat.src = '/SciREPL/help/tutorial-edition.js';
    document.head.append(repeat);
    return new Promise((resolve, reject) => { repeat.onload = resolve; repeat.onerror = reject; });
  });
  for (const id of ['external', 'pro', 'reference', 'download']) {
    assert.equal(await page.locator(`#edition-fixture-${id}`).evaluate(link => new URL(link.href).searchParams.has('edition')), false, `${id}: target remains unchanged`);
  }
  for (const query of ['?edition=pro', '?edition=unexpected']) {
    await page.goto(`${origin}${BASE}help/en/tutorials/${query}`, { waitUntil: 'load' });
    assert.equal(await page.locator('a.card').count(), 8, `${query}: not a Free view`);
    assert.equal(await page.locator('#ai-tutorials').isVisible(), true);
    assert.equal(await page.locator('html').getAttribute('data-tutorial-edition'), null);
  }
  await page.close();
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
console.log(`Tutorial Free view: ${profiles} shared/Free locale and orientation profiles, 13 index/lesson/language/index roundtrips, explicit non-Free views, and excluded-target checks passed.`);
