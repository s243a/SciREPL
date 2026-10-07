// Generate the small tutorial download from its exact copyable code snippets.
// --check verifies it without writing. No example code is executed here.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'www/help/workbooks/named-cells');
const html = readFileSync(path.join(dir, 'index.html'), 'utf8');
const browser = await chromium.launch({ headless: true });
let sources;
try {
  const page = await browser.newPage();
  await page.route('**/*', route => route.abort());
  sources = await page.evaluate(html => {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    return Object.fromEntries([...doc.querySelectorAll('code[data-cell-example]')]
      .map(element => [element.dataset.cellExample, element.textContent]));
  }, html);
} finally {
  await browser.close();
}
const languages = { numbers: 'javascript', inspect_cells: 'bash', write_shared: 'javascript', read_shared: 'javascript',
  generate_report: 'javascript', bash_report: 'bash', python_total: 'python' };
assert.deepEqual(Object.keys(sources), Object.keys(languages), 'Tutorial example hooks differ');
const workbook = { format: 'srwb', version: '1.0', notebook: {
  name: 'Named Cell Interop', cells: [
    { name: 'intro', type: 'markdown', language: 'markdown', code:
      '# Named cells and cross-language paths\n\n'
      + 'Read the code before running it. This workbook uses the current workbook’s /nb/ virtual cell paths.\n\n'
      + 'Run **numbers**, then **inspect_cells** to inspect virtual paths. Run **write_shared**, then **read_shared** to read the copied JSON file (expected total: `16`). Run **generate_report**, inspect the new Bash source in **bash_report**, then run that cell yourself. Expected result: `Total: 16`.\n\n'
      + '**write_shared** writes a small JSON text copy to `/shared/data/named-cell-tutorial/values.json`, replacing an earlier copy at that exact path if present. Open it through Menu → Files & Storage.\n\n'
      + '**python_total** is optional and reads both the named cell and the shared file. It requires the Python runtime; the first six code cells use only JavaScript and bundled Bash. No cell installs packages, uses a model or sends a network request. A runtime download, if needed, is separate.\n\n'
      + 'Writing another cell’s source does not execute it or refresh its old output. After editing numbers, rerun numbers → write_shared (to update the copied file) → read_shared. For the generated-code route, rerun numbers → generate_report → bash_report. Ordinary .srwb import drops saved code outputs; rerun the producer before its readers.' },
    ...Object.entries(languages).map(([name, language]) =>
      ({ name, type: 'code', language, code: sources[name] }))
  ]
} };
assert(workbook.notebook.cells.every(cell => !cell.lastOutput && !cell.lastOutputHtml));
const output = path.join(dir, 'assets/named-cell-interop.srwb');
if (process.argv.includes('--check')) {
  assert.deepEqual(JSON.parse(readFileSync(output, 'utf8')), workbook,
    'Named-cell companion differs from tutorial sources');
  console.log('PASS: named-cell companion matches every tutorial source');
} else {
  mkdirSync(path.dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify(workbook, null, 2) + '\n');
  console.log('Generated named-cell companion, without outputs or execution');
}
