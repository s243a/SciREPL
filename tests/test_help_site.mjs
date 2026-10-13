// Public-help regression: metadata, links, aliases, and narrow/zoomed layout.
// Run after server.js is listening on http://localhost:8085.

import { chromium } from 'playwright';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
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
const aiGeneralFigureEnd = aiTablesMarkup.indexOf('</figure>', aiGeneralFigurePosition) + '</figure>'.length;
const aiJavascriptFigurePosition = aiTablesMarkup.indexOf('src="assets/phone-table-javascript.png"');
check('Pro AI table lesson places the settings figure before practice item 3 and acceptance before its example',
  aiTablesLists.length === 2
    && (aiTablesLists[0][2].match(/<li\b/g) || []).length === 2
    && /\bstart="3"/.test(aiTablesLists[1][1])
    && (aiTablesLists[1][2].match(/<li\b/g) || []).length === 2
    && /Close Completion\./.test(aiTablesLists[1][2])
    && aiTablesLists[1][2].indexOf('Close Completion.') < aiTablesLists[1][2].indexOf('In the screenshot below')
    && aiGeneralFigurePosition > aiTablesLists[0].index + aiTablesLists[0][0].length
    && aiGeneralFigureEnd > aiGeneralFigurePosition
    && aiGeneralFigureEnd < aiTablesLists[1].index
    && aiTablesMarkup.indexOf('View the complete settings capture') < aiGeneralFigureEnd
    && aiJavascriptFigurePosition > aiTablesLists[1].index + aiTablesLists[1][0].length
    && aiJavascriptFigurePosition < aiTablesMarkup.indexOf('src="assets/phone-table-ghost.png"'));
check('Pro AI table lesson defines prefix in the first practice step',
  /These first letters of const are called a prefix/.test(helpText(aiTablesLists[1]?.[2] || '')));
const aiTableAcceptNotes = [...aiTablesMarkup.matchAll(
  /<p class="callout"><strong>Accept is not Run\.<\/strong>[\s\S]*?<\/p>/g)];
check('Pro AI Accept is not Run note immediately follows practice step 4, before its screenshot',
  aiTablesLists.length === 2 && aiTableAcceptNotes.length === 1
    && aiTableAcceptNotes[0].index >= aiTablesLists[1].index + aiTablesLists[1][0].length
    && aiTablesMarkup.slice(aiTablesLists[1].index + aiTablesLists[1][0].length,
      aiTableAcceptNotes[0].index).trim() === ''
    && aiTableAcceptNotes[0].index + aiTableAcceptNotes[0][0].length < aiJavascriptFigurePosition);
check('Pro AI completion exercise explains editing-only scope next to acceptance rather than the distant transition',
  /The JavaScript and Python examples in this section demonstrate autocomplete while editing/.test(helpText(aiTableAcceptNotes[0]?.[0] || ''))
    && /Running these practice cells is not part of this section/.test(helpText(aiTableAcceptNotes[0]?.[0] || ''))
    && !/Review it, then use that editor's Run button|no need to Run them/.test(aiSection('tables'))
    && /After trying these completion displays, switch back to JavaScript and leave chips on/.test(aiSection('tables')));
const aiTablePrefetchNotes = [...aiTablesMarkup.matchAll(
  /<p class="note"><strong>Future online prefetch:<\/strong>[\s\S]*?<\/p>/g)];
const aiJavascriptFigureStart = aiTablesMarkup.lastIndexOf('<figure', aiJavascriptFigurePosition);
check('Pro AI future-prefetch note stays beside the no-request explanation before the screenshot',
  aiTableAcceptNotes.length === 1 && aiTablePrefetchNotes.length === 1
    && aiTablePrefetchNotes[0].index >= aiTableAcceptNotes[0].index + aiTableAcceptNotes[0][0].length
    && aiTablesMarkup.slice(aiTableAcceptNotes[0].index + aiTableAcceptNotes[0][0].length,
      aiTablePrefetchNotes[0].index).trim() === ''
    && aiTablePrefetchNotes[0].index + aiTablePrefetchNotes[0][0].length < aiJavascriptFigureStart
    && aiTablesMarkup.slice(aiTablePrefetchNotes[0].index + aiTablePrefetchNotes[0][0].length,
      aiJavascriptFigureStart).trim() === '');
check('Pro AI JavaScript example separates hidden extra keys from table-only completion',
  /JavaScript table completion offers const for cons/.test(aiSection('tables'))
    && /the faint t is ghost text, with Accept visible and chips enabled/.test(aiSection('tables'))
    && /extra-key row is hidden here/.test(aiSection('tables'))
    && /not a requirement for completion/.test(aiSection('tables')));
check('Pro AI offline suggestions explain kernel and source-derived names without universal live resolution',
  ['variables and functions found in workbook code', 'cached kernel names and object attributes, including methods',
    'Frequency and acceptance history help rank them', 'static lists, unrun definitions or stale snapshots',
    'not currently available in scope'].every(text => aiSection('tables').includes(text)));
check('Pro AI table explanation names the offline chips control and matching method explicitly',
  /The offline chips shown here, enabled under Completion → General → Suggestion chips/.test(aiSection('tables'))
    && /curated name tables with local code information/.test(aiSection('tables'))
    && /Table-based completion is not a language model and does not reason about your task/.test(aiSection('tables'))
    && !/This layer is/.test(aiSection('tables')));
check('Pro AI no-request promise is scoped to current tables and distinguishes future opt-in prefetch',
  /With only the offline table layer enabled, typing a prefix does not send an API request/.test(aiSection('tables'))
    && /Future online prefetch/.test(aiSection('tables'))
    && /an opt-in mode is planned that could send model requests while you type/.test(aiSection('tables'))
    && /not available yet, and no release number is assigned/.test(aiSection('tables')));
check('Pro AI tutorial puts keys in settings, not workbook source',
  /API Key/i.test(aiSection('key')) && /Saved keys/i.test(aiSection('key'))
    && /without application-level encryption/i.test(aiSection('key'))
    && /Do not paste it into a cell/i.test(aiSection('key')));
const aiKeyMarkup = (aiTutorial.match(
  /<section\b[^>]*\bid="key"[^>]*>([\s\S]*?)<\/section>/i) || [])[1] || '';
check('Pro AI key setup places the scroll tip after the gear and the configuration image after key privacy',
  aiKeyMarkup.indexOf("Can't see the gear?") > aiKeyMarkup.indexOf('⚙ gear')
    && aiKeyMarkup.indexOf("Can't see the gear?") < aiKeyMarkup.indexOf('Configure model for → AI Assistant')
    && aiKeyMarkup.indexOf('assets/assistant-key-setup.png') > aiKeyMarkup.indexOf('Keep the key out of the workbook.')
    && /Drag the panel's contents downwards/.test(aiSection('key'))
    && /placeholder, not a saved key/.test(aiSection('key')));
check('Pro AI model examples link primary documentation and qualify version and provider availability',
  ['GLM 5.3 Flash', 'GPT-6 Luna', 'Claude Haiku 5.5', 'DeepSeek V4 Flash']
    .every(name => aiSection('key').includes(name))
    && ['https://openrouter.ai/z-ai/glm-5.3-flash',
      'https://developers.openai.com/api/docs/models/gpt-6-luna',
      'https://www.anthropic.com/claude/haiku',
      'https://api-docs.deepseek.com/quick_start/pricing']
      .every(href => aiKeyMarkup.includes(`href="${href}"`))
    && /depend on your app version and provider/.test(aiSection('key')));
const aiCustomMarkup = (aiTutorial.match(
  /<aside\b[^>]*\bid="custom-model"[^>]*>([\s\S]*?)<\/aside>/i) || [])[1] || '';
const aiCustomText = helpText(aiCustomMarkup);
check('Pro AI missing-model callout follows named examples and gives the real custom-ID route',
  aiKeyMarkup.indexOf('id="custom-model"') > aiKeyMarkup.indexOf('A low-cost, tool-capable model')
    && ['AI Settings → Configure model for → AI Assistant', 'Backend first', 'exact API model ID',
      'Or enter custom model ID', 'below the Model picker', 'already available in Pro 1.4.0']
      .every(text => aiCustomText.includes(text)));
check('Pro AI custom-ID guidance verifies provider format, precedence and compatibility without claiming validation',
  ['organization prefix', 'anthropic/claude-haiku-5.5', "not that page's URL", 'takes precedence over the dropdown',
    'clears the custom field', 'An ID does not add API support', 'support tool calls through the API SciREPL uses',
    'saving does not validate them or make a model request'].every(text => aiCustomText.includes(text))
    && aiCustomMarkup.includes('href="https://openrouter.ai/anthropic/claude-haiku-5.5"'));
const aiAgentMarkup = (aiTutorial.match(
  /<section\b[^>]*\bid="agent"[^>]*>([\s\S]*?)<\/section>/i) || [])[1] || '';
const aiAgentList = (aiAgentMarkup.match(/<ol\b[^>]*>([\s\S]*?)<\/ol>/i) || [])[1] || '';
const aiAgentItems = [...aiAgentList.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)];
const aiPracticePrompt = `In this practice workbook, add a Markdown explanation followed
by one JavaScript cell named summary_demo. Generate an input
array of 10 pseudorandom integers from 1 to 20 inclusive.
Use the Park-Miller generator with initial state 42. For each
value, first update state = (16807 * state) % 2147483647;
then append 1 + Math.floor(20 * state / 2147483647).
Generate the array with this rule; do not hard-code its values
or use Math.random. Reset state to 42 on each cell Run.
Print the generated input array, then compute its count (array
length), arithmetic mean, minimum and maximum. Print each
result on its own labelled line with console.log.
Use ordinary JavaScript arrays, arithmetic and Math.floor,
with no packages.
Do not run cells or change existing cells. Do not use files,
storage, DOM APIs or network requests. Explain the expected
results so I can review the code.`;
check('Pro AI auto-run warning sits directly inside setup instruction 1 before choosing the conversation',
  aiAgentItems.length === 4
    && /id="auto-run-warning"/.test(aiAgentItems[0][1])
    && /Auto-run off is not an execution lock/.test(helpText(aiAgentItems[0][1]))
    && /Your own manual cell Run remains a separate action/.test(helpText(aiAgentItems[0][1]))
    && /In the Assistant panel/.test(helpText(aiAgentItems[1][1]))
    && aiAgentMarkup.split('Auto-run off is not an execution lock.').length === 2);
const aiSetupSafetyMarkup = (((aiAgentItems[0] || [])[1] || '').match(
  /<aside\b[^>]*\bid="sandbox"[^>]*>([\s\S]*?)<\/aside>/i) || [])[1] || '';
check('Pro AI Cautious and sandbox callout follows the auto-run warning inside setup instruction 1 before Send',
  aiAgentItems.length === 4
    && /id="auto-run-warning"[^>]*>[\s\S]*?<\/p>\s*<aside\b[^>]*class="callout"[^>]*id="sandbox"/.test(aiAgentItems[0][1])
    && aiSetupSafetyMarkup.indexOf('If you prefer more confirmation') >= 0
    && aiSetupSafetyMarkup.indexOf('If you prefer more confirmation') < aiSetupSafetyMarkup.indexOf('<h3>')
    && /Cautious/.test(helpText(aiSetupSafetyMarkup))
    && /What the browser sandbox does—and does not—protect/.test(helpText(aiSetupSafetyMarkup))
    && /Remote\/MCP Terminal is different/.test(helpText(aiSetupSafetyMarkup))
    && aiSetupSafetyMarkup.includes('href="../../remote/"')
    && aiAgentMarkup.indexOf('id="sandbox"') < aiAgentMarkup.indexOf('Send the practice prompt')
    && aiAgentMarkup.split('id="sandbox"').length === 2
    && aiAgentMarkup.split('If you prefer more confirmation').length === 2);
check('Pro AI practice prompt is labelled and directly inside instruction 3 before review instruction 4',
  aiAgentItems.length === 4
    && /id="assistant-practice-prompt"/.test(aiAgentItems[2][1])
    && /Copy this prompt/.test(helpText(aiAgentItems[2][1]))
    && /Assistant's message box\s*, not a code cell/.test(helpText(aiAgentItems[2][1]))
    && aiAgentItems[2][1].includes(`<pre><code>${aiPracticePrompt}</code></pre>`)
    && /Read the proposed explanation/.test(helpText(aiAgentItems[3][1]))
    && aiAgentMarkup.split(aiPracticePrompt).length === 2);
check('Pro AI practice prompt specifies generated input, exact seed and rule, and separately labelled summaries',
  /array of 10 pseudorandom integers from 1 to 20 inclusive\./.test(aiPracticePrompt)
    && /Park-Miller generator with initial state 42/.test(aiPracticePrompt)
    && /first update state = \(16807 \* state\) % 2147483647;/.test(aiPracticePrompt)
    && /then append 1 \+ Math\.floor\(20 \* state \/ 2147483647\)\./.test(aiPracticePrompt)
    && /do not hard-code its values\s+or use Math\.random/.test(aiPracticePrompt)
    && /Reset state to 42 on each cell Run\./.test(aiPracticePrompt)
    && /Print the generated input array, then compute its count \(array\s+length\), arithmetic mean, minimum and maximum/.test(aiPracticePrompt)
    && /each\s+result on its own labelled line with console\.log/.test(aiPracticePrompt)
    && /count <strong>10<\/strong>, mean <strong>9\.3<\/strong>, minimum <strong>1<\/strong>, maximum <strong>20<\/strong>/.test(aiAgentItems[3][1]));
// Use exact integer arithmetic independently of the exercise's Number-based
// implementation, including the conversion to the stated integer range.
let summaryState = 42n;
const summaryVector = Array.from({ length: 10 }, () => {
  summaryState = (16807n * summaryState) % 2147483647n;
  return Number(1n + (20n * summaryState) / 2147483647n);
});
const summaryCheck = (aiAgentMarkup.match(
  /<aside\b[^>]*\bid="seeded-summary-check"[^>]*>([\s\S]*?)<\/aside>/i) || [])[1] || '';
const summaryOutput = (summaryCheck.match(/<pre><code>([\s\S]*?)<\/code><\/pre>/i) || [])[1] || '';
check('Pro AI seeded-vector check agrees with an independent exact-integer calculation',
  summaryOutput === `Input: [${summaryVector.join(', ')}]\nCount: ${summaryVector.length}\nMean: ${summaryVector.reduce((a, b) => a + b, 0) / summaryVector.length}\nMinimum: ${Math.min(...summaryVector)}\nMaximum: ${Math.max(...summaryVector)}`
    && /same input and summaries/.test(helpText(summaryCheck))
    && /not security-sensitive randomness/.test(helpText(summaryCheck)));
check('Pro AI real phone result matches the current seeded exercise and distinguishes manual execution',
  /Actual Galaxy S24\+ Android screenshot of the seeded-vector exercise above/.test(helpText(aiAgentMarkup))
    && /count 10, mean 9\.3, minimum 1 and maximum 20/.test(helpText(aiAgentMarkup))
    && /run manually—not automatically by the agent/.test(helpText(aiAgentMarkup))
    && /second manual Run reproduced the same results/.test(helpText(aiAgentMarkup))
    && /output and part of the source/.test(helpText(aiAgentMarkup)));
check('Pro AI Prompt follow-up asks about the matching seeded calculation rather than the old fixed array',
  /generator rule and seed 42 determine its input array/.test(aiSection('prompt-cells'))
    && /count 10, mean 9\.3, minimum 1 and maximum 20/.test(aiSection('prompt-cells'))
    && /resetting the seed make the result repeatable/.test(aiSection('prompt-cells')));
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
const aiExecutionText = helpText((aiTutorial.match(
  /<aside\b[^>]*\bid="execution-permissions"[^>]*>([\s\S]*?)<\/aside>/i) || [])[1] || '');
check('Pro AI future execution details are a linked appendix after the walkthrough and troubleshooting',
  aiTutorial.indexOf('id="execution-permissions"') > aiTutorial.lastIndexOf('</section>')
    && /Appendix · Upcoming execution approval/.test(aiExecutionText)
    && !aiAgentMarkup.includes('id="execution-permissions"')
    && aiAgentItems[0][1].includes('href="#execution-permissions"')
    && /<aside\b[^>]*id="execution-permissions"[^>]*aria-labelledby="execution-appendix-title"/.test(aiTutorial)
    && aiTutorial.split('id="execution-permissions"').length === 2);
check('Pro AI tutorial separates released Open defaults from a provisional unreleased update',
  /Released Pro 1\.4\.0's Open default can allow them without asking/.test(aiSection('agent'))
    && /The upcoming Open default asks/.test(aiSection('agent'))
    && /proposed Pro 1\.5\.0/.test(aiExecutionText)
    && /Unreleased/.test(aiExecutionText) && /release number is provisional/.test(aiExecutionText));
const aiVersionNote = (aiTutorial.match(
  /<p class="callout"><strong>Check your version\.<\/strong>([\s\S]*?)<\/p>/) || [])[1] || '';
check('Pro AI opening version note links the unreleased appendix without repeating section details',
  aiVersionNote.includes('href="#execution-permissions"')
    && /proposed Pro 1\.5\.0/.test(helpText(aiVersionNote))
    && /unreleased/.test(helpText(aiVersionNote))
    && /final release number may change/.test(helpText(aiVersionNote))
    && !/Open|Kernels|Offline tables|on-tap API|separate completion model|Android local model/.test(helpText(aiVersionNote)));
check('Pro AI execution guide identifies real settings and independent override precedence',
  /AI Settings → Security… → execute_cell \/ run_cells/.test(aiExecutionText)
    && /Default \/ Allow \/ Ask \/ Deny/.test(aiExecutionText)
    && /already offers Default \/ Allow \/ Ask \/ Deny/.test(aiExecutionText)
    && /changes Open's inherited Default to Ask/.test(aiExecutionText)
    && /when both are explicit, the safer rule wins/.test(aiExecutionText)
    && /Auto-run off is not an execution lock/.test(aiSection('agent'))
    && /explicit tool or kernel Allow can change that default/.test(aiSection('agent')));
check('Pro AI execution guide limits standing-grant creation and warns about cross-workbook scope',
  /leave Allow future Assistant cell execution without asking unchecked/.test(aiExecutionText)
    && /all workbooks/.test(aiExecutionText)
    && /explicit kernel Ask hides that option/.test(aiExecutionText)
    && /Namespace-inspection and newly created-cell prompts cannot create that standing grant/.test(aiExecutionText)
    && /bounded code preview/.test(aiExecutionText) && /long preview ends with an ellipsis/.test(aiExecutionText)
    && /saved execution Allow can still permit created-cell autorun/.test(aiExecutionText));
check('Pro AI execution guide distinguishes staged preset changes and separate sending consent',
  ['Reset to Default', 'Keep Allow', 'Cancel', 'without clearing kernel overrides',
    'Cancel restores the previous preset selection', 'draft changes until you save Settings',
    'Execution approval is not blanket permission to share data',
    "Execution-tool outputs can return to the Assistant's model",
    'permitted code can use networking', 'MCP notebook execution uses the same execution checks']
    .every(text => aiExecutionText.includes(text))
    && /Online completion's Always allow\s*, AI Prompt's context review, and Remote\/MCP's privacy disclosure remain separate/.test(aiExecutionText));
const aiContextMarkup = (aiTutorial.match(
  /<aside\b[^>]*\bid="planned-workbook-context"[^>]*>([\s\S]*?)<\/aside>/i) || [])[1] || '';
const aiContextText = helpText(aiContextMarkup);
check('Pro AI current workbook disclosure links a separate design-only context appendix',
  /first 500 characters of each cell/.test(aiSection('agent'))
    && aiAgentMarkup.includes('href="#planned-workbook-context"')
    && aiTutorial.indexOf('id="planned-workbook-context"') > aiTutorial.lastIndexOf('</section>')
    && /<aside\b[^>]*id="planned-workbook-context"[^>]*aria-labelledby="context-appendix-title"/.test(aiTutorial)
    && /Design proposal only/.test(aiContextText)
    && /not implemented or assigned to a release/.test(aiContextText)
    && /separate from the upcoming execution-approval changes/.test(aiContextText));
check('Pro AI planned summary uses metadata tooling rather than an automatic source or model summary',
  ['metadata-only directory tool', 'cell names, optional descriptions, languages and types',
    'list_cells', 'view: "metadata"', 'read selected source separately',
    'not an automatically generated AI explanation'].every(text => aiContextText.includes(text)));
check('Pro AI attach-once idea discloses its tentative default, actual-send consumption and privacy boundaries',
  ['Attach workbook summary this time', 'could start checked for a fresh conversation',
    'after that attachment is actually sent', 'initial default still needs privacy and usability review',
    'Continuations would not add another summary', 'switching tabs would not silently re-enable it',
    'existing read/privacy permissions', 'not remove summaries already in the conversation',
    'prevent allowed tool reads'].every(text => aiContextText.includes(text)));
check('Pro AI optional changes and Git/GitHub history are scoped future features with separate sharing',
  ['known sent-context baseline', 'agent edits, imports and unknown changes',
    'not automatically rewrite a cell', 'longer-term Pro ideas', 'Local Send checkpoints',
    'Gist or a chosen file in a repository', 'Enabling history would not push to GitHub',
    'not proof that a human made them', 'A secret Gist is not private',
    'Anyone with its URL can read it', 'use a private repository'].every(text => aiContextText.includes(text))
    && aiContextMarkup.includes('href="https://docs.github.com/en/get-started/writing-on-github/editing-and-sharing-content-with-gists/creating-gists"'));
check('Pro AI tutorial retains honest pre-update screenshot provenance',
  /browser capture predates the execution-consent update/.test(aiSection('agent'))
    && /upcoming approval and override dialogs are not pictured/.test(aiSection('agent'))
    && !/Open also lets the agent execute allowed kernels/.test(aiSection('agent')));
const aiReferenceText = helpText(readFileSync(path.join(WWW, 'help/pro/ai/index.html'), 'utf8'));
const aiOverviewText = helpText(readFileSync(path.join(WWW, 'help/pro/index.html'), 'utf8'));
const aiRemoteText = helpText(readFileSync(path.join(WWW, 'help/pro/remote/index.html'), 'utf8'));
check('Pro reference pages qualify historical defaults and share the pending-release explanation',
  /In Pro 1\.3\.0 and 1\.4\.0/.test(aiReferenceText)
    && [aiReferenceText, aiOverviewText, aiRemoteText].every(text =>
      /proposed Pro 1\.5\.0|proposed for Pro 1\.5\.0/i.test(text) && /unreleased/i.test(text))
    && /version provisional/.test(aiReferenceText)
    && /Execution approval, Remote-data consent and access to a Terminal shell are distinct permissions/.test(aiRemoteText));
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
const aiOpenPng = readFileSync(path.join(aiAssets, 'assistant-open.png'));
const aiOpenOverlay = readFileSync(path.join(aiAssets, 'assistant-open-overlay.svg'), 'utf8');
const aiOpenFigureMatch = aiAgentMarkup.match(
  /<figure\b[^>]*\bid="assistant-run-controls"[^>]*>([\s\S]*?)<\/figure>/i);
const aiOpenFigure = (aiOpenFigureMatch || [])[1] || '';
const aiOpenRects = [...aiOpenOverlay.matchAll(/<rect\b[^>]*\bx="([\d.]+)"[^>]*\by="([\d.]+)"[^>]*\bwidth="([\d.]+)"[^>]*\bheight="([\d.]+)"/g)];
check('Pro AI execution settings overlay matches the original PNG and outlines five relevant controls',
  aiOpenPng.readUInt32BE(16) === 390 && aiOpenPng.readUInt32BE(20) === 1100
    && /viewBox="0 0 390 1100"/.test(aiOpenOverlay)
    && /stroke="#ffd43b"/.test(aiOpenOverlay)
    && ['auto-run-setting', 'source-browsing-setting', 'agent-writes-setting',
      'max-steps-setting', 'security-level-setting']
      .every(id => aiOpenOverlay.includes(`id="${id}"`))
    && aiOpenRects.length === 5
    && aiOpenRects
      .every(([, x, y, width, height]) => Number(x) > 0 && Number(y) > 0
        && Number(x) + Number(width) < 390 && Number(y) + Number(height) < 1100));
check('Pro AI execution highlights extend to both GUI margins without clipping their strokes',
  aiOpenRects.length === 5 && aiOpenRects.every(([, x, , width]) =>
    Number(x) === 3 && Number(width) === aiOpenPng.readUInt32BE(16) - 6));
check('Pro AI execution figure keeps controls accessible and links the original without changing provenance',
  /role="img" aria-label="[^\"]*Auto-run[^\"]*Allow source browsing[^\"]*Max steps/.test(aiOpenFigure)
    && aiOpenFigure.includes('src="assets/assistant-open-overlay.svg"')
    && ['both unchecked', 'Agent writes → Active worksheet', 'Agent limits (per run)',
      'Security Level → Open', 'browser capture predates the execution-consent update']
      .every(text => helpText(aiOpenFigure).includes(text))
    && aiOpenFigure.includes('href="assets/assistant-open.png"'));
check('Pro AI Continue explanation points to the pictured per-run Max steps control',
  /Agent limits \(per run\) → Max steps\s*, highlighted below, controls the step allowance/.test(aiSection('agent'))
    && /Continuing can incur more API charges/.test(aiSection('agent'))
    && /not needed after Done/.test(aiSection('agent')));
const aiSeededCheckAside = aiAgentMarkup.match(
  /<aside\b[^>]*\bid="seeded-summary-check"[^>]*>[\s\S]*?<\/aside>/i);
const aiAgentResultFigures = [...aiAgentMarkup.matchAll(/<figure\b[^>]*>[\s\S]*?<\/figure>/gi)]
  .filter(match => match[0].includes('src="assets/phone-agent-result.png"'));
const aiBeforeSendPosition = aiAgentMarkup.indexOf('<strong>Before Send:</strong>');
check('Pro AI seeded phone result immediately follows the expected-output check before the sending-context note',
  aiSeededCheckAside && aiAgentResultFigures.length === 1
    && aiAgentResultFigures[0].index >= aiSeededCheckAside.index + aiSeededCheckAside[0].length
    && !aiAgentMarkup.slice(aiSeededCheckAside.index + aiSeededCheckAside[0].length,
      aiAgentResultFigures[0].index).trim()
    && aiBeforeSendPosition > aiAgentResultFigures[0].index + aiAgentResultFigures[0][0].length);
const aiContinueParagraph = aiAgentMarkup.match(
  /<p\b[^>]*><strong>Paused with a Continue button\?<\/strong>[\s\S]*?<\/p>/i);
check('Pro AI Continue explanation immediately precedes its execution-settings figure',
  aiContinueParagraph && aiOpenFigureMatch
    && aiAgentMarkup.split('Paused with a Continue button?').length === 2
    && aiOpenFigureMatch.index >= aiContinueParagraph.index + aiContinueParagraph[0].length
    && !aiAgentMarkup.slice(aiContinueParagraph.index + aiContinueParagraph[0].length,
      aiOpenFigureMatch.index).trim());
const aiPhoneReceipt = JSON.parse(readFileSync(path.join(aiAssets, 'capture-pro-phone.json'), 'utf8'));
const aiKeyReceipt = JSON.parse(readFileSync(path.join(aiAssets, 'capture-pro-key-setup.json'), 'utf8'));
check('Pro AI configuration capture is keyless, guarded and measured without sending a request',
  aiKeyReceipt.sourceSha === aiReceipt.sourceSha
    && aiKeyReceipt.sourceGuards.exactShaBeforeAndAfter === true
    && aiKeyReceipt.sourceGuards.trackedSourceCleanBeforeAndAfter === true
    && aiKeyReceipt.actualUi.apiKeyEmpty === true
    && aiKeyReceipt.actualUi.settingsSaved === false
    && aiKeyReceipt.actualUi.configureModelFor === 'assistant'
    && aiKeyReceipt.actualUi.backend === 'openrouter'
    && aiKeyReceipt.actualUi.model === 'z-ai/glm-5.3-flash'
    && ['providerStoreList', 'blockedRequests', 'externalResponses', 'pageErrors']
      .every(field => Array.isArray(aiKeyReceipt[field]) && aiKeyReceipt[field].length === 0));
for (const asset of [aiKeyReceipt.screenshot, aiKeyReceipt.overlay]) {
  const bytes = readFileSync(path.join(aiAssets, asset.file));
  check(`Pro AI ${asset.file} matches the keyless capture receipt`,
    createHash('sha256').update(bytes).digest('hex') === asset.sha256
      && aiTutorial.includes(`src="assets/${asset.file}"`));
}
const aiKeyOverlay = readFileSync(path.join(aiAssets, aiKeyReceipt.overlay.file), 'utf8');
check('Pro AI configuration overlay highlights the four actual setup fields',
  /viewBox="0 0 390 538"/.test(aiKeyOverlay)
    && ['configure-target', 'backend-setting', 'model-setting', 'api-key-setting']
      .every(id => aiKeyOverlay.includes(`id="${id}"`))
    && aiKeyReceipt.overlay.highlights.length === 4);
const aiCustomReceipt = JSON.parse(readFileSync(path.join(aiAssets, 'capture-pro-custom-model.json'), 'utf8'));
check('Pro AI custom-model capture is a separately pinned, genuinely keyless UI entry',
  aiCustomReceipt.sourceSha === '6dbc4d0793e04f0ea051d2e464032bf8fcab09d5'
    && aiCustomReceipt.sourceGuards.exactShaBeforeAndAfter === true
    && aiCustomReceipt.sourceGuards.trackedSourceCleanBeforeAndAfter === true
    && aiCustomReceipt.actualUi.backend === 'openrouter'
    && aiCustomReceipt.actualUi.configureModelFor === 'assistant'
    && aiCustomReceipt.actualUi.customModelId === 'anthropic/claude-haiku-5.5'
    && aiCustomReceipt.actualUi.customIdAbsentFromPicker === true
    && aiCustomReceipt.actualUi.customIdEnteredThroughUi === true
    && aiCustomReceipt.actualUi.apiKeyEmpty === true
    && aiCustomReceipt.actualUi.apiKeyOutsideCrop === true
    && aiCustomReceipt.actualUi.settingsSaved === false
    && ['providerStoreList', 'blockedRequests', 'externalResponses', 'pageErrors']
      .every(field => Array.isArray(aiCustomReceipt[field]) && aiCustomReceipt[field].length === 0));
for (const asset of [aiCustomReceipt.screenshot, aiCustomReceipt.overlay]) {
  const bytes = readFileSync(path.join(aiAssets, asset.file));
  check(`Pro AI ${asset.file} matches its independent custom-model receipt`,
    createHash('sha256').update(bytes).digest('hex') === asset.sha256
      && aiTutorial.includes(`src="assets/${asset.file}"`));
}
const aiCustomPng = readFileSync(path.join(aiAssets, aiCustomReceipt.screenshot.file));
const aiCustomOverlay = readFileSync(path.join(aiAssets, aiCustomReceipt.overlay.file), 'utf8');
check('Pro AI custom-model picture highlights actual controls and makes the untested state clear',
  aiCustomPng.readUInt32BE(16) === 390 && aiCustomPng.readUInt32BE(20) === 456
    && /viewBox="0 0 390 456"/.test(aiCustomOverlay)
    && ['backend-setting', 'custom-model-setting'].every(id => aiCustomOverlay.includes(`id="${id}"`))
    && aiCustomReceipt.overlay.highlights.length === 2
    && /dropdown still shows GLM 5.3 Flash/.test(aiSection('key'))
    && /configuration example, not a test that the model works/.test(aiSection('key')));
check('Pro AI expanded position screenshot follows the alternative and explains whole-cell and native-menu limits',
  aiTablesMarkup.indexOf('assets/phone-completion-position.png')
      > aiTablesMarkup.indexOf('<strong>End of cell only</strong> is an alternative')
    && /whole cell\s*, not each line/.test(aiSection('tables'))
    && /expanded menu covers the nearby indentation settings/.test(aiSection('tables'))
    && aiPhoneReceipt.completionPositionMenu.nativeAndroidMenuOpen === true
    && aiPhoneReceipt.completionPositionMenu.options.map(option => option.value).join(',') === 'caret,end'
    && aiPhoneReceipt.completionPositionMenu.providerRequests === 0
    && aiPhoneReceipt.completionPositionMenu.settingsRestored === true);
check('Pro AI phone receipt includes the JavaScript example and the existing phone evidence',
  ['phone-completion-position.png', 'phone-table-javascript.png', 'phone-table-ghost.png', 'phone-table-chips.png',
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
    && aiPhoneReceipt.agent.maxStepsPerRun === 4
    && aiPhoneReceipt.agent.stepBursts.join(',') === '4,1'
    && aiPhoneReceipt.agent.continuePresses === 1 && aiPhoneReceipt.agent.status === 'Done'
    && aiPhoneReceipt.agent.output === `input: ${summaryVector.join(', ')}\ncount: 10\nmean: 9.3\nmin: 1\nmax: 20`
    && JSON.stringify(aiPhoneReceipt.agent.input) === JSON.stringify(summaryVector)
    && aiPhoneReceipt.agent.initialState === 42
    && aiPhoneReceipt.agent.manualRuns === 2 && aiPhoneReceipt.agent.repeatableOutput === true
    && aiPhoneReceipt.agent.generatedSourceUnchangedExceptTrailingWhitespace === true
    && aiPhoneReceipt.agent.originalWorkbookDraftLanguageAndSnapshottedSettingsRestored === true
    && aiPhoneReceipt.agent.providerRequests === 5
    && aiPhoneReceipt.agent.providerStatuses.length === aiPhoneReceipt.agent.providerRequests
    && aiPhoneReceipt.agent.providerStatuses.every(status => status === 200)
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

const aiContextReceipt = JSON.parse(readFileSync(path.join(aiAssets, 'capture-pro-assistant-context.json'), 'utf8'));
const aiContextFigure = (aiAgentMarkup.match(
  /<figure\b[^>]*\bid="assistant-context-controls"[^>]*>([\s\S]*?)<\/figure>/i) || [])[1] || '';
check('Pro AI conversation and toggle figure sits inside instruction 2 before sending the practice prompt',
  aiAgentItems.length === 4
    && aiAgentItems[1][1].includes('id="assistant-context-controls"')
    && aiAgentItems[1][1].indexOf('id="assistant-context-controls"') > aiAgentItems[1][1].indexOf('In the Assistant panel')
    && aiAgentMarkup.indexOf('id="assistant-context-controls"') < aiAgentMarkup.indexOf('Send the practice prompt')
    && aiAgentMarkup.split('id="assistant-context-controls"').length === 2);
check('Pro AI panel figure names both detail views, unchecked toggles, and the unchanged full phone screenshot',
  ['Two details of the same actual Galaxy S24+ Android screenshot', 'This workbook',
    'Review', 'Remote', 'Terminal', 'all unchecked', 'empty middle of the panel is omitted',
    'No prompt was sent'].every(text => helpText(aiContextFigure).includes(text))
    && (aiContextFigure.match(/role="img" aria-label="/g) || []).length === 2
    && (aiContextFigure.match(/src="assets\/phone-assistant-context-overlay\.svg"[^>]*aria-hidden="true"/g) || []).length === 2
    && aiContextFigure.includes('href="assets/phone-assistant-context.png"'));
check('Pro AI panel capture records actual controls and restored state without sending or executing anything',
  aiContextReceipt.device.package === 'com.unifyweaver.scirepl.pro.debug'
    && aiContextReceipt.device.buildCommit === null
    && aiContextReceipt.actualUi.scope === 'workbook'
    && aiContextReceipt.actualUi.scopeLabel === 'This workbook'
    && aiContextReceipt.actualUi.securityPreset === 'open'
    && ['review', 'remote', 'terminal', 'sendPressed', 'codeExecuted']
      .every(field => aiContextReceipt.actualUi[field] === false)
    && aiContextReceipt.actualUi.promptEmpty === true
    && aiContextReceipt.actualUi.practiceCellCount === 0
    && aiContextReceipt.actualUi.conversationEntryCount === 0
    && aiContextReceipt.monitor.providerRequests === 0
    && aiContextReceipt.monitor.externalFetchOrXhrRequests === 0
    && aiContextReceipt.monitor.originalFunctionsRestored === true
    && Object.values(aiContextReceipt.cleanup).every(value => value === true));
const aiContextPng = readFileSync(path.join(aiAssets, aiContextReceipt.screenshot.file));
const aiContextOverlay = readFileSync(path.join(aiAssets, aiContextReceipt.overlay.file), 'utf8');
check('Pro AI panel screenshot and editable overlay match their independent capture receipt',
  aiContextPng.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    && aiContextPng.readUInt32BE(16) === 1080 && aiContextPng.readUInt32BE(20) === 2340
    && aiContextReceipt.screenshot.width === 1080 && aiContextReceipt.screenshot.height === 2340
    && createHash('sha256').update(aiContextPng).digest('hex') === aiContextReceipt.screenshot.sha256
    && createHash('sha256').update(aiContextOverlay).digest('hex') === aiContextReceipt.overlay.sha256
    && /viewBox="0 0 1080 2340"/.test(aiContextOverlay)
    && /fill="none" stroke="#ffd43b"/.test(aiContextOverlay));
const aiContextRects = [...aiContextOverlay.matchAll(
  /<rect\b[^>]*\bid="([^"]+)"[^>]*\bx="([\d.]+)"[^>]*\by="([\d.]+)"[^>]*\bwidth="([\d.]+)"[^>]*\bheight="([\d.]+)"/g)];
check('Pro AI panel outlines identify exactly the selected scope and three off toggles within their detail views',
  aiContextRects.length === 4
    && aiContextReceipt.overlay.highlights.map(item => item.id).join(',')
      === 'this-workbook-setting,review-setting,remote-setting,terminal-setting'
    && aiContextRects.every(([, id, x, y, width, height], index) => {
      const recorded = aiContextReceipt.overlay.highlights[index];
      const view = aiContextReceipt.displayViews[index === 0 ? 0 : 1];
      return id === recorded.id
        && ['x', 'y', 'width', 'height'].every((key, i) => recorded.bounds[key] === Number([x, y, width, height][i]))
        && Number(x) >= view.x && Number(x) + Number(width) <= view.x + view.width
        && Number(y) >= view.y && Number(y) + Number(height) <= view.y + view.height;
    }));
const aiTutorialCss = readFileSync(path.join(WWW, 'help/pro/ai/tutorial/tutorial.css'), 'utf8');
check('Pro AI panel detail crops match their documented windows without editing the source image',
  aiContextReceipt.displayViews.length === 2
    && ['header', 'footer'].every((name, index) => {
      const view = aiContextReceipt.displayViews[index];
      const css = (aiTutorialCss.match(new RegExp(`\\.shot-window--assistant-context-${name}\\s*\\{([^}]+)\\}`)) || [])[1] || '';
      const shift = Number((css.match(/--shift:\s*([\d.-]+)%/) || [])[1]);
      return aiContextFigure.includes(`shot-window--assistant-context-${name}`)
        && css.includes(`aspect-ratio: ${view.width} / ${view.height}`)
        && Math.abs(shift / 100 + view.y / aiContextReceipt.screenshot.height) < 0.00000001;
    }));

const aiPreviewReceipt = JSON.parse(readFileSync(path.join(aiAssets, 'capture-pro-completion-preview-phone.json'), 'utf8'));
const aiOnlineMarkup = (aiTutorial.match(
  /<section\b[^>]*\bid="online"[^>]*>([\s\S]*?)<\/section>/i) || [])[1] || '';
const aiChooseCodeCallout = aiOnlineMarkup.match(
  /<p\b[^>]*><strong>Choose the code, not just an AI chip\.<\/strong>[\s\S]*?<\/p>/i);
const aiPreviewFigureMatch = aiOnlineMarkup.match(
  /<figure\b[^>]*\bid="online-completion-preview"[^>]*>[\s\S]*?<\/figure>/i);
const aiPreviewFigure = aiPreviewFigureMatch?.[0] || '';
const aiPreviewCaption = helpText((aiPreviewFigure.match(/<figcaption>([\s\S]*?)<\/figcaption>/i) || [])[1] || '');
check('Pro AI online preview immediately follows the code-review callout in Step 4',
  aiChooseCodeCallout && aiPreviewFigureMatch
    && aiTutorial.split('id="online-completion-preview"').length === 2
    && aiPreviewFigureMatch.index >= aiChooseCodeCallout.index + aiChooseCodeCallout[0].length
    && !aiOnlineMarkup.slice(aiChooseCodeCallout.index + aiChooseCodeCallout[0].length,
      aiPreviewFigureMatch.index).trim()
    && aiOnlineMarkup.indexOf('The request asks for up to five alternatives')
      > aiPreviewFigureMatch.index + aiPreviewFigure.length);
check('Pro AI preview explains immediate insertion through a chosen logical line, not a selection-confirmation workflow',
  /for a multi-line suggestion, tap or click the last line you want/i.test(aiPreviewCaption)
    && /immediately inserts everything from the first line through that line, leaving later lines out/i.test(aiPreviewCaption)
    && /Insert all accepts the whole suggestion/.test(aiPreviewCaption)
    && /Cancel inserts nothing/.test(aiPreviewCaption)
    && /one code line, even though it wraps on screen/.test(aiPreviewCaption)
    && /tapping it accepts the whole expression/.test(aiPreviewCaption)
    && /Accepting edits the source; it does not Run the cell/.test(aiPreviewCaption));
check('Pro AI preview records one guarded toy request, an unknown phone build, and no acceptance or execution',
  aiPreviewReceipt.schemaVersion === 1
    && aiPreviewReceipt.sourceRepository === 'SciREPL-Pro'
    && aiPreviewReceipt.captureMethod === 'Android screencap; unmodified full-screen PNG'
    && aiPreviewReceipt.device.model === 'SM-S926W'
    && aiPreviewReceipt.device.package === 'com.unifyweaver.scirepl.pro.debug'
    && aiPreviewReceipt.device.buildCommit === null
    && aiPreviewReceipt.request.backend === 'openrouter'
    && aiPreviewReceipt.request.model === 'google/gemini-3.5-flash-lite'
    && aiPreviewReceipt.request.count === 1 && aiPreviewReceipt.request.status === 200
    && aiPreviewReceipt.request.maxOutputTokens === 500
    && aiPreviewReceipt.request.guardedBeforeDispatch === true
    && aiPreviewReceipt.request.source === 'const values = [12, 15, 18];\nconst average = '
    && aiPreviewReceipt.request.privateWorkbookSent === false
    && aiPreviewReceipt.request.providerBillIndependentlyVerified === false
    && aiPreviewReceipt.preview.text === aiPhoneReceipt.online.firstAlternative
    && aiPreviewReceipt.preview.logicalLineCount === 1
    && aiPreviewReceipt.preview.text.split('\n').length === aiPreviewReceipt.preview.logicalLineCount
    && aiPreviewReceipt.preview.visuallyWrapped === true
    && aiPreviewReceipt.preview.displayedTier === 'unverified'
    && aiPreviewReceipt.preview.sourceUnchangedWhenOpened === true
    && aiPreviewReceipt.preview.accepted === false
    && aiPreviewReceipt.preview.codeExecuted === false
    && /new Gemini(?: 3\.5)? Flash-Lite request returned the same/.test(aiPreviewCaption));
check('Pro AI preview capture restores workbook, draft, language, settings, credentials and monitoring',
  ['originalWorkbookRestored', 'originalDraftRestored', 'originalLanguageRestored', 'settingsRestored',
    'emptyCaptureWorkbookRemoved', 'providerCredentialsNotExposedOrModified', 'spendingTalliesAndLedgerPreserved',
    'originalCompletionFetchRestored', 'temporaryAdbForwardRemoved']
    .every(field => aiPreviewReceipt.cleanup[field] === true));
const aiPreviewPng = readFileSync(path.join(aiAssets, aiPreviewReceipt.screenshot.file));
check('Pro AI preview is an intact native phone PNG with a labeled detail and original full-image link',
  aiPreviewReceipt.screenshot.file === 'phone-completion-preview.png'
    && aiPreviewPng.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    && aiPreviewPng.readUInt32BE(16) === 1080 && aiPreviewPng.readUInt32BE(20) === 2340
    && aiPreviewReceipt.screenshot.width === 1080 && aiPreviewReceipt.screenshot.height === 2340
    && createHash('sha256').update(aiPreviewPng).digest('hex') === aiPreviewReceipt.screenshot.sha256
    && /src="assets\/phone-completion-preview\.png" width="1080" height="2340" alt=""/.test(aiPreviewFigure)
    && /role="img" aria-label="[^\"]*AI suggestion preview[^\"]*Cancel and Insert all[^\"]*No suggestion has been inserted/.test(aiPreviewFigure)
    && aiPreviewFigure.includes('href="assets/phone-completion-preview.png"')
    && /unmodified full phone screenshot/.test(helpText(aiPreviewFigure)));
const aiPreviewCropCss = (aiTutorialCss.match(/\.shot-window--completion-preview\s*\{([^}]+)\}/) || [])[1] || '';
const aiPreviewCropShift = Number((aiPreviewCropCss.match(/--shift:\s*([\d.-]+)%/) || [])[1]);
check('Pro AI preview-only crop omits the keyboard and matches the receipt without editing the screenshot',
  aiPreviewFigure.includes('shot-window--completion-preview')
    && aiPreviewReceipt.displayView.x === 0 && aiPreviewReceipt.displayView.y === 690
    && aiPreviewReceipt.displayView.width === 1080 && aiPreviewReceipt.displayView.height === 390
    && /The keyboard is omitted/.test(aiPreviewFigure)
    && aiPreviewCropCss.includes(`aspect-ratio: ${aiPreviewReceipt.displayView.width} / ${aiPreviewReceipt.displayView.height}`)
    && Math.abs(aiPreviewCropShift / 100 + aiPreviewReceipt.displayView.y / aiPreviewReceipt.screenshot.height) < 0.00000001);

const aiLocalMarkup = (aiTutorial.match(
  /<section\b[^>]*\bid="local"[^>]*>([\s\S]*?)<\/section>/i) || [])[1] || '';
const aiLocalFigure = (aiLocalMarkup.match(/<figure class="phone-figure" id="local-model-settings">[\s\S]*?<\/figure>/) || [])[0] || '';
check('Pro AI local settings picture follows install/use steps, before returning to code',
  /Use local model → When unsure[\s\S]*?<\/li>\s*<\/ol>\s*<figure class="phone-figure" id="local-model-settings">/.test(aiLocalMarkup)
    && /<\/figure>\s*<ol class="lesson-steps" start="4">\s*<li>Return to a code cell/.test(aiLocalMarkup));
const aiLocalReceipt = JSON.parse(readFileSync(path.join(aiAssets, 'capture-pro-local-settings-phone.json'), 'utf8'));
const aiLocalPng = readFileSync(path.join(aiAssets, aiLocalReceipt.screenshot.file));
const aiLocalOverlay = readFileSync(path.join(aiAssets, 'phone-local-settings-overlay.svg'), 'utf8');
check('Pro AI local settings are an intact native screenshot, not fabricated delivery state',
  aiLocalPng.readUInt32BE(16) === 1080 && aiLocalPng.readUInt32BE(20) === 2340
    && createHash('sha256').update(aiLocalPng).digest('hex') === aiLocalReceipt.screenshot.sha256
    && aiLocalReceipt.captureMethod === 'Android screencap; unmodified full-screen PNG'
    && aiLocalReceipt.device.appPackage === 'com.unifyweaver.scirepl.pro.debug'
    && aiLocalReceipt.device.sourceCommit === null
    && aiLocalReceipt.settings.section === 'local' && aiLocalReceipt.settings.selectedMode === 'unsure'
    && aiLocalReceipt.settings.status === 'Ready (398 MB on this device)'
    && aiLocalReceipt.settings.installVisible === false && aiLocalReceipt.settings.deleteVisible === true
    && aiLocalReceipt.settings.advancedOpen === false
    && /Delete.*instead of.*Install/.test(helpText(aiLocalFigure))
    && /not a test of Google Play delivery/.test(helpText(aiLocalFigure))
    && /href="assets\/phone-local-settings.png">View the unmodified full phone screenshot/.test(aiLocalFigure));
check('Pro AI local settings capture makes no request, install, deletion or execution and restores state',
  aiLocalReceipt.providerRequests === 0 && aiLocalReceipt.externalRequests === 0
    && ['installPressed', 'deletePressed', 'modelDownloaded', 'inferenceRequested', 'codeExecuted']
      .every(key => aiLocalReceipt[key] === false)
    && ['originalWorkbookRestored', 'originalDraftRestored', 'originalLanguageUnchanged', 'settingsRestored',
      'emptyCaptureWorkbookRemoved', 'completionScreenClosed', 'originalCompletionFetchRestored']
      .every(key => aiLocalReceipt.cleanup[key] === true));
check('Pro AI local settings overlay highlights section, Ready and use mode on the unchanged PNG',
  /viewBox="0 0 1080 2340"/.test(aiLocalOverlay) && /stroke="#ffd43b"/.test(aiLocalOverlay)
    && ['local-section-setting', 'local-ready-status', 'local-use-setting'].every(id => aiLocalOverlay.includes(`id="${id}"`))
    && aiLocalFigure.includes('assets/phone-local-settings-overlay.svg')
    && /Yellow borders locate/.test(aiLocalFigure));
const aiLocalCropCss = (aiTutorialCss.match(/\.shot-window--local-model-settings\s*\{([^}]+)\}/) || [])[1] || '';
const aiLocalCropShift = Number((aiLocalCropCss.match(/--shift:\s*([\d.-]+)%/) || [])[1]);
check('Pro AI local settings detail crop matches its receipt and excludes unused space',
  aiLocalFigure.includes('shot-window--local-model-settings')
    && aiLocalReceipt.displayView.x === 0 && aiLocalReceipt.displayView.y === 90
    && aiLocalReceipt.displayView.width === 1080 && aiLocalReceipt.displayView.height === 1080
    && aiLocalCropCss.includes(`aspect-ratio: ${aiLocalReceipt.displayView.width} / ${aiLocalReceipt.displayView.height}`)
    && Math.abs(aiLocalCropShift / 100 + aiLocalReceipt.displayView.y / aiLocalReceipt.screenshot.height) < 0.00000001);

const aiPromptMarkup = (aiTutorial.match(
  /<section\b[^>]*\bid="prompt-cells"[^>]*>([\s\S]*?)<\/section>/i) || [])[1] || '';
const aiPromptSteps = aiPromptMarkup.match(/<ol\b[^>]*>([\s\S]*?)<\/ol>/i);
const aiPromptItems = [...(aiPromptSteps?.[1] || '').matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)];
const aiPromptFigure = id => (aiPromptMarkup.match(new RegExp(
  `<figure\\b[^>]*\\bid="${id}"[^>]*>[\\s\\S]*?<\\/figure>`, 'i')) || [])[0] || '';
const aiPromptResultFigure = aiPromptFigure('ai-prompt-explanation');
check('Pro AI Prompt instructions place the prompt and both Configure locations inside item 2',
  aiPromptItems.length === 4
    && ['ai-prompt-practice-prompt', 'ai-prompt-composer-controls', 'ai-prompt-edit-controls']
      .every(id => aiPromptItems[1][1].includes(`id="${id}"`)
        && aiPromptMarkup.split(`id="${id}"`).length === 2)
    && /not the Assistant's message box/.test(helpText(aiPromptItems[1][1])));
check('Pro AI Prompt configuration and Save detail remain inside item 3 before explicit Run',
  aiPromptItems.length === 4
    && aiPromptItems[2][1].includes('id="ai-prompt-configuration"')
    && aiPromptItems[2][1].includes('shot-window--ai-prompt-config-save')
    && /Previous 1 cell/.test(helpText(aiPromptItems[2][1]))
    && /Uncheck Include saved output text/.test(helpText(aiPromptItems[2][1]))
    && /Context preview names summary_demo/.test(helpText(aiPromptItems[2][1]))
    && /Send to AI provider/.test(helpText(aiPromptItems[3][1])));
const aiPromptResultPosition = aiPromptMarkup.indexOf(aiPromptResultFigure);
check('Pro AI Prompt actual output immediately follows the four instructions without replacing them',
  aiPromptSteps && aiPromptResultFigure
    && aiPromptMarkup.split('id="ai-prompt-explanation"').length === 2
    && aiPromptResultPosition >= aiPromptSteps.index + aiPromptSteps[0].length
    && !aiPromptMarkup.slice(aiPromptSteps.index + aiPromptSteps[0].length, aiPromptResultPosition).trim()
    && /did not change or re-run the JavaScript cell/.test(helpText(aiPromptResultFigure))
    && /beginning of the explanation/.test(helpText(aiPromptResultFigure))
    && /not a correctness guarantee/.test(helpText(aiPromptResultFigure)));
const aiPromptReceipt = JSON.parse(readFileSync(path.join(aiAssets, 'capture-pro-ai-prompt-phone.json'), 'utf8'));
const aiPromptPractice = (aiPromptItems[1]?.[1].match(
  /<div\b[^>]*\bid="ai-prompt-practice-prompt"[^>]*>([\s\S]*?)<\/div>/i) || [])[1] || '';
const aiPromptPracticeText = (aiPromptPractice.match(/<pre><code>([\s\S]*?)<\/code><\/pre>/i) || [])[1] || '';
check('Pro AI Prompt copyable exercise matches its source-only recorded request and seeded cell names',
  aiPromptPracticeText === aiPromptReceipt.exercise.prompt
    && aiPromptReceipt.exercise.summaryName === 'summary_demo'
    && aiPromptReceipt.exercise.promptName === 'explain_summary'
    && aiPromptReceipt.exercise.configuration.placement === 'output'
    && aiPromptReceipt.exercise.configuration.scope === 'previous-1'
    && aiPromptReceipt.exercise.configuration.includeSavedOutputs === false
    && /immediately preceding cell in workbook order; it does not search by name/.test(helpText(aiPromptMarkup)));
const aiPromptRequest = aiPromptReceipt.exercise.request;
check('Pro AI Prompt records exactly one bounded, reviewed GLM request without history or tools',
  aiPromptReceipt.captureMethod === 'Android screencap; unmodified full-screen PNG'
    && aiPromptReceipt.device.model === 'SM-S926W'
    && aiPromptReceipt.device.appPackage === 'com.unifyweaver.scirepl.pro.debug'
    && aiPromptReceipt.device.sourceCommit === null
    && aiPromptRequest.backend === 'openrouter' && aiPromptRequest.model === 'z-ai/glm-5.3-flash'
    && aiPromptRequest.requests === 1 && aiPromptRequest.maxOutputTokens === 2048
    && aiPromptRequest.selectedSourceCount === 1 && aiPromptRequest.sourceOnly === true
    && aiPromptRequest.chatHistorySent === false && aiPromptRequest.toolsAvailable === false
    && aiPromptRequest.reviewedBeforeSending === true && aiPromptRequest.finishReason === 'stop'
    && aiPromptRequest.usage.inputTokens === 331 && aiPromptRequest.usage.outputTokens === 922
    && aiPromptRequest.usage.totalTokens === aiPromptRequest.usage.inputTokens + aiPromptRequest.usage.outputTokens
    && aiPromptReceipt.exercise.sourcesUnchanged === true);
check('Pro AI Prompt capture restores workbook, draft, language, settings, request hook, credentials and rotation',
  ['originalWorkbookRestored', 'originalDraftRestored', 'originalLanguageRestored', 'settingsRestored',
    'captureWorkbookRemoved', 'originalRequestRestored', 'providerCredentialsNotExposedOrModified']
    .every(field => aiPromptReceipt.cleanup[field] === true)
    && aiPromptReceipt.rotationRestored === true);
const aiPromptVmOutput = [];
let aiPromptVmError = '';
try {
  runInNewContext(aiPromptReceipt.exercise.source, {
    console: Object.freeze({ log: (...args) => aiPromptVmOutput.push(args.map(String).join(' ')) }),
  }, { timeout: 1000 });
} catch (error) {
  aiPromptVmError = error.message;
}
const aiPromptExpectedOutput = `Input: ${JSON.stringify(summaryVector)}\nCount: 10\nMean: 9.3\nMinimum: 1\nMaximum: 20`;
check('Pro AI Prompt selected toy source independently reproduces the seeded statistics in a time-limited VM',
  !aiPromptVmError && aiPromptVmOutput.join('\n') === aiPromptReceipt.exercise.summaryOutput
    && aiPromptReceipt.exercise.summaryOutput === aiPromptExpectedOutput, aiPromptVmError);
const aiPromptShots = [
  ['composer', 'ai-prompt-composer-controls', 1590, 550, 0,
    ['composer-ai-language-setting', 'composer-ai-configure-setting'], /AI language selector and Configure button/],
  ['edit', 'ai-prompt-edit-controls', 980, 360, 0,
    ['saved-ai-configure-setting'], /Configure in the cell header above the start of the prompt/],
  ['config', 'ai-prompt-configuration', 95, 1285, 0,
    ['ai-prompt-result-placement-setting', 'ai-prompt-context-scope-setting', 'ai-prompt-context-outputs-setting'],
    /This cell's output, Previous 1 cell, and Include saved output text unchecked/],
  ['config-save', 'ai-prompt-configuration', 2110, 170, 1,
    ['ai-prompt-save-configuration-setting'], /Save configuration beside Cancel/],
  ['result', 'ai-prompt-explanation', 225, 1400, 1, [], /GLM 5\.3 Flash[\s\S]*summary_demo/],
];
check('Pro AI Prompt receipt identifies exactly five separate native screenshots',
  aiPromptReceipt.screenshots.length === aiPromptShots.length
    && new Set(aiPromptReceipt.screenshots.map(shot => shot.file)).size === aiPromptShots.length);
for (const [stem, figureId, y, height, requestsAtCapture, highlightIds, label] of aiPromptShots) {
  const file = `phone-ai-prompt-${stem}.png`;
  const shot = aiPromptReceipt.screenshots.find(item => item.file === file);
  const figure = aiPromptFigure(figureId);
  const cropClass = `shot-window--ai-prompt-${stem}`;
  const detail = (figure.match(new RegExp(
    `<div\\b[^>]*\\bclass="[^"]*\\b${cropClass}\\b[^"]*"[^>]*>[\\s\\S]*?<\\/div>\\s*<\\/div>`, 'i')) || [])[0] || '';
  const accessibleLabel = (detail.match(/\brole="img" aria-label="([^"]+)"/) || [])[1] || '';
  const png = readFileSync(path.join(aiAssets, file));
  check(`Pro AI Prompt ${file} is an intact native PNG with an honest capture sequence`,
    shot && png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      && png.readUInt32BE(16) === 1080 && png.readUInt32BE(20) === 2340
      && shot.width === 1080 && shot.height === 2340
      && createHash('sha256').update(png).digest('hex') === shot.sha256
      && shot.providerRequestsAtCapture === requestsAtCapture);
  check(`Pro AI Prompt ${file} has a truthful accessible detail and full-image link`,
    detail.includes(`src="assets/${file}" width="1080" height="2340" alt=""`)
      && label.test(accessibleLabel) && figure.includes(`href="assets/${file}"`)
      && (stem !== 'edit' || !/\bRun\b|\bCancel\b/.test(accessibleLabel)));
  const cropCss = (aiTutorialCss.match(new RegExp(`\\.${cropClass}\\s*\\{([^}]+)\\}`)) || [])[1] || '';
  const shift = Number((cropCss.match(/--shift:\s*([\d.-]+)%/) || [])[1]);
  check(`Pro AI Prompt ${file} crop matches its independently documented native detail window`,
    shot?.displayView && shot.displayView.x === 0 && shot.displayView.y === y
      && shot.displayView.width === 1080 && shot.displayView.height === height
      && y + height <= shot.height && cropCss.includes(`aspect-ratio: 1080 / ${height}`)
      && Math.abs(shift / 100 + y / shot.height) < 0.00000001);
  if (highlightIds.length) {
    const overlayFile = `phone-ai-prompt-${stem}-overlay.svg`;
    const overlay = readFileSync(path.join(aiAssets, overlayFile), 'utf8');
    const rects = [...overlay.matchAll(
      /<rect\b[^>]*\bid="([^"]+)"[^>]*\bx="([\d.]+)"[^>]*\by="([\d.]+)"[^>]*\bwidth="([\d.]+)"[^>]*\bheight="([\d.]+)"/g)];
    check(`Pro AI Prompt ${overlayFile} retains editable, labeled borders wholly inside its detail crop`,
      /viewBox="0 0 1080 2340"/.test(overlay)
        && /fill="none" stroke="#ffd43b" stroke-width="6"/.test(overlay)
        && rects.length === highlightIds.length && rects.map(rect => rect[1]).join(',') === highlightIds.join(',')
        && rects.every(([, , left, top, width, rectHeight]) => Number(left) >= 3
          && Number(left) + Number(width) + 3 <= 1080 && Number(top) - 3 >= y
          && Number(top) + Number(rectHeight) + 3 <= y + height)
        && detail.includes(`src="assets/${overlayFile}"`)
        && /class="shot-overlay"[^>]*aria-hidden="true"/.test(detail));
  }
}
check('Pro AI Prompt scrolled Save view records its later capture rather than claiming pre-request evidence',
  Date.parse(aiPromptReceipt.screenshots.find(shot => shot.file === 'phone-ai-prompt-config-save.png').capturedAtUtc)
    > Date.parse(aiPromptReceipt.screenshots.find(shot => shot.file === 'phone-ai-prompt-result.png').capturedAtUtc));

const aiVarianceStart = aiPromptMarkup.indexOf('<div id="ai-prompt-apply-example">');
const aiVarianceMarkup = aiVarianceStart < 0 ? '' : aiPromptMarkup.slice(aiVarianceStart);
const aiVarianceSteps = aiVarianceMarkup.match(/<ol\b[^>]*>([\s\S]*?)<\/ol>/i);
const aiVarianceItems = [...(aiVarianceSteps?.[1] || '').matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)];
const aiVariancePractice = (aiVarianceItems[1]?.[1].match(
  /<div\b[^>]*\bid="ai-variance-practice-prompt"[^>]*>([\s\S]*?)<\/div>/i) || [])[1] || '';
const aiVariancePracticeText = (aiVariancePractice.match(/<pre><code>([\s\S]*?)<\/code><\/pre>/i) || [])[1] || '';
const aiVarianceExpectedPrompt = `Return only complete JavaScript source, without Markdown fences.
Create a reproducible histogram of estimated sample variances.
Simulate 2,000 fresh samples, each containing 10 standard-normal N(0,1) values.
Do not reuse the earlier integer array from summary_demo.
Initialize state = 42 once for the whole run, not per sample. Before each uniform draw set state = (16807 * state) % 2147483647, then u = state / 2147483647.
For each normal draw use two successive uniforms: sqrt(-2 * log(u1)) * cos(2 * PI * u2). Do not reuse the spare sine result or use Math.random.
For each sample compute its mean, then unbiased variance sum((x - mean)^2) / 9.
Draw a labelled canvas histogram with 40 equal-width bins from 0 to 4. The horizontal axis is estimated variance; the vertical axis is sample count.
Mark the true population variance 1 with a labelled vertical line. Use a light background, dark text and readable labels.
Print sample size, repetitions, seed, mean estimated variance, histogram total and any overflow count. Count overflow separately rather than hiding it.
Display the canvas with window.renderImage(canvas.toDataURL("image/png")).
Use no packages, network, storage or workbook edits.`;
check('Pro AI Prompt replacement exercise follows rather than alters the first four-step explanation',
  aiVarianceStart > aiPromptResultPosition + aiPromptResultFigure.length
    && aiPromptItems.length === 4 && aiVarianceItems.length === 6
    && (aiPromptMarkup.match(/<ol\b/g) || []).length === 2
    && ['ai-prompt-apply-example', 'ai-variance-practice-prompt']
      .every(id => aiPromptMarkup.split(`id="${id}"`).length === 2)
    && aiPromptPracticeText === aiPromptReceipt.exercise.prompt);
check('Pro AI Prompt variance request fixes fresh normal samples, exact seeded draws and separate overflow',
  aiVariancePracticeText === aiVarianceExpectedPrompt
    && /fresh normal samples—not the earlier summary_demo integer array/.test(helpText(aiVarianceMarkup))
    && /Configure → preview → Apply → Run/.test(helpText(aiVarianceMarkup)));
const aiVarianceText = helpText(aiVarianceMarkup);
check('Pro AI Prompt distinguishes chi-square sample variance from Student t sample mean with NIST links',
  aiVarianceText.includes("Variance is not Student's t.")
    && aiVarianceText.includes('9s² / σ² follows a chi-square distribution with 9 degrees of freedom')
    && aiVarianceText.includes('true variance σ² = 1')
    && aiVarianceText.includes("Student's t instead describes the standardized sample mean (mean − μ) / (s / √10)")
    && /estimated standard deviation s/.test(aiVarianceText)
    && /href="https:\/\/www\.itl\.nist\.gov\/div898\/handbook\/eda\/section3\/eda358\.htm"/.test(aiVarianceMarkup)
    && /href="https:\/\/www\.itl\.nist\.gov\/div898\/handbook\/eda\/section3\/eda352\.htm"/.test(aiVarianceMarkup));
check('Pro AI Prompt replacement prepares a unique named JavaScript target and a separate prompt',
  aiVarianceItems.length === 6
    && /JavaScript cell containing \/\/ Reviewed plot code will go here\./.test(helpText(aiVarianceItems[0][1]))
    && /Run that harmless comment to save the cell/.test(helpText(aiVarianceItems[0][1]))
    && /name it variance_plot\s*\. Keep that name unique/.test(helpText(aiVarianceItems[0][1]))
    && /href="\.\.\/\.\.\/\.\.\/workbooks\/named-cells\/#name"/.test(aiVarianceItems[0][1])
    && /Add a separate AI Prompt cell/.test(helpText(aiVarianceItems[1][1])));
check('Pro AI Prompt replacement preserves target language and explains source sent despite No other cells',
  aiVarianceItems.length === 6
    && ['Put final response in → Replacement preview for a cell', 'Result cell language → Preserve target language',
      'Cell to replace → Named cell', 'Cell name → variance_plot', 'Include source from → No other cells (default)',
      'Save configuration'].every(text => helpText(aiVarianceItems[2][1]).includes(text))
    && /Review what will be sent, then choose Send to AI provider/.test(helpText(aiVarianceItems[3][1]))
    && /No other cells excludes extra workbook context; replacement still sends the complete source of the target cell/.test(
      helpText(aiVarianceItems[3][1])));
check('Pro AI Prompt replacement separates Before/After approval, Cancel and the target cell manual Run',
  aiVarianceItems.length === 6
    && /Before \/ After/.test(helpText(aiVarianceItems[4][1]))
    && /seed 42, 2,000 samples of 10, variance divided by 9/.test(helpText(aiVarianceItems[4][1]))
    && /Apply replacement only if you accept that source; Cancel leaves variance_plot unchanged/.test(
      helpText(aiVarianceItems[4][1]))
    && /Applying edits the destination cell but does not run it/.test(helpText(aiVarianceItems[4][1]))
    && /Find variance_plot and tap its own Run/.test(helpText(aiVarianceItems[5][1]))
    && /bar counts sample-variance estimates—not individual observations/.test(helpText(aiVarianceItems[5][1]))
    && /mean estimated variance near 0\.9852\s*, a histogram total of 2,000 and overflow 0/.test(
      helpText(aiVarianceItems[5][1]))
    && /Re-running from seed 42 should reproduce the plot/.test(helpText(aiVarianceItems[5][1]))
    && /Send to AI provider approves sharing the reviewed request\. Apply replacement approves editing the target's source/.test(
      aiVarianceText)
    && /Neither runs the proposed JavaScript/.test(aiVarianceText)
    && /Do not choose A linked new cell/.test(aiVarianceText)
    && /inserts an unrun result cell without this replacement-approval step/.test(aiVarianceText));
// This calculation makes no provider request and does not execute returned code.
// BigInt keeps the Park–Miller update independent of generated JavaScript arithmetic.
let aiVarianceState = 42n;
let aiVarianceUniformDraws = 0;
const aiVarianceUniform = () => {
  aiVarianceState = (16807n * aiVarianceState) % 2147483647n;
  aiVarianceUniformDraws++;
  return Number(aiVarianceState) / 2147483647;
};
const aiVarianceValues = [];
const aiVarianceBins = Array(40).fill(0);
let aiVarianceOverflow = 0;
for (let repetition = 0; repetition < 2000; repetition++) {
  const sample = Array.from({ length: 10 }, () => {
    const u1 = aiVarianceUniform();
    const u2 = aiVarianceUniform();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  });
  const mean = sample.reduce((sum, value) => sum + value, 0) / 10;
  const variance = sample.reduce((sum, value) => sum + (value - mean) ** 2, 0) / 9;
  aiVarianceValues.push(variance);
  if (variance >= 0 && variance < 4) aiVarianceBins[Math.floor(variance / 0.1)]++;
  else aiVarianceOverflow++;
}
const aiVarianceMean = aiVarianceValues.reduce((sum, value) => sum + value, 0) / aiVarianceValues.length;
const aiVarianceHistogramTotal = aiVarianceBins.reduce((sum, count) => sum + count, 0);
check('Pro AI Prompt normal-sample variance exercise independently reproduces the exact seeded statistics',
  aiVarianceValues.length === 2000 && aiVarianceUniformDraws === 40000
    && aiVarianceState === 2057487431n && aiVarianceBins.length === 40
    && aiVarianceValues.every(value => Number.isFinite(value) && value >= 0)
    && Math.abs(aiVarianceMean - 0.9852140436801163) < 1e-12
    && Math.abs(Math.min(...aiVarianceValues) - 0.08290714618890192) < 1e-12
    && Math.abs(Math.max(...aiVarianceValues) - 3.215275275225368) < 1e-12
    && aiVarianceHistogramTotal === 2000 && aiVarianceOverflow === 0);

const aiVarianceReceipt = JSON.parse(readFileSync(path.join(aiAssets, 'capture-pro-ai-variance-phone.json'), 'utf8'));
const aiVarianceExercise = aiVarianceReceipt.exercise;
const aiVarianceRequest = aiVarianceExercise.request;
const aiVarianceGenerated = readFileSync(path.join(aiAssets, 'ai-variance-generated.js'), 'utf8');
const aiVarianceReviewed = readFileSync(path.join(aiAssets, 'ai-variance-reviewed.js'), 'utf8');
const aiVarianceFigure = id => (aiVarianceMarkup.match(new RegExp(
  `<figure\\b[^>]*\\bid="${id}"[^>]*>[\\s\\S]*?<\\/figure>`, 'i')) || [])[0] || '';
check('Pro AI Prompt variance capture records the exact prompt and one bounded reviewed GLM request',
  aiVariancePracticeText === aiVarianceExercise.prompt
    && aiVarianceReceipt.captureMethod === 'Android screencap; unmodified full-screen PNG'
    && aiVarianceReceipt.device.model === 'SM-S926W'
    && aiVarianceReceipt.device.appPackage === 'com.unifyweaver.scirepl.pro.debug'
    && aiVarianceReceipt.device.sourceCommit === null
    && aiVarianceRequest.backend === 'openrouter' && aiVarianceRequest.model === 'z-ai/glm-5.3-flash'
    && aiVarianceRequest.requests === 1 && aiVarianceRequest.maxOutputTokens === 4096
    && aiVarianceRequest.finishReason === 'stop'
    && aiVarianceRequest.usage.inputTokens === 395 && aiVarianceRequest.usage.outputTokens === 1389
    && aiVarianceRequest.usage.totalTokens === aiVarianceRequest.usage.inputTokens + aiVarianceRequest.usage.outputTokens
    && aiVarianceExercise.review.requestsBeforeApproval === 0
    && aiVarianceExercise.review.text === aiVarianceExercise.before
    && aiVarianceExercise.before === '// Reviewed plot code will go here.');
check('Pro AI Prompt variance documents the source-only request guard without claiming an HTTP-body capture',
  aiVarianceExercise.contextScopeChosen === 'none'
    && /Exactly one requestCellOnce call/.test(aiVarianceExercise.requestGuard)
    && /toy prompt plus the complete harmless target source/.test(aiVarianceExercise.requestGuard)
    && /no other cell source in the method argument/.test(aiVarianceExercise.requestGuard)
    && /system framing\/runtime guide and one user message, without Assistant history or tools/.test(
      aiVarianceExercise.singlePromptPathAudit)
    && /source-path audit, not a saved HTTP-body capture/.test(aiVarianceExercise.singlePromptPathAudit));
check('Pro AI Prompt variance capture preserves the named target language until approved replacement',
  aiVarianceExercise.targetName === 'variance_plot'
    && aiVarianceExercise.configuration.result.placement === 'replace-target'
    && aiVarianceExercise.configuration.result.target.kind === 'namedCell'
    && aiVarianceExercise.configuration.result.target.name === aiVarianceExercise.targetName
    && aiVarianceExercise.configuration.result.targetLanguage === null
    && aiVarianceExercise.targetUnchangedBeforeApply === true
    && aiVarianceExercise.afterApply.targetMatchesGenerated === true
    && aiVarianceExercise.afterApply.language === 'javascript'
    && aiVarianceExercise.afterApply.outputCleared === true
    && aiVarianceExercise.afterApply.requests === 1
    && aiVarianceExercise.manualRun.separateFromApply === true);
const aiVarianceReportMarker = '\n// Report\n';
const aiVarianceReportStart = aiVarianceGenerated.indexOf(aiVarianceReportMarker);
const aiVarianceGeneratedReport = aiVarianceGenerated.slice(aiVarianceReportStart + aiVarianceReportMarker.length).trimEnd();
const aiVarianceOnlyPrintCorrection = aiVarianceGenerated.slice(0, aiVarianceReportStart + aiVarianceReportMarker.length)
  + 'console.log(\n' + aiVarianceGeneratedReport.slice(0, -1) + '\n);\n';
check('Pro AI Prompt variance links the unmodified response and discloses only the final print correction before Run',
  aiVarianceGenerated.trimEnd() === aiVarianceRequest.text
    && aiVarianceReviewed.trimEnd() === aiVarianceExercise.manualCorrection.code
    && aiVarianceReportStart >= 0 && aiVarianceGeneratedReport.endsWith(';')
    && aiVarianceReviewed === aiVarianceOnlyPrintCorrection
    && aiVarianceExercise.manualRun.reviewedSourceFile === 'ai-variance-reviewed.js'
    && /bare expression/.test(aiVarianceExercise.manualCorrection.reason)
    && /console\.log before manual Run/.test(aiVarianceExercise.manualCorrection.reason)
    && /href="assets\/ai-variance-generated\.js">Read the complete generated source/.test(aiVarianceItems[4][1])
    && /href="assets\/ai-variance-reviewed\.js">Read the corrected source that was run/.test(aiVarianceItems[5][1])
    && /After Apply, we edited only that final report into console\.log\(…\) before Run/.test(
      helpText(aiVarianceItems[5][1])));
const aiVarianceExpectedReport = 'sample size=10 | repetitions=2000 | seed=42 | mean estimated variance='
  + aiVarianceMean.toFixed(5) + ` | histogram total=${aiVarianceHistogramTotal} | overflow=${aiVarianceOverflow}`;
check('Pro AI Prompt variance actual plot checks agree with the independent normal-sample calculation',
  aiVarianceExercise.output.text.includes(aiVarianceExpectedReport)
    && aiVarianceExercise.output.plot.naturalWidth === 900 && aiVarianceExercise.output.plot.naturalHeight === 560
    && aiVarianceExercise.output.requests === 1 && aiVarianceExercise.output.sourceMatchesReviewedCorrection === true
    && Math.abs(aiVarianceExercise.manualRun.expected.meanEstimatedVariance - aiVarianceMean) < 1e-12
    && aiVarianceExercise.manualRun.expected.histogramTotal === aiVarianceHistogramTotal
    && aiVarianceExercise.manualRun.expected.overflow === aiVarianceOverflow);
check('Pro AI Prompt variance capture restores state, rotation and request hook without preserving unexpected edits',
  ['originalWorkbookRestored', 'originalDraftRestored', 'originalLanguageRestored', 'settingsRestored',
    'requestFunctionRestored', 'temporaryWorkbookRemoved', 'rotationRestored', 'temporaryAdbForwardRemoved']
    .every(field => aiVarianceReceipt.cleanup[field] === true)
    && aiVarianceReceipt.cleanup.unexpectedEditsPreserved === false);
const aiVarianceShots = [
  ['config', 'ai-variance-configuration', 2, 380, 1560, 0,
    ['ai-variance-placement-setting', 'ai-variance-language-setting', 'ai-variance-target-kind-setting',
      'ai-variance-target-name-setting', 'ai-variance-context-setting'],
    /Replacement preview for a cell, Preserve target language, Named cell, variance_plot, and No other cells/],
  ['preview-start', 'ai-variance-approval', 4, 225, 1060, 1, [],
    /Before\/After replacement preview[\s\S]*harmless comment[\s\S]*seed 42/],
  ['preview-apply', 'ai-variance-approval', 4, 1100, 630, 1, ['ai-variance-approval-actions'],
    /Apply replacement and Cancel; neither action runs the proposed code/],
  ['plot', 'ai-variance-output', 5, 225, 900, 1, [],
    /separate manual Run[\s\S]*2,000 sample-variance estimates[\s\S]*mean is 0\.98521[\s\S]*total 2000 and overflow 0/],
];
check('Pro AI Prompt variance receipt identifies exactly four separate native screenshots in capture order',
  aiVarianceReceipt.screenshots.length === aiVarianceShots.length
    && aiVarianceReceipt.screenshots.map(shot => shot.file).join(',')
      === aiVarianceShots.map(([stem]) => `phone-ai-variance-${stem}.png`).join(',')
    && aiVarianceReceipt.screenshots.every((shot, index, shots) => Number.isFinite(Date.parse(shot.capturedAtUtc))
      && (index === 0 || Date.parse(shot.capturedAtUtc) > Date.parse(shots[index - 1].capturedAtUtc))));
for (const [stem, figureId, itemIndex, y, height, requestsAtCapture, highlightIds, label] of aiVarianceShots) {
  const file = `phone-ai-variance-${stem}.png`;
  const shot = aiVarianceReceipt.screenshots.find(item => item.file === file);
  const figure = aiVarianceFigure(figureId);
  const cropClass = `shot-window--ai-variance-${stem}`;
  const detail = (figure.match(new RegExp(
    `<div\\b[^>]*\\bclass="[^"]*\\b${cropClass}\\b[^"]*"[^>]*>[\\s\\S]*?<\\/div>\\s*<\\/div>`, 'i')) || [])[0] || '';
  const accessibleLabel = (detail.match(/\brole="img" aria-label="([^"]+)"/) || [])[1] || '';
  const png = readFileSync(path.join(aiAssets, file));
  check(`Pro AI Prompt variance ${file} stays in its relevant instruction with a truthful label and full-image link`,
    aiVarianceItems[itemIndex][1].includes(`id="${figureId}"`)
      && aiVarianceMarkup.split(`id="${figureId}"`).length === 2
      && detail.includes(`src="assets/${file}" width="1080" height="2340" alt=""`)
      && label.test(accessibleLabel) && figure.includes(`href="assets/${file}"`));
  check(`Pro AI Prompt variance ${file} is the intact native PNG at the documented request count`,
    shot && png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      && png.readUInt32BE(16) === 1080 && png.readUInt32BE(20) === 2340
      && shot.width === 1080 && shot.height === 2340
      && createHash('sha256').update(png).digest('hex') === shot.sha256
      && shot.providerRequestsAtCapture === requestsAtCapture);
  const cropCss = (aiTutorialCss.match(new RegExp(`\\.${cropClass}\\s*\\{([^}]+)\\}`)) || [])[1] || '';
  const shift = Number((cropCss.match(/--shift:\s*([\d.-]+)%/) || [])[1]);
  check(`Pro AI Prompt variance ${file} CSS crop matches its native display window`,
    shot?.displayView && shot.displayView.x === 0 && shot.displayView.y === y
      && shot.displayView.width === 1080 && shot.displayView.height === height
      && y + height <= shot.height && cropCss.includes(`aspect-ratio: 1080 / ${height}`)
      && Math.abs(shift / 100 + y / shot.height) < 0.00000001);
  if (highlightIds.length) {
    const overlayFile = `phone-ai-variance-${stem}-overlay.svg`;
    const overlay = readFileSync(path.join(aiAssets, overlayFile), 'utf8');
    const rects = [...overlay.matchAll(
      /<rect\b[^>]*\bid="([^"]+)"[^>]*\bx="([\d.]+)"[^>]*\by="([\d.]+)"[^>]*\bwidth="([\d.]+)"[^>]*\bheight="([\d.]+)"/g)];
    check(`Pro AI Prompt variance ${overlayFile} contains only labeled editable borders inside the displayed crop`,
      /viewBox="0 0 1080 2340"/.test(overlay)
        && /<title>[^<]+<\/title>/.test(overlay) && /<desc>[^<]+<\/desc>/.test(overlay)
        && /fill="none" stroke="#ffd43b" stroke-width="6"/.test(overlay)
        && !/<(?:image|text|foreignObject)\b/i.test(overlay)
        && rects.length === highlightIds.length && rects.map(rect => rect[1]).join(',') === highlightIds.join(',')
        && rects.every(([, , left, top, width, rectHeight]) => Number(left) >= 3
          && Number(left) + Number(width) + 3 <= 1080 && Number(top) - 3 >= y
          && Number(top) + Number(rectHeight) + 3 <= y + height)
        && detail.includes(`src="assets/${overlayFile}"`)
        && /class="shot-overlay"[^>]*aria-hidden="true"/.test(detail));
  }
}
const aiVarianceApprovalFigure = aiVarianceFigure('ai-variance-approval');
check('Pro AI Prompt variance shows both ends of one preview and discloses the omitted middle',
  aiVarianceApprovalFigure.indexOf('shot-window--ai-variance-preview-start')
    < aiVarianceApprovalFigure.indexOf('shot-window--ai-variance-preview-apply')
    && /target still contains only our comment/.test(helpText(aiVarianceApprovalFigure))
    && /Read the whole After section/.test(helpText(aiVarianceApprovalFigure))
    && /middle of this long preview is omitted/.test(helpText(aiVarianceApprovalFigure))
    && /Apply replacement changes the named cell's source; it does not execute it/.test(helpText(aiVarianceApprovalFigure)));

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
