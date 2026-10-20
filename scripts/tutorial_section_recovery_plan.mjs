// Explicit one-generation recovery of a stopped coherent-section campaign.
// Preparation is read-only; failed/incomplete output is never salvaged.
import assert from 'node:assert/strict';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, sha, validateText, validateKeep } from './tutorial_locale_lib.mjs';
import { prepareSectionPlan, buildSectionPlan, classifySections, sectionPlanSummary, writeSectionPlan } from './tutorial_locale_section_plan.mjs';
import { parseTransport } from './tutorial_translation_transport.mjs';
import { getProcessStartIdentity } from './tutorial_translation_queue.mjs';

const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const input = file => {
  assert(lstatSync(file).isFile() && !lstatSync(file).isSymbolicLink(), 'Recovery evidence must be regular files');
  const bytes = readFileSync(file);
  return { file: path.resolve(file), sha256: sha(bytes), value: JSON.parse(bytes.toString('utf8')) };
};
const pin = row => ({ file: row.file, sha256: row.sha256 });
function assertDead(record, requireBoot = false) {
  assert(Number.isSafeInteger(record?.pid) && record.pid > 0 && typeof record.startIdentity === 'string', 'Unverifiable prior process identity');
  const bootIdentity = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}:[0-9]+$/;
  assert(bootIdentity.test(record.startIdentity) || !requireBoot && /^[0-9]+$/.test(record.startIdentity), 'Malformed prior process identity');
  try {
    const actual = getProcessStartIdentity(record.pid);
    const expected = record.startIdentity.includes(':') ? actual : actual.split(':').at(-1);
    assert.notEqual(expected, record.startIdentity, 'A prior section owner or worker is still live');
  } catch (error) {
    if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error;
  }
}
function rememberConversation(value, identities) {
  if (typeof value === 'string' && /^[\w.-]{1,200}$/.test(value)) identities.add(value);
}
function checkSeed(seed, sourceFields, locale, identities) {
  assert.equal(seed.locale, locale); assert.equal(seed.text, sourceFields.get(seed.id)?.text, 'Preserved seed source differs');
  const transport = input(seed.source.transport.file), proposal = input(seed.source.proposal.file);
  assert.equal(transport.sha256, seed.source.transport.sha256, 'Original seed transport changed');
  assert.equal(proposal.sha256, seed.source.proposal.sha256, 'Original seed proposal changed');
  assert.deepEqual(parseTransport(transport.value), proposal.value, 'Original seed differs from successful transport');
  assert.deepEqual(transport.value.unexpectedFiles || [], [], 'Original seed draft wrote files');
  assert(!transport.value.persistenceFailure, 'Original seed persistence failed');
  assert.equal(proposal.value.translations?.[seed.id], seed.translation, 'Original seed translation differs');
  assert(typeof seed.translation === 'string' && seed.translation.trim(), 'Original seed is empty');
  rememberConversation(JSON.parse(transport.value.stdout).conversation_id, identities);
  return [pin(transport), pin(proposal)];
}

export function prepareSectionRecoveryPlan({ root = ROOT, sourceJob, sourcePlanFile, sourceCampaign } = {}) {
  assert(sourceJob, 'Provide the stopped source job');
  sourceJob = path.resolve(sourceJob); root = path.resolve(root);
  const config = input(path.join(sourceJob, 'config.json')), result = input(path.join(sourceJob, 'result.json'));
  assert.equal(config.value.schema, 1); assert.equal(config.value.root, root); assert.equal(config.value.job, sourceJob);
  assert.equal(result.value.state, 'held', 'Source section job must be terminal held');
  assert.equal(result.value.exitCode, 1); assert(result.value.finishedAt && Number.isFinite(Date.parse(result.value.finishedAt)), 'Missing terminal finish time');
  sourcePlanFile = path.resolve(sourcePlanFile || config.value.sectionsPlan);
  sourceCampaign = path.resolve(sourceCampaign || config.value.campaign);
  assert.equal(sourcePlanFile, config.value.sectionsPlan); assert.equal(sourceCampaign, config.value.campaign);
  assert(!existsSync(path.join(sourceCampaign, 'controller.lock')), 'Stop and drain the prior section campaign first');
  const old = input(sourcePlanFile), oldPlan = old.value;
  assert.equal(oldPlan.schema, 1); assert.equal(oldPlan.kind, 'tutorial-coherent-section-plan');
  assert(!oldPlan.recovery, 'A bounded recovery generation cannot recursively recover another recovery');
  const { planHash: oldHash, ...oldUnsigned } = oldPlan;
  assert.equal(sha(JSON.stringify(oldUnsigned)), oldHash, 'Original section plan hash differs');
  const oldPin = config.value.pins?.find(row => row.file === sourcePlanFile);
  assert(oldPin && oldPin.hash === old.sha256, 'Original section plan differs from job pin');
  const status = input(path.join(sourceCampaign, 'controller-status.json'));
  assert.equal(status.value.state, 'held'); assert.equal(status.value.unit, 'pages');
  const globalEvidence = [pin(config), pin(result), pin(status)];
  for (const name of ['owner.json', 'launch.json', 'controller.json']) {
    const file = path.join(sourceJob, name); if (!existsSync(file)) continue;
    const record = input(file); assert.equal(record.value.nonce, config.value.nonce, 'Prior owner nonce differs');
    assertDead(record.value); globalEvidence.push(pin(record));
  }
  const baseline = prepareSectionPlan({ root, campaigns: [], locales: oldPlan.locales.map(row => row.locale),
    maxChars: oldPlan.maximumSectionCharacters, minChars: oldPlan.tinySectionCharacters });
  assert.equal(baseline.manifestHash, oldPlan.manifestHash, 'Recovery source changed');
  const manifest = input(baseline.manifestFile.file).value;
  const fields = new Map([...manifest.pages.flatMap(page => page.fields), ...manifest.chrome].map(field => [field.id, field]));
  const htmlByRoute = Object.fromEntries(baseline.sources.map(row => [row.route, readFileSync(row.file, 'utf8')]));
  const records = Object.fromEntries(baseline.accepted.filter(row => row.sha256 !== null).map(row => [row.locale, input(row.file).value]));
  const seeds = [], evidence = [], heldPages = new Set(), priorIdentities = new Map();
  let originalPages = 0, originalCompleted = 0;
  for (const locale of oldPlan.locales) for (const [index, page] of locale.pages.entries()) {
    originalPages++;
    const chunk = String(index + 1).padStart(2, '0'), dir = path.join(sourceCampaign, locale.locale, chunk);
    const started = input(path.join(dir, 'started.json'));
    assert.equal(started.value.planHash, oldHash); assert.equal(started.value.locale, locale.locale); assert.equal(started.value.route, page.route);
    const originalIds = [...page.sections.flatMap(section => section.fieldIds), ...page.draftSeeds.map(seed => seed.id)];
    assert.equal(new Set(originalIds).size, originalIds.length, 'Original page repeats fields');
    const current = records[locale.locale]?.translations || {};
    for (const context of page.context) {
      assert.equal(context.readonly, true); assert.equal(context.text, fields.get(context.id)?.text, 'Original accepted context source differs');
      assert.equal(current[context.id], context.translation, 'Original accepted context changed');
    }
    // Even a completed page must not hide an unexpectedly live old worker.
    for (const name of readdirSync(dir).filter(name => /^(?:draft|review)-\d{2}\.child\.json$/.test(name))) assertDead(input(path.join(dir, name)).value, true);
    if (existsSync(path.join(dir, 'completed.json'))) {
      const completed = input(path.join(dir, 'completed.json'));
      assert.equal(completed.value.planHash, oldHash);
      assert(originalIds.every(id => Object.hasOwn(current, id)), 'Completed source page lost accepted fields');
      originalCompleted++; continue;
    }
    const failed = input(path.join(dir, 'failed.json'));
    assert.equal(failed.value.planHash, oldHash); assert.equal(failed.value.noAutomaticRetry, true);
    assert(originalIds.every(id => !Object.hasOwn(current, id)), 'Held source page now overlaps accepted work; re-audit rather than replay');
    assert(/^(?:draft-\d{2}|review-\d{2})$/.test(failed.value.phase), 'Only draft/review holds are authorized for this recovery');
    const key = locale.locale + '/' + page.route; assert(!heldPages.has(key)); heldPages.add(key);
    const identities = new Set(); priorIdentities.set(key, identities);
    const pins = [pin(started), pin(failed), ...globalEvidence];
    for (const name of readdirSync(dir).filter(name => /^(?:draft|review)-\d{2}\.(?:queued|dispatched|child|session|transport|proposal)\.json$/.test(name))) {
      const row = input(path.join(dir, name)); pins.push(pin(row));
      if (name.endsWith('.child.json')) assertDead(row.value, true);
      if (name.endsWith('.session.json') || name.endsWith('.dispatched.json')) rememberConversation(row.value.conversationId, identities);
      if (name.endsWith('.transport.json')) {
        // Failed output is never a draft/review seed. Its outer envelope may
        // still supply a private identity to exclude from the fresh reviewer.
        try { rememberConversation(JSON.parse(row.value.stdout).conversation_id, identities); } catch { /* No recoverable identity. */ }
      }
    }
    for (const seed of page.draftSeeds) { pins.push(...checkSeed(seed, fields, locale.locale, identities)); seeds.push(seed); }
    let conversationId = null, workspace = null;
    for (const [i, section] of page.sections.entries()) {
      const phase = 'draft-' + String(i + 1).padStart(2, '0');
      assert.equal(section.requestHash, sha(JSON.stringify(section.request)), 'Original section request changed');
      assert.equal(section.request.locale, locale.locale); assert.equal(section.request.manifestHash, manifest.manifestHash);
      assert.deepEqual(section.request.fields.map(field => field.id), section.fieldIds);
      for (const field of section.request.fields) assert.equal(field.text, fields.get(field.id)?.text, 'Original draft source differs');
      const transportFile = path.join(dir, phase + '.transport.json'), proposalFile = path.join(dir, phase + '.proposal.json');
      if (phase === failed.value.phase || !existsSync(proposalFile)) {
        // Only the explicit failed draft and never-reached later drafts may be
        // regenerated. Missing successful prior evidence is an audit blocker.
        assert(failed.value.phase.startsWith('draft-') && i >= Number(failed.value.phase.slice(-2)) - 1, 'Successful draft evidence is missing');
        if (i > Number(failed.value.phase.slice(-2)) - 1) assert(!existsSync(path.join(dir, phase + '.dispatched.json')), 'Later draft has ambiguous dispatch');
        continue;
      }
      const transport = input(transportFile), proposal = input(proposalFile);
      const session = input(path.join(dir, phase + '.session.json')), dispatched = input(path.join(dir, phase + '.dispatched.json'));
      assert.deepEqual(parseTransport(transport.value), proposal.value, 'Saved draft differs from its complete SUCCESS envelope');
      assert(!transport.value.persistenceFailure, 'Saved draft persistence failed');
      assert.deepEqual(transport.value.unexpectedFiles || [], [], 'Saved draft wrote files');
      const envelope = JSON.parse(transport.value.stdout);
      assert(typeof session.value.conversationId === 'string' && /^[\w.-]{1,200}$/.test(session.value.conversationId), 'Invalid saved conversation identity');
      assert.equal(envelope.conversation_id, session.value.conversationId, 'Saved draft conversation identity differs');
      assert.equal(dispatched.value.planHash, oldHash);
      assert.equal(dispatched.value.conversationId, conversationId, 'Saved draft continuation differs');
      if (conversationId !== null) assert.equal(session.value.conversationId, conversationId, 'Saved page conversation changed');
      if (workspace !== null) assert.equal(session.value.workspace, workspace, 'Saved draft workspace changed');
      assert(typeof session.value.workspace === 'string' && session.value.workspace.length > 0, 'Missing saved workspace');
      conversationId = session.value.conversationId; workspace = session.value.workspace;
      assert(plain(proposal.value) && plain(proposal.value.translations), 'Invalid saved draft object');
      assert(Object.keys(proposal.value).every(key => ['translations', 'keptFields'].includes(key)), 'Unexpected saved draft fields');
      assert.deepEqual(Object.keys(proposal.value.translations).sort(), [...section.fieldIds].sort(), 'Saved draft field set is incomplete or added');
      for (const field of section.request.fields) {
        const translation = proposal.value.translations[field.id];
        assert(typeof translation === 'string' && translation.trim(), 'Saved draft has an empty/non-string value');
        let draftValid = true;
        try { const keep = proposal.value.keptFields?.[field.id]; if (keep !== undefined) validateKeep(fields.get(field.id), keep); validateText(fields.get(field.id), translation, { allowSource: Boolean(keep) }); } catch { draftValid = false; }
        seeds.push({ locale: locale.locale, id: field.id, text: field.text, translation, draftValid,
          source: { campaign: sourceCampaign, chunk, transport: pin(transport), proposal: pin(proposal) } });
      }
    }
    evidence.push({ campaign: sourceCampaign, locale: locale.locale, chunk, request: pin(old), files: [...new Map(pins.map(row => [row.file, row])).values()], recovery: true });
  }
  assert.equal(status.value.counts.planned, originalPages); assert.equal(status.value.counts.completed, originalCompleted);
  assert.equal(status.value.counts.held, heldPages.size); assert.equal(status.value.counts.skipped || 0, 0);
  const plan = buildSectionPlan({ manifest, htmlByRoute, records, draftSeeds: seeds, campaignEvidence: evidence,
    locales: oldPlan.locales.map(row => row.locale), maxChars: oldPlan.maximumSectionCharacters, minChars: oldPlan.tinySectionCharacters,
    pins: { manifestFile: baseline.manifestFile, sources: baseline.sources, accepted: baseline.accepted } });
  const plannedPages = plan.locales.flatMap(locale => locale.pages.map(page => locale.locale + '/' + page.route));
  assert.deepEqual(plannedPages.sort(), [...heldPages].sort(), 'Recovery must cover exactly the formerly held page-language units');
  for (const locale of plan.locales) for (const page of locale.pages) {
    const missing = new Set([...page.sections.flatMap(section => section.fieldIds), ...page.draftSeeds.map(seed => seed.id)]);
    const parts = page.route === '@chrome' ? [{ fields: manifest.chrome }]
      : classifySections(manifest.pages.find(row => row.route === page.route), htmlByRoute[page.route], { maxChars: plan.maximumSectionCharacters, minChars: plan.tinySectionCharacters });
    page.recovery = { maxDraftCalls: page.sections.length, maxReviewCalls: parts.filter(part => part.fields.some(field => missing.has(field.id))).length,
      priorConversationIds: [...priorIdentities.get(locale.locale + '/' + page.route)].sort() };
  }
  const pages = plan.locales.flatMap(locale => locale.pages);
  plan.recovery = { kind: 'single-bounded-section-recovery', sourcePlanHash: oldHash, sourcePlan: pin(old), sourceCampaign, sourceJob,
    acceptedBaseline: Object.fromEntries(Object.entries(records).map(([locale, record]) => [locale, record.translations])),
    bounds: { pages: pages.length, maxDraftCalls: pages.reduce((sum, page) => sum + page.recovery.maxDraftCalls, 0), maxReviewCalls: pages.reduce((sum, page) => sum + page.recovery.maxReviewCalls, 0) } };
  delete plan.planHash; plan.planHash = sha(JSON.stringify(plan));
  return plan;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), options = {};
  while (args.length) { const key = args.shift(), value = args.shift(); assert(['--source-job', '--output'].includes(key) && value && !value.startsWith('--') && !Object.hasOwn(options, key), 'Invalid recovery planner option'); options[key] = value; }
  const plan = prepareSectionRecoveryPlan({ sourceJob: options['--source-job'] });
  console.log(JSON.stringify({ ...sectionPlanSummary(plan), bounds: plan.recovery.bounds,
    ...(options['--output'] ? { output: writeSectionPlan(plan, options['--output']) } : { mode: 'read-only-preparation' }) }, null, 2));
}
