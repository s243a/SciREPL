// Mechanical companion generation: preserve the exact tutorial examples.
// Run with --check to verify the committed download without changing it.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'www/help/workbooks/graphics');
const html = readFileSync(path.join(dir, 'index.html'), 'utf8');
const browser = await chromium.launch({ headless: true });
let workbook;
try {
  const page = await browser.newPage();
  await page.route('**/*', route => route.abort());
  workbook = await page.evaluate(html => {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const source = kind => doc.querySelector(`[data-graphic-example="${kind}"]`).textContent;
    let png;
    window.renderImage = data => { png = data; };
    // Only this repository's fixed canvas example runs in an isolated page;
    // no workbook, local storage, filesystem or network is exposed to it.
    new Function(source('javascript'))();
    if (!png?.startsWith('data:image/png;base64,')) throw Error('Canvas example produced no PNG');
    return { format: 'srwb', version: '1.0', notebook: {
      name: 'Workbook Graphics', cells: [
        { name: 'static_axes', type: 'markdown', language: 'markdown',
          code: '# A static SVG diagram\n\nRight and up lie on the paper. The dot in a circle means the normal points toward you.\n\n' + source('svg') },
        { name: 'embedded_png', type: 'markdown', language: 'markdown',
          code: '## The same picture as an embedded PNG\n\nThis image is stored in Markdown source, not as saved code output.\n\n<img alt="Paper axes" width="100%" src="' + png + '">' },
        { name: 'canvas_axes', type: 'code', language: 'javascript', code: source('javascript') },
        { name: 'math_axes', type: 'markdown', language: 'markdown', code: source('math') }
      ]
    } };
  }, html);
} finally {
  await browser.close();
}
const generated = JSON.stringify(workbook, null, 2) + '\n';
const output = path.join(dir, 'assets/workbook-graphics.srwb');
if (process.argv.includes('--check')) {
  const saved = JSON.parse(readFileSync(output, 'utf8'));
  const embedded = saved.notebook.cells[1].code.match(/data:image\/png;base64,([A-Za-z0-9+/=]+)/);
  assert(embedded, 'Companion has no embedded PNG');
  const png = Buffer.from(embedded[1], 'base64');
  assert(png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), 'Not a PNG');
  assert.equal(png.readUInt32BE(16), 360);
  assert.equal(png.readUInt32BE(20), 220);
  // Font rasterization differs by OS. Freeze the stored image but check every
  // other source byte against today's examples, including its responsive tag.
  const generatedPng = workbook.notebook.cells[1].code.match(/data:image\/png;base64,[A-Za-z0-9+/=]+/)[0];
  workbook.notebook.cells[1].code = workbook.notebook.cells[1].code.replace(generatedPng, embedded[0]);
  assert.deepEqual(saved, workbook, 'Companion differs from the tutorial sources');
  console.log('PASS: graphics companion matches the tutorial sources; embedded PNG is 360 by 220');
} else {
  mkdirSync(path.dirname(output), { recursive: true });
  writeFileSync(output, generated);
  console.log(`Generated graphics companion (${Buffer.byteLength(generated)} bytes)`);
}
