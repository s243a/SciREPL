// Explicit controller-reviewed edits to COMPLETE fresh-review JSON only.
// No model calls, retries, partial JSON salvage, or approval claims on behalf of Gemini.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, rmdirSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { ROOT, LOCALES, readManifest, sha, validateText, validateKeep } from './tutorial_locale_lib.mjs';
import { parseTransport } from './tutorial_translation_transport.mjs';

const args = process.argv.slice(2);
const checkOnly = args.at(-1) === '--check';
const [directory, correctionFile] = checkOnly ? args.slice(0, -1) : args;
assert(directory && correctionFile && args.length === (checkOnly ? 3 : 2), 'Provide a held chunk directory and its explicitly reviewed correction file, optionally --check');
const dir = path.resolve(directory);
assert(dir.startsWith('/tmp/scirepl-tutorial-translation-'), 'Raw evidence stays in the task campaign');
const edit = JSON.parse(readFileSync(correctionFile, 'utf8'));
const manifest = readManifest();
assert.equal(edit.schema, 1);
assert(LOCALES.includes(edit.locale) && edit.locale !== 'en');
assert(/^\d{2}$/.test(edit.chunk));
assert.equal(path.basename(dir), edit.chunk);
assert.equal(path.basename(path.dirname(dir)), edit.locale);
assert.equal(edit.manifestHash, manifest.manifestHash);
assert(edit.reviewer?.length > 12 && edit.reviewScope?.length > 30);
assert.equal(edit.nativeLanguageReview, 'pending');
assert(Array.isArray(edit.corrections));
assert(edit.corrections.length || edit.verifiedLiteralKeep, 'Require an explicit text correction or the one verified operational-label clarification');
assert(!existsSync(path.join(dir, 'accepted.json')) && !existsSync(path.join(dir, 'completed.json')), 'Never overwrite or replay an applied chunk');
const started = JSON.parse(readFileSync(path.join(dir, 'started.json')));
assert.equal(started.manifestHash, manifest.manifestHash);
assert.equal(started.locale, edit.locale);
assert.equal(started.chunk, edit.chunk);
const failure = JSON.parse(readFileSync(path.join(dir, 'failed.json')));
assert.equal(failure.phase, 'gate', 'Cannot salvage incomplete, timed-out, or failed transport');
for (const page of manifest.pages) assert.equal(sha(readFileSync(path.join(ROOT, 'www/help', page.route, 'index.html'))), page.sourceHash, 'Frozen English source changed');
const prompt = readFileSync(path.join(dir, 'draft.prompt.txt'), 'utf8');
const begin = 'BEGIN UNTRUSTED SOURCE REQUEST\n', end = '\nEND UNTRUSTED SOURCE REQUEST';
assert.equal(prompt.split(begin).length, 2); assert.equal(prompt.split(end).length, 2);
const request = JSON.parse(prompt.slice(prompt.indexOf(begin) + begin.length, prompt.indexOf(end)));
assert.equal(sha(JSON.stringify(request, null, 2) + '\n'), started.requestHash, 'Pinned request changed');
assert.equal(request.locale, edit.locale); assert.equal(request.manifestHash, manifest.manifestHash);
const original = JSON.parse(readFileSync(path.join(dir, 'review.proposal.json')));
assert.equal(sha(JSON.stringify(original)), edit.originalReviewHash, 'Fresh review changed since the manual audit');
const draft = JSON.parse(readFileSync(path.join(dir, 'draft.proposal.json')));
for (const [phase, proposal] of [['draft', draft], ['review', original]]) {
  const transport = JSON.parse(readFileSync(path.join(dir, phase + '.transport.json')));
  assert.equal(sha(JSON.stringify(parseTransport(transport))), sha(JSON.stringify(proposal)), 'Proposal does not match complete, successful transport');
}
const fields = new Map([...manifest.pages.flatMap(page => page.fields), ...manifest.chrome].map(field => [field.id, field]));
assert(Object.keys(original).every(key => ['translations', 'keptFields'].includes(key)), 'Unexpected review envelope keys');
assert.deepEqual(Object.keys(original.translations).sort(), request.fields.map(field => field.id).sort(), 'Review must contain the complete exact chunk');
for (const field of request.fields) assert.equal(field.text, fields.get(field.id)?.text, 'Request disagrees with frozen source');
const translations = { ...original.translations };
const changed = new Set();
for (const correction of edit.corrections) {
  assert(fields.has(correction.fieldId) && typeof translations[correction.fieldId] === 'string');
  assert(!changed.has(correction.fieldId), 'One explicit edit per field');
  assert(correction.before && correction.after && correction.reason?.length > 12);
  const pieces = translations[correction.fieldId].split(correction.before);
  assert.equal(pieces.length, 2, 'Correction must match exactly one reviewed substring');
  translations[correction.fieldId] = pieces.join(correction.after);
  changed.add(correction.fieldId);
}
const kept = original.keptFields || {};
if (edit.verifiedLiteralKeep) {
  const literal = edit.verifiedLiteralKeep;
  assert.equal(literal.fieldId, 'workbooks.tutorial.0067');
  assert.equal(literal.sourceHash, 'd02073d0cfe1eba58a30788da919516205f791dbeaedc199ddccfa5adf47c767');
  assert.equal(literal.identifier, 'Markov Groups: A Random Walk on Cube Moves');
  const field = fields.get(literal.fieldId);
  assert.equal(field.sourceHash, literal.sourceHash);
  assert.equal(translations[literal.fieldId], field.text);
  assert.equal(translations[literal.fieldId], literal.identifier);
  assert(kept[literal.fieldId], 'Original independent review must have kept this exact literal title');
  validateKeep(field, kept[literal.fieldId]);
}
for (const [id, reason] of Object.entries(kept)) {
  assert(Object.hasOwn(translations, id), 'Keep outside this chunk');
  validateKeep(fields.get(id), reason);
  assert.equal(translations[id].trim(), fields.get(id).text.trim(), 'Only unchanged text needs a keep declaration');
}
for (const [id, text] of Object.entries(translations)) {
  assert(fields.has(id), 'Unknown field');
  if (kept[id]) validateKeep(fields.get(id), kept[id]);
  validateText(fields.get(id), text, { allowSource: Boolean(kept[id]) });
}
const accepted = {
  manifestHash: manifest.manifestHash, translations,
  review: {
    status: 'accepted', reviewer: edit.reviewer + (edit.corrections.length ? ' (manual correction after independent Gemini review)' : ' (verified literal-label acceptance after independent Gemini review)'),
    draftModel: started.model, nativeLanguageReview: 'pending', keptFields: kept,
    requestHash: started.requestHash, draftHash: sha(JSON.stringify(draft)), reviewedHash: edit.originalReviewHash,
    originalMachineReviewer: started.model + ' (fresh independent invocation)',
    finalControllerHash: sha(JSON.stringify(translations)),
    controllerEditorialCorrection: edit,
    requests: { draft: 1, freshReview: 1, repair: 0 },
  },
};
if (checkOnly) {
  console.log(`${edit.locale}/${edit.chunk}: complete transport, pinned review/request/source and all ${Object.keys(translations).length} validated fields pass; no writes or model calls.`);
  process.exit(0);
}
const applyRoot = path.join(tmpdir(), 'scirepl-tutorial-apply-locks', sha(ROOT));
mkdirSync(applyRoot, { recursive: true });
const lock = path.join(applyRoot, edit.locale), nonce = randomUUID();
mkdirSync(lock);
writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, nonce, locale: edit.locale }), { flag: 'wx' });
try {
  writeFileSync(path.join(dir, 'accepted.json'), JSON.stringify(accepted, null, 2) + '\n', { flag: 'wx' });
  const result = spawnSync(process.execPath, [path.join(ROOT, 'scripts/tutorial_locale_apply.mjs'), edit.locale, path.join(dir, 'accepted.json')], { encoding: 'utf8', cwd: ROOT });
  assert.equal(result.status, 0, result.stderr || 'Deterministic apply failed');
  writeFileSync(path.join(dir, 'completed.json'), JSON.stringify({ ...started, fields: Object.keys(translations).length,
    acceptedHash: sha(readFileSync(path.join(dir, 'accepted.json'))), status: 'controller-reviewed-manual-correction-passed',
    nativeLanguageReview: 'pending', manualCorrections: edit.corrections.length }, null, 2) + '\n', { flag: 'wx' });
  console.log(`${edit.locale}/${edit.chunk}: applied ${Object.keys(translations).length} fields after ${edit.corrections.length} explicit text corrections${edit.verifiedLiteralKeep ? ' and a verified literal-label clarification' : ''}; no extra model call.`);
} finally {
  const owner = JSON.parse(readFileSync(path.join(lock, 'owner.json')));
  assert.equal(owner.pid, process.pid); assert.equal(owner.nonce, nonce);
  unlinkSync(path.join(lock, 'owner.json')); rmdirSync(lock);
}
