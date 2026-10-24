#!/usr/bin/env node
// One-off, explicitly user-approved acceptance of a HELD stuck-after-completion
// review phase whose worker printed a complete envelope and was then stopped
// (before the controller captured stack dumps). The approval record carries a
// parsed goroutine-dump summary (never a raw crash log) showing the
// title-generation hang. Nothing is salvaged: the held envelope must be complete
// and pass the same transport, identity and review gates as the controller.
// No model, provider or authentication request is made. The old campaign and
// its pins are only read; new receipts go to a fresh private output directory.
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { ROOT, readManifest, localeFile, sha } from './tutorial_locale_lib.mjs';
import { acceptStuckAfterCompletion, matchStackSignature, STUCK_ACCEPTANCE_SIGNATURE } from './tutorial_translation_transport.mjs';
import { gateSection } from './tutorial_section_protocol.mjs';
import { getProcessStartIdentity } from './tutorial_translation_queue.mjs';

const MODEL = 'gemini-3.8-flash-medium';
const json = file => JSON.parse(readFileSync(file, 'utf8'));
const plain = value => value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
function regular(file) { const info = lstatSync(file); assert(info.isFile() && !info.isSymbolicLink(), 'Evidence must be regular files'); return readFileSync(file); }
function pinned(pin) { assert(pin && typeof pin.file === 'string' && /^[a-f0-9]{64}$/.test(pin.sha256), 'Invalid pin'); assert.equal(sha(regular(pin.file)), pin.sha256, 'Pinned evidence changed: ' + path.basename(pin.file)); }
function dead(record, what) {
  assert(Number.isSafeInteger(record?.pid) && typeof record.startIdentity === 'string', 'Unverifiable ' + what);
  let current;
  try { current = getProcessStartIdentity(record.pid); } catch (error) { if (['ENOENT', 'ESRCH'].includes(error.code)) return; throw error; }
  assert.notEqual(record.startIdentity.includes(':') ? current : current.split(':').at(-1), record.startIdentity, what + ' is still live');
}

export function validateStuckApproval(value) {
  assert(plain(value) && value.schema === 1 && value.kind === 'user-approved-stuck-worker-acceptance', 'Invalid stuck-worker acceptance approval');
  assert(typeof value.approvalId === 'string' && /^[\w.-]{8,120}$/.test(value.approvalId), 'Invalid approval identity');
  assert(typeof value.approvedBy === 'string' && value.approvedBy.trim() && Number.isFinite(Date.parse(value.approvedAt)), 'Approval provenance is required');
  assert(typeof value.sourceJob === 'string' && value.sourceJob.startsWith('/tmp/scirepl-tutorial-translation-job-'), 'Approval must name the held job');
  assert(typeof value.phase === 'string' && /^[a-zA-Z-]{2,5}\/\d{2}\/review-\d{2}$/.test(value.phase), 'Approval must name one held review phase');
  assert.equal(value.outcome, 'accepted-after-stuck-worker'); assert.equal(value.manualReviewSuggested, true);
  assert.equal(value.automaticRetries, false); assert.equal(value.modelCalls, 0);
  const summary = value.evidence?.stackSummary;
  assert(plain(summary) && summary.knownSignature === STUCK_ACCEPTANCE_SIGNATURE, 'Approval evidence must be a title-generation-hang stack summary');
  // Independently re-match the signature from the summary's own frames.
  const goroutines = [{ id: 1, frames: summary.main?.frames || [] }, ...(summary.blocked || []).map(row => ({ id: row.id, frames: row.frames || [] }))];
  assert.equal(matchStackSignature(goroutines, { completeOutput: true }), STUCK_ACCEPTANCE_SIGNATURE, 'Stack summary frames do not show the title-generation hang');
  assert(plain(value.transport) && /^[a-f0-9]{64}$/.test(value.transport.sha256), 'Approval must pin the held transport');
  return value;
}

export function acceptHeldStuckPhase({ approvalFile, outputDir, execute = false }) {
  const approvalBytes = regular(path.resolve(approvalFile)), approval = validateStuckApproval(JSON.parse(approvalBytes.toString('utf8')));
  const job = path.resolve(approval.sourceJob), config = json(path.join(job, 'config.json')), result = json(path.join(job, 'result.json'));
  assert.equal(config.schema, 1); assert.equal(config.root, ROOT); assert.equal(config.job, job); assert.equal(result.state, 'held', 'Source job must be terminal held');
  const campaign = path.resolve(config.campaign), planFile = path.resolve(config.sectionsPlan);
  assert(campaign.startsWith('/tmp/scirepl-tutorial-translation-')); assert(!existsSync(path.join(campaign, 'controller.lock')), 'Source controller must be drained');
  const planPin = config.pins.find(row => row.file === planFile); assert(planPin && sha(regular(planFile)) === planPin.hash, 'Source job plan pin differs');
  const plan = json(planFile), { planHash, ...unsigned } = plan; assert.equal(sha(JSON.stringify(unsigned)), planHash, 'Plan semantic hash changed');
  const status = json(path.join(campaign, 'controller-status.json')); assert.equal(status.state, 'held'); dead(status.controller, 'Source controller');
  const [locale, chunk, phase] = approval.phase.split('/'), dir = path.join(campaign, locale, chunk), base = path.join(dir, phase);
  const pages = plan.locales.find(row => row.locale === locale)?.pages || [], page = pages[Number(chunk) - 1];
  assert(page, 'Held page is not in the source plan');
  const started = json(path.join(dir, 'started.json')); assert.equal(started.planHash, planHash); assert.equal(started.route, page.route); assert.equal(started.locale, locale);
  const failed = json(path.join(dir, 'failed.json')); assert.equal(failed.phase, phase); assert.match(failed.error, /stuck after complete output/, 'Only a stuck-after-completion hold is eligible');
  assert(!existsSync(path.join(dir, 'accepted.json')) && !existsSync(path.join(dir, 'completed.json')), 'Page already accepted');
  dead(json(base + '.child.json'), 'Held worker');
  // Held envelope: pinned by the approval, complete before termination, then the
  // unchanged parseTransport via the single stuck-worker acceptance path.
  const transportBytes = regular(base + '.transport.json'); assert.equal(sha(transportBytes), approval.transport.sha256, 'Held transport differs from approval');
  const transport = JSON.parse(transportBytes.toString('utf8'));
  assert.deepEqual(transport.unexpectedFiles, [], 'Held worker wrote files'); assert.equal(transport.persistenceFailure, false);
  const proposal = acceptStuckAfterCompletion(transport, { ...approval.evidence.stackSummary, completeOutput: true });
  const id = JSON.parse(transport.stdout).conversation_id;
  assert(typeof id === 'string' && /^[\w.-]{1,200}$/.test(id), 'Missing explicit conversation identity');
  assert(!page.recovery.priorConversationIds.includes(id), 'Reviewer reused a prior conversation');
  // Same pins and gates as the controller.
  const manifest = readManifest(); assert.equal(manifest.manifestHash, plan.manifestHash, 'Manifest changed');
  pinned(plan.manifestFile); for (const pin of plan.sources) pinned(pin);
  for (const seed of page.draftSeeds) { pinned(seed.source.transport); pinned(seed.source.proposal); assert.equal(seed.locale, locale); }
  assert.deepEqual(page.reviewSeeds, [], 'Preserved reviews are not expected for this page');
  assert.equal(page.correctionReviews.length, Number(phase.slice(-2)), 'Held phase must be the page\'s final review batch');
  const sourceFields = new Map([...manifest.pages.flatMap(row => row.fields), ...manifest.chrome].map(field => [field.id, field]));
  const candidates = Object.fromEntries(page.draftSeeds.map(seed => { assert.equal(seed.text, sourceFields.get(seed.id)?.text, 'Seed source changed'); return [seed.id, seed.translation]; }));
  const batch = page.correctionReviews[Number(phase.slice(-2)) - 1].fieldIds, fields = batch.map(fieldId => { assert(sourceFields.has(fieldId)); return sourceFields.get(fieldId); });
  assert.deepEqual([...batch].sort(), Object.keys(candidates).sort(), 'Held review batch must cover the whole held page');
  const normalized = gateSection(fields, proposal, sourceFields);
  const expectedIds = Object.keys(candidates).sort();
  assert.deepEqual(Object.keys(normalized.translations).sort(), expectedIds, 'Page review incomplete');
  gateSection(expectedIds.map(fieldId => sourceFields.get(fieldId)), normalized, sourceFields);
  const record = existsSync(localeFile(locale)) ? json(localeFile(locale)) : { translations: {} };
  for (const [baselineLocale, values] of Object.entries(plan.recovery?.acceptedBaseline || {})) {
    const current = existsSync(localeFile(baselineLocale)) ? json(localeFile(baselineLocale)) : { translations: {} };
    for (const [fieldId, value] of Object.entries(values)) assert.equal(current.translations[fieldId], value, 'Accepted baseline changed');
  }
  for (const context of page.context) assert.equal(record.translations[context.id], context.translation, 'Accepted context changed');
  assert(expectedIds.every(fieldId => !Object.hasOwn(record.translations, fieldId)), 'Refusing to overwrite an accepted translation');
  const summary = { mode: execute ? 'execute' : 'prepare-only', phase: approval.phase, route: page.route, fields: expectedIds.length, knownSignature: STUCK_ACCEPTANCE_SIGNATURE, noModelsCalled: true };
  if (!execute) return summary;

  const out = path.resolve(outputDir);
  assert(out.startsWith(path.join(tmpdir(), 'scirepl-tutorial-stuck-acceptance-')) || out.startsWith('/tmp/scirepl-tutorial-stuck-acceptance-'), 'Use a fresh private output directory');
  mkdirSync(out, { mode: 0o700 });
  const approvalPin = { file: path.resolve(approvalFile), sha256: sha(approvalBytes) };
  const receipt = { manifestHash: manifest.manifestHash, translations: normalized.translations, review: { status: 'accepted',
    reviewer: MODEL + ' (fresh independent review under an explicit user-approved allowance; complete output kept from a worker stopped during conversation-title generation, explicitly user-approved)',
    draftModel: MODEL, nativeLanguageReview: 'pending', keptFields: normalized.keptFields, planHash, source: 'explicit-approved-review-allowance',
    requests: { draft: 0, freshReview: 1, repair: 0 }, preservedDraftFields: page.draftSeeds.length, preservedReviewFields: 0, preservedReviewSections: 0,
    explicitApprovedReviewAllowance: true, allowanceId: plan.recovery.allowanceId,
    draftHash: sha(JSON.stringify(candidates)), reviewedHash: sha(JSON.stringify(normalized.translations)),
    outcome: 'accepted-after-stuck-worker', manualReviewSuggested: true, manualReviewFields: expectedIds,
    stuckWorkerAcceptances: [{ phase, outcome: 'accepted-after-stuck-worker', knownSignature: STUCK_ACCEPTANCE_SIGNATURE, fields: expectedIds.length }],
    stuckWorkerApproval: { approvalId: approval.approvalId, approval: approvalPin, sourceCampaign: campaign, heldPhase: approval.phase, transportSha256: approval.transport.sha256 } } };
  writeFileSync(path.join(out, 'accepted.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  // Same apply lock and deterministic apply as the controller.
  const applyRoot = path.join(tmpdir(), 'scirepl-tutorial-apply-locks', sha(ROOT)); mkdirSync(applyRoot, { recursive: true, mode: 0o700 });
  const lockDir = path.join(applyRoot, locale), owner = { pid: process.pid, startIdentity: getProcessStartIdentity(), nonce: randomUUID() };
  mkdirSync(lockDir, { mode: 0o700 }); writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify(owner) + '\n', { flag: 'wx', mode: 0o600 });
  try {
    const now = existsSync(localeFile(locale)) ? json(localeFile(locale)) : { translations: {} };
    assert(expectedIds.every(fieldId => !Object.hasOwn(now.translations, fieldId)), 'Refusing to overwrite an accepted translation');
    const applied = spawnSync(process.execPath, [path.join(ROOT, 'scripts/tutorial_locale_apply.mjs'), locale, path.join(out, 'accepted.json')], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1024 * 1024 });
    assert.equal(applied.status, 0, 'Deterministic page apply failed');
  } finally { assert.deepEqual(json(path.join(lockDir, 'owner.json')), owner); unlinkSync(path.join(lockDir, 'owner.json')); rmdirSync(lockDir); }
  writeFileSync(path.join(out, 'completed.json'), JSON.stringify({ planHash, locale, route: page.route, fields: expectedIds.length, acceptedHash: sha(readFileSync(path.join(out, 'accepted.json'))),
    nativeLanguageReview: 'pending', outcome: 'accepted-after-stuck-worker', manualReviewSuggested: true, approvalId: approval.approvalId }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return summary;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), option = name => { const index = args.indexOf(name); return index === -1 ? null : args[index + 1]; };
  try {
    assert(option('--approval'), 'Usage: --approval APPROVAL.json [--output-dir /tmp/scirepl-tutorial-stuck-acceptance-NEW --execute]');
    const execute = args.includes('--execute'); assert(!execute || option('--output-dir'), '--execute requires --output-dir');
    console.log(JSON.stringify(acceptHeldStuckPhase({ approvalFile: option('--approval'), outputDir: option('--output-dir'), execute })));
  } catch (error) { console.error(JSON.stringify({ held: true, error: error.message })); process.exitCode = 1; }
}
