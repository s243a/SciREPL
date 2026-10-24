// Finite operator-reviewed continuation: copy only proven never-started chunks.
// This does not recover the old slot holds or retry failed provider requests.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import { ROOT, LOCALES, readManifest, sha } from './tutorial_locale_lib.mjs';
const manifest = readManifest();
assert.equal(manifest.manifestHash, 'c2e6f315f7f94b38e579a4e7c7eb152b7730c1c9fb24c91788f807079327e25c');
const original = '/tmp/scirepl-tutorial-translation-requests-small-pilot-v3';
// Preserve the exact schema/order of the original authorization fingerprint.
const inventory = LOCALES.filter(locale => locale !== 'en').flatMap(locale => readdirSync(path.join(original, locale))
  .filter(name => /^\d{2}\.json$/.test(name)).sort().map(name => ({ locale, name, hash: sha(readFileSync(path.join(original, locale, name))) })));
assert.equal(inventory.length, 552);
assert.equal(sha(JSON.stringify(inventory)), '0a68ca2cac1bcd7caa77d3bd7804aa098eabe18ab03734b3878b37bcd5aa27d4', 'Original authorized request inventory changed');
const attempts = ['small-approved', 'polled-unconsumed', 'polled-remaining'].map(name => '/tmp/scirepl-tutorial-translation-' + name + '-20261014');
for (const base of attempts) assert(!existsSync(path.join(base, 'controller.lock')), 'A prior controller still owns a campaign');
for (const page of manifest.pages) assert.equal(sha(readFileSync(path.join(ROOT, 'www/help', page.route, 'index.html'))), page.sourceHash);
// These ranges were independently audited against all 552 original requests.
// Actual-error locales are intentionally excluded; their evidence stays held.
const ranges = { ar: [23, 46], bn: [11, 46], de: [27, 46], ja: [45, 46], ko: [26, 46], 'pt-BR': [37, 46], zh: [6, 46] };
const rows = [];
for (const [locale, [first, last]] of Object.entries(ranges)) for (let n = first; n <= last; n++) {
  const chunk = String(n).padStart(2, '0'), source = path.join(original, locale, chunk + '.json');
  const bytes = readFileSync(source), request = JSON.parse(bytes);
  assert.equal(sha(bytes), inventory.find(row => row.locale === locale && row.name === chunk + '.json')?.hash);
  assert.equal(request.manifestHash, manifest.manifestHash); assert.equal(request.locale, locale);
  for (const base of attempts) assert(!existsSync(path.join(base, locale, chunk, 'started.json')), 'Never replay a previously started chunk');
  rows.push({ locale, chunk, hash: sha(bytes), bytes });
}
assert.equal(rows.length, 154);
assert.equal(new Set(rows.map(row => row.locale + '/' + row.chunk)).size, 154, 'Untouched subset contains duplicates');
if (!process.argv.includes('--execute')) { console.log(JSON.stringify({ mode: 'preflight', chunks: rows.length, maximumNewCalls: rows.length * 2, retries: 0 })); process.exit(0); }
const output = mkdtempSync('/tmp/scirepl-tutorial-translation-requests-background-');
for (const locale of LOCALES.filter(locale => locale !== 'en')) mkdirSync(path.join(output, locale));
for (const row of rows) {
  for (const base of attempts) assert(!existsSync(path.join(base, row.locale, row.chunk, 'started.json')));
  const file = path.join(output, row.locale, row.chunk + '.json');
  writeFileSync(file, row.bytes, { flag: 'wx', mode: 0o600 }); assert.equal(sha(readFileSync(file)), row.hash);
}
writeFileSync(path.join(output, 'authorization.json'), JSON.stringify({ schema: 1, manifestHash: manifest.manifestHash,
  kind: 'Finite continuation of original authorized untouched chunks; no phase retries', previousCampaigns: attempts,
  requests: rows.map(({ locale, chunk, hash }) => ({ locale, chunk, hash })), maximumNewCalls: rows.length * 2,
  heldLocalesNotIncluded: ['es', 'fr', 'hi', 'id', 'ru'], oldZeroCallHoldsNotReplayed: true }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ output, chunks: rows.length, maximumNewCalls: rows.length * 2, retries: 0 }));
