// Forward-only use of UNUSED review calls in the original correction ceiling.
// Preparation is read-only. Consumed phases and continuation sources cannot recur.
import assert from 'node:assert/strict';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, LOCALES, sha } from './tutorial_locale_lib.mjs';
import { prepareSectionPlan, buildSectionPlan, classifySections, writeSectionPlan } from './tutorial_locale_section_plan.mjs';
import { parseTransport } from './tutorial_translation_transport.mjs';
import { getProcessStartIdentity } from './tutorial_translation_queue.mjs';
import { gateSection, correctionReviewPrompt } from './tutorial_section_protocol.mjs';
import { packReviewSections } from './tutorial_review_batching.mjs';

const input = (file, json = true) => {
  const absolute = path.resolve(file), info = lstatSync(absolute);
  assert(info.isFile() && !info.isSymbolicLink(), 'Continuation evidence must be regular files');
  const bytes = readFileSync(absolute);
  return { file: absolute, sha256: sha(bytes), value: json ? JSON.parse(bytes.toString('utf8')) : null };
};
const pin = row => ({ file: row.file, sha256: row.sha256 });
const verified = expected => {
  assert(expected && typeof expected.file === 'string' && /^[a-f0-9]{64}$/.test(expected.sha256), 'Invalid continuation evidence pin');
  const row = input(expected.file, expected.file.endsWith('.json'));
  assert.equal(row.sha256, expected.sha256, 'Prior evidence changed'); return row;
};
function dead(record, bootRequired = false) {
  assert(Number.isSafeInteger(record?.pid) && record.pid > 0 && typeof record.startIdentity === 'string', 'Unverifiable prior ownership');
  assert(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}:\d+$/.test(record.startIdentity) || !bootRequired && /^\d+$/.test(record.startIdentity), 'Malformed prior identity');
  try { const current = getProcessStartIdentity(record.pid); assert.notEqual(record.startIdentity.includes(':') ? current : current.split(':').at(-1), record.startIdentity, 'Prior owner or worker remains live'); }
  catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error; }
}
function semantic(row) {
  const { planHash, ...unsigned } = row.value;
  assert.equal(row.value.schema, 1); assert.equal(row.value.kind, 'tutorial-coherent-section-plan');
  assert.equal(sha(JSON.stringify(unsigned)), planHash, 'Source semantic plan changed'); return planHash;
}
function remember(id, identities) { if (id == null) return; assert(typeof id === 'string' && /^[\w.-]{1,200}$/.test(id), 'Malformed old conversation identity'); identities.add(id); }
function complete(transport, proposal) {
  const envelope = JSON.parse(transport.value.stdout);
  assert(!envelope.is_error && !envelope.error, 'Contradictory SUCCESS');
  assert.deepEqual(parseTransport(transport.value), proposal.value, 'Proposal differs from complete SUCCESS transport');
  assert(!transport.value.persistenceFailure); assert.deepEqual(transport.value.unexpectedFiles || [], []); return envelope;
}
export function assertReviewNeverDispatched(directory, phase, queueDirectory) {
  assert(/^review-\d{2}$/.test(phase));
  assert(!readdirSync(directory).some(name => name.startsWith(phase + '.')), 'Never-dispatched source phase now has evidence');
  assert(!existsSync(queueDirectory), 'Never-dispatched source phase has queue history');
}

// Preserve the complete normal terminology context. Only an oversized source
// section is divided, between complete fields, as in the original controller's
// reviewSections fallback. No prose, field, context, or acceptance gate is cut.
export function splitContinuationReviewSections({ sections, job, candidates }) {
  const pieces = [];
  function add(fields, first) {
    if (Buffer.byteLength(correctionReviewPrompt(job, fields, candidates, first)) <= 100000) { pieces.push(fields); return; }
    assert(fields.length > 1, 'A single review field and complete context exceed the transport cap');
    const middle = Math.ceil(fields.length / 2);
    add(fields.slice(0, middle), first); add(fields.slice(middle), false);
  }
  for (const section of sections) add(section, pieces.length === 0);
  assert.deepEqual(pieces.flatMap(fields => fields.map(field => field.id)), sections.flatMap(fields => fields.map(field => field.id)), 'Review splitting lost or reordered fields');
  return pieces;
}

export function prepareSectionReviewContinuationPlan({ root = ROOT, sourceJob, sourcePlanFile, sourceCampaign, manualReceipts = [],
  expectedAcceptedFields = 13278, expectedRemainingFields = 354, expectedPages = 3, maxReviewCalls = 5 } = {}) {
  assert(sourceJob); root = path.resolve(root); sourceJob = path.resolve(sourceJob);
  assert(Number.isSafeInteger(maxReviewCalls) && maxReviewCalls > 0 && maxReviewCalls <= 5, 'At most five original unused calls may be carried forward');
  const config = input(path.join(sourceJob, 'config.json')), result = input(path.join(sourceJob, 'result.json'));
  assert.equal(config.value.schema, 1); assert.equal(config.value.root, root); assert.equal(config.value.job, sourceJob);
  assert.equal(result.value.state, 'held'); assert.equal(result.value.exitCode, 1); assert(Number.isFinite(Date.parse(result.value.finishedAt)));
  sourcePlanFile = path.resolve(sourcePlanFile || config.value.sectionsPlan); sourceCampaign = path.resolve(sourceCampaign || config.value.campaign);
  assert.equal(sourcePlanFile, config.value.sectionsPlan); assert.equal(sourceCampaign, config.value.campaign);
  assert(!existsSync(path.join(sourceCampaign, 'controller.lock')), 'Source controller must be drained');
  const old = input(sourcePlanFile), oldPlan = old.value, oldHash = semantic(old);
  assert.equal(oldPlan.recovery?.kind, 'explicit-bounded-section-correction', 'Only the original correction may supply unused reviews; continuations cannot recurse');
  assert(config.value.pins?.some(row => row.file === old.file && row.hash === old.sha256), 'Source job plan pin differs');
  const status = input(path.join(sourceCampaign, 'controller-status.json'));
  assert.equal(status.value.state, 'held'); assert.equal(status.value.unit, 'pages'); dead(status.value.controller, true);
  const evidence = new Map([config, result, status, old].map(row => [row.file, pin(row)])), identities = new Set(), sourceTemporaryRoots = new Set();
  const keep = row => { evidence.set(row.file, pin(row)); return row; };
  for (const name of ['owner.json', 'controller.json', 'launch.json']) {
    const file = path.join(sourceJob, name); if (name === 'launch.json' && !existsSync(file)) continue;
    const row = keep(input(file)); assert.equal(row.value.nonce, config.value.nonce); dead(row.value);
  }
  for (const phase of status.value.phases || []) if (phase.worker) dead(phase.worker, true);
  for (const expected of [oldPlan.manifestFile, ...oldPlan.sources]) keep(verified(expected));
  // Dead generations retain their original runtime hashes as history. Frozen
  // source, plans, requests and provider evidence remain strict file pins.
  for (const item of oldPlan.campaignEvidence || []) for (const expected of [item.request, ...(item.files || [])].filter(Boolean)) {
    if (expected.file === process.execPath || expected.file.startsWith(path.join(root, 'scripts') + path.sep) && expected.file.endsWith('.mjs')) continue;
    keep(verified(expected));
  }
  const ancestor = keep(verified(oldPlan.recovery.sourcePlan)); assert.equal(semantic(ancestor), oldPlan.recovery.sourcePlanHash);
  const baseline = prepareSectionPlan({ root, campaigns: [], locales: LOCALES.filter(locale => locale !== 'en'),
    maxChars: oldPlan.maximumSectionCharacters, minChars: oldPlan.tinySectionCharacters });
  assert.equal(baseline.manifestHash, oldPlan.manifestHash);
  const manifest = input(baseline.manifestFile.file).value, fields = new Map([...manifest.pages.flatMap(page => page.fields), ...manifest.chrome].map(field => [field.id, field]));
  const records = Object.fromEntries(baseline.accepted.filter(row => row.sha256 !== null).map(row => [row.locale, input(row.file).value]));
  const acceptedBaseline = Object.fromEntries(LOCALES.filter(locale => locale !== 'en').map(locale => [locale, records[locale]?.translations || {}]));
  assert.equal(Object.values(acceptedBaseline).reduce((sum, values) => sum + Object.keys(values).length, 0), expectedAcceptedFields, 'Manual acceptance must finish before continuation');
  for (const [locale, values] of Object.entries(oldPlan.recovery.acceptedBaseline)) for (const [id, text] of Object.entries(values)) assert.equal(acceptedBaseline[locale]?.[id], text, 'Source accepted baseline changed');
  const manualFields = new Set(), receiptPins = []; assert(manualReceipts.length, 'Applied manual receipt provenance is required');
  for (const expected of manualReceipts) {
    const row = verified(expected), receipt = row.value;
    assert.equal(receipt.manifestHash, manifest.manifestHash); assert.equal(receipt.review?.planHash, oldHash); assert.equal(receipt.review?.status, 'accepted');
    assert.equal(receipt.review.nativeLanguageReview, 'pending'); assert.equal(receipt.review.machineApprovedEditorialChanges, false);
    assert(typeof receipt.review.reviewer === 'string' && receipt.review.reviewer.trim() && typeof receipt.review.draftModel === 'string' && receipt.review.draftModel.trim());
    assert(receipt.review.originalMachineReview?.evidence, 'Manual receipt must retain independent-review provenance');
    const original = receipt.review.originalMachineReview.evidence;
    for (const expected of Object.values(original).filter(value => value?.file && value?.sha256)) keep(verified(expected));
    if (receipt.review.originalMachineReview.prompt) keep(verified(receipt.review.originalMachineReview.prompt));
    assert(original.transport && original.proposal && original.session && original.dispatched && original.child && original.queued, 'Manual receipt lacks complete review ownership/dispatch evidence');
    const proposal = verified(original.proposal), envelope = complete(verified(original.transport), proposal), session = verified(original.session).value;
    assert.equal(session.conversationId, envelope.conversation_id); dead(verified(original.child).value, true);
    const ids = Object.keys(receipt.translations || {}), locale = receipt.locale;
    assert(LOCALES.includes(locale) && locale !== 'en' && ids.length);
    assert.deepEqual(Object.keys(proposal.value.translations).sort(), [...ids].sort(), 'Manual receipt lost original complete-review coverage');
    const edits = new Map((receipt.review.editorialCorrections || []).map(edit => [edit.id, edit]));
    assert.equal(edits.size, receipt.review.editorialCorrections.length, 'Repeated editorial correction');
    for (const [id, text] of Object.entries(receipt.translations)) {
      if (edits.has(id)) {
        const edit = edits.get(id); assert(['source-aligned-clause', 'translate-unchanged-label'].includes(edit.kind));
        assert.equal(edit.beforeHash, sha(proposal.value.translations[id])); assert.equal(edit.afterHash, sha(text)); assert(edit.reason?.length >= 20);
      } else assert.equal(text, proposal.value.translations[id], 'Unrecorded editorial alteration');
    }
    assert([...edits.keys()].every(id => ids.includes(id)), 'Editorial correction outside complete review');
    const saved = records[locale]?.receipts?.find(entry => entry.source === row.file && JSON.stringify(entry.review) === JSON.stringify(receipt.review)
      && JSON.stringify([...entry.fields].sort()) === JSON.stringify([...ids].sort()));
    assert(saved, 'Manual receipt is not exactly attested by the applied locale record');
    gateSection(ids.map(id => { assert(fields.has(id)); return fields.get(id); }), { translations: receipt.translations, keptFields: receipt.review.keptFields || {} }, fields);
    for (const id of ids) { assert.equal(acceptedBaseline[locale][id], receipt.translations[id], 'Manual accepted value changed'); const key = locale + '/' + id; assert(!manualFields.has(key), 'Manual receipt fields overlap'); manualFields.add(key); }
    receiptPins.push(pin(row)); keep(row);
    for (const name of ['evidence.json', 'editorial-spec.json', 'completed.json']) keep(input(path.join(path.dirname(row.file), name)));
  }
  const seeds = [], phases = [], requiredManual = new Set(), selectedPages = new Set(), authorized = new Set(), originalPartition = new Set();
  let completed = 0, held = 0, dispatchRecords = 0;
  for (const locale of oldPlan.locales) for (const [index, page] of locale.pages.entries()) {
    const directory = path.join(sourceCampaign, locale.locale, String(index + 1).padStart(2, '0')), started = keep(input(path.join(directory, 'started.json')));
    assert.equal(started.value.planHash, oldHash); assert.equal(started.value.locale, locale.locale); assert.equal(started.value.route, page.route);
    for (const id of page.recovery?.priorConversationIds || []) remember(id, identities);
    for (const seed of page.draftSeeds) { const key = locale.locale + '/' + seed.id; assert(!authorized.has(key)); authorized.add(key); }
    const names = readdirSync(directory), allowedPhases = new Set(page.correctionReviews.map((_, i) => 'review-' + String(i + 1).padStart(2, '0')));
    assert(!names.some(name => /^draft-\d+\./.test(name)), 'Source correction unexpectedly drafted');
    for (const name of names) if (/^review-\d+\./.test(name)) assert(allowedPhases.has(name.slice(0, name.indexOf('.'))), 'Unknown source review phase');
    for (const context of page.context) { assert.equal(context.text, fields.get(context.id)?.text); assert.equal(acceptedBaseline[locale.locale][context.id], context.translation, 'Accepted context changed'); }
    const doneFile = path.join(directory, 'completed.json'), done = existsSync(doneFile) ? keep(input(doneFile)) : null;
    const failure = done ? null : keep(input(path.join(directory, 'failed.json')));
    let failedIndex = page.correctionReviews.length;
    if (done) {
      completed++; const accepted = keep(input(path.join(directory, 'accepted.json')));
      assert.equal(done.value.planHash, oldHash); assert.equal(done.value.acceptedHash, accepted.sha256);
      assert.deepEqual(Object.keys(accepted.value.translations).sort(), [...page.draftSeeds.map(seed => seed.id), ...page.reviewSeeds.flatMap(seed => seed.fieldIds)].sort());
      for (const [id, text] of Object.entries(accepted.value.translations)) assert.equal(acceptedBaseline[locale.locale][id], text);
    } else {
      held++; assert.equal(failure.value.planHash, oldHash); assert.equal(failure.value.noAutomaticRetry, true); assert(/^review-\d{2}$/.test(failure.value.phase));
      failedIndex = Number(failure.value.phase.slice(-2)) - 1; assert(failedIndex >= 0 && failedIndex < page.correctionReviews.length);
      for (const seed of page.reviewSeeds) for (const id of seed.fieldIds) requiredManual.add(locale.locale + '/' + id);
    }
    const candidates = Object.fromEntries(page.draftSeeds.map(seed => [seed.id, seed.translation]));
    let previous = null;
    for (const [i, group] of page.correctionReviews.entries()) {
      const phase = 'review-' + String(i + 1).padStart(2, '0');
      for (const id of group.fieldIds) { const key = locale.locale + '/' + id; assert(!originalPartition.has(key)); originalPartition.add(key); assert(authorized.has(key)); }
      if (i <= failedIndex) {
        const docs = Object.fromEntries(['queued', 'dispatched', 'child', 'session', 'transport', 'proposal'].map(kind => [kind, keep(input(path.join(directory, phase + '.' + kind + '.json')))]));
        dispatchRecords++; dead(docs.child.value, true); assert.deepEqual(docs.child.value.controller, status.value.controller);
        assert.equal(docs.queued.value.planHash, oldHash); assert.equal(docs.queued.value.phase, phase); assert(Number.isFinite(Date.parse(docs.queued.value.at)));
        assert.equal(docs.dispatched.value.planHash, oldHash); assert.equal(docs.dispatched.value.conversationId, previous?.id ?? null);
        assert.equal(docs.dispatched.value.model, config.value.model); assert.equal(docs.dispatched.value.printTimeout, '0s');
        const envelope = complete(docs.transport, docs.proposal), id = docs.session.value.conversationId;
        assert.equal(id, envelope.conversation_id); assert(!page.recovery.priorConversationIds.includes(id), 'Source reviewer independence changed');
        assert(typeof docs.session.value.workspace === 'string' && path.isAbsolute(docs.session.value.workspace), 'Missing source queue-root provenance');
        if (previous) { assert.equal(id, previous.id); assert.equal(docs.session.value.workspace, previous.workspace); }
        sourceTemporaryRoots.add(path.dirname(docs.session.value.workspace)); remember(id, identities); previous = { id, workspace: docs.session.value.workspace };
        assert.deepEqual(Object.keys(docs.proposal.value.translations).sort(), [...group.fieldIds].sort(), 'Consumed source review is incomplete');
        const prompt = keep(input(path.join(directory, phase + '.prompt.txt'), false));
        assert.equal(prompt.sha256, sha(correctionReviewPrompt({ locale: locale.locale, page }, group.fieldIds.map(id => fields.get(id)), candidates, i === 0)), 'Consumed source review request changed');
        if (done || i < failedIndex) gateSection(group.fieldIds.map(id => fields.get(id)), docs.proposal.value, fields);
        if (!done) for (const fieldId of group.fieldIds) requiredManual.add(locale.locale + '/' + fieldId);
        continue;
      }
      assert(!names.some(name => name.startsWith(phase + '.')), 'Untouched source group has phase evidence');
      phases.push({ directory, phase }); selectedPages.add(locale.locale + '/' + page.route);
      for (const id of group.fieldIds) {
        assert(!Object.hasOwn(acceptedBaseline[locale.locale], id), 'Untouched review overlaps accepted work');
        assert(!page.reviewSeeds.some(seed => seed.fieldIds.includes(id)));
        const seed = page.draftSeeds.find(seed => seed.id === id);
        assert(seed && seed.locale === locale.locale && seed.text === fields.get(id)?.text, 'Untouched review lacks its original successful draft');
        const transport = keep(verified(seed.source.transport)), proposal = keep(verified(seed.source.proposal)), envelope = complete(transport, proposal);
        assert.equal(proposal.value.translations?.[id], seed.translation); assert(typeof seed.translation === 'string' && seed.translation.trim());
        remember(envelope.conversation_id, identities);
        for (const kind of ['session', 'dispatched']) if (seed.source[kind]) { const row = keep(verified(seed.source[kind])); remember(row.value.conversationId, identities); }
        seeds.push(seed);
      }
    }
  }
  assert.equal(sourceTemporaryRoots.size, 1, 'Pinned source workers disagree on their queue-root provenance');
  const sourceTemporaryRoot = [...sourceTemporaryRoots][0];
  for (const item of phases) {
    item.queueDirectory = path.join(sourceTemporaryRoot, 'scirepl-example-gemini-slots', 'tutorial-waiters', 'records', sha(item.directory + '/' + item.phase));
    assertReviewNeverDispatched(item.directory, item.phase, item.queueDirectory);
  }
  assert.deepEqual([...authorized].sort(), [...originalPartition].sort(), 'Original authorized review membership changed');
  assert.deepEqual([...requiredManual].sort(), [...manualFields].sort(), 'Manual receipts must cover exactly consumed held fields and preserved reviews');
  assert.equal(status.value.counts.planned, completed + held); assert.equal(status.value.counts.completed, completed); assert.equal(status.value.counts.held, held); assert.equal(status.value.counts.skipped || 0, 0);
  const sourceMaximum = oldPlan.recovery.bounds.maxReviewCalls, sourceCharged = status.value.recoveryBudget.usedReviewCalls;
  assert.equal(status.value.recoveryBudget.usedDraftCalls, 0); assert.equal(oldPlan.recovery.bounds.maxDraftCalls, 0);
  assert.equal(status.value.recoveryBudget.maxReviewCalls, sourceMaximum); assert.equal(sourceCharged, dispatchRecords, 'Charged calls differ from actual dispatch history');
  assert.equal(oldPlan.locales.reduce((n, locale) => n + locale.pages.reduce((sum, page) => sum + page.correctionReviews.length, 0), 0), sourceMaximum);
  const maxAdditional = sourceMaximum - sourceCharged;
  assert(Number.isSafeInteger(maxAdditional) && maxAdditional > 0 && maxAdditional <= maxReviewCalls);
  assert.equal(maxAdditional, phases.length, 'Unused original allocation differs from untouched groups');
  assert.equal(seeds.length, expectedRemainingFields); assert.equal(new Set(seeds.map(seed => seed.locale + '/' + seed.id)).size, seeds.length); assert.equal(selectedPages.size, expectedPages);
  const htmlByRoute = Object.fromEntries(baseline.sources.map(row => [row.route, readFileSync(row.file, 'utf8')]));
  const plan = buildSectionPlan({ manifest, htmlByRoute, records, draftSeeds: seeds,
    campaignEvidence: [{ campaign: sourceCampaign, request: pin(old), files: [...evidence.values()], neverDispatchedContinuation: true }],
    locales: LOCALES.filter(locale => locale !== 'en'), maxChars: oldPlan.maximumSectionCharacters, minChars: oldPlan.tinySectionCharacters,
    pins: { manifestFile: baseline.manifestFile, sources: baseline.sources, accepted: baseline.accepted } });
  assert.deepEqual(plan.locales.flatMap(locale => locale.pages.map(page => locale.locale + '/' + page.route)).sort(), [...selectedPages].sort(), 'Global missing work differs from untouched original groups');
  for (const locale of plan.locales) for (const page of locale.pages) {
    assert.equal(page.sections.length, 0, 'No drafting is authorized'); page.reviewSeeds = [];
    const selected = new Set(page.draftSeeds.map(seed => seed.id)), candidates = Object.fromEntries(page.draftSeeds.map(seed => [seed.id, seed.translation]));
    const parts = page.route === '@chrome' ? [{ fields: manifest.chrome }] : classifySections(manifest.pages.find(source => source.route === page.route), htmlByRoute[page.route], { maxChars: plan.maximumSectionCharacters, minChars: plan.tinySectionCharacters });
    const sections = splitContinuationReviewSections({ sections: parts.map(part => part.fields.filter(field => selected.has(field.id))).filter(fields => fields.length),
      job: { locale: locale.locale, page }, candidates });
    const packed = packReviewSections({ sections, maxPromptBytes: 100000,
      measurePromptBytes: (fields, { firstBatch }) => Buffer.byteLength(correctionReviewPrompt({ locale: locale.locale, page }, fields, candidates, firstBatch)) });
    page.correctionReviews = packed.batches.map(fields => ({ fieldIds: fields.map(field => field.id) }));
    page.recovery = { maxDraftCalls: 0, maxReviewCalls: packed.batches.length, priorConversationIds: [...identities].sort() };
  }
  const pages = plan.locales.flatMap(locale => locale.pages), calls = pages.reduce((sum, page) => sum + page.recovery.maxReviewCalls, 0);
  assert(calls <= maxAdditional && sourceCharged + calls <= sourceMaximum, 'Continuation would exceed the original joint allocation');
  plan.recovery = { kind: 'explicit-never-dispatched-review-continuation', sourcePlanHash: oldHash, sourcePlan: pin(old), sourceCampaign, sourceJob,
    acceptedBaseline, manualReceipts: receiptPins, maximumReviewCalls: maxReviewCalls,
    reviewBudgetLineage: { sourceMaximum, sourceCharged, sourceDispatchRecords: dispatchRecords, maxAdditional, jointMaximum: sourceMaximum },
    neverDispatchedPhases: phases, automaticRetries: false, dispatchPolicy: { maxConcurrent: 2, minimumDispatchGapMs: 15000 },
    bounds: { pages: pages.length, maxDraftCalls: 0, maxReviewCalls: calls } };
  delete plan.planHash; plan.planHash = sha(JSON.stringify(plan)); return plan;
}
export function reviewContinuationPlanSummary(plan) {
  return { preservedDraftFields: plan.locales.reduce((sum, locale) => sum + locale.preservedDraftCount, 0),
    neverDispatchedGroups: plan.recovery.neverDispatchedPhases.length, pendingReviews: plan.recovery.bounds.maxReviewCalls,
    bounds: plan.recovery.bounds, reviewBudgetLineage: plan.recovery.reviewBudgetLineage };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2), options = {}, manualReceipts = [];
    while (args.length) {
      const key = args.shift(), value = args.shift(); assert(['--source-job', '--output', '--manual-receipt'].includes(key) && value && !value.startsWith('--'));
      if (key === '--manual-receipt') manualReceipts.push(pin(input(value))); else { assert(!Object.hasOwn(options, key)); options[key] = value; }
    }
    const plan = prepareSectionReviewContinuationPlan({ sourceJob: options['--source-job'], manualReceipts });
    console.log(JSON.stringify({ ...reviewContinuationPlanSummary(plan), ...(options['--output'] ? { output: writeSectionPlan(plan, options['--output']) } : { mode: 'read-only-preparation' }) }, null, 2));
  } catch { console.error('Continuation preparation held; inspect private evidence without replaying work.'); process.exitCode = 1; }
}
