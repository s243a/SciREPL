import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { DATA, LOCALES, readManifest, readLocale, localeFile, validateText, validateKeep } from './tutorial_locale_lib.mjs';

const [locale, responseFile] = process.argv.slice(2);
if (!LOCALES.includes(locale) || locale === 'en' || !responseFile) throw new Error('Usage: node scripts/tutorial_locale_apply.mjs <locale> <reviewed-response.json>');
const manifest = readManifest();
const response = JSON.parse(readFileSync(responseFile, 'utf8'));
if (response.manifestHash !== manifest.manifestHash) throw new Error('A reviewed response must name the exact manifestHash');
if (!response.review || response.review.status !== 'accepted' || !response.review.reviewer || !response.review.draftModel) throw new Error('A fresh accepted review with reviewer and draft model is required');
const fields = new Map([...manifest.pages.flatMap(page => page.fields), ...manifest.chrome].map(field => [field.id, field]));
const existing = existsSync(localeFile(locale)) ? readLocale(locale) : { schema: 1, locale, manifestHash: manifest.manifestHash, translations: {}, receipts: [] };
if (existing.manifestHash !== manifest.manifestHash) throw new Error('Source changed: discard or explicitly migrate stale translations');
for (const [id, value] of Object.entries(response.translations || {})) {
  if (!fields.has(id)) throw new Error(`Unexpected field: ${id}`);
  const keep = response.review.keptFields?.[id];
  if (keep !== undefined) validateKeep(fields.get(id), keep);
  validateText(fields.get(id), value, { allowSource: Boolean(keep) }); existing.translations[id] = value;
}
existing.receipts.push({ source: path.basename(responseFile), fields: Object.keys(response.translations).sort(), review: response.review });
mkdirSync(path.dirname(localeFile(locale)), { recursive: true });
writeFileSync(localeFile(locale), JSON.stringify(existing, null, 2) + '\n');
console.log(`${locale}: applied ${Object.keys(response.translations).length} independently reviewed fields; ${Object.keys(existing.translations).length}/${fields.size} complete`);
