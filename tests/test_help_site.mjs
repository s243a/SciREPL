// Public-help regression: metadata, links, aliases, and narrow/zoomed layout.
// Run after server.js is listening on http://localhost:8085.

import { chromium } from 'playwright';
import { createHash } from 'node:crypto';
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
  'help/tutorials/index.html',
  'help/getting-started/index.html',
  'help/interface/index.html',
  'help/interface/tutorial/index.html',
  'help/interface/appearance/index.html',
  'help/files-export/tutorial/index.html',
  'help/workbooks/index.html',
  'help/workbooks/tutorial/index.html',
  'help/workbooks/import/index.html',
  'help/workbooks/graphics/index.html',
  'help/workbooks/named-cells/index.html',
  'help/languages-packages/index.html',
  'help/files-export/index.html',
  'help/troubleshooting/index.html',
  'help/privacy/index.html',
  'help/pro/index.html',
  'help/pro/ai/index.html',
  'help/pro/ai/tutorial/index.html',
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
check('Help home directly links to All tutorials',
  /<a\b[^>]*href=["']tutorials\/["'][^>]*>All tutorials<\/a>/i.test(rootHelp));

const tutorialIndexPath = 'help/tutorials/index.html';
const tutorialIndex = readFileSync(path.join(WWW, tutorialIndexPath), 'utf8');
// Curate the cards for readers, but discover lessons from their existing step
// navigation. A future tutorial must not silently be omitted from the index.
const publishedTutorials = walkHtml(path.join(WWW, 'help'))
  .filter(file => /<nav\b[^>]*\bclass=["'][^"']*\blesson-nav\b[^"']*["']/i
    .test(readFileSync(file, 'utf8')))
  .map(file => path.relative(WWW, file).replaceAll(path.sep, '/'))
  .sort();
const indexedTutorials = [...tutorialIndex.matchAll(/<a\b([^>]*)>/gi)]
  .filter(([, attributes]) => /\bclass=["'][^"']*\bcard\b[^"']*["']/i.test(attributes))
  .map(([, attributes]) => {
    const href = (attributes.match(/\bhref=["']([^"']+)["']/i) || [])[1];
    if (!href) return null;
    const target = new URL(href, new URL(BASE_PATH + tutorialIndexPath, ORIGIN));
    if (target.origin !== ORIGIN || !target.pathname.startsWith(BASE_PATH)) return null;
    const relative = decodeURIComponent(target.pathname.slice(BASE_PATH.length));
    return relative.endsWith('/') ? relative + 'index.html' : relative;
  });
check('Tutorial discovery includes the published walkthroughs', publishedTutorials.length >= 7);
for (const rel of publishedTutorials) {
  check(`Tutorial index lists ${rel} exactly once`,
    indexedTutorials.filter(target => target === rel).length === 1);
  const lesson = readFileSync(path.join(WWW, rel), 'utf8');
  const backLinks = [...lesson.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>\s*All tutorials\s*<\/a>/gi)];
  check(`Tutorial ${rel} links back to its index`, backLinks.some(([, href]) =>
    new URL(href, new URL(BASE_PATH + rel, ORIGIN)).href
      === new URL(BASE_PATH + tutorialIndexPath.replace(/index\.html$/, ''), ORIGIN).href));
}
check('Tutorial index cards point only to published lessons',
  indexedTutorials.every(target => publishedTutorials.includes(target)));
check('Tutorial index needs no JavaScript or external stylesheet',
  !/<script\b/i.test(tutorialIndex)
    && /<link\b[^>]*href=["']\.\.\/styles\.css["']/i.test(tutorialIndex));

const csvTutorial = readFileSync(path.join(WWW, 'help/files-export/tutorial/index.html'), 'utf8');
// Check the lesson's meaning without depending on emphasis tags or line wrapping.
const helpText = html => html.replace(/<[^>]*>/g, ' ')
  .replace(/&amp;/gi, '&').replace(/&nbsp;|&#160;/gi, ' ')
  .replace(/&#39;|&apos;/gi, "'").replace(/&quot;/gi, '"')
  .replace(/\s+/g, ' ').trim();

const aiTutorial = readFileSync(path.join(WWW, 'help/pro/ai/tutorial/index.html'), 'utf8');
const aiSection = id => helpText((aiTutorial.match(new RegExp(
  `<section\\b[^>]*\\bid=["']${id}["'][^>]*>([\\s\\S]*?)<\\/section>`, 'i')) || [])[1] || '');
const aiSteps = ['tables', 'key', 'agent', 'online', 'local', 'prompt-cells'];
check('Pro AI tutorial follows tables, key, Open agent, API completion, local model, AI Prompt',
  aiSteps.every((id, index) => aiTutorial.includes(`id="${id}"`)
    && (!index || aiTutorial.indexOf(`id="${aiSteps[index - 1]}"`) < aiTutorial.indexOf(`id="${id}"`))));
check('Pro AI tutorial distinguishes no API charge from the Free edition and touch Auto default',
  /Free.{0,60}means no API charge/i.test(helpText(aiTutorial))
    && /not make them Free-edition features/i.test(helpText(aiTutorial))
    && /desktop on, touch off/i.test(aiSection('tables'))
    && /Accept is not Run/i.test(aiSection('tables')));
const aiTablesMarkup = (aiTutorial.match(
  /<section\b[^>]*\bid="tables"[^>]*>([\s\S]*?)<\/section>/i) || [])[1] || '';
const aiTablesLists = [...aiTablesMarkup.matchAll(/<ol\b([^>]*)>([\s\S]*?)<\/ol>/gi)];
const aiGeneralFigurePosition = aiTablesMarkup.indexOf('src="assets/completion-general.png"');
const aiJavascriptFigurePosition = aiTablesMarkup.indexOf('src="assets/phone-table-javascript.png"');
check('Pro AI table lesson places setup before item 4 and the JavaScript example after acceptance',
  aiTablesLists.length === 2
    && (aiTablesLists[0][2].match(/<li\b/g) || []).length === 3
    && /\bstart="4"/.test(aiTablesLists[1][1])
    && (aiTablesLists[1][2].match(/<li\b/g) || []).length === 1
    && aiGeneralFigurePosition > aiTablesLists[0].index + aiTablesLists[0][0].length
    && aiGeneralFigurePosition < aiTablesLists[1].index
    && aiJavascriptFigurePosition > aiTablesLists[1].index + aiTablesLists[1][0].length
    && aiJavascriptFigurePosition < aiTablesMarkup.indexOf('src="assets/phone-table-ghost.png"'));
check('Pro AI JavaScript example separates hidden extra keys from table-only completion',
  /JavaScript table completion offers const for cons/.test(aiSection('tables'))
    && /the faint t is ghost text, with Accept visible and chips enabled/.test(aiSection('tables'))
    && /extra-key row is hidden here/.test(aiSection('tables'))
    && /not a requirement for completion/.test(aiSection('tables')));
check('Pro AI tutorial puts keys in settings, not workbook source',
  /API Key/i.test(aiSection('key')) && /Saved keys/i.test(aiSection('key'))
    && /without application-level encryption/i.test(aiSection('key'))
    && /Do not paste it into a cell/i.test(aiSection('key')));
check('Pro AI tutorial describes Open and browser limits without promising safe generated code',
  /second-most-permissive/i.test(aiSection('agent'))
    && /Active worksheet/.test(aiSection('agent'))
    && /turn off Auto-run cells created by AI/.test(aiSection('agent'))
    && /not a guarantee/.test(aiSection('agent'))
    && /saved credentials/.test(aiSection('agent'))
    && /Kernels… → JavaScript → Ask/.test(aiSection('agent'))
    && /first 500 characters of each cell/.test(aiSection('agent'))
    && /network restrictions are best-effort/.test(aiSection('agent'))
    && /real shell on the broker host/.test(aiSection('agent')));
check('Pro AI tutorial covers independent completion identity and on-demand consent',
  ['Follow AI Assistant', 'Choose provider and model', 'On tap', 'Always allow', 'first real payload']
    .every(text => aiSection('online').includes(text))
    && /Prefetch while I type is not yet available/.test(aiSection('online'))
    && /completion-only soft spending guards/.test(aiSection('online'))
    && /not the budget for Assistant or AI Prompt/.test(aiSection('online')));
check('Pro AI tutorial qualifies Android memory, delivery and S10 performance claims',
  ['64-bit ARM', '4 GB', '400 MB', 'Google Play', 'Galaxy S24+', 'Galaxy S10+', '460–490 MB']
    .every(text => aiSection('local').includes(text))
    && /did not measure the S10\+/.test(aiSection('local'))
    && /not a measured speed comparison/.test(aiSection('local'))
    && /sideloaded installations cannot download/.test(aiSection('local')));
check('Pro AI tutorial ends with isolated Prompt context and qualified cost savings',
  ['Previous 1 cell', 'Include saved output text', "This cell's output", 'one isolated request',
    'without Assistant history or tools', 'not guaranteed', "Assistant's provider/model", 'language/mode dropdown']
    .every(text => aiSection('prompt-cells').includes(text))
    && /outside the completion spending guards/.test(aiSection('prompt-cells')));
check('Pro AI reference links the guide rather than claiming AI completion is unshipped',
  /href="tutorial\/"/.test(readFileSync(path.join(WWW, 'help/pro/ai/index.html'), 'utf8'))
    && !/AI autocomplete is not shipped/.test(readFileSync(path.join(WWW, 'help/pro/ai/index.html'), 'utf8')));
const aiAssets = path.join(WWW, 'help/pro/ai/tutorial/assets');
const aiReceipt = JSON.parse(readFileSync(path.join(aiAssets, 'capture-pro-ui.json'), 'utf8'));
check('Pro AI captures record a keyless browser UI, not phone or model performance',
  aiReceipt.browser.headless === true && aiReceipt.sourceVersion.version === '1.4.0'
    && !aiReceipt.sourceVersion.scripts
    && ['providerStoreList', 'blockedRequests', 'externalResponses', 'pageErrors']
      .every(field => Array.isArray(aiReceipt[field]) && aiReceipt[field].length === 0)
    && aiReceipt.assistantSettings.autoRunCellsCreatedByAI === false
    && aiReceipt.assistantSettings.sourceBrowsing === false
    && aiReceipt.assistantSettings.securityLevel === 'open'
    && /not an Android screenshot/.test(aiSection('tables'))
    && /keyless browser capture/.test(aiSection('online')));
for (const shot of aiReceipt.screenshots) {
  const png = readFileSync(path.join(aiAssets, shot.file));
  check(`Pro AI ${shot.file} matches its capture receipt`,
    createHash('sha256').update(png).digest('hex') === shot.sha256);
}
const aiGeneralOverlay = readFileSync(path.join(aiAssets, 'completion-general-overlay.svg'), 'utf8');
const aiGeneralPng = readFileSync(path.join(aiAssets, 'completion-general.png'));
check('Pro AI General callouts match the unchanged screenshot and locate headings and settings',
  aiGeneralPng.readUInt32BE(16) === 414 && aiGeneralPng.readUInt32BE(20) === 820
    && /viewBox="0 0 414 820"/.test(aiGeneralOverlay)
    && ['ghost-heading', 'suggestions-setting', 'chips-heading', 'chips-setting']
      .every(id => aiGeneralOverlay.includes(`id="${id}"`))
    && /stroke="#ffd43b"/.test(aiGeneralOverlay)
    && aiTutorial.includes('assets/completion-general-overlay.svg')
    && /Yellow borders locate/.test(aiSection('tables')));
const aiPhoneReceipt = JSON.parse(readFileSync(path.join(aiAssets, 'capture-pro-phone.json'), 'utf8'));
check('Pro AI phone receipt includes the JavaScript example and the existing phone evidence',
  ['phone-table-javascript.png', 'phone-table-ghost.png', 'phone-table-chips.png',
    'phone-online-chips.png', 'phone-agent-result.png']
    .every(file => aiPhoneReceipt.screenshots.some(shot => shot.file === file)));
check('Pro AI JavaScript phone capture verifies ghost acceptance without extra keys or API use',
  aiPhoneReceipt.offline.javascript?.prefix === 'cons'
    && aiPhoneReceipt.offline.javascript.suffix === 't'
    && aiPhoneReceipt.offline.javascript.chipsEnabled === true
    && aiPhoneReceipt.offline.javascript.extraKeysEnabled === false
    && aiPhoneReceipt.offline.javascript.extraKeysVisible === false
    && aiPhoneReceipt.offline.javascript.acceptedBy === 'Accept button'
    && aiPhoneReceipt.offline.javascript.acceptedSource === 'const'
    && aiPhoneReceipt.offline.javascript.providerRequests === 0);
check('Pro AI phone captures distinguish offline tables from a real independent API request',
  aiPhoneReceipt.device.package === 'com.unifyweaver.scirepl.pro.debug'
    && aiPhoneReceipt.device.buildCommit === null
    && aiPhoneReceipt.practiceWorkbookOnly === true
    && aiPhoneReceipt.offline.onlineMode === 'off'
    && aiPhoneReceipt.offline.localModelMode === 'off'
    && aiPhoneReceipt.offline.codeExecuted === false
    && aiPhoneReceipt.offline.ghost.suffix === 'nt'
    && aiPhoneReceipt.offline.ghost.chipsEnabled === true
    && aiPhoneReceipt.offline.ghost.realChipsControl === 'On'
    && aiPhoneReceipt.offline.ghost.providerRequests === 0
    && aiPhoneReceipt.offline.ghost.originalWorkbookDraftLanguageAndSettingsRestored === true
    && aiPhoneReceipt.offline.chips.labels.join(',') === 'sample_mean,sample_median'
    && aiPhoneReceipt.online.model === 'google/gemini-3.5-flash-lite'
    && aiPhoneReceipt.online.assistantModel === 'z-ai/glm-5.3-flash'
    && aiPhoneReceipt.online.independentModel === true
    && aiPhoneReceipt.online.requests === 1 && aiPhoneReceipt.online.status === 200
    && aiPhoneReceipt.online.latencyBenchmark === false);
check('Pro AI ghost lesson keeps chips On and links optional Pro editor controls',
  /You do not need to turn chips off to see ghost text/.test(aiSection('tables'))
    && /With chips still On/.test(aiSection('tables'))
    && !/temporarily set Suggestion chips → Off/.test(aiSection('tables'))
    && aiTutorial.includes('href="../../../interface/appearance/#pro-editor"'));
check('Pro AI phone examples explain ghost acceptance and reject the actual eval alternative',
  /not part of your source until you accept it/.test(aiSection('tables'))
    && /sample_mean/.test(aiSection('tables')) && /sample_median/.test(aiSection('tables'))
    && /Reject that unnecessary eval alternative/.test(aiSection('online'))
    && /not the average-only snippet from Step 4/.test(aiSection('prompt-cells')));
check('Pro AI tutorial explains bounded Continue runs and records a reviewed manual agent run',
  /another bounded run/.test(aiSection('agent'))
    && /Continuing can incur more API charges/.test(aiSection('agent'))
    && aiPhoneReceipt.agent.model === 'z-ai/glm-5.3-flash'
    && aiPhoneReceipt.agent.autoRun === false
    && aiPhoneReceipt.agent.continuePresses === 2 && aiPhoneReceipt.agent.status === 'Done'
    && aiPhoneReceipt.agent.output === 'count: 3\nmean: 15\nmin: 12\nmax: 18'
    && aiPhoneReceipt.agent.providerTotalIndependentlyVerified === false);
for (const shot of aiPhoneReceipt.screenshots) {
  const png = readFileSync(path.join(aiAssets, shot.file));
  check(`Pro AI phone ${shot.file} is an intact full-size PNG linked from its detail view`,
    png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      && png.readUInt32BE(16) === shot.width && png.readUInt32BE(20) === shot.height
      && createHash('sha256').update(png).digest('hex') === shot.sha256
      && aiTutorial.includes(`src="assets/${shot.file}"`)
      && aiTutorial.includes(`href="assets/${shot.file}"`));
}

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
check('Markov tutorial places show_turn and random_walk instructions after the checks screenshot',
  markovTutorial.indexOf('assets/phone-checks.png') < markovTutorial.indexOf('Run <code>show_turn</code>')
    && markovTutorial.indexOf('Run <code>show_turn</code>') < markovTutorial.indexOf('Run <code>random_walk</code>')
    && markovTutorial.indexOf('Run <code>show_turn</code>') < markovTutorial.indexOf('id="show-turn-output"')
    && markovTutorial.indexOf('id="show-turn-output"') < markovTutorial.indexOf('Run <code>random_walk</code>')
    && /<ol\b[^>]*\bstart="4"[^>]*>\s*<li>Run <code>random_walk<\/code>/.test(markovTutorial)
    && /<ol\b[^>]*\bstart="3"[^>]*>\s*<li>Run <code>show_turn<\/code>/.test(markovTutorial));
const showTurnExcerpt = (markovTutorial.match(
  /<pre\b[^>]*\bid="show-turn-output"[^>]*><code>([\s\S]*?)<\/code><\/pre>/i) || [])[1] || '';
check('Markov show_turn excerpt contains the actual U cycles and before/after label output',
  ['1 -&gt; 3 -&gt; 9 -&gt; 7 -&gt; 1', '2 -&gt; 6 -&gt; 8 -&gt; 4 -&gt; 2',
    '19 -&gt; 37 -&gt; 28 -&gt; 46 -&gt; 19', '20 -&gt; 38 -&gt; 29 -&gt; 47 -&gt; 20',
    '21 -&gt; 39 -&gt; 30 -&gt; 48 -&gt; 21', 'F top row labels before U: [19, 20, 21]',
    'F top row labels after U:  [46, 47, 48]', 'U then R equals R then U: False']
    .every(line => showTurnExcerpt.includes(line))
    && /Part of the printed output:/.test(markovText)
    && /long face-letter list is omitted/.test(markovText)
    && /cycle lines use one-based positions/.test(markovText)
    && /row comparison shows sticker labels/.test(markovText));
check('Markov tutorial distinguishes importing from execution',
  /(?:does not|doesn['’]t|without|not)\s+(?:automatically\s+)?(?:execut(?:e|ing)|run)/i.test(markovText));
check('Markov tutorial edits a saved cell, not the composer',
  /pencil|✎/.test(markovText) && /size=12/.test(markovText) && /size=6/.test(markovText)
    && /new-cell panel/i.test(markovText));
check('Markov tutorial separates one-sticker probabilities from full cube states',
  /one-sticker/i.test(markovText) && /not.{0,120}(?:full|every|all).{0,60}cube/i.test(markovText));
check('Markov tutorial offers a pinned catalogue workbook fallback',
  /href="https:\/\/raw\.githubusercontent\.com\/s243a\/SciREPL-Catalog\/v0\.4\.0\/workbooks\/en\/markov-groups\.srwb"/.test(markovTutorial));
check('Markov fallback links the manual import tutorial without changing its example file',
  markovTutorial.includes('href="../import/"')
    && /choose the Markov file above to continue this lesson/.test(markovText));
check('Markov tutorial shows the actual down-chevron workbook selector icon',
  /<svg\b[^>]*aria-label="down-chevron"/.test(markovTutorial)
    && /from the[\s\S]*?<svg\b[\s\S]*?workbook selector/.test(markovTutorial)
    && /workbook selector next to SciREPL in the header/.test(markovText));
check('Markov tutorial identifies the actual screenshot edition',
  /Pro 1\.4\.0-debug/.test(markovText) && /S24\+/.test(markovText));
check('Markov tutorial links a workbook backup workflow',
  /Export Workbooks & Packages/.test(markovText) && /Current tab only/.test(markovText)
    && /Workbook\s*\(\.srwb\)/.test(markovText));
const markovAssets = path.join(WWW, 'help/workbooks/tutorial/assets');
const markovStage4Preview = (markovTutorial.match(
  /<div\b[^>]*\bid="stage4-preview"[^>]*>([\s\S]*?)<\/div>\s*<\/section>/i) || [])[1] || '';
const markovStage4PreviewText = helpText(markovStage4Preview);
const markovCompletion = (markovTutorial.match(
  /<p\b[^>]*\bid="walkthrough-complete"[^>]*>([\s\S]*?)<\/p>/i) || [])[1] || '';
const markovRunSection = (markovTutorial.match(
  /<section\b[^>]*\bid="run"[^>]*>([\s\S]*?)<\/section>/i) || [])[1] || '';
const markovBatchNote = (markovTutorial.match(
  /<aside\b[^>]*\bid="batch-run-note"[^>]*>([\s\S]*?)<\/aside>/i) || [])[1] || '';
check('Markov tutorial explains both batch-run actions before the optional reading boundary',
  /open a saved cell with its ✎ pencil/.test(helpText(markovBatchNote))
    && /Run All Below/.test(helpText(markovBatchNote))
    && /▶↓/.test(helpText(markovBatchNote))
    && /that cell and every cell below it, in order/.test(helpText(markovBatchNote))
    && /Menu → Run All Cells/.test(helpText(markovBatchNote))
    && /selected workbook from its first cell to its last/.test(helpText(markovBatchNote))
    && /not a command to run every workbook tab/.test(helpText(markovBatchNote))
    && /These actions execute code/.test(helpText(markovBatchNote))
    && /does not make the app skip its code cells/.test(helpText(markovBatchNote))
    && /cube_moves/.test(helpText(markovBatchNote))
    && markovRunSection.includes('href="#batch-run-note"')
    && markovTutorial.indexOf('<section id="export">') < markovTutorial.indexOf('id="batch-run-note"')
    && markovTutorial.indexOf('id="batch-run-note"') < markovTutorial.indexOf('id="walkthrough-complete"'));
check('Markov tutorial completes the five app-use steps before optional mathematics',
  /Here to learn the app\?/.test(markovText)
    && /Follow Steps 1–5/.test(markovText)
    && /not needed to complete this walkthrough/.test(markovText)
    && markovTutorial.includes('href="#optional-maths"')
    && /You’ve completed the SciREPL walkthrough/.test(helpText(markovCompletion))
    && /you can stop here/.test(helpText(markovCompletion))
    && markovTutorial.indexOf('<section id="export">') < markovTutorial.indexOf('id="walkthrough-complete"')
    && markovTutorial.indexOf('id="walkthrough-complete"') < markovTutorial.indexOf('<section id="optional-maths">')
    && markovTutorial.indexOf('<section id="optional-maths">') < markovTutorial.indexOf('id="stage4-preview"')
    && !markovRunSection.includes('stage4-preview')
    && !markovRunSection.includes('A little meaning behind the output')
    && /The Step 4 size=12 edit/.test(markovStage4PreviewText)
    && !/The next section/.test(markovStage4PreviewText));
check('Markov tutorial keeps the stable lesson distinct from the pinned development preview',
  /steps and phone screenshots above use the stable v0\.4\.0 workbook/.test(markovStage4PreviewText)
    && /development preview.{0,40}not yet the stable catalogue/.test(markovStage4PreviewText)
    && /https:\/\/raw\.githubusercontent\.com\/s243a\/SciREPL-Catalog\/[a-f0-9]{40}\/workbooks\/en\/markov-groups\.srwb/.test(markovStage4Preview)
    && /Menu → Import File/.test(markovStage4PreviewText)
    && markovTutorial.indexOf('Run <code>random_walk</code>') < markovTutorial.indexOf('id="stage4-preview"'));
check('Markov preview puts the probability chart after sticker_step and before random_walk',
  markovStage4Preview.indexOf('Run <code>transition_matrix</code>') >= 0
    && markovStage4Preview.indexOf('Run <code>transition_matrix</code>') < markovStage4Preview.indexOf('Run <code>sticker_step</code>')
    && markovStage4Preview.indexOf('Run <code>sticker_step</code>') < markovStage4Preview.indexOf('id="sticker-probability-figure"')
    && markovStage4Preview.indexOf('id="sticker-probability-figure"') < markovStage4Preview.indexOf('Run <code>random_walk</code>')
    && /sticker label 1.{0,50}zero-based position 0/.test(markovStage4PreviewText)
    && /not a phone screenshot or a new output produced by the workbook/.test(markovStage4PreviewText)
    && /probability bar chart, not a binned histogram/.test(markovStage4PreviewText));
const stickerProbabilitySvg = readFileSync(path.join(markovAssets, 'sticker-one-step.svg'), 'utf8');
const stickerProbabilityBars = [...stickerProbabilitySvg.matchAll(
  /<rect\s+data-position="(\d+)"\s+data-numerator="(\d+)"\s+data-denominator="(\d+)"[^>]*\bwidth="([\d.]+)"/g)]
  .map(match => ({ position: Number(match[1]), numerator: Number(match[2]), denominator: Number(match[3]), width: Number(match[4]) }));
check('Markov probability illustration matches T[:, 0] and has an accessible zero-probability summary',
  JSON.stringify(stickerProbabilityBars.map(({ position, numerator, denominator }) => [position, numerator, denominator]))
    === JSON.stringify([[0, 7, 13], [2, 1, 13], [6, 1, 13], [18, 1, 13], [35, 1, 13], [42, 1, 13], [47, 1, 13]])
    && stickerProbabilityBars.slice(1).every(bar => Math.abs(bar.width * 7 - stickerProbabilityBars[0].width) < 0.00001)
    && /<title[^>]*>One-step destination probabilities for sticker label 1<\/title>/.test(stickerProbabilitySvg)
    && /All other 47 positions have probability zero and are omitted/.test(stickerProbabilitySvg)
    && /<table\b[^>]*aria-label="Exact one-step probabilities for sticker label 1"/.test(markovStage4Preview)
    && /0.{0,20}7\/13 ≈ 53\.85%/.test(markovStage4PreviewText)
    && /2, 6, 18, 35, 42, 47 \(each\).{0,20}1\/13 ≈ 7\.69%/.test(markovStage4PreviewText));
const markovShots = ['browse', 'search', 'workbook', 'checks', 'edit', 'six-moves', 'export'];
check('Markov tutorial contains all seven phone captures plus the annotated header crop',
  (markovTutorial.match(/<figure\b[^>]*\bclass="phone-figure"/g) || []).length === markovShots.length + 1
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
const appearanceProEditor = helpText((appearanceTutorial.match(
  /<section\b[^>]*\bid="pro-editor"[^>]*>([\s\S]*?)<\/section>/i) || [])[1] || '');
check('Pro Appearance explains both full-screen entry routes and draft-preserving exit',
  /New cell: tap the ⤢ Full screen button in the new-cell code field/.test(appearanceProEditor)
    && /Saved cell: tap that cell's ✎ pencil/.test(appearanceProEditor)
    && /then tap ⤢ in the corner of that cell's code field/.test(appearanceProEditor)
    && /editor label at the top/.test(appearanceProEditor)
    && /Done applies the draft without running it/.test(appearanceProEditor)
    && /Cancel discards the edit/.test(appearanceProEditor)
    && /Done and Cancel both leave full screen without clearing the draft/.test(appearanceProEditor)
    && /does not open the full-screen code editor/.test(appearanceProEditor));
check('Appearance walkthrough distinguishes optional Pro keys, live colours and file highlighting',
  appearanceTutorial.includes('href="#pro-editor"')
    && /Pro only/.test(appearanceProEditor)
    && /Menu → Completion → Section → General/.test(appearanceProEditor)
    && /Extra keys above the keyboard → On/.test(appearanceProEditor)
    && /Menu → Appearance → Syntax colours while typing/.test(appearanceProEditor)
    && /Auto \(desktop on, touch off\)/.test(appearanceProEditor)
    && /6000 characters/.test(appearanceProEditor)
    && /Files & Storage has a separate switch/.test(appearanceProEditor)
    && /Syntax highlighting checkbox is independent/.test(appearanceProEditor)
    && /100,000 characters/.test(appearanceProEditor)
    && /not controls shown in the Free screenshots/.test(appearanceProEditor));
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

const importTutorial = readFileSync(path.join(WWW, 'help/workbooks/import/index.html'), 'utf8');
const importText = helpText(importTutorial);
check('Manual import tutorial downloads the actual Simpson workbook from main, not a release',
  importTutorial.includes('https://github.com/s243a/SciREPL-Catalog/blob/main/workbooks/en/simpsons-paradox.srwb')
    && importTutorial.includes('https://raw.githubusercontent.com/s243a/SciREPL-Catalog/main/workbooks/en/simpsons-paradox.srwb')
    && /main.{0,70}development branch/.test(importText)
    && /not yet in the latest stable catalogue release/.test(importText));
check('Manual import tutorial names both notebook formats correctly',
  /two notebook formats/.test(importText) && importText.includes('.srwb')
    && importText.includes('.ipynb') && !importText.includes('.ipywb'));
check('Manual import tutorial teaches Menu, file selection and preserved tabs',
  /three horizontal lines/.test(importText) && /Import File/.test(importText)
    && /system file picker/.test(importText) && /Downloads/.test(importText)
    && /Your existing tabs are kept/.test(importText)
    && /another import adds another copy/.test(importText));
check('Manual import tutorial identifies R and JavaScript cells without implying auto-execution',
  ['data', 'compute', 'viz', 'js_check'].every(name => importText.includes(name))
    && /does not execute the code when you import an .srwb/.test(importText)
    && /standalone/.test(importText));
check('Manual import tutorial warns about Jupyter auto-execute and separate data',
  /Menu → Settings → Import & Editing/.test(importText)
    && /Auto-execute cells on workbook import/.test(importText)
    && /off \(unchecked\)/.test(importText)
    && /does not carry separate CSV files/.test(importText)
    && importTutorial.includes('../../files-export/tutorial/#reopen'));

const graphicsTutorial = readFileSync(path.join(WWW, 'help/workbooks/graphics/index.html'), 'utf8');
const graphicsText = helpText(graphicsTutorial);
check('Graphics tutorial covers static images, canvas output and KaTeX',
  ['svg', 'javascript', 'math'].every(kind => graphicsTutorial.includes(`data-graphic-example="${kind}"`))
    && graphicsText.includes('data:image/png;base64,')
    && graphicsText.includes('window.renderImage(canvas.toDataURL')
    && graphicsText.includes('KaTeX'));
check('Graphics tutorial distinguishes Markdown rendering from code execution',
  /For an Md cell.{0,100}renders text.{0,100}does not execute JavaScript/.test(graphicsText)
    && /Only canvas_axes needs JavaScript execution/.test(graphicsText));
check('Graphics tutorial teaches editing and ordinary SRWB output loss',
  /pencil/.test(graphicsText) && /new-cell panel/.test(graphicsText)
    && /manual Menu → Import File does not restore that code output/.test(graphicsText)
    && /Markdown source and are displayed on import/.test(graphicsText));
check('Graphics tutorial does not promise KaTeX image inclusion or Android captures',
  /not Android captures/.test(graphicsText)
    && /requires a trust option that SciREPL does not enable/.test(graphicsText)
    && /does not compile TikZ/.test(graphicsText));
const graphicsAssets = path.join(WWW, 'help/workbooks/graphics/assets');
const graphicsBook = JSON.parse(readFileSync(path.join(graphicsAssets, 'workbook-graphics.srwb'), 'utf8'));
check('Graphics download contains four named cells and no saved code outputs',
  JSON.stringify(graphicsBook.notebook.cells.map(c => c.name)) === JSON.stringify(['static_axes', 'embedded_png', 'canvas_axes', 'math_axes'])
    && graphicsBook.notebook.cells.every(c => !c.lastOutputHtml && !c.lastOutput));
for (const name of ['static', 'canvas', 'equations']) {
  const png = readFileSync(path.join(graphicsAssets, `browser-graphics-${name}.png`));
  check(`Graphics ${name} browser capture is 390 by 844`,
    png.readUInt32BE(16) === 390 && png.readUInt32BE(20) === 844);
}

const namedTutorial = readFileSync(path.join(WWW, 'help/workbooks/named-cells/index.html'), 'utf8');
const namedText = helpText(namedTutorial);
check('Named-cell guide is linked where Markov first asks readers to use names',
  markovTutorial.includes('href="../named-cells/"')
    && markovText.indexOf('What do these names mean?') < markovText.indexOf('Run cube_moves'));
check('Markov double-tap shortcut is clearly a Pro callout',
  /<aside\b[^>]*data-editions="pro"[^>]*>[\s\S]*?double-tap[\s\S]*?<\/aside>/.test(markovTutorial));
check('Named-cell guide teaches the naming label rather than the pencil',
  /double-click its In\[…\] label/.test(namedText) && /press and hold that label/.test(namedText)
    && /not the .*pencil/.test(namedText));
check('Named-cell guide separates virtual cell paths and shared files',
  ['/nb/numbers/.output', '/shared/data/named-cell-tutorial/values.json', 'Files & Storage'].every(value => namedText.includes(value))
    && /not a folder in Android/.test(namedText) && /does not browse \/nb\//.test(namedText)
    && /not.{0,100}cloud synchronization/.test(namedText));
check('Named-cell guide distinguishes source replacement from running',
  /not run Bash/.test(namedText) && /source write does not execute the destination/.test(namedText)
    && /read-only/.test(namedText) && /old.{0,30}Total: 16.{0,30}output/.test(namedText));
check('Named-cell guide explains unstable positions and unsaved drafts',
  /current 1-based position/.test(namedText) && /printed In\[…\] number can differ/.test(namedText)
    && /unsaved editor draft is not the stored .code/.test(namedText));
check('Named-cell guide explains shared-file backup and refresh',
  /copy does not update automatically/.test(namedText)
    && /workbook-only .srwb export does not include separate files/.test(namedText)
    && /Package archive export/.test(namedText));
const namedAssets = path.join(WWW, 'help/workbooks/named-cells/assets');
const namedBook = JSON.parse(readFileSync(path.join(namedAssets, 'named-cell-interop.srwb'), 'utf8'));
check('Named-cell download contains the complete named sources without outputs',
  JSON.stringify(namedBook.notebook.cells.map(c => c.name)) === JSON.stringify(['intro', 'numbers', 'inspect_cells', 'write_shared', 'read_shared', 'generate_report', 'bash_report', 'python_total'])
    && namedBook.notebook.cells.every(c => !c.lastOutputHtml && !c.lastOutput)
    && namedBook.notebook.name === 'Named Cell Interop');
for (const name of ['named-cell', 'name-dialog', 'cell-paths', 'shared-values', 'generated-report']) {
  const png = readFileSync(path.join(namedAssets, `browser-${name}.png`));
  check(`Named-cell ${name} browser capture is 390 by 844`,
    png.readUInt32BE(16) === 390 && png.readUInt32BE(20) === 844);
}

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
    if (publishedTutorials.includes(route.slice(1))) {
      const backLink = page.locator('.site-header').getByRole('link', { name: 'All tutorials', exact: true });
      check(`${route} has a visible narrow-screen tutorial-index link`,
        await backLink.isVisible()
          && await backLink.evaluate(link => link.href) === `${TEST_ORIGIN}/help/tutorials/`);
    }
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
