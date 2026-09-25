// The Browse CSV starter is executable without downloads or third-party Python packages.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workbook = JSON.parse(readFileSync(path.join(root, 'www/workbooks/csv-basics-seedlings.srwb'), 'utf8'));
const workbookBytes = readFileSync(path.join(root, 'www/workbooks/csv-basics-seedlings.srwb'));
const helpDownloadBytes = readFileSync(path.join(root, 'www/help/files-export/tutorial/assets/csv-basics-seedlings.srwb'));
const catalog = readFileSync(path.join(root, 'www/js/package_catalog.js'), 'utf8');
const sample = readFileSync(path.join(root, 'www/help/files-export/tutorial/assets/seedling-heights.csv'), 'utf8');

assert.equal(workbook.format, 'srwb');
assert.deepEqual(helpDownloadBytes, workbookBytes, 'public-help fallback and built-in workbook must be identical');
assert.equal(workbook.notebook.name, 'CSV Basics: Seedling Heights');
assert.match(catalog, /id: 'csv-basics-seedlings'/);
assert.match(catalog, /pages_url: 'workbooks\/csv-basics-seedlings\.srwb'/);
const cells = workbook.notebook.cells.filter(cell => cell.type === 'code');
assert.equal(cells.length, 3);
assert.ok(cells.every(cell => cell.language === 'python'));

const scratch = mkdtempSync(path.join(tmpdir(), 'scirepl-csv-test-'));
try {
  const csvPath = path.join(scratch, 'seedling-heights.csv');
  const code = cells.map(cell => cell.code.replaceAll('/shared/data/seedling-heights.csv', csvPath)).join('\n\n');
  const result = spawnSync('python3', ['-c', code], { cwd: scratch, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.match(result.stdout, /Saved 6 fictional rows/);
  assert.match(result.stdout, /Read 6 rows/);
  assert.match(result.stdout, /Light mean: 13\.0 cm/);
  assert.match(result.stdout, /Shade mean: 8\.0 cm/);
  assert.match(result.stdout, /Difference: 5\.0 cm/);
  assert.equal(readFileSync(csvPath, 'utf8').replaceAll('\r\n', '\n'), sample);
  console.log('PASS: CSV starter creates, reads, and summarizes the tutorial dataset');
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
