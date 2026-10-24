import { mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { DATA, readManifest, LOCALES } from './tutorial_locale_lib.mjs';

const manifest = readManifest();
const destination = process.argv[2] || path.join(DATA, 'requests');
const maxCharacters = Number(process.env.TUTORIAL_CHUNK_CHARACTERS || 11000);
const maxFields = Number(process.env.TUTORIAL_CHUNK_FIELDS || 1000);
if (!Number.isInteger(maxCharacters) || maxCharacters < 1000 || maxCharacters > 20000) throw new Error('TUTORIAL_CHUNK_CHARACTERS must be an integer from 1000 to 20000');
if (!Number.isInteger(maxFields) || maxFields < 1 || maxFields > 1000) throw new Error('TUTORIAL_CHUNK_FIELDS must be an integer from 1 to 1000');
const fields = [...manifest.pages.flatMap(page => page.fields), ...manifest.chrome];
const chunks = [];
let current = [], length = 0;
for (const field of fields) {
  const size = field.text.length + field.id.length + 50;
  if (size > maxCharacters) throw new Error(`${field.id}: one protected field exceeds the selected character budget`);
  if (current.length && (length + size > maxCharacters || current.length >= maxFields)) { chunks.push(current); current = []; length = 0; }
  current.push(field); length += size;
}
if (current.length) chunks.push(current);
mkdirSync(destination, { recursive: true });
for (const locale of LOCALES.filter(value => value !== 'en')) {
  const dir = path.join(destination, locale);
  // Never leave superseded extra chunks in a directory the controller might
  // enumerate. A fresh destination is safer than deleting previous evidence.
  if (existsSync(dir)) for (const file of readdirSync(dir).filter(file => file.endsWith('.json'))) {
    const old = JSON.parse(readFileSync(path.join(dir, file), 'utf8'));
    if (old.manifestHash !== manifest.manifestHash || old.chunks !== chunks.length) throw new Error(`${dir} contains superseded requests; choose a fresh destination`);
  }
  mkdirSync(dir, { recursive: true });
  chunks.forEach((chunk, index) => {
    const request = { schema: 1, task: 'Translate tutorial prose only. Return JSON: {"translations":{"field.id":"translated text"}}. Preserve every {{P000}} token exactly once and in its existing order. Do not supply HTML, code, URLs, credentials, or additional fields. Preserve the mathematical and security meaning. Plain text between protected tokens is the only editable content. App UI labels will be substituted from existing app catalogs. Use natural, clear instructions in the requested language; screenshots remain English. This is machine translation with native review pending.', locale, sourceLocale: 'en', manifestHash: manifest.manifestHash, chunk: index + 1, chunks: chunks.length, fields: chunk.map(field => ({ id: field.id, text: field.text, context: field.tag || 'shared navigation', protected: field.protectedSpans.map(span => ({ token: span.token, meaning: span.kind === 'ui' ? `App control: ${span.label}; localized automatically` : span.kind === 'html' ? 'Protected formatting or executable example; do not edit' : span.value })) })) };
    writeFileSync(path.join(dir, `${String(index + 1).padStart(2, '0')}.json`), JSON.stringify(request, null, 2) + '\n');
  });
}
console.log(JSON.stringify({ chunksPerLocale: chunks.length, locales: LOCALES.length - 1, requests: chunks.length * (LOCALES.length - 1), maximumCharacters: maxCharacters, maximumFields: maxFields, directory: destination }, null, 2));
