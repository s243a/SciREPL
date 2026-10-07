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
  'help/interface/tutorial/index.html',
  'help/interface/appearance/index.html',
  'help/files-export/tutorial/index.html',
  'help/workbooks/index.html',
  'help/workbooks/tutorial/index.html',
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

const csvTutorial = readFileSync(path.join(WWW, 'help/files-export/tutorial/index.html'), 'utf8');
// Check the lesson's meaning without depending on emphasis tags or line wrapping.
const helpText = html => html.replace(/<[^>]*>/g, ' ')
  .replace(/&amp;/gi, '&').replace(/&nbsp;|&#160;/gi, ' ')
  .replace(/&#39;|&apos;/gi, "'").replace(/&quot;/gi, '"')
  .replace(/\s+/g, ' ').trim();
const csvSection = id => (csvTutorial.match(new RegExp(
  `<section\\b[^>]*\\bid=["']${id}["'][^>]*>([\\s\\S]*?)<\\/section>`, 'i')) || [])[1] || '';
const csvText = helpText(csvTutorial);
const csvChange = csvSection('change');
const csvEdit = (csvChange.match(
  /<div\b[^>]*\bid=["']edit-file["'][^>]*>([\s\S]*?)<\/div>/i) || [])[1] || '';
const csvEditText = helpText(csvEdit);
const csvExport = helpText(csvSection('export'));
const csvReopen = csvSection('reopen');
const csvReopenText = helpText(csvReopen);
const proHighlighting = csvTutorial.match(
  /<aside\b([^>]*\bid=["']pro-syntax-highlighting["'][^>]*)>([\s\S]*?)<\/aside>/i);
const proHighlightingText = helpText(proHighlighting?.[2] || '');
check('CSV tutorial begins in Browse', csvTutorial.indexOf('Browse Packages, Bundles &amp; Workbooks')
  < csvTutorial.indexOf('Run the cells in order'));
check('CSV tutorial distinguishes workbook from data export',
  /does not include the separate CSV/i.test(csvExport)
    && /Package\s*\(archive\)/i.test(csvExport));
check('CSV tutorial shows how to inspect and edit the created file',
  /Files\s*&\s*Storage/i.test(csvText)
    && csvText.includes('/shared/data/seedling-heights.csv')
    && /\bEdit\b/.test(csvText) && /\bSave\b/.test(csvText));
check('CSV tutorial illustrates editing the CSV in Files & Storage',
  /Files\s*&\s*Storage/i.test(csvEditText)
    && csvEditText.includes('/shared/data/seedling-heights.csv')
    && /\bEdit\b/.test(csvEditText) && /\bSave\b/.test(csvEditText)
    && /<figure\b[\s\S]*?<img\b[^>]*\bsrc=["'][^"']+["']/i.test(csvEdit));
check('CSV tutorial keeps optional syntax highlighting a Pro-only feature',
  /\bdata-editions=["']pro["']/i.test(proHighlighting?.[1] || '')
    && /Full[- ]screen/i.test(proHighlightingText)
    && /Syntax highlighting/i.test(proHighlightingText)
    && /optional/i.test(proHighlightingText)
    && /(?:off|unchecked|disabled)\s+by default/i.test(proHighlightingText));
check('CSV tutorial leaves CSV plain text and names supported Pro script extensions',
  /\bCSV\b.{0,100}\bplain text\b|\bplain text\b.{0,100}\bCSV\b/i.test(proHighlightingText)
    && ['.py', '.js', '.R', '.pl'].every(extension => proHighlightingText.includes(extension))
    && /\.pl\b.{0,50}\bProlog\b|\bProlog\b.{0,50}\.pl\b/i.test(proHighlightingText));
check('CSV tutorial packages both the workbook and CSV in a .zip archive',
  /Package\s*\(archive\)/i.test(csvExport) && /\.zip\b/i.test(csvExport)
    && /\bselect\b/i.test(csvExport) && /\bworkbook\b/i.test(csvExport)
    && /\bCSV\b/i.test(csvExport) && /contents tree/i.test(csvExport));
check('CSV tutorial links to reopening the package through Import Package',
  !!csvReopen && /\bhref=["']#reopen["']/i.test(csvTutorial)
    && /Import Package/i.test(csvReopenText) && /\.zip\b/i.test(csvReopenText));
check('CSV tutorial verifies the imported data before rerunning its reading cells',
  /Files\s*&\s*Storage/i.test(csvReopenText)
    && csvReopenText.includes('/shared/data/seedling-heights.csv')
    && /\b(?:check|inspect|verify|confirm|open)\b/i.test(csvReopenText)
    && /\b(?:rerun|run)\b/i.test(csvReopenText)
    && csvReopenText.indexOf('read_csv') >= 0
    && csvReopenText.indexOf('/shared/data/seedling-heights.csv') < csvReopenText.indexOf('read_csv')
    && csvReopenText.indexOf('read_csv') < csvReopenText.indexOf('compare_groups'));
check('CSV tutorial warns against overwriting imported edits with create_csv',
  /\b(?:do not|don['’]t|avoid|skip)\b.{0,180}\bcreate_csv\b/i.test(csvReopenText)
    && /overwrit/i.test(csvReopenText));
check('CSV tutorial offers a downloadable workbook before the next app release',
  /<a\s+download="csv-basics-seedlings\.srwb"\s+href="assets\/csv-basics-seedlings\.srwb"/.test(csvTutorial));

const markovTutorial = readFileSync(path.join(WWW, 'help/workbooks/tutorial/index.html'), 'utf8');
const markovText = helpText(markovTutorial);
const markovMenuSection = (markovTutorial.match(
  /<section\b[^>]*\bid="find-menu"[^>]*>([\s\S]*?)<\/section>/i) || [])[1] || '';
check('Markov tutorial shows where Menu is before Step 1',
  !!markovMenuSection
    && markovTutorial.indexOf('id="find-menu"') < markovTutorial.indexOf('id="browse"')
    && /header row at the top/i.test(helpText(markovMenuSection))
    && /☰ Menu/.test(helpText(markovMenuSection))
    && /three horizontal lines/i.test(helpText(markovMenuSection))
    && /<figure\b/.test(markovMenuSection)
    && markovMenuSection.includes('assets/menu-overlay.svg'));
check('Markov tutorial shows unfiltered Browse before the search and other topics after results',
  markovTutorial.indexOf('assets/phone-browse.png') < markovTutorial.indexOf('Type <strong>Markov Groups')
    && markovTutorial.indexOf('Type <strong>Markov Groups') < markovTutorial.indexOf('assets/phone-search.png')
    && markovTutorial.indexOf('assets/phone-search.png') < markovTutorial.indexOf('What else is available?')
    && /<ol\b[^>]*\bstart="3"/.test(markovTutorial));
check('Markov tutorial links the Free Browse shortcut setup',
  /In Free, the optional/.test(markovText)
    && markovTutorial.includes('../../interface/appearance/#browse-shortcut'));
check('Markov tutorial offers the catalogue folder and distinguishes development from stable',
  markovTutorial.includes('https://github.com/s243a/SciREPL-Catalog/tree/main/workbooks/en')
    && /GitHub link shows the latest development contents/.test(markovText)
    && /SciREPL normally uses the latest stable catalogue release/.test(markovText)
    && /workbooks shown on GitHub may not yet appear in Browse/.test(markovText)
    && /<label\b[^>]*for="catalogue-workbooks-locale"/.test(markovTutorial));
check('Markov tutorial starts with catalogue search, not a new workbook',
  markovText.indexOf('Browse Packages, Bundles & Workbooks') >= 0
    && markovText.indexOf('Browse Packages, Bundles & Workbooks') < markovText.indexOf('cube_moves')
    && markovText.includes('Markov Groups: A Random Walk on Cube Moves'));
check('Markov tutorial names the four code cells in their run order',
  ['cube_moves', 'check_moves', 'show_turn', 'random_walk'].every(name => markovText.includes(name))
    && markovText.indexOf('cube_moves') < markovText.indexOf('check_moves')
    && markovText.indexOf('check_moves') < markovText.indexOf('show_turn')
    && markovText.indexOf('show_turn') < markovText.indexOf('random_walk'));
check('Markov tutorial distinguishes importing from execution',
  /(?:does not|doesn['’]t|without|not)\s+(?:automatically\s+)?(?:execut(?:e|ing)|run)/i.test(markovText));
check('Markov tutorial edits a saved cell, not the composer',
  /pencil|✎/.test(markovText) && /size=12/.test(markovText) && /size=6/.test(markovText)
    && /new-cell panel/i.test(markovText));
check('Markov tutorial separates one-sticker probabilities from full cube states',
  /one-sticker/i.test(markovText) && /not.{0,120}(?:full|every|all).{0,60}cube/i.test(markovText));
check('Markov tutorial offers a pinned catalogue workbook fallback',
  /href="https:\/\/raw\.githubusercontent\.com\/s243a\/SciREPL-Catalog\/v0\.4\.0\/workbooks\/en\/markov-groups\.srwb"/.test(markovTutorial));
check('Markov tutorial identifies the actual screenshot edition',
  /Pro 1\.4\.0-debug/.test(markovText) && /S24\+/.test(markovText));
check('Markov tutorial links a workbook backup workflow',
  /Export Workbooks & Packages/.test(markovText) && /Current tab only/.test(markovText)
    && /Workbook\s*\(\.srwb\)/.test(markovText));
const markovAssets = path.join(WWW, 'help/workbooks/tutorial/assets');
const markovShots = ['browse', 'search', 'workbook', 'checks', 'edit', 'six-moves', 'export'];
check('Markov tutorial contains all seven phone captures plus the annotated header crop',
  (markovTutorial.match(/<figure\b/g) || []).length === markovShots.length + 1
    && markovShots.every(name => markovTutorial.includes(`assets/phone-${name}.png`)
      && markovTutorial.includes(`assets/${name}-overlay.svg`)));
for (const name of markovShots) {
  const png = readFileSync(path.join(markovAssets, `phone-${name}.png`));
  const svg = readFileSync(path.join(markovAssets, `${name}-overlay.svg`), 'utf8');
  check(`Markov ${name} screenshot and editable overlay use the same dimensions`,
    png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      && png.readUInt32BE(16) === 1080 && png.readUInt32BE(20) === 2340
      && /viewBox="0 0 1080 2340"/.test(svg));
}
check('Markov Menu overlay uses the existing unmodified workbook screenshot dimensions',
  markovMenuSection.includes('assets/phone-workbook.png')
    && /viewBox="0 0 1080 2340"/.test(readFileSync(path.join(markovAssets, 'menu-overlay.svg'), 'utf8')));
const markovReceipt = JSON.parse(readFileSync(path.join(markovAssets, 'capture-receipt.json'), 'utf8'));
check('Markov capture receipt records real run results and the export-test limit',
  markovReceipt.imagesUnmodified === true
    && markovReceipt.phoneChecks.allSixMovesPassed === true
    && markovReceipt.phoneChecks.editedSampledMoves.length === 6
    && markovReceipt.limits.some(limit => /destination.{0,100}not selected/i.test(limit)));

const appearanceTutorial = readFileSync(path.join(WWW, 'help/interface/appearance/index.html'), 'utf8');
const appearanceText = helpText(appearanceTutorial);
const browseShortcutSection = (appearanceTutorial.match(
  /<section\b[^>]*\bid="browse-shortcut"[^>]*>([\s\S]*?)<\/section>/i) || [])[1] || '';
check('Appearance tutorial teaches the Free Browse shortcut and the Pro menu fallback',
  /Free 1\.4\.0/.test(helpText(browseShortcutSection))
    && /Show Browse shortcut/.test(helpText(browseShortcutSection))
    && ['Always', 'When there is room', 'Never'].every(value => helpText(browseShortcutSection).includes(value))
    && /Using Pro\?/.test(helpText(browseShortcutSection))
    && /Menu → Browse Packages, Bundles & Workbooks/.test(helpText(browseShortcutSection)));
check('Appearance Browse shortcut deep link includes opening the settings',
  /Open Menu → Appearance\s*, then scroll to Header shortcuts/.test(helpText(browseShortcutSection)));
check('Appearance tutorial explains immediate changes and limited Reset',
  /Closing Appearance.{0,80}does not cancel/i.test(appearanceText)
    && /does not erase your workbook cells/i.test(appearanceText)
    && /not reset the separate Run button or interface-language/i.test(appearanceText));
check('Appearance tutorial separates button size from font zoom and composer Run from cell Run',
  /no text-zoom slider/i.test(appearanceText)
    && /not a general font-size setting/i.test(appearanceText)
    && /new-cell panel.{0,100}not the Run buttons inside saved-cell editors/i.test(appearanceText));
check('Appearance tutorial keeps Android status and navigation bars distinct',
  /status bar, not the navigation or gesture bar/i.test(appearanceText)
    && /absent from the browser\/PWA and Windows/i.test(appearanceText));
const appearanceAssets = path.join(WWW, 'help/interface/appearance/assets');
const appearanceShots = ['menu', 'shortcuts', 'header', 'options', 'theme'];
check('Appearance tutorial contains five annotated Free phone figures',
  (appearanceTutorial.match(/<figure\b/g) || []).length === appearanceShots.length
    && /SciREPL Free 1\.4\.0-debug/.test(appearanceText));
for (const name of appearanceShots) {
  const png = readFileSync(path.join(appearanceAssets, `phone-${name}.png`));
  const svg = readFileSync(path.join(appearanceAssets, `${name}-overlay.svg`), 'utf8');
  check(`Appearance ${name} screenshot and overlay share dimensions`,
    png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      && png.readUInt32BE(16) === 1080 && png.readUInt32BE(20) === 2340
      && /viewBox="0 0 1080 2340"/.test(svg));
}
const appearanceReceipt = JSON.parse(readFileSync(path.join(appearanceAssets, 'capture-receipt.json'), 'utf8'));
check('Appearance capture receipt records Browse visibility and restoration',
  appearanceReceipt.imagesUnmodified === true
    && appearanceReceipt.checks.browseHeaderVisible === true
    && appearanceReceipt.checks.browseOriginalStorageValueRestored === true
    && appearanceReceipt.checks.noNotebookChanges === true);

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
  const catalogueFolder = 'https://github.com/s243a/SciREPL-Catalog/tree/main/workbooks/';
  const tutorialRoute = `${TEST_ORIGIN}/help/workbooks/tutorial/index.html`;
  const folders = ['ar', 'bn', 'de', 'en', 'es', 'fr', 'hi', 'id', 'ja', 'ko', 'pt-BR', 'ru', 'zh'];
  const cataloguePage = await browser.newPage({ viewport: { width: 320, height: 800 } });
  let tutorialLocale = 'en';
  let externalRequests = 0;
  await cataloguePage.route('**/*', async route => {
    if (new URL(route.request().url()).origin !== new URL(TEST_ORIGIN).origin) {
      externalRequests++;
      return route.abort();
    }
    if (route.request().url() === tutorialRoute) {
      return route.fulfill({ contentType: 'text/html',
        body: markovTutorial.replace('<html lang="en">', `<html lang="${tutorialLocale}">`) });
    }
    return route.continue();
  });
  await cataloguePage.goto(tutorialRoute, { waitUntil: 'networkidle' });
  check('Catalogue folder selector names all thirteen actual locale folders',
    JSON.stringify(await cataloguePage.locator('#catalogue-workbooks-locale option')
      .evaluateAll(options => options.map(option => option.value))) === JSON.stringify(folders));
  check('Catalogue selector is labelled, visible and tap-sized',
    await cataloguePage.getByLabel('Workbook language:').isVisible()
      && (await cataloguePage.getByLabel('Workbook language:').boundingBox()).height >= 44);
  for (const folder of folders) {
    await cataloguePage.getByLabel('Workbook language:').selectOption(folder);
    check(`Catalogue language selection points to ${folder}`,
      await cataloguePage.locator('#catalogue-workbooks-link').getAttribute('href') === catalogueFolder + folder
        && await cataloguePage.locator('#catalogue-workbooks-language').textContent()
          === await cataloguePage.locator('#catalogue-workbooks-locale').evaluate(select => select.selectedOptions[0].textContent));
  }
  for (const [locale, folder] of [
    ['en', 'en'], ['fr-FR', 'fr'], ['pt-BR', 'pt-BR'], ['pt', 'pt-BR'],
    ['PT_pt', 'pt-BR'], ['zh-Hant', 'zh'], ['unknown', 'en'], ['', 'en'],
    ['constructor', 'en'], ['../../outside', 'en'],
  ]) {
    tutorialLocale = locale;
    await cataloguePage.goto(tutorialRoute, { waitUntil: 'networkidle' });
    check(`Catalogue link defaults from tutorial locale ${locale || '(empty)'}`,
      await cataloguePage.locator('#catalogue-workbooks-link').getAttribute('href') === catalogueFolder + folder
        && await cataloguePage.getByLabel('Workbook language:').inputValue() === folder);
  }
  check('Catalogue selector does not fetch GitHub or make other external requests', externalRequests === 0);
  await cataloguePage.close();
  const noScript = await browser.newPage({ javaScriptEnabled: false });
  await noScript.goto(tutorialRoute, { waitUntil: 'networkidle' });
  check('Catalogue link remains usable without JavaScript, with no dead selector',
    await noScript.locator('#catalogue-workbooks-link').getAttribute('href') === catalogueFolder + 'en'
      && !await noScript.locator('#catalogue-language-choice').isVisible());
  await noScript.close();
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
