// All records, process identities, sources and applies here are synthetic.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { sha } from '../scripts/tutorial_locale_lib.mjs';
import { correctionReviewPrompt } from '../scripts/tutorial_section_protocol.mjs';
import { auditManualSectionApply, loadManualSectionAudit, applyManualSectionAudit } from '../scripts/tutorial_section_manual_apply.mjs';

const bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
const encoded = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
let passed = 0;
function test(name, body) { body(); passed++; console.log('PASS ' + name); }
function fixture(root = '/fixture') {
  const files = new Map(), missingFiles = [], directoryEntries = {}, processIdentities = {};
  const put = (file, value, raw = false) => { const bytes = raw ? Buffer.from(value) : encoded(value); files.set(file, bytes); return { file, sha256: sha(bytes) }; };
  const read = file => JSON.parse(files.get(file).toString('utf8'));
  const alter = (file, mutate) => { const value = read(file); mutate(value); put(file, value); };
  const owner = (pid, tick = 100) => { processIdentities[pid] = null; return { pid, startIdentity: bootId + ':' + tick, nonce: '12345678-1234-1234-1234-123456789abc' }; };
  const jobDir = path.join(root, 'job'), campaign = path.join(root, 'campaign'), priorCampaign = path.join(root, 'prior-campaign');
  const controller = owner(99999990), oldController = owner(99999991);
  const sourceField = (id, text) => ({ id, text, kind: 'html-text', tag: 'p', protectedSpans: [] });
  const first = sourceField('fixture.page.0001', 'Use {{P001}} before {{P002}}.'), label = sourceField('fixture.page.0002', 'Name');
  const seed = sourceField('fixture.page.0003', 'Earlier prose.'), future = sourceField('fixture.page.0004', 'Future prose.'), accepted = sourceField('fixture.page.0005', 'Accepted prose.');
  first.protectedSpans = [{ token: '{{P001}}', kind: 'literal', value: 'alpha' }, { token: '{{P002}}', kind: 'literal', value: 'beta' }];
  const fields = [first, label, seed, future, accepted], manifestHash = sha('offline source manifest');
  const manifestFile = put(path.join(root, 'manifest.json'), { schema: 1, manifestHash, pages: [{ route: 'fixture/page', fields }], chrome: [] });
  const source = put(path.join(root, 'www/help/fixture/page/index.html'), '<p>Offline frozen source</p>', true);
  const recordFile = path.join(root, 'docs/tutorial-localization/translations/fr.json');
  const record = { schema: 1, locale: 'fr', manifestHash, translations: { [accepted.id]: 'Texte déjà accepté.' }, receipts: [] };
  const acceptedSnapshot = { locale: 'fr', ...put(recordFile, record) };
  const draftValues = { [first.id]: 'Utilisez {{P001}} avant {{P002}}.', [label.id]: 'Name', [future.id]: 'Texte futur.' };
  const draftProposal = { translations: draftValues };
  const draftTransport = put(path.join(root, 'draft.transport.json'), { exitCode: 0, stderr: '', stdout: JSON.stringify({ status: 'SUCCESS', conversation_id: 'offline-original-draft', response: JSON.stringify(draftProposal) }), unexpectedFiles: [] });
  const draftProposalPin = put(path.join(root, 'draft.proposal.json'), draftProposal);
  const oldPlan = { schema: 1, kind: 'tutorial-coherent-section-plan', recovery: { kind: 'single-bounded-section-recovery' }, locales: [{ locale: 'fr', pages: [{ route: 'fixture/page', recovery: { priorConversationIds: ['offline-older-review'] } }] }] };
  oldPlan.planHash = sha(JSON.stringify(oldPlan));
  const oldPlanPin = put(path.join(root, 'prior-plan.json'), oldPlan);
  const chain = (directory, phase, planHash, proposal, conversationId, workerController, previous = null) => {
    const rows = {
      transport: { exitCode: 0, stderr: '', stdout: JSON.stringify({ status: 'SUCCESS', conversation_id: conversationId, response: JSON.stringify(proposal) }),
        timedOut: false, outputLimited: false, cancelled: false, persistenceFailure: false, cliTimeoutWarning: false, unexpectedFiles: [] },
      proposal, session: { conversationId, workspace: path.join(root, 'private-empty-review') },
      dispatched: { planHash, model: 'offline-fixture-model', printTimeout: '0s', conversationId: previous },
      queued: { planHash, phase, at: '2026-10-17T01:00:00.000Z' },
      child: { ...owner(workerController.pid === controller.pid ? 99999992 : 99999993), controller: workerController },
    };
    return Object.fromEntries(Object.entries(rows).map(([kind, value]) => [kind, put(path.join(directory, phase + '.' + kind + '.json'), value)]));
  };
  const priorDir = path.join(priorCampaign, 'fr/01');
  put(path.join(priorCampaign, 'controller-status.json'), { state: 'held', controller: oldController });
  const seedProposal = { translations: { [seed.id]: 'Texte antérieur.' } };
  const seedEvidence = chain(priorDir, 'review-01', oldPlan.planHash, seedProposal, 'offline-seed-review', oldController);
  const page = { route: 'fixture/page', sections: [],
    context: [{ id: accepted.id, text: accepted.text, translation: record.translations[accepted.id], readonly: true }],
    draftSeeds: [first, label, future].map(field => ({ locale: 'fr', id: field.id, text: field.text, translation: draftValues[field.id], source: { transport: draftTransport, proposal: draftProposalPin } })),
    reviewSeeds: [{ fieldIds: [seed.id], translations: seedProposal.translations, keptFields: {}, source: { campaign: priorCampaign, locale: 'fr', chunk: '01', phase: 'review-01', ...seedEvidence } }],
    correctionReviews: [{ fieldIds: [first.id, label.id] }, { fieldIds: [future.id] }], recovery: { priorConversationIds: ['offline-original-draft', 'offline-seed-review', 'offline-older-review'] } };
  const plan = { schema: 1, kind: 'tutorial-coherent-section-plan', manifestHash, manifestFile, sources: [source], campaignEvidence: [],
    locales: [{ locale: 'fr', pages: [page] }],
    recovery: { kind: 'explicit-bounded-section-correction', sourcePlan: oldPlanPin, sourcePlanHash: oldPlan.planHash, automaticRetries: false,
      acceptedBaseline: { fr: { ...record.translations } }, bounds: { pages: 1, maxDraftCalls: 0, maxReviewCalls: 2 } } };
  plan.planHash = sha(JSON.stringify(plan));
  const planPin = put(path.join(root, 'plan.json'), plan);
  const dummyController = put(path.join(root, 'scripts/run_tutorial_section_translations.mjs'), '// pinned offline fixture', true);
  const nonce = controller.nonce;
  put(path.join(jobDir, 'config.json'), { schema: 1, root, job: jobDir, campaign, sectionsPlan: planPin.file, controller: dummyController.file,
    nonce, model: 'offline-fixture-model', printTimeout: '0s', watchdogTimeout: '0s', pins: [planPin, dummyController].map(pin => ({ file: pin.file, hash: pin.sha256 })) });
  put(path.join(jobDir, 'result.json'), { state: 'held', exitCode: 1, finishedAt: '2026-10-17T02:00:00.000Z' });
  for (const [index, name] of ['owner.json', 'controller.json', 'launch.json'].entries()) put(path.join(jobDir, name), { ...owner(99999980 + index, 20 + index), startIdentity: String(20 + index), nonce });
  put(path.join(campaign, 'controller-status.json'), { state: 'held', unit: 'pages', controller, counts: { planned: 1, completed: 0, held: 1, skipped: 0 }, phases: [{ worker: { pid: 99999992, startIdentity: bootId + ':100' } }] });
  missingFiles.push(path.join(campaign, 'controller.lock'));
  const directory = path.join(campaign, 'fr/01'), bad = { translations: { [first.id]: 'Utilisez {{P002}} puis {{P001}}.', [label.id]: 'Name' } };
  const currentEvidence = chain(directory, 'review-01', plan.planHash, bad, 'offline-fresh-review', controller);
  put(path.join(directory, 'review-01.prompt.txt'), correctionReviewPrompt({ locale: 'fr', page }, [first, label], draftValues, true), true);
  put(path.join(directory, 'started.json'), { planHash: plan.planHash, locale: 'fr', route: page.route, explicitCorrection: true });
  put(path.join(directory, 'failed.json'), { planHash: plan.planHash, phase: 'review-01', noAutomaticRetry: true, error: 'offline protected token order hold' });
  put(path.join(directory, 'review.seeds.json'), page.reviewSeeds); put(path.join(directory, 'draft.seeds.json'), page.draftSeeds);
  missingFiles.push(path.join(directory, 'completed.json'), path.join(directory, 'accepted.json'));
  directoryEntries[directory] = [...files.keys()].filter(file => path.dirname(file) === directory).map(file => path.basename(file));
  const edit = (field, before, after, kind, replaceOne) => ({ id: field.id, kind, beforeHash: sha(before), afterHash: sha(after), before, after,
    reason: 'Explicit fixture editorial review restores the frozen source meaning.', ...(replaceOne ? { replaceOne } : {}) });
  const spec = { schema: 1, kind: 'explicit-section-editorial-correction', sourceJob: jobDir, plan: planPin, acceptedSnapshots: [acceptedSnapshot],
    reviewer: 'Offline controller editorial reviewer', reviewScope: 'Two explicit field edits after complete independent section review; no native approval.', nativeLanguageReview: 'pending',
    pages: [{ locale: 'fr', route: page.route, includeReviewSeeds: true, sections: [{ phase: 'review-01', edits: [
      edit(first, bad.translations[first.id], 'Utilisez {{P001}} avant {{P002}}.', 'source-aligned-clause', { before: '{{P002}} puis {{P001}}', after: '{{P001}} avant {{P002}}' }),
      edit(label, 'Name', 'Nom', 'translate-unchanged-label', { before: 'Name', after: 'Nom' }),
    ] }] }] };
  const snapshot = () => ({ spec, files: [...files].map(([file, bytes]) => ({ file, bytes })), missingFiles, directoryEntries, processIdentities, bootId, root });
  const run = () => auditManualSectionApply(snapshot());
  return { root, spec, files, read, put, alter, snapshot, run, directory, campaign, currentEvidence, controller, recordFile, first, label, future, accepted };
}

test('complete sections plus preserved reviews accept only explicit editorial fields', () => {
  const fixtureData = fixture(), before = fixtureData.snapshot().files.map(row => sha(row.bytes));
  const audit = fixtureData.run();
  assert.equal(audit.summary.fields, 3); assert.equal(audit.summary.editedFields, 2); assert.equal(audit.summary.sections, 2);
  assert(!audit.receipts.some(receipt => Object.hasOwn(receipt.translations, fixtureData.future.id)));
  assert(audit.receipts.every(receipt => receipt.review.nativeLanguageReview === 'pending' && receipt.review.machineApprovedEditorialChanges === false));
  const edited = audit.receipts.find(receipt => receipt.review.editorialCorrections.length);
  assert.equal(edited.review.source, 'explicit-editorial-correction-after-independent-machine-review');
  assert.equal(edited.review.controllerEditorialReviewer, fixtureData.spec.reviewer);
  assert.deepEqual(fixtureData.snapshot().files.map(row => sha(row.bytes)), before);
});
test('failed incomplete and persistence-failed transports cannot be manually accepted', () => {
  for (const change of [value => { value.exitCode = 1; }, value => { value.stdout = '{'; }, value => { value.persistenceFailure = true; }, value => { value.unexpectedFiles = ['forbidden']; }, value => { value.timedOut = true; }]) {
    const f = fixture(); f.alter(f.currentEvidence.transport.file, change); assert.throws(f.run);
  }
});
test('missing original fields remain rejected even with coherent SUCCESS JSON', () => {
  const f = fixture();
  const proposal = f.read(f.currentEvidence.proposal.file); delete proposal.translations[f.label.id]; f.put(f.currentEvidence.proposal.file, proposal);
  f.alter(f.currentEvidence.transport.file, transport => { const envelope = JSON.parse(transport.stdout); envelope.response = JSON.stringify(proposal); transport.stdout = JSON.stringify(envelope); });
  assert.throws(f.run, /Missing or extra original review fields/);
});
test('extra original schema keys and mismatched proposal copies remain rejected', () => {
  const f = fixture(); f.alter(f.currentEvidence.proposal.file, value => { value.approved = true; }); assert.throws(f.run);
});
test('exact original prompt and plan/source pins are mandatory', () => {
  const prompt = fixture(); prompt.put(path.join(prompt.directory, 'review-01.prompt.txt'), 'tampered request', true); assert.throws(prompt.run, /Saved review prompt/);
  const source = fixture(); source.put(path.join(source.root, 'www/help/fixture/page/index.html'), 'source changed', true); assert.throws(source.run, /Pinned evidence/);
  const plan = fixture(); plan.alter(plan.spec.plan.file, value => { value.manifestHash = 'changed'; }); assert.throws(plan.run);
});
test('review identities and dispatch continuation cannot be recycled', () => {
  const f = fixture(); f.alter(f.currentEvidence.session.file, value => { value.conversationId = 'offline-original-draft'; }); assert.throws(f.run);
  const dispatch = fixture(); dispatch.alter(dispatch.currentEvidence.dispatched.file, value => { value.conversationId = 'unexpected-continuation'; }); assert.throws(dispatch.run, /Dispatch continuation/);
});
test('live owners workers unknown liveness and missing absence evidence block acceptance', () => {
  const owner = fixture(); owner.snapshot().processIdentities[99999980] = bootId + ':20'; assert.throws(owner.run, /still live/);
  const worker = fixture(); worker.snapshot().processIdentities[99999992] = bootId + ':100'; assert.throws(worker.run, /still live/);
  const unknown = fixture(); delete unknown.snapshot().processIdentities[99999992]; assert.throws(unknown.run, /not observed/);
  const absence = fixture(); absence.snapshot().missingFiles.splice(0, 1); assert.throws(absence.run, /absence/);
});
test('current accepted drift is rejected and repinning cannot overwrite the baseline', () => {
  const f = fixture(); f.alter(f.recordFile, value => { value.translations[f.accepted.id] = 'changed'; }); assert.throws(f.run, /Pinned evidence/);
  f.spec.acceptedSnapshots[0].sha256 = sha(f.files.get(f.recordFile)); assert.throws(f.run, /Immutable accepted baseline/);
  const overwrite = fixture(); overwrite.alter(overwrite.recordFile, value => { value.translations[overwrite.first.id] = 'already accepted'; });
  overwrite.spec.acceptedSnapshots[0].sha256 = sha(overwrite.files.get(overwrite.recordFile)); assert.throws(overwrite.run, /overwrite/);
});
test('undispatched future review groups unknown phases and overlaps are not approvals', () => {
  const future = fixture(); future.spec.pages[0].sections.push({ phase: 'review-02', edits: [] }); assert.throws(future.run, /Undispatched future/);
  const unknown = fixture(); unknown.snapshot().directoryEntries[unknown.directory].push('review-99.dispatched.json'); assert.throws(unknown.run, /Unknown dispatched phase/);
  const overlap = fixture(); overlap.spec.pages.push(overlap.spec.pages[0]); assert.throws(overlap.run, /repeated selected page/);
});
test('explicit edits reject stale hashes nonunique clauses and changes outside the clause', () => {
  const stale = fixture(); stale.spec.pages[0].sections[0].edits[0].beforeHash = '0'.repeat(64); assert.throws(stale.run, /reviewed field changed/);
  const outside = fixture(), edit = outside.spec.pages[0].sections[0].edits[0]; edit.after += ' extra'; edit.afterHash = sha(edit.after); assert.throws(outside.run, /outside the explicit clause/);
  const nonunique = fixture(); nonunique.spec.pages[0].sections[0].edits[0].replaceOne.before = '{{P'; assert.throws(nonunique.run, /exactly once/);
});
test('editing cannot invent marker counts keep reasons or native approval', () => {
  const markers = fixture(), edit = markers.spec.pages[0].sections[0].edits[0]; edit.replaceOne.after = '{{P001}} avant {{P001}}'; edit.after = edit.before.replace(edit.replaceOne.before, edit.replaceOne.after); edit.afterHash = sha(edit.after); assert.throws(markers.run, /multiset/);
  const native = fixture(); native.spec.nativeLanguageReview = 'approved'; assert.throws(native.run, /native-language/);
});

const diskRoot = mkdtempSync(path.join(tmpdir(), 'scirepl-section-manual-offline-fixture-'));
const disk = fixture(diskRoot), specFile = path.join(diskRoot, 'editorial-spec.json');
for (const [file, bytes] of disk.files) { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, bytes); }
writeFileSync(specFile, encoded(disk.spec));
const inventory = directory => readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? inventory(path.join(directory, entry.name)) : [path.join(directory, entry.name)]).sort();
test('read-only loader/check creates no directories claims receipts or accepted changes', () => {
  const before = inventory(diskRoot), hash = sha(readFileSync(disk.recordFile));
  const audit = loadManualSectionAudit(specFile, { root: diskRoot }); assert.equal(audit.summary.fields, 3);
  assert.deepEqual(inventory(diskRoot), before); assert.equal(sha(readFileSync(disk.recordFile)), hash);
  assert(!existsSync(path.join(tmpdir(), 'scirepl-tutorial-apply-locks', sha(diskRoot))));
});
test('isolated apply is per-locale atomic records truthful provenance and preserves original evidence', () => {
  const output = path.join('/tmp', 'scirepl-tutorial-manual-correction-offline-' + randomUUID());
  const evidence = [...disk.files].filter(([file]) => file !== disk.recordFile).map(([file, bytes]) => [file, sha(bytes)]);
  const result = applyManualSectionAudit(specFile, output, { root: diskRoot }); assert.equal(result.fields, 3);
  const record = JSON.parse(readFileSync(disk.recordFile, 'utf8'));
  assert.equal(record.translations[disk.accepted.id], 'Texte déjà accepté.'); assert.equal(record.translations[disk.label.id], 'Nom');
  assert.equal(record.translations[disk.future.id], undefined); assert.equal(record.receipts.length, 2);
  assert(!existsSync(path.join(disk.directory, 'completed.json'))); assert(!existsSync(path.join(disk.directory, 'accepted.json')));
  for (const [file, hash] of evidence) assert.equal(sha(readFileSync(file)), hash);
  assert(existsSync(path.join(output, 'completed.json'))); assert(existsSync(path.join(output, 'applied-fr.json')));
  const intent = JSON.parse(readFileSync(path.join(output, 'intent-fr.json'), 'utf8'));
  assert.equal(intent.afterHash, sha(readFileSync(disk.recordFile))); assert(intent.beforeHash);
  assert.equal(JSON.parse(readFileSync(path.join(output, 'apply-started.json'), 'utf8')).atomicity, 'one-locale-at-a-time; no cross-locale rollback');
  const replay = path.join('/tmp', 'scirepl-tutorial-manual-correction-offline-' + randomUUID());
  assert.throws(() => applyManualSectionAudit(specFile, replay, { root: diskRoot })); assert(!existsSync(replay));
});
console.log(`PASS ${passed} isolated manual section acceptance scenarios (no live applies or model calls)`);
