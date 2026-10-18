#!/usr/bin/env node
// Offline-only AGY double. It never imports networking or calls a provider.
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
const root = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('0.0.1'); process.exit(0); }
const config = JSON.parse(readFileSync(path.join(root, 'fake-config.json')));
const prompt = args[args.indexOf('-p') + 1], review = prompt.includes('BEGIN UNTRUSTED REVIEW SECTION');
const raw = prompt.split(review ? 'BEGIN UNTRUSTED REVIEW SECTION\n' : 'BEGIN UNTRUSTED SECTION\n')[1].split('\nEND UNTRUSTED')[0];
const request = JSON.parse(raw), conversation = args.includes('--conversation') ? args[args.indexOf('--conversation') + 1] : null;
if (args.includes('--continue') || args.includes('-c')) throw new Error('Implicit continuation is forbidden');
const sessionFile = path.join(root, 'fake-sessions.json');
const sessions = existsSync(sessionFile) ? JSON.parse(readFileSync(sessionFile)) : {};
let id = conversation || randomUUID();
if (conversation && (!sessions[id] || sessions[id].review !== review || sessions[id].route !== request.route || sessions[id].workspace !== process.cwd())) throw new Error('Wrong conversation identity');
if (!sessions[id]) sessions[id] = { review, route: request.route, workspace: process.cwd(), turns: 0 };
sessions[id].turns++; writeFileSync(sessionFile, JSON.stringify(sessions));
appendFileSync(path.join(root, 'fake-calls.jsonl'), JSON.stringify({ id, resumed: Boolean(conversation), review, route: request.route, workspace: process.cwd(), fieldIds: request.fields.map(field => field.id), argvHasImplicitContinue: false, workerPath: process.env.PATH,
  ...(review ? { reviewFields: request.fields, explicitKeepReview: prompt.includes('for EVERY such unchanged eligible label'), exactNumericReview: prompt.includes('preserve every exact sequence in order') } : {}) }) + '\n');
if (config.mode === 'hang') { console.log('offline fake pending'); setInterval(() => {}, 1000); }
else {
  if (config.mode === 'drift' && !review) appendFileSync(config.driftFile, '\n');
  if (config.mode === 'evidence-drift' && !review) appendFileSync(config.evidenceFile, '\n');
  if (config.mode === 'helper-drift' && !review) appendFileSync(config.helperFile, '\n');
  if (config.mode === 'correction-evidence-drift' && review) appendFileSync(config.evidenceFile, '\n');
  if (config.mode === 'correction-helper-drift' && review) appendFileSync(config.helperFile, '\n');
  if (config.mode === 'correction-baseline-drift' && review) {
    const record = JSON.parse(readFileSync(config.baselineFile));
    record.translations[Object.keys(record.translations)[0]] = 'Une valeur approuvée a changé.';
    writeFileSync(config.baselineFile, JSON.stringify(record));
  }
  if (config.mode === 'write-file') writeFileSync(path.join(process.cwd(), 'unexpected.txt'), 'offline fixture');
  if (config.mode === 'wrong-id' && conversation) id = randomUUID();
  if (config.mode === 'prior-id' && review) id = 'historical-review-' + request.route;
  const translations = Object.fromEntries(request.fields.map(field => [field.id, request.translations?.[field.id] || 'Texte traduit : ' + field.text]));
  if (config.mode === 'invalid-review' && review) Object.keys(translations).forEach(key => { translations[key] += ' 987654321'; });
  if (config.mode === 'numeric-order' && review && translations['alpha.one']) translations['alpha.one'] = 'Valeurs 10 puis 2.';
  if (config.mode === 'numeric-script' && review && translations['alpha.one']) translations['alpha.one'] = 'Valeurs ٢ puis ١٠.';
  const keptFields = {};
  if (['label-keep', 'missing-label-keep'].includes(config.mode) && review) for (const field of request.fields.filter(field => field.id === 'alpha.one')) {
    translations[field.id] = field.text;
    if (config.mode === 'label-keep') keptFields[field.id] = 'Independent offline reviewer confirms this is the customary borrowed label.';
  }
  const envelope = JSON.stringify({ status: config.mode === 'failed-review' && review ? 'ERROR' : 'SUCCESS', conversation_id: id, response: JSON.stringify({ translations, ...(Object.keys(keptFields).length ? { keptFields } : {}) }), duration_seconds: 1, usage: { input_tokens: 1, output_tokens: 1 } });
  // Complete final envelope, then the process never exits (field-observed hang).
  // Like an MCP helper: a descendant inherits stdout/stderr and outlives the worker.
  if (config.mode === 'stuck-with-descendant' && review) {
    const helper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 'inherit', 'inherit'] });
    appendFileSync(path.join(root, 'fake-descendants.txt'), helper.pid + '\n');
    process.stdout.write(envelope + '\n'); setInterval(() => {}, 1000);
  } else if (config.mode === 'stuck-after-complete' && review) { process.stdout.write(envelope + '\n'); setInterval(() => {}, 1000); }
  // Slow but working: half an envelope, a pause longer than the grace, the rest.
  else if (config.mode === 'slow-complete' && review) { process.stdout.write(envelope.slice(0, 20)); setTimeout(() => console.log(envelope.slice(20)), 2500); }
  else console.log(envelope);
}
