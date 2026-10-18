// One explicitly authorized correction generation; preparation makes no calls.
import assert from 'node:assert/strict';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, LOCALES, sha, validateText, validateKeep } from './tutorial_locale_lib.mjs';
import { prepareSectionPlan, buildSectionPlan, classifySections, writeSectionPlan } from './tutorial_locale_section_plan.mjs';
import { parseTransport } from './tutorial_translation_transport.mjs';
import { getProcessStartIdentity } from './tutorial_translation_queue.mjs';
import { packReviewSections } from './tutorial_review_batching.mjs';
import { gateSection, reviewPrompt, correctionReviewPrompt } from './tutorial_section_protocol.mjs';

const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const identityPattern = /^[\w.-]{1,200}$/;
const input = file => {
  const absolute = path.resolve(file), info = lstatSync(absolute);
  assert(info.isFile() && !info.isSymbolicLink(), 'Correction evidence must be regular files');
  const bytes = readFileSync(absolute);
  return { file: absolute, sha256: sha(bytes), value: JSON.parse(bytes.toString('utf8')) };
};
const pin = row => ({ file: row.file, sha256: row.sha256 });
const verifiedPin = expected => {
  assert(plain(expected) && typeof expected.file === 'string' && /^[a-f0-9]{64}$/.test(expected.sha256), 'Invalid correction evidence pin');
  const row = input(expected.file);
  assert.equal(row.sha256, expected.sha256, 'Pinned prior evidence changed');
  return row;
};
function assertDead(record, requireBoot = false) {
  assert(Number.isSafeInteger(record?.pid) && record.pid > 0 && typeof record.startIdentity === 'string', 'Unverifiable prior ownership');
  const boot = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}:\d+$/;
  assert(boot.test(record.startIdentity) || !requireBoot && /^\d+$/.test(record.startIdentity), 'Malformed prior ownership identity');
  try {
    const actual = getProcessStartIdentity(record.pid), compared = record.startIdentity.includes(':') ? actual : actual.split(':').at(-1);
    assert.notEqual(compared, record.startIdentity, 'A prior owner or worker is still live');
  } catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error; }
}
function remember(value, identities) {
  if (value === null || value === undefined) return;
  assert(typeof value === 'string' && identityPattern.test(value), 'Malformed prior conversation identity');
  identities.add(value);
}
function collectPrior(value, identities) {
  if (Array.isArray(value)) for (const item of value) collectPrior(item, identities);
  else if (plain(value)) for (const item of Object.values(value)) collectPrior(item, identities);
  else remember(value, identities);
}
function semanticPlan(row) {
  const { planHash, ...unsigned } = row.value;
  assert.equal(row.value.schema, 1); assert.equal(row.value.kind, 'tutorial-coherent-section-plan');
  assert.equal(sha(JSON.stringify(unsigned)), planHash, 'Prior semantic plan changed');
  return planHash;
}
function success(transport, proposal) {
  const envelope = JSON.parse(transport.value.stdout);
  assert(!envelope.is_error && !envelope.error, 'Contradictory prior SUCCESS envelope');
  assert.deepEqual(parseTransport(transport.value), proposal.value, 'Saved proposal differs from complete SUCCESS transport');
  assert(!transport.value.persistenceFailure, 'Prior transport persistence failed');
  assert.deepEqual(transport.value.unexpectedFiles || [], [], 'Prior worker wrote files');
  return envelope;
}
function chain({ dir, phase, planHash, previous, identities, forbidden, evidence, expectedPrompt }) {
  const files = Object.fromEntries(['transport', 'proposal', 'session', 'dispatched', 'child', 'queued'].map(kind => [kind, input(path.join(dir, phase + '.' + kind + '.json'))]));
  for (const row of Object.values(files)) evidence.set(row.file, pin(row));
  if (expectedPrompt !== undefined) {
    const file = path.join(dir, phase + '.prompt.txt'), info = lstatSync(file);
    assert(info.isFile() && !info.isSymbolicLink(), 'Prior review request must be a regular file');
    const bytes = readFileSync(file);
    assert.equal(sha(bytes), sha(expectedPrompt), 'Preserved review request differs from frozen source and original successful drafts');
    evidence.set(file, { file, sha256: sha(bytes) });
  }
  assertDead(files.child.value, true);
  assert.equal(files.dispatched.value.planHash, planHash); assert.equal(files.queued.value.planHash, planHash);
  assert.equal(files.dispatched.value.conversationId, previous?.id ?? null, 'Prior dispatch continuation differs');
  const envelope = success(files.transport, files.proposal), id = files.session.value.conversationId;
  assert(typeof id === 'string' && identityPattern.test(id), 'Missing successful prior conversation identity');
  assert.equal(envelope.conversation_id, id, 'Saved session differs from transport identity');
  assert(!forbidden.has(id), 'Prior reviewer/drafter independence was not preserved');
  assert(typeof files.session.value.workspace === 'string' && files.session.value.workspace.length > 0, 'Missing prior workspace');
  if (previous) {
    assert.equal(id, previous.id, 'Prior continuation identity changed');
    assert.equal(files.session.value.workspace, previous.workspace, 'Prior continuation workspace changed');
  }
  remember(id, identities);
  return { files, proposal: files.proposal.value, id, workspace: files.session.value.workspace };
}

export function prepareSectionCorrectionPlan({ root = ROOT, sourceJob, sourcePlanFile, sourceCampaign,
  expectedHeldPages = 7, expectedAcceptedFields = 12007, maximumReviewPromptBytes = 100000 } = {}) {
  assert(sourceJob, 'Provide the terminal recovery source job');
  root = path.resolve(root); sourceJob = path.resolve(sourceJob);
  assert.equal(maximumReviewPromptBytes, 100000, 'Correction prompt ceiling must remain 100000 bytes');
  const config = input(path.join(sourceJob, 'config.json')), result = input(path.join(sourceJob, 'result.json'));
  assert.equal(config.value.schema, 1); assert.equal(config.value.root, root); assert.equal(config.value.job, sourceJob);
  assert.equal(result.value.state, 'held', 'Source recovery must be terminal held'); assert.equal(result.value.exitCode, 1);
  assert(Number.isFinite(Date.parse(result.value.finishedAt)), 'Missing source terminal time');
  sourcePlanFile = path.resolve(sourcePlanFile || config.value.sectionsPlan);
  sourceCampaign = path.resolve(sourceCampaign || config.value.campaign);
  assert.equal(sourcePlanFile, config.value.sectionsPlan); assert.equal(sourceCampaign, config.value.campaign);
  assert(!existsSync(path.join(sourceCampaign, 'controller.lock')), 'Drain the source controller before correction planning');
  const old = input(sourcePlanFile), oldPlan = old.value, oldHash = semanticPlan(old);
  assert.equal(oldPlan.recovery?.kind, 'single-bounded-section-recovery', 'Only the original bounded recovery may be explicitly corrected; correction generations cannot recurse');
  const configured = config.value.pins?.find(row => row.file === sourcePlanFile);
  assert(configured && configured.hash === old.sha256, 'Source recovery plan differs from its job pin');
  const status = input(path.join(sourceCampaign, 'controller-status.json'));
  assert.equal(status.value.state, 'held'); assert.equal(status.value.unit, 'pages'); assertDead(status.value.controller);
  const evidence = new Map([config, result, status, old].map(row => [row.file, pin(row)])), identities = new Set();
  for (const name of ['owner.json', 'controller.json', 'launch.json']) {
    const file = path.join(sourceJob, name); if (name === 'launch.json' && !existsSync(file)) continue;
    const row = input(file); assert.equal(row.value.nonce, config.value.nonce, 'Source owner nonce changed'); assertDead(row.value);
    evidence.set(row.file, pin(row));
  }
  for (const phase of status.value.phases || []) if (phase.worker) assertDead(phase.worker, true);
  // Historical runtime files may change only after all owners have stopped.
  // Their old hashes remain history; source, plans, and evidence stay strict.
  const manifestEvidence = verifiedPin(oldPlan.manifestFile); evidence.set(manifestEvidence.file, pin(manifestEvidence));
  for (const expected of oldPlan.sources) {
    assert.equal(sha(readFileSync(expected.file)), expected.sha256, 'Frozen English source changed');
    evidence.set(expected.file, { file: expected.file, sha256: expected.sha256 });
  }
  const ancestor = verifiedPin(oldPlan.recovery.sourcePlan);
  assert.equal(semanticPlan(ancestor), oldPlan.recovery.sourcePlanHash, 'Recovery ancestry differs from its original plan');
  assert(!ancestor.value.recovery, 'The source recovery must derive from an original section pass');
  evidence.set(ancestor.file, pin(ancestor));
  for (const item of oldPlan.campaignEvidence || []) {
    if (item.request) { const row = verifiedPin(item.request); evidence.set(row.file, pin(row)); }
    for (const expected of item.files || []) {
      const row = verifiedPin(expected); evidence.set(row.file, pin(row));
      if (/\.(?:session|dispatched)\.json$/.test(row.file)) remember(row.value.conversationId, identities);
      if (/\.transport\.json$/.test(row.file)) {
        try { remember(JSON.parse(row.value.stdout).conversation_id, identities); } catch { /* Failed output is not salvageable. */ }
      }
    }
  }
  collectPrior(oldPlan.recovery.priorIdentities || [], identities);
  for (const locale of oldPlan.locales) for (const page of locale.pages) collectPrior(page.recovery?.priorConversationIds || [], identities);
  const baseline = prepareSectionPlan({ root, campaigns: [], locales: LOCALES.filter(locale => locale !== 'en'),
    maxChars: oldPlan.maximumSectionCharacters, minChars: oldPlan.tinySectionCharacters });
  assert.equal(baseline.manifestHash, oldPlan.manifestHash, 'Correction source manifest changed');
  const manifest = input(baseline.manifestFile.file).value;
  const fields = new Map([...manifest.pages.flatMap(page => page.fields), ...manifest.chrome].map(field => [field.id, field]));
  const htmlByRoute = Object.fromEntries(baseline.sources.map(row => [row.route, readFileSync(row.file, 'utf8')]));
  const records = Object.fromEntries(baseline.accepted.filter(row => row.sha256 !== null).map(row => [row.locale, input(row.file).value]));
  const acceptedBaseline = Object.fromEntries(LOCALES.filter(locale => locale !== 'en').map(locale => [locale, records[locale]?.translations || {}]));
  assert.equal(Object.values(acceptedBaseline).reduce((sum, values) => sum + Object.keys(values).length, 0), expectedAcceptedFields, 'Current accepted baseline count changed');
  for (const [locale, values] of Object.entries(oldPlan.recovery.acceptedBaseline)) for (const [id, value] of Object.entries(values)) {
    assert.equal(acceptedBaseline[locale]?.[id], value, 'A prior accepted baseline value changed');
  }
  const drafts = [], held = new Map(), reviewed = new Map(); let completed = 0, startedCount = 0;
  for (const locale of oldPlan.locales) for (const [index, page] of locale.pages.entries()) {
    startedCount++;
    const chunk = String(index + 1).padStart(2, '0'), dir = path.join(sourceCampaign, locale.locale, chunk);
    const started = input(path.join(dir, 'started.json'));
    assert.equal(started.value.planHash, oldHash); assert.equal(started.value.locale, locale.locale); assert.equal(started.value.route, page.route);
    evidence.set(started.file, pin(started));
    const pendingIds = [...page.sections.flatMap(section => section.fieldIds), ...page.draftSeeds.map(seed => seed.id)];
    assert.equal(new Set(pendingIds).size, pendingIds.length, 'Source recovery page repeats fields');
    for (const context of page.context) {
      assert.equal(context.readonly, true); assert.equal(context.text, fields.get(context.id)?.text, 'Accepted context source changed');
      assert.equal(acceptedBaseline[locale.locale]?.[context.id], context.translation, 'Accepted context value changed');
    }
    const names = readdirSync(dir);
    for (const name of names.filter(name => /^(?:draft|review)-\d+\.(?:queued|dispatched|child|session|transport|proposal)\.json$/.test(name))) {
      const row = input(path.join(dir, name)); evidence.set(row.file, pin(row));
      if (name.endsWith('.child.json')) assertDead(row.value, true);
      if (/\.(?:session|dispatched)\.json$/.test(name)) remember(row.value.conversationId, identities);
      if (name.endsWith('.transport.json')) {
        try { remember(JSON.parse(row.value.stdout).conversation_id, identities); } catch { /* Never interpret failed inner output. */ }
      }
    }
    const current = acceptedBaseline[locale.locale];
    if (existsSync(path.join(dir, 'completed.json'))) {
      const done = input(path.join(dir, 'completed.json')), accepted = input(path.join(dir, 'accepted.json'));
      assert.equal(done.value.planHash, oldHash); assert.equal(done.value.acceptedHash, accepted.sha256);
      assert.deepEqual(Object.keys(accepted.value.translations).sort(), [...pendingIds].sort(), 'Completed recovery receipt field set changed');
      for (const id of pendingIds) assert.equal(current[id], accepted.value.translations[id], 'Completed recovery accepted value changed');
      evidence.set(done.file, pin(done)); evidence.set(accepted.file, pin(accepted)); completed++; continue;
    }
    const failed = input(path.join(dir, 'failed.json')); evidence.set(failed.file, pin(failed));
    assert.equal(failed.value.planHash, oldHash); assert.equal(failed.value.noAutomaticRetry, true);
    assert(/^review-\d{2}$/.test(failed.value.phase), 'Only a held review with complete saved drafts may be corrected');
    assert(pendingIds.every(id => !Object.hasOwn(current, id)), 'Held page overlaps accepted work');
    const key = locale.locale + '/' + page.route; assert(!held.has(key)); held.set(key, { locale: locale.locale, page });
    const oldExcluded = new Set(page.recovery.priorConversationIds), candidates = new Map();
    for (const seed of page.draftSeeds) {
      assert.equal(seed.locale, locale.locale); assert.equal(seed.text, fields.get(seed.id)?.text, 'Original draft source changed');
      const transport = verifiedPin(seed.source.transport), proposal = verifiedPin(seed.source.proposal); success(transport, proposal);
      assert.equal(proposal.value.translations?.[seed.id], seed.translation, 'Original successful draft value changed');
      assert(typeof seed.translation === 'string' && seed.translation.trim(), 'Empty original draft');
      evidence.set(transport.file, pin(transport)); evidence.set(proposal.file, pin(proposal));
      try { remember(JSON.parse(transport.value.stdout).conversation_id, identities); } catch { /* Older evidence may lack identity. */ }
      assert(!candidates.has(seed.id), 'Duplicate successful draft seed'); candidates.set(seed.id, seed); drafts.push(seed);
    }
    let draftChain = null;
    for (const [i, section] of page.sections.entries()) {
      assert.equal(section.requestHash, sha(JSON.stringify(section.request))); assert.equal(section.request.manifestHash, manifest.manifestHash);
      assert.equal(section.request.locale, locale.locale); assert.deepEqual(section.request.fields.map(field => field.id), section.fieldIds);
      for (const field of section.request.fields) assert.equal(field.text, fields.get(field.id)?.text, 'New saved draft source changed');
      const phase = 'draft-' + String(i + 1).padStart(2, '0');
      const value = chain({ dir, phase, planHash: oldHash, previous: draftChain, identities, forbidden: oldExcluded, evidence });
      assert(plain(value.proposal) && plain(value.proposal.translations));
      assert(Object.keys(value.proposal).every(key => ['translations', 'keptFields'].includes(key)));
      assert.deepEqual(Object.keys(value.proposal.translations).sort(), [...section.fieldIds].sort(), 'New saved draft field set changed');
      for (const field of section.request.fields) {
        const translation = value.proposal.translations[field.id]; assert(typeof translation === 'string' && translation.trim(), 'Empty new saved draft');
        let draftValid = true;
        try { const reason = value.proposal.keptFields?.[field.id]; if (reason !== undefined) validateKeep(fields.get(field.id), reason); validateText(fields.get(field.id), translation, { allowSource: Boolean(reason) }); }
        catch { draftValid = false; }
        const seed = { locale: locale.locale, id: field.id, text: field.text, translation, draftValid,
          source: { campaign: sourceCampaign, chunk, phase, transport: pin(value.files.transport), proposal: pin(value.files.proposal), session: pin(value.files.session), dispatched: pin(value.files.dispatched) } };
        assert(!candidates.has(seed.id)); candidates.set(seed.id, seed); drafts.push(seed);
      }
      draftChain = value;
    }
    assert.deepEqual([...candidates.keys()].sort(), [...pendingIds].sort(), 'Correction requires complete saved draft coverage; zero regeneration is authorized');
    const sourcePage = manifest.pages.find(source => source.route === page.route);
    const parts = page.route === '@chrome' ? [{ fields: manifest.chrome }] : classifySections(sourcePage, htmlByRoute[page.route], {
      maxChars: oldPlan.maximumSectionCharacters, minChars: oldPlan.tinySectionCharacters });
    const selected = new Set(pendingIds), reviewParts = parts.map(part => part.fields.filter(field => selected.has(field.id))).filter(part => part.length);
    assert.deepEqual(reviewParts.flat().map(field => field.id).sort(), [...pendingIds].sort(), 'Prior review partition changed');
    const failedIndex = Number(failed.value.phase.slice(-2)) - 1;
    assert(failedIndex >= 0 && failedIndex < reviewParts.length, 'Held review phase is outside its original partition');
    const failedDispatch = input(path.join(dir, failed.value.phase + '.dispatched.json'));
    assert.equal(failedDispatch.value.planHash, oldHash); input(path.join(dir, failed.value.phase + '.child.json'));
    const saved = [], forbiddenReviewer = new Set(oldExcluded); if (draftChain) forbiddenReviewer.add(draftChain.id);
    let reviewChain = null;
    for (let i = 0; i < failedIndex; i++) {
      const phase = 'review-' + String(i + 1).padStart(2, '0');
      const expectedPrompt = reviewPrompt({ locale: locale.locale, page }, reviewParts[i], Object.fromEntries([...candidates].map(([id, seed]) => [id, seed.translation])), i === 0);
      const value = chain({ dir, phase, planHash: oldHash, previous: reviewChain, identities, forbidden: forbiddenReviewer, evidence, expectedPrompt });
      const normalized = gateSection(reviewParts[i], value.proposal, fields);
      saved.push({ fieldIds: reviewParts[i].map(field => field.id), translations: normalized.translations, keptFields: normalized.keptFields,
        source: { phase, campaign: sourceCampaign, locale: locale.locale, chunk, transport: pin(value.files.transport), proposal: pin(value.files.proposal), session: pin(value.files.session), dispatched: pin(value.files.dispatched) } });
      reviewChain = value;
    }
    assert.equal(failedDispatch.value.conversationId, reviewChain?.id ?? null, 'Held review dispatch chain is ambiguous');
    for (let i = failedIndex + 1; i < reviewParts.length; i++) assert(!names.some(name => name.startsWith('review-' + String(i + 1).padStart(2, '0') + '.')), 'Later review evidence has ambiguous dispatch');
    reviewed.set(key, { seeds: saved, parts: reviewParts.slice(failedIndex) });
  }
  assert.equal(status.value.counts.planned, startedCount); assert.equal(status.value.counts.completed, completed);
  assert.equal(status.value.counts.held, held.size); assert.equal(status.value.counts.skipped || 0, 0);
  assert.equal(startedCount, completed + held.size, 'Terminal source counts are incomplete');
  assert.equal(held.size, expectedHeldPages, 'Explicitly authorized held-page count changed');
  const plan = buildSectionPlan({ manifest, htmlByRoute, records, draftSeeds: drafts,
    campaignEvidence: [{ campaign: sourceCampaign, request: pin(old), files: [...evidence.values()], explicitCorrection: true }],
    locales: LOCALES.filter(locale => locale !== 'en'), maxChars: oldPlan.maximumSectionCharacters, minChars: oldPlan.tinySectionCharacters,
    pins: { manifestFile: baseline.manifestFile, sources: baseline.sources, accepted: baseline.accepted } });
  const planned = plan.locales.flatMap(locale => locale.pages.map(page => locale.locale + '/' + page.route));
  assert.deepEqual(planned.sort(), [...held.keys()].sort(), 'Correction must cover exactly the authorized held page-language units');
  for (const locale of plan.locales) {
    locale.preservedReviewCount = 0; locale.preservedDraftCount = 0;
    for (const page of locale.pages) {
      assert.equal(page.sections.length, 0, 'No new drafting is authorized');
      const saved = reviewed.get(locale.locale + '/' + page.route); page.reviewSeeds = saved.seeds;
      const reviewedIds = new Set(page.reviewSeeds.flatMap(seed => seed.fieldIds));
      page.draftSeeds = page.draftSeeds.filter(seed => !reviewedIds.has(seed.id));
      const draftsById = Object.fromEntries(page.draftSeeds.map(seed => [seed.id, seed.translation]));
      const packed = packReviewSections({ sections: saved.parts, maxPromptBytes: maximumReviewPromptBytes,
        measurePromptBytes: (selectedFields, { firstBatch }) => Buffer.byteLength(correctionReviewPrompt({ locale: locale.locale, page }, selectedFields, draftsById, firstBatch)) });
      page.correctionReviews = packed.batches.map(batch => ({ fieldIds: batch.map(field => field.id) }));
      assert.deepEqual(page.correctionReviews.flatMap(batch => batch.fieldIds).sort(), page.draftSeeds.map(seed => seed.id).sort(), 'Correction packing lost or duplicated pending fields');
      assert.equal(new Set([...reviewedIds, ...page.draftSeeds.map(seed => seed.id)]).size, reviewedIds.size + page.draftSeeds.length, 'Reviewed and draft seeds overlap');
      page.recovery = { maxDraftCalls: 0, maxReviewCalls: page.correctionReviews.length, priorConversationIds: [...identities].sort() };
      locale.preservedReviewCount += reviewedIds.size; locale.preservedDraftCount += page.draftSeeds.length;
    }
  }
  const pages = plan.locales.flatMap(locale => locale.pages);
  plan.recovery = { kind: 'explicit-bounded-section-correction', sourcePlanHash: oldHash, sourcePlan: pin(old), sourceCampaign, sourceJob,
    acceptedBaseline, maximumReviewPromptBytes, automaticRetries: false,
    dispatchPolicy: { maxConcurrent: 2, minimumDispatchGapMs: 15000 },
    bounds: { pages: pages.length, maxDraftCalls: 0, maxReviewCalls: pages.reduce((sum, page) => sum + page.recovery.maxReviewCalls, 0) } };
  delete plan.planHash; plan.planHash = sha(JSON.stringify(plan)); return plan;
}

export function correctionPlanSummary(plan) {
  return { preservedReviewFields: plan.locales.reduce((sum, locale) => sum + locale.preservedReviewCount, 0),
    preservedDraftFields: plan.locales.reduce((sum, locale) => sum + locale.preservedDraftCount, 0),
    pendingReviews: plan.recovery.bounds.maxReviewCalls, bounds: plan.recovery.bounds };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2), options = {};
    while (args.length) { const key = args.shift(), value = args.shift(); assert(['--source-job', '--output'].includes(key) && value && !value.startsWith('--') && !Object.hasOwn(options, key), 'Invalid correction planner option'); options[key] = value; }
    const plan = prepareSectionCorrectionPlan({ sourceJob: options['--source-job'] });
    console.log(JSON.stringify({ ...correctionPlanSummary(plan), ...(options['--output'] ? { output: writeSectionPlan(plan, options['--output']) } : { mode: 'read-only-preparation' }) }, null, 2));
  } catch { console.error('Correction preparation held; inspect private metadata without exposing its contents.'); process.exitCode = 1; }
}
