// Recovery preparation is exercised only with synthetic, private offline records.
// No provider, controller, production campaign, queue or shared lock is accessed.
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { extractPage, sha } from '../scripts/tutorial_locale_lib.mjs';
import { classifySections, prepareSectionPlan, writeSectionPlan } from '../scripts/tutorial_locale_section_plan.mjs';
import { getProcessStartIdentity } from '../scripts/tutorial_translation_queue.mjs';
import { prepareSectionRecoveryPlan } from '../scripts/tutorial_section_recovery_plan.mjs';

let checks = 0;
const pass = name => { checks++; console.log('PASS ' + name); };
const write = (file, value) => {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value) + '\n', { mode: 0o600 });
  return { file, sha256: sha(readFileSync(file)) };
};
const read = file => JSON.parse(readFileSync(file, 'utf8'));
const unchanged = root => {
  const files = [];
  function visit(dir) {
    for (const name of readdirSync(dir).sort()) {
      const file = path.join(dir, name), info = lstatSync(file);
      if (info.isDirectory()) visit(file);
      else files.push([path.relative(root, file), info.mode & 0o777, sha(readFileSync(file))]);
    }
  }
  visit(root); return JSON.stringify(files);
};
const deadOwner = { pid: 2147483647, startIdentity: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:123', nonce: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' };

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'scirepl-tutorial-section-recovery-fixture-'));
  const sourceJob = path.join(root, 'old-job'), sourceCampaign = path.join(root, 'old-campaign');
  const sourcePlanFile = path.join(root, 'old-plan', 'plan.json');
  const description = 'This explanatory source paragraph describes a safe local calculation and its result. ';
  const alphaHtml = '<html><head><title>Alpha tutorial</title></head><body><h1>Alpha</h1><p>Accepted introduction.</p>'
    + Array.from({ length: 4 }, (_, index) => '<h2>Activity ' + String.fromCharCode(65 + index) + '</h2><p>'
      + description.repeat(3) + '</p><p>' + description.repeat(2) + '</p>').join('') + '</body></html>';
  const betaHtml = '<html><head><title>Beta tutorial</title></head><body><h1>Beta</h1><p>This whole page was accepted by the completed original unit.</p></body></html>';
  const pages = [extractPage('alpha/tutorial', alphaHtml), extractPage('beta/tutorial', betaHtml)];
  const unsigned = { schema: 1, sourceLocale: 'en', locales: ['en', 'fr'], pages, chrome: [] };
  const manifest = { ...unsigned, manifestHash: sha(JSON.stringify(unsigned)) };
  const manifestPin = write(path.join(root, 'docs/tutorial-localization/source.json'), manifest);
  const sources = [alphaHtml, betaHtml].map((html, index) => write(path.join(root, 'www/help', pages[index].route, 'index.html'), html));
  const acceptedId = pages[0].fields[0].id, oldSeedId = pages[0].fields.at(-1).id;
  const recordFile = path.join(root, 'docs/tutorial-localization/translations/fr.json');
  const record = { schema: 1, locale: 'fr', manifestHash: manifest.manifestHash,
    translations: { [acceptedId]: 'Titre déjà accepté.' },
    receipts: [{ fields: [acceptedId], review: { status: 'accepted', reviewer: 'offline reviewer', draftModel: 'offline draft', nativeLanguageReview: 'pending' } }] };
  write(recordFile, record);
  const seedProposal = { translations: { [oldSeedId]: 'Une proposition conservée avant la première passe.' } };
  const seedProposalPin = write(path.join(root, 'legacy-evidence/draft.proposal.json'), seedProposal);
  const seedTransportPin = write(path.join(root, 'legacy-evidence/draft.transport.json'), {
    exitCode: 0, timedOut: false, outputLimited: false, cancelled: false, unexpectedFiles: [], stderr: '',
    stdout: JSON.stringify({ status: 'SUCCESS', response: JSON.stringify(seedProposal) }),
  });
  const sourcePlan = prepareSectionPlan({ root, locales: ['fr'], maxChars: 500, minChars: 0 });
  // The original plan was already allowed to preserve this successful old draft.
  const alpha = sourcePlan.locales[0].pages.find(page => page.route === pages[0].route);
  for (const section of alpha.sections) {
    section.fieldIds = section.fieldIds.filter(id => id !== oldSeedId);
    section.request.fields = section.request.fields.filter(field => field.id !== oldSeedId);
    section.sourceChars = section.request.fields.reduce((sum, field) => sum + field.text.length, 0);
    section.requestHash = sha(JSON.stringify(section.request));
  }
  alpha.sections = alpha.sections.filter(section => section.fieldIds.length);
  alpha.draftSeeds = [{ locale: 'fr', id: oldSeedId, text: pages[0].fields.at(-1).text,
    translation: seedProposal.translations[oldSeedId], draftValid: true,
    source: { campaign: path.join(root, 'legacy-evidence'), chunk: '01', transport: seedTransportPin, proposal: seedProposalPin } }];
  sourcePlan.locales[0].plannedCount--;
  sourcePlan.locales[0].preservedDraftCount++;
  delete sourcePlan.planHash; sourcePlan.planHash = sha(JSON.stringify(sourcePlan));
  const planPin = write(sourcePlanFile, sourcePlan);
  assert(alpha.sections.length >= 3, 'Fixture must contain multiple draft turns');
  const alphaDir = path.join(sourceCampaign, 'fr/01'), betaDir = path.join(sourceCampaign, 'fr/02');
  for (const [index, page] of sourcePlan.locales[0].pages.entries()) write(path.join(sourceCampaign, 'fr', String(index + 1).padStart(2, '0'), 'started.json'), {
    planHash: sourcePlan.planHash, locale: 'fr', route: page.route, model: 'offline synthetic model',
    sections: page.sections.length, preservedDraftFields: page.draftSeeds.length,
  });
  const goodSection = alpha.sections[0];
  const goodProposal = { translations: Object.fromEntries(goodSection.fieldIds.map(id => [id, 'Traduction conservée de la première section.'])) };
  const conversationId = 'offline-draft-session';
  const workspace = path.join(root, 'finished-draft-workspace');
  const goodTransport = { exitCode: 0, timedOut: false, outputLimited: false, cancelled: false, persistenceFailure: false,
    unexpectedFiles: [], stderr: '', stdout: JSON.stringify({ status: 'SUCCESS', conversation_id: conversationId, response: JSON.stringify(goodProposal) }) };
  write(path.join(alphaDir, 'draft-01.dispatched.json'), { planHash: sourcePlan.planHash, conversationId: null });
  write(path.join(alphaDir, 'draft-01.transport.json'), goodTransport);
  write(path.join(alphaDir, 'draft-01.proposal.json'), goodProposal);
  write(path.join(alphaDir, 'draft-01.session.json'), { conversationId, workspace });
  write(path.join(alphaDir, 'draft-01.child.json'), deadOwner);
  write(path.join(alphaDir, 'draft-02.dispatched.json'), { planHash: sourcePlan.planHash, conversationId });
  write(path.join(alphaDir, 'draft-02.transport.json'), { ...goodTransport, stdout: '{"status":"SUCCESS","response":"truncated' });
  write(path.join(alphaDir, 'failed.json'), { planHash: sourcePlan.planHash, phase: 'draft-02', error: 'Incomplete synthetic transport', noAutomaticRetry: true });
  // A failed reviewer must never become a seed, even with complete-looking JSON.
  write(path.join(alphaDir, 'review-01.transport.json'), { exitCode: 1, stdout: JSON.stringify({ status: 'ERROR', response: { translations: { [oldSeedId]: 'NEVER REUSE THIS FAILED REVIEW' } } }) });
  write(path.join(alphaDir, 'review-01.proposal.json'), { translations: { [oldSeedId]: 'NEVER REUSE THIS FAILED REVIEW' } });
  const betaIds = pages[1].fields.map(field => field.id);
  Object.assign(record.translations, Object.fromEntries(betaIds.map(id => [id, 'Page complète déjà acceptée.'])));
  record.receipts.push({ fields: betaIds, review: { status: 'accepted', reviewer: 'offline reviewer', draftModel: 'offline draft', nativeLanguageReview: 'pending' } });
  write(recordFile, record);
  write(path.join(betaDir, 'accepted.json'), { manifestHash: manifest.manifestHash, translations: Object.fromEntries(betaIds.map(id => [id, record.translations[id]])), review: record.receipts.at(-1).review });
  write(path.join(betaDir, 'completed.json'), { planHash: sourcePlan.planHash, locale: 'fr', route: pages[1].route, fields: betaIds.length,
    acceptedHash: sha(readFileSync(path.join(betaDir, 'accepted.json'))), nativeLanguageReview: 'pending' });
  write(path.join(sourceCampaign, 'controller-status.json'), { schema: 1, unit: 'pages', state: 'held', controller: deadOwner,
    counts: { planned: 2, completed: 1, held: 1, skipped: 0 },
    phases: [{ locale: 'fr', chunk: '01', route: pages[0].route, phase: 'draft-01', state: 'completed', worker: deadOwner }] });
  write(path.join(sourceJob, 'config.json'), { schema: 1, root, job: sourceJob, campaign: sourceCampaign, sectionsPlan: sourcePlanFile,
    controller: path.join(root, 'scripts/run_tutorial_section_translations.mjs'), nonce: deadOwner.nonce, printTimeout: '0s', watchdogTimeout: '0s', pollIntervalSeconds: 30,
    pins: [planPin, manifestPin, ...sources].map(pin => ({ file: pin.file, hash: pin.sha256 })) });
  write(path.join(sourceJob, 'owner.json'), deadOwner);
  write(path.join(sourceJob, 'controller.json'), deadOwner);
  write(path.join(sourceJob, 'result.json'), { state: 'held', exitCode: 1, finishedAt: '2026-10-16T06:04:00.000Z' });
  const prepare = overrides => prepareSectionRecoveryPlan({ root, sourceJob, ...overrides });
  return { root, sourceJob, sourceCampaign, sourcePlanFile, sourcePlan, manifest, manifestPin, sources, recordFile, record,
    alphaDir, betaDir, alpha, acceptedId, oldSeedId, goodSection, goodProposal, goodTransport, conversationId, prepare };
}

const base = fixture(), before = unchanged(base.root), recovery = base.prepare();
assert.equal(unchanged(base.root), before, 'Preparation must not modify any fixture input');
assert.equal(recovery.kind, 'tutorial-coherent-section-plan');
assert.equal(recovery.recovery.kind, 'single-bounded-section-recovery');
assert.equal(recovery.recovery.sourcePlanHash, base.sourcePlan.planHash);
assert.equal(recovery.recovery.sourceCampaign, base.sourceCampaign);
assert.equal(recovery.recovery.sourceJob, base.sourceJob);
const recoveredPages = recovery.locales.flatMap(locale => locale.pages.map(page => ({ locale: locale.locale, ...page })));
assert.equal(recoveredPages.length, 1);
assert.equal(recoveredPages[0].route, 'alpha/tutorial');
const recoveredAlpha = recoveredPages[0];
const seedIds = recoveredAlpha.draftSeeds.map(seed => seed.id);
assert(seedIds.includes(base.oldSeedId), 'Previously preserved successful draft must survive');
assert(base.goodSection.fieldIds.every(id => seedIds.includes(id)), 'Successful first turn must survive a later failed draft');
for (const id of base.goodSection.fieldIds) {
  const seed = recoveredAlpha.draftSeeds.find(row => row.id === id);
  assert.equal(seed.translation, base.goodProposal.translations[id]);
  assert.equal(seed.source.transport.file, path.join(base.alphaDir, 'draft-01.transport.json'));
  assert.equal(seed.source.transport.sha256, sha(readFileSync(seed.source.transport.file)));
  assert.equal(seed.source.proposal.sha256, sha(readFileSync(seed.source.proposal.file)));
}
assert.deepEqual(recoveredAlpha.draftSeeds.find(row => row.id === base.oldSeedId).source, base.alpha.draftSeeds[0].source);
assert(!JSON.stringify(recovery).includes('NEVER REUSE THIS FAILED REVIEW'));
pass('partial successful section drafts and pinned legacy seeds survive; completed pages and failed review outputs do not enter recovery');

const plannedIds = recoveredAlpha.sections.flatMap(section => section.fieldIds);
const missing = base.manifest.pages[0].fields.filter(field => !Object.hasOwn(base.record.translations, field.id)).map(field => field.id);
assert.deepEqual([...plannedIds, ...seedIds].sort(), missing.sort());
assert.equal(new Set([...plannedIds, ...seedIds]).size, missing.length);
assert(!plannedIds.includes(base.acceptedId) && !seedIds.includes(base.acceptedId));
assert(recoveredAlpha.context.some(field => field.id === base.acceptedId && field.readonly && field.translation === base.record.translations[base.acceptedId]));
assert.equal(recovery.locales[0].missingCount, missing.length);
assert.equal(recovery.locales[0].plannedCount, plannedIds.length);
assert.equal(recovery.locales[0].preservedDraftCount, seedIds.length);
const { planHash, ...unsignedRecovery } = recovery;
assert.equal(planHash, sha(JSON.stringify(unsignedRecovery)));
for (const section of recoveredAlpha.sections) assert.equal(section.requestHash, sha(JSON.stringify(section.request)));
assert.equal(JSON.stringify(base.prepare()), JSON.stringify(recovery));
pass('all remaining missing fields occur exactly once with accepted fields read-only and deterministic request/plan hashes');

assert.equal(recovery.recovery.bounds.pages, recoveredPages.length);
assert.equal(recovery.recovery.bounds.maxDraftCalls, recoveredPages.reduce((sum, page) => sum + page.sections.length, 0));
assert.equal(recovery.recovery.bounds.maxReviewCalls, recoveredPages.reduce((sum, page) => sum + page.recovery.maxReviewCalls, 0));
for (const page of recoveredPages) {
  assert.equal(page.recovery.maxDraftCalls, page.sections.length);
  assert(Number.isSafeInteger(page.recovery.maxReviewCalls) && page.recovery.maxReviewCalls > 0);
  const source = base.manifest.pages.find(source => source.route === page.route);
  const fields = new Set([...page.sections.flatMap(section => section.fieldIds), ...page.draftSeeds.map(seed => seed.id)]);
  const parts = classifySections(source, readFileSync(base.sources.find(pin => pin.file.includes(source.route)).file, 'utf8'), {
    maxChars: base.sourcePlan.maximumSectionCharacters, minChars: base.sourcePlan.tinySectionCharacters,
  });
  assert.equal(page.recovery.maxReviewCalls, parts.filter(part => part.fields.some(field => fields.has(field.id))).length);
}
pass('per-page and aggregate draft/review call ceilings are explicit and include zero-regeneration saved fields');

function completeDraftsBeforeReviewHold(test) {
  const workspace = path.join(test.root, 'finished-draft-workspace');
  for (const [index, section] of test.alpha.sections.entries()) {
    const phase = 'draft-' + String(index + 1).padStart(2, '0');
    const proposal = { translations: Object.fromEntries(section.fieldIds.map(id => [id, 'Proposition complète conservée pour la révision.'])) };
    write(path.join(test.alphaDir, phase + '.transport.json'), { ...test.goodTransport,
      stdout: JSON.stringify({ status: 'SUCCESS', conversation_id: test.conversationId, response: proposal }) });
    write(path.join(test.alphaDir, phase + '.proposal.json'), proposal);
    write(path.join(test.alphaDir, phase + '.session.json'), { conversationId: test.conversationId, workspace });
    write(path.join(test.alphaDir, phase + '.dispatched.json'), { planHash: test.sourcePlan.planHash, conversationId: index ? test.conversationId : null });
    write(path.join(test.alphaDir, phase + '.child.json'), deadOwner);
  }
  write(path.join(test.alphaDir, 'failed.json'), { planHash: test.sourcePlan.planHash, phase: 'review-01', error: 'Synthetic failed reviewer', noAutomaticRetry: true });
}
const reviewHold = fixture(); completeDraftsBeforeReviewHold(reviewHold);
const reviewOnly = reviewHold.prepare(), reviewOnlyPage = reviewOnly.locales[0].pages[0];
assert.equal(reviewOnlyPage.sections.length, 0);
assert.equal(reviewOnlyPage.recovery.maxDraftCalls, 0);
assert.equal(reviewOnly.recovery.bounds.maxDraftCalls, 0);
assert.equal(reviewOnlyPage.draftSeeds.length, missing.length);
assert(reviewOnlyPage.recovery.maxReviewCalls > 0);
pass('a reviewer hold with all successful drafts needs zero regeneration and has a finite fresh-review-only budget');

const rejectedDraft = (label, change) => {
  const test = fixture(); change(test);
  const snapshot = unchanged(test.root);
  assert.throws(() => test.prepare(), undefined, label + ': ambiguous successful-looking evidence must block, never silently regenerate');
  assert.equal(unchanged(test.root), snapshot, label + ': rejected planning must preserve all evidence');
};
rejectedDraft('cancelled', test => write(path.join(test.alphaDir, 'draft-01.transport.json'), { ...test.goodTransport, cancelled: true }));
rejectedDraft('provider error', test => write(path.join(test.alphaDir, 'draft-01.transport.json'), { ...test.goodTransport, stdout: JSON.stringify({ status: 'ERROR', conversation_id: test.conversationId, response: test.goodProposal }) }));
rejectedDraft('truncated inner JSON', test => write(path.join(test.alphaDir, 'draft-01.transport.json'), { ...test.goodTransport, stdout: JSON.stringify({ status: 'SUCCESS', conversation_id: test.conversationId, response: '{"translations":' }) }));
rejectedDraft('transport output cap', test => write(path.join(test.alphaDir, 'draft-01.transport.json'), { ...test.goodTransport, outputLimited: true }));
pass('cancelled, error, truncated and output-limited transport cannot be reused even when proposal files exist');

rejectedDraft('proposal mismatch', test => write(path.join(test.alphaDir, 'draft-01.proposal.json'), { translations: Object.fromEntries(test.goodSection.fieldIds.map(id => [id, 'Different saved draft.'])) }));
rejectedDraft('partial fieldset', test => {
  const proposal = { translations: { [test.goodSection.fieldIds[0]]: test.goodProposal.translations[test.goodSection.fieldIds[0]] } };
  assert(test.goodSection.fieldIds.length > 1, 'Partial-field fixture needs more than one source field');
  write(path.join(test.alphaDir, 'draft-01.proposal.json'), proposal);
  write(path.join(test.alphaDir, 'draft-01.transport.json'), { ...test.goodTransport, stdout: JSON.stringify({ status: 'SUCCESS', conversation_id: test.conversationId, response: proposal }) });
});
rejectedDraft('foreign field', test => {
  const proposal = { translations: { ...test.goodProposal.translations, 'foreign.field': 'Foreign output.' } };
  write(path.join(test.alphaDir, 'draft-01.proposal.json'), proposal);
  write(path.join(test.alphaDir, 'draft-01.transport.json'), { ...test.goodTransport, stdout: JSON.stringify({ status: 'SUCCESS', conversation_id: test.conversationId, response: proposal }) });
});
pass('draft proposal must match SUCCESS bytes and the exact original section field set');

rejectedDraft('wrong session', test => write(path.join(test.alphaDir, 'draft-01.session.json'), { conversationId: 'different-conversation', workspace: path.join(test.root, 'old-workspace') }));
rejectedDraft('workspace writes', test => write(path.join(test.alphaDir, 'draft-01.transport.json'), { ...test.goodTransport, unexpectedFiles: ['unexpected.txt'] }));
rejectedDraft('metadata persistence failure', test => write(path.join(test.alphaDir, 'draft-01.transport.json'), { ...test.goodTransport, persistenceFailure: true }));
rejectedDraft('nonempty issues', test => {
  const proposal = { ...test.goodProposal, issues: ['This synthetic result is not a completed draft.'] };
  write(path.join(test.alphaDir, 'draft-01.proposal.json'), proposal);
  write(path.join(test.alphaDir, 'draft-01.transport.json'), { ...test.goodTransport, stdout: JSON.stringify({ status: 'SUCCESS', conversation_id: test.conversationId, response: proposal }) });
});
pass('conversation drift, worker writes, persistence failure and explicit issues are rejected as seed evidence');

for (const mutation of ['continuation-id', 'workspace', 'dispatch-id']) {
  const test = fixture(); completeDraftsBeforeReviewHold(test);
  if (mutation === 'workspace') write(path.join(test.alphaDir, 'draft-02.session.json'), { conversationId: test.conversationId, workspace: path.join(test.root, 'foreign-workspace') });
  else if (mutation === 'dispatch-id') write(path.join(test.alphaDir, 'draft-02.dispatched.json'), { planHash: test.sourcePlan.planHash, conversationId: 'unrelated-prior-conversation' });
  else {
    const file = path.join(test.alphaDir, 'draft-02.transport.json'), transport = read(file), envelope = JSON.parse(transport.stdout);
    envelope.conversation_id = 'unrelated-new-conversation'; transport.stdout = JSON.stringify(envelope); write(file, transport);
    write(path.join(test.alphaDir, 'draft-02.session.json'), { conversationId: envelope.conversation_id, workspace: path.join(test.root, 'finished-draft-workspace') });
  }
  assert.throws(() => test.prepare());
}
pass('multiple saved draft turns must preserve the same page conversation, workspace and dispatched continuation identity');

const failedPhase = fixture();
const failedSection = failedPhase.alpha.sections[1];
const failedProposal = { translations: Object.fromEntries(failedSection.fieldIds.map(id => [id, 'Output from the explicitly failed draft is not reused.'])) };
write(path.join(failedPhase.alphaDir, 'draft-02.transport.json'), { ...failedPhase.goodTransport, stdout: JSON.stringify({ status: 'SUCCESS', conversation_id: failedPhase.conversationId, response: failedProposal }) });
write(path.join(failedPhase.alphaDir, 'draft-02.proposal.json'), failedProposal);
write(path.join(failedPhase.alphaDir, 'draft-02.session.json'), { conversationId: failedPhase.conversationId, workspace: path.join(failedPhase.root, 'finished-draft-workspace') });
const failedRecovery = failedPhase.prepare();
const failedPage = failedRecovery.locales[0].pages[0];
assert(!failedPage.draftSeeds.some(seed => failedSection.fieldIds.includes(seed.id)));
assert(failedSection.fieldIds.every(id => failedPage.sections.some(section => section.fieldIds.includes(id))));
pass('the explicitly failed draft phase is excluded even if complete-looking saved output exists');

for (const name of ['owner.json', 'controller.json']) {
  const test = fixture();
  write(path.join(test.sourceJob, name), { pid: process.pid, startIdentity: getProcessStartIdentity(), nonce: deadOwner.nonce });
  assert.throws(() => test.prepare(), /live|owner|running|drain|stop|identity/i, name);
}
const liveWorker = fixture();
write(path.join(liveWorker.alphaDir, 'draft-01.child.json'), { pid: process.pid, startIdentity: getProcessStartIdentity() });
assert.throws(() => liveWorker.prepare(), /live|worker|running|drain|stop/i);
const completedWorker = fixture();
write(path.join(completedWorker.betaDir, 'review-01.child.json'), { pid: process.pid, startIdentity: getProcessStartIdentity() });
assert.throws(() => completedWorker.prepare(), /live|worker|running|drain|stop/i);
const malformedWorker = fixture();
write(path.join(malformedWorker.alphaDir, 'draft-01.child.json'), { pid: 2147483647, startIdentity: 'not-a-valid-identity' });
assert.throws(() => malformedWorker.prepare(), /identity|malformed|unverifiable/i);
const active = fixture(); write(path.join(active.sourceJob, 'result.json'), { state: 'running', exitCode: null });
assert.throws(() => active.prepare(), /held|terminal|stopped|finish|running/i);
const locked = fixture(); mkdirSync(path.join(locked.sourceCampaign, 'controller.lock'));
assert.throws(() => locked.prepare(), /lock|drain|stop|owner/i);
pass('live supervisors, controllers and workers including completed units, malformed ownership and nonterminal/locked jobs block planning');

const sourceDrift = fixture(); write(sourceDrift.sources[0].file, readFileSync(sourceDrift.sources[0].file, 'utf8') + ' ');
assert.throws(() => sourceDrift.prepare(), /source|changed|pin|hash/i);
const manifestDrift = fixture(); const changedManifest = read(manifestDrift.manifestPin.file); changedManifest.pages[0].fields[0].text += ' drift'; write(manifestDrift.manifestPin.file, changedManifest);
assert.throws(() => manifestDrift.prepare(), /source|manifest|changed|pin|hash/i);
const planDrift = fixture(); const changedPlan = read(planDrift.sourcePlanFile); changedPlan.maximumSectionCharacters++;
delete changedPlan.planHash; changedPlan.planHash = sha(JSON.stringify(changedPlan)); write(planDrift.sourcePlanFile, changedPlan);
assert.throws(() => planDrift.prepare(), /plan|changed|pin|hash/i);
pass('English, manifest and exact pinned original plan drift stop preparation before any calls');

const wrongStarted = fixture(); write(path.join(wrongStarted.alphaDir, 'started.json'), { planHash: wrongStarted.sourcePlan.planHash, locale: 'fr', route: 'beta/tutorial', sections: wrongStarted.alpha.sections.length, preservedDraftFields: 1 });
assert.throws(() => wrongStarted.prepare());
const wrongFailed = fixture(); const failure = read(path.join(wrongFailed.alphaDir, 'failed.json')); failure.planHash = 'foreign-plan'; write(path.join(wrongFailed.alphaDir, 'failed.json'), failure);
assert.throws(() => wrongFailed.prepare());
const acceptedDrift = fixture(); const changedRecord = read(acceptedDrift.recordFile); changedRecord.translations[acceptedDrift.acceptedId] = 'Changed previously accepted introduction.'; write(acceptedDrift.recordFile, changedRecord);
assert.throws(() => acceptedDrift.prepare(), /accepted|context|changed|snapshot/i);
pass('started/failed association drift and changed old accepted context cannot be silently replanned');

const explicit = fixture();
const explicitPlan = explicit.prepare({ sourcePlanFile: explicit.sourcePlanFile, sourceCampaign: explicit.sourceCampaign });
assert.equal(explicitPlan.recovery.sourcePlanHash, explicit.sourcePlan.planHash);
const outside = path.join(explicit.root, 'wrong-plan.json'); write(outside, explicit.sourcePlan);
assert.throws(() => explicit.prepare({ sourcePlanFile: outside }));
assert.throws(() => explicit.prepare({ sourceCampaign: path.join(explicit.root, 'another-campaign') }));
const output = path.join(explicit.root, 'prepared-output', 'plan.json');
assert(!existsSync(output));
const saved = writeSectionPlan(explicitPlan, output);
assert.equal(saved.sha256, sha(readFileSync(output)));
assert.equal(lstatSync(output).mode & 0o777, 0o600);
assert.throws(() => writeSectionPlan(explicitPlan, output), /fresh|replace/i);
assert(!existsSync(path.join(explicit.root, 'scirepl-example-gemini-slots')));
assert(!existsSync(path.join(explicit.root, 'scirepl-tutorial-section-claims')));
pass('optional original paths must match job pins; only explicit fresh private output writing creates a plan');

const moduleUrl = new URL('../scripts/tutorial_section_recovery_plan.mjs', import.meta.url).href;
const imported = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(moduleUrl)})`], { encoding: 'utf8' });
assert.equal(imported.status, 0, imported.stderr); assert.equal(imported.stdout, ''); assert.equal(imported.stderr, '');
assert.equal(unchanged(base.root), before);
pass('pure imports and repeated read-only preparation make no records, claims, locks or provider requests');

console.log(`${checks}/${checks} bounded section-recovery planner groups passed; no model requests or production writes.`);
