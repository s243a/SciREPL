// Public-help regression: metadata, links, aliases, and narrow/zoomed layout.
// Run after server.js is listening on http://localhost:8085.

import { chromium } from 'playwright';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { preparePublicPagesServiceWorker } from '../scripts/prepare-public-pages-sw.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WWW = path.join(ROOT, 'www');
const ORIGIN = 'https://s243a.github.io';
const BASE_PATH = '/SciREPL/';
const TEST_ORIGIN = process.env.HELP_TEST_ORIGIN || 'http://localhost:8085';
let failures = 0;
const check = (name, ok, detail = '', quietPass = false) => {
  if (!ok) failures++;
  if (!quietPass || !ok) {
    console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? `: ${detail}` : ''}`);
  }
};

const expected = [
  'help/index.html',
  'help/getting-started/index.html',
  'help/interface/index.html',
  'help/workbooks/index.html',
  'help/languages-packages/index.html',
  'help/files-export/index.html',
  'help/troubleshooting/index.html',
  'help/privacy/index.html',
  'help/pro/index.html',
  'help/pro/ai/index.html',
  'help/pro/remote/index.html',
  'pro/help/index.html',
];

const walkHtml = dir => readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
  const full = path.join(dir, entry.name);
  if (entry.isDirectory()) return walkHtml(full);
  return entry.name.endsWith('.html') ? [full] : [];
});

for (const rel of expected) check(`page exists: ${rel}`, existsSync(path.join(WWW, rel)));

const contentPages = expected.filter(rel => rel.startsWith('help/'));
for (const rel of contentPages) {
  const html = readFileSync(path.join(WWW, rel), 'utf8');
  const ids = [...html.matchAll(/\sid=["']([^"']+)["']/g)].map(match => match[1]);
  const navs = [...html.matchAll(/<nav\b([^>]*)>/gi)];
  const navLabels = navs.map(match => (match[1].match(/\baria-label=["']([^"']+)["']/i) || [])[1]);
  check(`${rel} has a title`, /<title>[^<]+<\/title>/i.test(html));
  check(`${rel} has one help canonical`,
    (html.match(/<link\s+rel=["']canonical["']/gi) || []).length === 1
      && /href=["']https:\/\/s243a\.github\.io\/SciREPL\/help\//i.test(html));
  check(`${rel} declares editions`, /<body[^>]+data-editions=["'](?:free pro|free|pro)["']/i.test(html));
  check(`${rel} declares platforms`, /<body[^>]+data-platforms=["'][^"']+["']/i.test(html));
  check(`${rel} shows an edition chip`, /class=["'][^"']*chip-(?:free|pro)[^"']*["']/i.test(html));
  check(`${rel} has no duplicate ids`, ids.length === new Set(ids).size);
  check(`${rel} labels every repeated navigation landmark`,
    navs.length <= 1 || navLabels.every(Boolean));
  check(`${rel} gives repeated navigation landmarks unique labels`,
    navs.length <= 1 || new Set(navLabels).size === navLabels.length);
  check(`${rel} does not link private Pro source`, !/github\.com\/s243a\/SciREPL-Pro/i.test(html));
}

const rootHelp = readFileSync(path.join(WWW, 'help/index.html'), 'utf8');
check('Free/shared contents precede Pro contents',
  rootHelp.indexOf('Free and shared notebook help') < rootHelp.indexOf('Optional Pro extensions'));

const alias = readFileSync(path.join(WWW, 'pro/help/index.html'), 'utf8');
check('compatibility alias is noindex', /name=["']robots["']\s+content=["']noindex["']/i.test(alias));
check('compatibility alias canonically targets /help/pro/',
  /href=["']https:\/\/s243a\.github\.io\/SciREPL\/help\/pro\/["']/i.test(alias));
check('compatibility alias redirects without a loop',
  /url=\.\.\/\.\.\/help\/pro\//i.test(alias) && !/url=\.\.\/\.\.\/pro\/help\//i.test(alias));
check('compatibility alias preserves query and hash',
  /target\.search\s*=\s*window\.location\.search/.test(alias)
    && /target\.hash\s*=\s*window\.location\.hash/.test(alias));

const legacyPublicPageRule = [
  "const CACHE_VERSION = 'v208';",
  '  if (isScopedAppRequest && url.pathname.startsWith(`${appScopePath}pro/`)) {',
  '    return;',
  '  }',
].join('\n');
const preparedLegacyWorker = preparePublicPagesServiceWorker(legacyPublicPageRule, 'test fixture');
check('Pages overlay adds /help/ to an older stable service worker',
  preparedLegacyWorker.changed && preparedLegacyWorker.source.includes("['pro', 'help']"));
check('Pages overlay gives its changed worker a distinct cache version',
  preparedLegacyWorker.source.includes("const CACHE_VERSION = 'v208-pages-help1';"));
check('Pages service-worker compatibility patch is idempotent',
  !preparePublicPagesServiceWorker(preparedLegacyWorker.source, 'test fixture').changed);

const linkedHtml = [...walkHtml(path.join(WWW, 'help')), path.join(WWW, 'pro/help/index.html')];
for (const file of linkedHtml) {
  const rel = path.relative(WWW, file).replaceAll(path.sep, '/');
  const html = readFileSync(file, 'utf8');
  const base = new URL(BASE_PATH + rel, ORIGIN);
  for (const match of html.matchAll(/\s(?:href|src)=["']([^"']+)["']/gi)) {
    const raw = match[1];
    if (/^(?:mailto:|tel:|data:|javascript:)/i.test(raw)) continue;
    const target = new URL(raw, base);
    if (target.origin !== ORIGIN) continue;
    // A different GitHub Pages project has the same origin but is external to
    // this artifact (for example /SciREPL-Catalog/).
    if (!target.pathname.startsWith(BASE_PATH)) continue;
    let targetRel = decodeURIComponent(target.pathname.slice(BASE_PATH.length));
    if (!targetRel || targetRel.endsWith('/')) targetRel += 'index.html';
    const targetFile = path.join(WWW, targetRel);
    check(`${rel} link exists`, existsSync(targetFile) && statSync(targetFile).isFile(), raw, true);
    if (target.hash && existsSync(targetFile) && targetFile.endsWith('.html')) {
      const targetHtml = readFileSync(targetFile, 'utf8');
      const fragment = decodeURIComponent(target.hash.slice(1));
      check(`${rel} fragment exists`,
        new RegExp(`\\sid=["']${fragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']`).test(targetHtml), raw, true);
    }
  }
}

const browser = await chromium.launch({ headless: true });
try {
  const pages = contentPages.map(rel => `/${rel}`);
  for (const route of pages) {
    const page = await browser.newPage({ viewport: { width: 320, height: 800 } });
    await page.goto(`${TEST_ORIGIN}${route}`, { waitUntil: 'networkidle' });
    const normal = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
    check(`${route} fits 320 CSS px`, normal);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.evaluate(() => { document.documentElement.style.zoom = '2'; });
    const zoomed = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
    check(`${route} fits at 200% zoom`, zoomed);
    await page.close();
  }
} finally {
  await browser.close();
}

console.log(`\n${failures ? `FAIL: ${failures} help check(s) failed` : 'PASS: public help checks passed'}`);
process.exit(failures ? 1 : 0);
