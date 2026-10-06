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
check('Markov tutorial contains all seven annotated phone figures',
  (markovTutorial.match(/<figure\b/g) || []).length === markovShots.length
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
const markovReceipt = JSON.parse(readFileSync(path.join(markovAssets, 'capture-receipt.json'), 'utf8'));
check('Markov capture receipt records real run results and the export-test limit',
  markovReceipt.imagesUnmodified === true
    && markovReceipt.phoneChecks.allSixMovesPassed === true
    && markovReceipt.phoneChecks.editedSampledMoves.length === 6
    && markovReceipt.limits.some(limit => /destination.{0,100}not selected/i.test(limit)));

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
