// A NEW, explicitly user-approved, finite review allowance for page/language
// units that a stopped continuation (or an earlier generation of the same
// allowance) left held. It never extends an exhausted lineage: the old ceiling
// is recorded as history and the new ceiling comes only from a pinned approval
// record. Preparation is read-only. No draft is regenerated, no failed or
// cancelled output is salvaged, and every acceptance gate is unchanged.
import assert from 'node:assert/strict';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, LOCALES, sha } from './tutorial_locale_lib.mjs';
import { prepareSectionPlan, buildSectionPlan, classifySections, writeSectionPlan } from './tutorial_locale_section_plan.mjs';
import { parseTransport } from './tutorial_translation_transport.mjs';
import { getProcessStartIdentity } from './tutorial_translation_queue.mjs';
import { correctionReviewPrompt } from './tutorial_section_protocol.mjs';
import { packReviewSections } from './tutorial_review_batching.mjs';
import { splitContinuationReviewSections } from './tutorial_section_review_continuation_plan.mjs';

export const ALLOWANCE_KIND = 'explicit-approved-review-allowance';
const SOURCE_KINDS = ['explicit-never-dispatched-review-continuation', ALLOWANCE_KIND];
const input = (file, json = true) => {
  const absolute = path.resolve(file), info = lstatSync(absolute);
  assert(info.isFile() && !info.isSymbolicLink(), 'Allowance evidence must be regular files');
  const bytes = readFileSync(absolute);
  return { file: absolute, sha256: sha(bytes), value: json ? JSON.parse(bytes.toString('utf8')) : null };
};
const pin = row => ({ file: row.file, sha256: row.sha256 });
const verified = expected => {
  assert(expected && typeof expected.file === 'string' && /^[a-f0-9]{64}$/.test(expected.sha256), 'Invalid allowance evidence pin');
  const row = input(expected.file, expected.file.endsWith('.json'));
  assert.equal(row.sha256, expected.sha256, 'Prior evidence changed'); return row;
};
function dead(record) {
  assert(Number.isSafeInteger(record?.pid) && record.pid > 0 && typeof record.startIdentity === 'string', 'Unverifiable prior ownership');
  try { const current = getProcessStartIdentity(record.pid); assert.notEqual(record.startIdentity.includes(':') ? current : current.split(':').at(-1), record.startIdentity, 'Prior owner or worker remains live'); }
  catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error; }
}
function semantic(row) {
  const { planHash, ...unsigned } = row.value;
  assert.equal(row.value.schema, 1); assert.equal(row.value.kind, 'tutorial-coherent-section-plan');
  assert.equal(sha(JSON.stringify(unsigned)), planHash, 'Source semantic plan changed'); return planHash;
}
function remember(id, identities) { if (id == null) return; assert(typeof id === 'string' && /^[\w.-]{1,200}$/.test(id), 'Malformed old conversation identity'); identities.add(id); }

// The approval record is the only source of a new ceiling. It is written once
// by the operator on the repository owner's explicit instruction and pinned.
export function validateAllowance(value) {
  assert(value && value.schema === 1 && value.kind === 'user-approved-review-allowance', 'Invalid review allowance record');
  assert(typeof value.allowanceId === 'string' && /^[\w.-]{8,120}$/.test(value.allowanceId), 'Invalid allowance identity');
  assert(typeof value.approvedBy === 'string' && value.approvedBy.trim() && Number.isFinite(Date.parse(value.approvedAt)), 'Allowance approval provenance is required');
  assert.equal(value.maxDraftCalls, 0, 'A review allowance never authorizes drafting');
  assert(Number.isSafeInteger(value.maxReviewCalls) && value.maxReviewCalls >= 1 && value.maxReviewCalls <= 5, 'Review allowance must be a small explicit positive ceiling');
  assert(Array.isArray(value.scope) && value.scope.length && value.scope.every(row => LOCALES.includes(row?.locale) && row.locale !== 'en' && typeof row.route === 'string' && row.route), 'Allowance scope must name page/language units');
  assert.equal(new Set(value.scope.map(row => row.locale + '/' + row.route)).size, value.scope.length, 'Allowance scope repeated');
  assert(typeof value.originSourceJob === 'string' && value.originSourceJob.startsWith('/tmp/scirepl-tutorial-translation-job-'), 'Allowance must name the stopped job it follows');
  assert.equal(value.automaticRetries, false, 'An allowance never enables automatic retry');
  return value;
}

export function prepareSectionReviewAllowancePlan({ root = ROOT, sourceJob, allowanceFile } = {}) {
  assert(sourceJob && allowanceFile, 'Usage: --source-job STOPPED_JOB --allowance APPROVAL.json');
  root = path.resolve(root); sourceJob = path.resolve(sourceJob);
  const approval = input(allowanceFile), allowance = validateAllowance(approval.value);
  const config = input(path.join(sourceJob, 'config.json')), result = input(path.join(sourceJob, 'result.json'));
  assert.equal(config.value.schema, 1); assert.equal(config.value.root, root); assert.equal(config.value.job, sourceJob);
  assert(['held', 'cancelled'].includes(result.value.state), 'Source job must be terminal held/cancelled'); assert(Number.isFinite(Date.parse(result.value.finishedAt)));
  const sourcePlanFile = path.resolve(config.value.sectionsPlan), sourceCampaign = path.resolve(config.value.campaign);
  assert(!existsSync(path.join(sourceCampaign, 'controller.lock')), 'Source controller must be drained');
  const old = input(sourcePlanFile), oldPlan = old.value, oldHash = semantic(old);
  assert(SOURCE_KINDS.includes(oldPlan.recovery?.kind), 'An allowance follows only a stopped continuation or an earlier generation of itself');
  assert(config.value.pins?.some(row => row.file === old.file && row.hash === old.sha256), 'Source job plan pin differs');
  // Lineage: the first generation must follow the exact stopped job named in
  // the approval; later generations must spend the SAME pinned approval.
  let priorAllowanceCharged = 0;
  const status = input(path.join(sourceCampaign, 'controller-status.json'));
  assert(['held', 'cancelled'].includes(status.value.state)); assert.equal(status.value.unit, 'pages'); dead(status.value.controller);
  const used = status.value.recoveryBudget?.usedReviewCalls;
  assert(Number.isSafeInteger(used) && used >= 0 && status.value.recoveryBudget.usedDraftCalls === 0, 'Source charged calls are unverifiable');
  if (oldPlan.recovery.kind === ALLOWANCE_KIND) {
    assert.equal(oldPlan.recovery.allowance.sha256, approval.sha256, 'A later generation must spend the same pinned approval');
    priorAllowanceCharged = oldPlan.recovery.reviewBudgetLineage.priorAllowanceCharged + used;
  } else assert.equal(path.resolve(allowance.originSourceJob), sourceJob, 'Approval names a different stopped job');
  const remaining = allowance.maxReviewCalls - priorAllowanceCharged;
  assert(remaining > 0, 'Approved review allowance is exhausted');
  const evidence = new Map([config, result, status, old, approval].map(row => [row.file, pin(row)])), identities = new Set();
  const keep = row => { evidence.set(row.file, pin(row)); return row; };
  for (const name of ['owner.json', 'controller.json', 'launch.json', 'cancel.request.json']) {
    const file = path.join(sourceJob, name); if (!existsSync(file)) { assert(name !== 'owner.json' && name !== 'controller.json', 'Missing source ownership'); continue; }
    const row = keep(input(file)); assert.equal(row.value.nonce, config.value.nonce); if (name !== 'cancel.request.json') dead(row.value);
  }
  for (const phase of status.value.phases || []) if (phase.worker) dead(phase.worker);
  for (const expected of [oldPlan.manifestFile, ...oldPlan.sources]) keep(verified(expected));
  const baseline = prepareSectionPlan({ root, campaigns: [], locales: LOCALES.filter(locale => locale !== 'en'),
    maxChars: oldPlan.maximumSectionCharacters, minChars: oldPlan.tinySectionCharacters });
  assert.equal(baseline.manifestHash, oldPlan.manifestHash);
  const manifest = input(baseline.manifestFile.file).value, fields = new Map([...manifest.pages.flatMap(page => page.fields), ...manifest.chrome].map(field => [field.id, field]));
  const records = Object.fromEntries(baseline.accepted.filter(row => row.sha256 !== null).map(row => [row.locale, input(row.file).value]));
  const acceptedBaseline = Object.fromEntries(LOCALES.filter(locale => locale !== 'en').map(locale => [locale, records[locale]?.translations || {}]));
  for (const [locale, values] of Object.entries(oldPlan.recovery.acceptedBaseline)) for (const [id, text] of Object.entries(values)) assert.equal(acceptedBaseline[locale]?.[id], text, 'Source accepted baseline changed');
  const scope = new Set(allowance.scope.map(row => row.locale + '/' + row.route)), selected = new Set(), seeds = [], heldPhases = [];
  for (const locale of oldPlan.locales) for (const [index, page] of locale.pages.entries()) {
    const directory = path.join(sourceCampaign, locale.locale, String(index + 1).padStart(2, '0')), unit = locale.locale + '/' + page.route;
    for (const id of page.recovery?.priorConversationIds || []) remember(id, identities);
    const names = existsSync(directory) ? readdirSync(directory).sort() : [];
    for (const name of names) {
      const row = keep(input(path.join(directory, name), name.endsWith('.json')));
      if (name.endsWith('.session.json')) remember(row.value.conversationId, identities);
      if (name.endsWith('.child.json')) dead(row.value);
      // Identity only: a failed/cancelled envelope is never a translation source.
      if (name.endsWith('.transport.json')) { try { const id = JSON.parse(row.value.stdout)?.conversation_id; if (typeof id === 'string' && /^[\w.-]{1,200}$/.test(id)) identities.add(id); } catch { /* incomplete output */ } }
    }
    if (names.includes('completed.json')) {
      const done = input(path.join(directory, 'completed.json')), accepted = input(path.join(directory, 'accepted.json'));
      assert.equal(done.value.planHash, oldHash); assert.equal(done.value.acceptedHash, accepted.sha256);
      for (const [id, text] of Object.entries(accepted.value.translations)) assert.equal(acceptedBaseline[locale.locale][id], text, 'Completed source page is not applied');
      assert(!scope.has(unit), 'Allowance scope names a completed page');
      continue;
    }
    if (names.length) {
      assert(names.includes('started.json') && names.includes('failed.json'), 'Source page is neither completed nor explicitly held');
      const failure = input(path.join(directory, 'failed.json')).value, started = input(path.join(directory, 'started.json')).value;
      assert.equal(failure.planHash, oldHash); assert.equal(started.planHash, oldHash); assert.equal(started.route, page.route); assert.equal(failure.noAutomaticRetry, true);
      assert(/^review-\d{2}$/.test(failure.phase), 'Only a held review is eligible');
      assert(!names.includes('accepted.json'), 'Held page unexpectedly has an acceptance receipt');
      heldPhases.push({ locale: locale.locale, route: page.route, directory, phase: failure.phase });
    }
    assert(scope.has(unit), 'Held source page is outside the approved allowance scope');
    selected.add(unit);
    for (const seed of page.draftSeeds) {
      if (Object.hasOwn(acceptedBaseline[locale.locale], seed.id)) continue;
      assert(seed.locale === locale.locale && seed.text === fields.get(seed.id)?.text, 'Held page lacks its original successful draft');
      const transport = keep(verified(seed.source.transport)), proposal = keep(verified(seed.source.proposal));
      const envelope = JSON.parse(transport.value.stdout); assert(!envelope.is_error && !envelope.error, 'Contradictory SUCCESS');
      assert.deepEqual(parseTransport(transport.value), proposal.value, 'Seed differs from complete SUCCESS transport');
      assert.deepEqual(transport.value.unexpectedFiles || [], []); assert.equal(proposal.value.translations?.[seed.id], seed.translation);
      remember(envelope.conversation_id, identities);
      for (const kind of ['session', 'dispatched']) if (seed.source[kind]) remember(keep(verified(seed.source[kind])).value.conversationId, identities);
      seeds.push(seed);
    }
  }
  assert.deepEqual([...selected].sort(), [...scope].sort(), 'Approved scope differs from the held source pages');
  const htmlByRoute = Object.fromEntries(baseline.sources.map(row => [row.route, readFileSync(row.file, 'utf8')]));
  const plan = buildSectionPlan({ manifest, htmlByRoute, records, draftSeeds: seeds,
    campaignEvidence: [{ campaign: sourceCampaign, request: pin(old), files: [...evidence.values()], approvedReviewAllowance: true }],
    locales: LOCALES.filter(locale => locale !== 'en'), maxChars: oldPlan.maximumSectionCharacters, minChars: oldPlan.tinySectionCharacters,
    pins: { manifestFile: baseline.manifestFile, sources: baseline.sources, accepted: baseline.accepted } });
  assert.deepEqual(plan.locales.flatMap(locale => locale.pages.map(page => locale.locale + '/' + page.route)).sort(), [...scope].sort(), 'Global missing work differs from the approved held pages');
  for (const locale of plan.locales) for (const page of locale.pages) {
    assert.equal(page.sections.length, 0, 'No drafting is authorized'); page.reviewSeeds = [];
    const chosen = new Set(page.draftSeeds.map(seed => seed.id)), candidates = Object.fromEntries(page.draftSeeds.map(seed => [seed.id, seed.translation]));
    const parts = page.route === '@chrome' ? [{ fields: manifest.chrome }] : classifySections(manifest.pages.find(source => source.route === page.route), htmlByRoute[page.route], { maxChars: plan.maximumSectionCharacters, minChars: plan.tinySectionCharacters });
    const sections = splitContinuationReviewSections({ sections: parts.map(part => part.fields.filter(field => chosen.has(field.id))).filter(list => list.length),
      job: { locale: locale.locale, page }, candidates });
    const packed = packReviewSections({ sections, maxPromptBytes: 100000,
      measurePromptBytes: (list, { firstBatch }) => Buffer.byteLength(correctionReviewPrompt({ locale: locale.locale, page }, list, candidates, firstBatch)) });
    page.correctionReviews = packed.batches.map(list => ({ fieldIds: list.map(field => field.id) }));
    page.recovery = { maxDraftCalls: 0, maxReviewCalls: packed.batches.length, priorConversationIds: [...identities].sort() };
  }
  const pages = plan.locales.flatMap(locale => locale.pages), calls = pages.reduce((sum, page) => sum + page.recovery.maxReviewCalls, 0);
  assert(calls > 0 && calls <= remaining, 'Allowance plan would exceed the approved review ceiling');
  const previous = status.value.recoveryBudget;
  plan.recovery = { kind: ALLOWANCE_KIND, sourcePlanHash: oldHash, sourcePlan: pin(old), sourceCampaign, sourceJob, acceptedBaseline,
    allowance: pin(approval), allowanceId: allowance.allowanceId,
    reviewBudgetLineage: { allowanceMaximum: allowance.maxReviewCalls, priorAllowanceCharged, remainingBeforeThisPlan: remaining,
      sourceKind: oldPlan.recovery.kind, sourceUsedReviewCalls: used,
      ...(Number.isSafeInteger(previous.jointMaxReviewCalls) ? { exhaustedPredecessorLineage: { jointUsedReviewCalls: previous.jointUsedReviewCalls, jointMaxReviewCalls: previous.jointMaxReviewCalls } } : {}) },
    heldPhases, automaticRetries: false, dispatchPolicy: { maxConcurrent: 2, minimumDispatchGapMs: 15000 },
    bounds: { pages: pages.length, maxDraftCalls: 0, maxReviewCalls: calls } };
  delete plan.planHash; plan.planHash = sha(JSON.stringify(plan)); return plan;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2), options = {};
    while (args.length) {
      const key = args.shift(), value = args.shift();
      assert(['--source-job', '--allowance', '--output'].includes(key) && value && !value.startsWith('--') && !Object.hasOwn(options, key)); options[key] = value;
    }
    const plan = prepareSectionReviewAllowancePlan({ sourceJob: options['--source-job'], allowanceFile: options['--allowance'] });
    console.log(JSON.stringify({ allowanceId: plan.recovery.allowanceId, bounds: plan.recovery.bounds, reviewBudgetLineage: plan.recovery.reviewBudgetLineage,
      heldPhases: plan.recovery.heldPhases.map(({ locale, route, phase }) => ({ locale, route, phase })),
      ...(options['--output'] ? { output: writeSectionPlan(plan, options['--output']) } : { mode: 'read-only-preparation' }) }, null, 2));
  } catch (error) { console.error('Allowance preparation held: ' + String(error?.message || '').slice(0, 200)); process.exitCode = 1; }
}
