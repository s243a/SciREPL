// Read-only completion/provenance inventory. Never renders, calls a model or
// substitutes English for missing translated fields.
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, LOCALES, readManifest, localeFile, sha, validateText, validateKeep } from './tutorial_locale_lib.mjs';

export function inspectLocaleRecord(manifest, locale, record) {
  const fields = [...manifest.pages.flatMap(page => page.fields), ...manifest.chrome];
  const expected = new Set(fields.map(field => field.id));
  const values = record?.translations || {};
  const missing = fields.filter(field => !(field.id in values)).map(field => field.id);
  const unknown = Object.keys(values).filter(id => !expected.has(id));
  const invalid = [];
  if (record && (record.locale !== locale || record.manifestHash !== manifest.manifestHash)) invalid.push({ id: '(record)', reason: 'Locale or source manifest does not match' });
  const kept = Object.assign({}, ...(record?.receipts || []).map(receipt => receipt.review?.keptFields || {}));
  const reviewed = new Set((record?.receipts || []).filter(receipt => receipt.review?.status === 'accepted' && typeof receipt.review.reviewer === 'string' && receipt.review.reviewer.trim() && typeof receipt.review.draftModel === 'string' && receipt.review.draftModel.trim()).flatMap(receipt => receipt.fields || []));
  for (const field of fields) {
    if (!(field.id in values)) continue;
    try {
      if (kept[field.id] !== undefined) validateKeep(field, kept[field.id]);
      validateText(field, values[field.id], { allowSource: Boolean(kept[field.id]) });
    } catch (error) { invalid.push({ id: field.id, reason: error.message }); }
  }
  const unreviewed = fields.filter(field => field.id in values && !reviewed.has(field.id)).map(field => field.id);
  // Accepted fields a human may choose to spot-check (for example output kept
  // from a worker stopped while waiting on title generation). Advisory only:
  // they are reviewed and complete. A later receipt for a field supersedes it.
  const manual = new Set();
  for (const receipt of record?.receipts || []) {
    const ids = receipt.fields || [];
    if (receipt.review?.manualReviewSuggested === true) {
      const flagged = new Set(Array.isArray(receipt.review.manualReviewFields) ? receipt.review.manualReviewFields : ids);
      for (const id of ids) if (flagged.has(id)) manual.add(id); else manual.delete(id);
    } else for (const id of ids) manual.delete(id);
  }
  const manualReviewSuggested = fields.filter(field => manual.has(field.id) && field.id in values).map(field => field.id);
  return { locale, fields: fields.length, translated: fields.length - missing.length, missing, unknown, invalid, unreviewed, manualReviewSuggested, complete: Boolean(record) && !missing.length && !unknown.length && !invalid.length && !unreviewed.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), selected = [], requireComplete = args.includes('--require-complete');
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--locale') { const locale = args[++index]; if (!LOCALES.includes(locale)) throw new Error('Unknown requested tutorial locale'); selected.push(locale); }
    else if (!['--all', '--require-complete', '--details', '--manual-review'].includes(args[index])) throw new Error(`Unknown status option: ${args[index]}`);
  }
  const manifest = readManifest();
  const sourceCurrent = manifest.pages.every(page => sha(readFileSync(path.join(ROOT, 'www', 'help', page.route, 'index.html'))) === page.sourceHash);
  const rows = (args.includes('--all') || !selected.length ? LOCALES : selected).map(locale => {
    if (locale === 'en') return { locale, complete: sourceCurrent, sourceLanguage: true };
    const file = localeFile(locale);
    if (!existsSync(file)) return inspectLocaleRecord(manifest, locale, null);
    try { return inspectLocaleRecord(manifest, locale, JSON.parse(readFileSync(file, 'utf8'))); }
    catch { return { locale, complete: false, recordError: 'Translation record is unreadable or currently being written' }; }
  });
  // --manual-review lists only the optional spot-check field ids per locale.
  const display = args.includes('--manual-review') ? rows.filter(row => row.manualReviewSuggested?.length).map(row => ({ locale: row.locale, manualReviewSuggested: row.manualReviewSuggested }))
    : args.includes('--details') ? rows : rows.map(row => row.fields === undefined ? row : { locale: row.locale, fields: row.fields, translated: row.translated, missing: row.missing.length, unknown: row.unknown.length, invalid: row.invalid.length, unreviewed: row.unreviewed.length, manualReviewSuggested: row.manualReviewSuggested.length, complete: row.complete });
  console.log(JSON.stringify({ schema: 1, manifestHash: manifest.manifestHash, sourceCurrent, locales: display }, null, 2));
  if (requireComplete && (!sourceCurrent || rows.some(row => !row.complete))) process.exitCode = 1;
}
