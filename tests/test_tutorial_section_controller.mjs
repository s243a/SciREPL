// All model calls, slots, histories and applies are confined to fixture copies.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { ROOT, sha } from '../scripts/tutorial_locale_lib.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function fixture(mode = 'success', extraConfig = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'scirepl-section-offline-fixture-'));
  const temporary = path.join(root, 'tmp'); mkdirSync(temporary);
  for (const name of ['run_tutorial_section_translations.mjs', 'tutorial_locale_section_plan.mjs', 'tutorial_section_recovery_plan.mjs', 'tutorial_locale_lib.mjs', 'tutorial_locale_status.mjs', 'tutorial_locale_apply.mjs', 'tutorial_translation_transport.mjs', 'tutorial_translation_queue.mjs', 'tutorial_section_protocol.mjs', 'tutorial_review_batching.mjs', 'tutorial_section_correction_plan.mjs', 'tutorial_section_review_continuation_plan.mjs']) {
    mkdirSync(path.join(root, 'scripts'), { recursive: true }); copyFileSync(path.join(ROOT, 'scripts', name), path.join(root, 'scripts', name));
  }
  const fake = path.join(root, 'offline-agy.mjs'); copyFileSync(path.join(ROOT, 'tests/fixtures/tutorial_section_fake_cli.mjs'), fake);
  // chmod through the filesystem API is fixture construction, never production.
  spawnSync('chmod', ['700', fake]);
  const write = (file, value) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); return { file, sha256: sha(readFileSync(file)) }; };
  const field = (id, text, start) => ({ id, text, start, end: start + text.length, kind: 'html-text', tag: 'p', protectedSpans: [] });
  const pages = ['alpha', 'beta'].map(route => {
    const firstText = ['label-keep', 'missing-label-keep'].includes(mode) ? 'Name' : ['numeric-order', 'numeric-script'].includes(mode) ? 'Values 2 and 10.' : 'First prose.';
    const source = '<html><body><p>Accepted introduction.</p><h2>First heading</h2><p>' + firstText + '</p><h2>Second heading</h2><p>Second prose.</p><p>Saved draft.</p></body></html>';
    const fields = route === 'alpha' ? [field('alpha.accepted', 'Accepted introduction.', source.indexOf('Accepted')), field('alpha.one', firstText, source.indexOf(firstText)), field('alpha.two', 'Second prose.', source.indexOf('Second prose')), field('alpha.seed', 'Saved draft.', source.indexOf('Saved draft'))] : [field('beta.one', firstText, source.indexOf(firstText))];
    const pin = write(path.join(root, 'www/help', route, 'index.html'), source);
    return { route, sourceHash: pin.sha256, fields, pin };
  });
  const manifest = { schema: 1, manifestHash: sha('offline section fixture source'), pages: pages.map(({ pin, ...page }) => page), chrome: [] };
  const manifestPin = write(path.join(root, 'docs/tutorial-localization/source.json'), manifest);
  const locale = { schema: 1, locale: 'fr', manifestHash: manifest.manifestHash, translations: { 'alpha.accepted': 'Introduction approuvée.' }, receipts: [{ fields: ['alpha.accepted'], review: { status: 'accepted', reviewer: 'offline fixture', draftModel: 'offline fixture' } }] };
  const record = path.join(root, 'docs/tutorial-localization/translations/fr.json'), accepted = write(record, locale);
  const seedProposal = { translations: { 'alpha.seed': 'Brouillon déjà traduit.' } };
  const proposalPin = write(path.join(root, 'seed.proposal.json'), seedProposal);
  const transportPin = write(path.join(root, 'seed.transport.json'), { exitCode: 0, stdout: JSON.stringify({ status: 'SUCCESS', response: JSON.stringify(seedProposal) }), stderr: '', unexpectedFiles: [] });
  const section = (page, id, fields) => {
    const request = { schema: 1, locale: 'fr', sourceLocale: 'en', manifestHash: manifest.manifestHash, route: page.route, sectionId: id, fields };
    return { id, heading: id, sourceStart: fields[0].start, sourceEnd: fields.at(-1).end, sourceChars: fields.reduce((sum, item) => sum + item.text.length, 0), fieldIds: fields.map(item => item.id), request, requestHash: sha(JSON.stringify(request)) };
  };
  const plan = { schema: 1, kind: 'tutorial-coherent-section-plan', manifestHash: manifest.manifestHash, manifestFile: manifestPin, sources: pages.map(page => ({ route: page.route, ...page.pin })), accepted: [{ locale: 'fr', ...accepted }], campaignEvidence: [], locales: [{ locale: 'fr', pages: [
    { route: 'alpha', context: [{ id: 'alpha.accepted', text: 'Accepted introduction.', translation: locale.translations['alpha.accepted'], readonly: true }], draftSeeds: [{ locale: 'fr', id: 'alpha.seed', text: 'Saved draft.', translation: seedProposal.translations['alpha.seed'], source: { campaign: 'offline-fixture', chunk: '01', transport: transportPin, proposal: proposalPin } }], sections: [section(pages[0], 'first', [pages[0].fields[1]]), section(pages[0], 'second', [pages[0].fields[2]])] },
    { route: 'beta', context: [], draftSeeds: [], sections: [section(pages[1], 'first', pages[1].fields)] },
  ] }] };
  plan.planHash = sha(JSON.stringify(plan)); const planFile = path.join(root, 'plan.json'); write(planFile, plan);
  // Crash logs go to a fixture directory, never the real ~/.gemini one.
  const crashes = path.join(root, 'crashes'); mkdirSync(crashes);
  write(path.join(root, 'fake-config.json'), { mode, driftFile: pages[0].pin.file, crashesDir: crashes, ...extraConfig });
  const env = { ...process.env, TMPDIR: temporary, SCIREPL_TRANSLATION_AGY: fake, SCIREPL_AGY_CRASHES_DIR: crashes };
  const campaign = mkdtempSync(path.join(tmpdir(), 'scirepl-tutorial-translation-section-offline-'));
  const args = [path.join(root, 'scripts/run_tutorial_section_translations.mjs'), '--plan', planFile, '--campaign', campaign];
  const calls = () => existsSync(path.join(root, 'fake-calls.jsonl')) ? readFileSync(path.join(root, 'fake-calls.jsonl'), 'utf8').trim().split('\n').map(row => JSON.parse(row)) : [];
  const run = execute => spawnSync(process.execPath, [...args, ...(execute ? ['--execute'] : [])], { cwd: root, env, encoding: 'utf8', timeout: 30000 });
  return { root, temporary, fake, plan, planFile, record, locale, campaign, args, env, calls, run, write };
}
function rewritePlan(test) { delete test.plan.planHash; test.plan.planHash = sha(JSON.stringify(test.plan)); test.write(test.planFile, test.plan); }
function authorizeRecovery(test, { seedOnly = false } = {}) {
  const sourcePlan = test.write(path.join(test.root, 'source-plan.json'), test.plan);
  const evidence = test.write(path.join(test.root, 'source-phase-evidence.json'), { state: 'held', noAutomaticRetry: true });
  if (seedOnly) {
    const page = test.plan.locales[0].pages[0], fields = page.sections.flatMap(section => section.request.fields);
    const proposal = { translations: Object.fromEntries(fields.map(field => [field.id, 'Brouillon conservé : ' + field.text])) };
    const proposalPin = test.write(path.join(test.root, 'recovery-seed.proposal.json'), proposal);
    const transportPin = test.write(path.join(test.root, 'recovery-seed.transport.json'), { exitCode: 0, stdout: JSON.stringify({ status: 'SUCCESS', conversation_id: 'historical-draft-alpha', response: JSON.stringify(proposal) }), stderr: '', unexpectedFiles: [] });
    page.draftSeeds.push(...fields.map(field => ({ locale: 'fr', id: field.id, text: field.text, translation: proposal.translations[field.id], source: { campaign: 'offline-fixture', chunk: '01', transport: transportPin, proposal: proposalPin } })));
    page.sections = [];
  }
  for (const page of test.plan.locales[0].pages) page.recovery = { maxDraftCalls: page.sections.length, maxReviewCalls: 1,
    priorConversationIds: ['historical-draft-' + page.route, 'historical-review-' + page.route] };
  test.plan.campaignEvidence = [{ request: sourcePlan, files: [evidence] }];
  test.plan.recovery = { kind: 'single-bounded-section-recovery', sourcePlanHash: JSON.parse(readFileSync(sourcePlan.file)).planHash, sourcePlan,
    sourceCampaign: '/tmp/scirepl-tutorial-translation-section-offline-original', sourceJob: '/tmp/scirepl-tutorial-translation-job-section-offline-original',
    acceptedBaseline: { fr: { ...test.locale.translations } },
    bounds: { pages: 2, maxDraftCalls: test.plan.locales[0].pages.reduce((sum, page) => sum + page.sections.length, 0), maxReviewCalls: 2 } };
  const configFile = path.join(test.root, 'fake-config.json'), config = JSON.parse(readFileSync(configFile));
  test.write(configFile, { ...config, evidenceFile: evidence.file, helperFile: path.join(test.root, 'scripts/tutorial_section_recovery_plan.mjs') });
  rewritePlan(test); return test;
}

const success = fixture();
const prepared = success.run(false); assert.equal(prepared.status, 0, prepared.stderr); assert.equal(JSON.parse(prepared.stdout).pages, 2); assert.equal(success.calls().length, 0); assert(!existsSync(path.join(success.campaign, 'controller.lock')));
assert(!existsSync(path.join(success.temporary, 'scirepl-tutorial-section-claims')));
console.log('PASS prepare-only validates pins without calls, claims, applies or workspace writes');
const executed = success.run(true); assert.equal(executed.status, 0, executed.stderr);
const calls = success.calls(), alphaDraft = calls.filter(row => row.route === 'alpha' && !row.review), alphaReview = calls.filter(row => row.route === 'alpha' && row.review);
assert.equal(calls.length, 5); assert.equal(alphaDraft.length, 2); assert.equal(alphaReview.length, 1);
assert.equal(alphaDraft[0].id, alphaDraft[1].id); assert.equal(alphaDraft[0].resumed, false); assert.equal(alphaDraft[1].resumed, true); assert.equal(alphaDraft[0].workspace, alphaDraft[1].workspace);
assert.notEqual(alphaReview[0].id, alphaDraft[0].id); assert.notEqual(alphaReview[0].workspace, alphaDraft[0].workspace); assert.equal(alphaReview[0].resumed, false);
assert(!calls.some(row => !row.review && row.fieldIds.includes('alpha.seed')), 'Successful draft is never regenerated');
assert(!calls.some(row => row.fieldIds.includes('alpha.accepted')), 'Accepted translation is never regenerated or reviewed as editable');
const record = JSON.parse(readFileSync(success.record)); assert.equal(record.translations['alpha.accepted'], success.locale.translations['alpha.accepted']); assert.equal(record.translations['alpha.seed'], 'Brouillon déjà traduit.'); assert.equal(record.receipts.length, 3);
assert.equal(record.receipts.find(row => row.fields.includes('alpha.seed')).review.requests.draft, 2);
const status = JSON.parse(readFileSync(path.join(success.campaign, 'controller-status.json'))); assert.equal(status.unit, 'pages'); assert.equal(status.state, 'completed'); assert.equal(status.counts.completed, 2); assert(!existsSync(path.join(success.campaign, 'controller.lock')));
for (const row of calls) assert(!existsSync(row.workspace));
console.log('PASS explicit per-page continuation, separate fresh reviewer, successful-draft reuse and once-per-page apply');

const failed = fixture('failed-review'), rejected = failed.run(true); assert.equal(rejected.status, 1); assert.deepEqual(JSON.parse(readFileSync(failed.record)), failed.locale); assert.equal(failed.calls().filter(row => row.review).length, 2);
assert.equal(JSON.parse(readFileSync(path.join(failed.campaign, 'controller-status.json'))).counts.held, 2); assert(!existsSync(path.join(failed.campaign, 'fr/01/accepted.json')));
const beforeReplay = failed.calls().length, replay = failed.run(true); assert.equal(replay.status, 1); assert.equal(failed.calls().length, beforeReplay);
const otherCampaign = mkdtempSync(path.join(tmpdir(), 'scirepl-tutorial-translation-section-offline-duplicate-'));
const duplicateArgs = [...failed.args]; duplicateArgs[duplicateArgs.indexOf('--campaign') + 1] = otherCampaign;
const duplicate = spawnSync(process.execPath, [...duplicateArgs, '--execute'], { cwd: failed.root, env: failed.env, encoding: 'utf8' });
assert.equal(duplicate.status, 1); assert.equal(failed.calls().length, beforeReplay); assert(!existsSync(path.join(otherCampaign, 'controller.lock')));
console.log('PASS failed envelopes do not apply; both page-local holds are preserved and cannot replay');

for (const mode of ['wrong-id', 'invalid-review', 'write-file', 'drift']) {
  const test = fixture(mode), result = test.run(true); assert.equal(result.status, 1, mode);
  assert.equal(JSON.parse(readFileSync(test.record)).translations['alpha.one'], undefined, mode + ' must not apply alpha');
  assert(!existsSync(path.join(test.campaign, 'controller.lock')));
}
console.log('PASS conversation mismatch, invalid numeric output, worker writes and source drift all hold');

const hanging = fixture('hang');
const controller = spawn(process.execPath, [...hanging.args, '--execute'], { cwd: hanging.root, env: hanging.env, stdio: ['ignore', 'pipe', 'pipe'] });
const finished = new Promise((resolve, reject) => { controller.on('error', reject); controller.on('close', (code, signal) => resolve({ code, signal })); });
try {
  let children = [], deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    children = ['01', '02'].map(index => path.join(hanging.campaign, 'fr', index, 'draft-01.child.json')).filter(existsSync).map(file => JSON.parse(readFileSync(file)).pid);
    if (children.length === 2) break; await sleep(25);
  }
  assert.equal(children.length, 2); controller.kill('SIGTERM'); const result = await finished; assert.equal(result.code, 143); assert.equal(result.signal, null);
  for (const pid of children) assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH');
  assert.deepEqual(JSON.parse(readFileSync(hanging.record)), hanging.locale); assert(!existsSync(path.join(hanging.campaign, 'controller.lock')));
  const slots = path.join(hanging.temporary, 'scirepl-example-gemini-slots'); assert(!readdirSync(slots).some(name => name.startsWith('slot-')));
} finally { if (controller.exitCode === null && controller.signalCode === null) controller.kill('SIGTERM'); await finished; }
console.log('PASS cancellation drains only owned fake children and releases isolated slots before exit');

const long = fixture();
const longManifest = JSON.parse(readFileSync(long.plan.manifestFile.file)), longPage = longManifest.pages[0], sourceFile = long.plan.sources[0].file;
let html = readFileSync(sourceFile, 'utf8').replace('</body></html>', '');
for (let index = 0; index < 5; index++) {
  const text = 'Additional explanatory prose. '.repeat(430), prefix = '<h2>More explanation</h2><p>';
  const start = html.length + prefix.length, id = 'alpha.additional.' + String.fromCharCode(97 + index);
  const field = { id, text, start, end: start + text.length, kind: 'html-text', tag: 'p', protectedSpans: [] };
  html += prefix + text + '</p>'; longPage.fields.push(field);
  const request = { schema: 1, locale: 'fr', sourceLocale: 'en', manifestHash: longManifest.manifestHash, route: 'alpha', sectionId: id, fields: [field] };
  long.plan.locales[0].pages[0].sections.push({ id, heading: 'More explanation', sourceStart: start, sourceEnd: field.end, sourceChars: text.length, fieldIds: [id], request, requestHash: sha(JSON.stringify(request)) });
}
html += '</body></html>'; writeFileSync(sourceFile, html); longPage.sourceHash = sha(html); long.plan.sources[0].sha256 = sha(html);
writeFileSync(long.plan.manifestFile.file, JSON.stringify(longManifest)); long.plan.manifestFile.sha256 = sha(readFileSync(long.plan.manifestFile.file));
delete long.plan.planHash; long.plan.planHash = sha(JSON.stringify(long.plan)); writeFileSync(long.planFile, JSON.stringify(long.plan));
const longResult = long.run(true); assert.equal(longResult.status, 0, longResult.stderr);
const reviews = long.calls().filter(row => row.route === 'alpha' && row.review), drafts = long.calls().filter(row => row.route === 'alpha' && !row.review);
assert(reviews.length > 1, 'Oversized pages must use coherent reviewer turns');
assert.equal(new Set(reviews.map(row => row.id)).size, 1); assert.equal(reviews[0].resumed, false); assert(reviews.slice(1).every(row => row.resumed));
assert.notEqual(reviews[0].id, drafts[0].id); assert.equal(new Set(reviews.map(row => row.workspace)).size, 1);
assert.equal(JSON.parse(readFileSync(long.record)).receipts.length, 3, 'A multi-turn reviewed page still applies once');
console.log('PASS oversized-page review retains one fresh reviewer conversation across bounded coherent turns');

const recovered = authorizeRecovery(fixture());
const recoveryPrepared = recovered.run(false); assert.equal(recoveryPrepared.status, 0, recoveryPrepared.stderr);
assert.deepEqual(JSON.parse(recoveryPrepared.stdout).recovery.bounds, { pages: 2, maxDraftCalls: 3, maxReviewCalls: 2 }); assert.equal(recovered.calls().length, 0);
const recoveryResult = recovered.run(true); assert.equal(recoveryResult.status, 0, recoveryResult.stderr); assert.equal(recovered.calls().length, 5);
const recoveryStatus = JSON.parse(readFileSync(path.join(recovered.campaign, 'controller-status.json')));
assert.deepEqual(recoveryStatus.recovery.dispatchedCalls, { draft: 3, review: 2 });
for (const row of recovered.calls().filter(row => row.review)) { assert(row.explicitKeepReview && row.exactNumericReview); assert(row.reviewFields.every(field => typeof field.sourceAllowsReviewedKeep === 'boolean' && Array.isArray(field.unprotectedNumericSequence))); }
const recoveryBeforeReplay = recovered.calls().length, recoveryReplay = recovered.run(true); assert.equal(recoveryReplay.status, 1); assert.equal(recovered.calls().length, recoveryBeforeReplay);
console.log('PASS bounded recovery validates exact caps, charges each dispatch and remains single-use');

for (const mutate of [
  plan => { plan.recovery.bounds.pages++; },
  plan => { plan.recovery.bounds.maxDraftCalls--; },
  plan => { plan.recovery.bounds.maxReviewCalls++; },
  plan => { plan.locales[0].pages[0].recovery.maxDraftCalls = 0; },
  plan => { plan.locales[0].pages[0].recovery.maxReviewCalls++; },
  plan => { delete plan.locales[0].pages[0].recovery.priorConversationIds; },
  plan => { plan.recovery.sourcePlanHash = '0'.repeat(64); },
  plan => { delete plan.recovery.acceptedBaseline.fr['alpha.accepted']; },
  plan => { delete plan.recovery; },
]) {
  const invalid = authorizeRecovery(fixture()); mutate(invalid.plan); rewritePlan(invalid);
  assert.equal(invalid.run(true).status, 1); assert.equal(invalid.calls().length, 0);
  assert(!existsSync(path.join(invalid.temporary, 'scirepl-tutorial-section-claims'))); assert.deepEqual(JSON.parse(readFileSync(invalid.record)), invalid.locale);
}
console.log('PASS invalid global/page recovery bounds, missing identity evidence and source mismatch reject before claims or dispatch');

const consumedRecovery = authorizeRecovery(fixture('failed-review')), consumedResult = consumedRecovery.run(true);
assert.equal(consumedResult.status, 1); assert.deepEqual(JSON.parse(readFileSync(consumedRecovery.record)), consumedRecovery.locale);
const consumedStatus = JSON.parse(readFileSync(path.join(consumedRecovery.campaign, 'controller-status.json')));
assert.deepEqual(consumedStatus.recovery.dispatchedCalls, { draft: 3, review: 2 }); assert.equal(consumedStatus.counts.held, 2);
assert(consumedStatus.phases.filter(row => row.phase.startsWith('review-')).every(row => row.state === 'held'), 'Caught provider failures must not remain running');
assert.equal(consumedRecovery.calls().length, 5); assert.equal(consumedRecovery.run(true).status, 1); assert.equal(consumedRecovery.calls().length, 5);
consumedRecovery.plan.auditNote = 'Different derived plan hash must not authorize another source recovery generation'; rewritePlan(consumedRecovery);
const alternateCampaign = mkdtempSync(path.join(tmpdir(), 'scirepl-tutorial-translation-section-offline-recovery-alternate-'));
const alternateArgs = [...consumedRecovery.args]; alternateArgs[alternateArgs.indexOf('--campaign') + 1] = alternateCampaign;
const alternate = spawnSync(process.execPath, [...alternateArgs, '--execute'], { cwd: consumedRecovery.root, env: consumedRecovery.env, encoding: 'utf8' });
assert.equal(alternate.status, 1); assert.equal(consumedRecovery.calls().length, 5); assert(!existsSync(path.join(alternateCampaign, 'controller.lock')));
console.log('PASS failed provider calls consume recovery budgets, never auto-retry or apply, and publish held phase states');

const seedOnly = authorizeRecovery(fixture(), { seedOnly: true }), seedOnlyResult = seedOnly.run(true);
assert.equal(seedOnlyResult.status, 0, seedOnlyResult.stderr); assert.equal(seedOnly.calls().filter(row => row.route === 'alpha' && !row.review).length, 0);
assert.equal(seedOnly.calls().filter(row => row.route === 'alpha' && row.review).length, 1);
assert(seedOnly.calls().filter(row => row.route === 'alpha').every(row => !row.resumed));
const oldReviewer = authorizeRecovery(fixture('prior-id'), { seedOnly: true }); assert.equal(oldReviewer.run(true).status, 1);
assert.equal(JSON.parse(readFileSync(oldReviewer.record)).translations['alpha.one'], undefined);
console.log('PASS seed-only recovery never regenerates drafts and rejects historical reviewer identity reuse');

for (const mode of ['evidence-drift', 'helper-drift']) {
  const drift = authorizeRecovery(fixture(mode)); assert.equal(drift.run(true).status, 1);
  assert.equal(JSON.parse(readFileSync(drift.record)).translations['alpha.one'], undefined);
  assert(!drift.calls().some(row => row.review), 'Pinned recovery evidence/helper drift stops before review dispatch');
}
console.log('PASS immutable campaign evidence and recovery helper pins are rechecked after dispatch and before apply');

const kept = authorizeRecovery(fixture('label-keep')); assert.equal(kept.run(true).status, 0);
const keptRecord = JSON.parse(readFileSync(kept.record)); assert.equal(keptRecord.translations['alpha.one'], 'Name');
assert(keptRecord.receipts.find(row => row.fields.includes('alpha.one')).review.keptFields['alpha.one'].length >= 12);
assert.equal(kept.calls().find(row => row.review && row.route === 'alpha').reviewFields.find(field => field.id === 'alpha.one').sourceAllowsReviewedKeep, true);
const missingKeep = authorizeRecovery(fixture('missing-label-keep')); assert.equal(missingKeep.run(true).status, 1);
assert.equal(JSON.parse(readFileSync(missingKeep.record)).translations['alpha.one'], undefined, 'Eligibility metadata must not automatically sanction an unchanged label');
console.log('PASS review prompts expose source eligibility but unchanged labels still require independent model-supplied reviewed reasons');
for (const mode of ['numeric-order', 'numeric-script']) {
  const numeric = authorizeRecovery(fixture(mode)); assert.equal(numeric.run(true).status, 1);
  assert.equal(JSON.parse(readFileSync(numeric.record)).translations['alpha.one'], undefined);
  assert.deepEqual(numeric.calls().find(row => row.review && row.route === 'alpha').reviewFields.find(field => field.id === 'alpha.one').unprotectedNumericSequence, ['2', '10']);
}
console.log('PASS exact numeric source sequence metadata never weakens ordering or digit-script validation');

// Stuck after complete output, but the goroutine dump shows shutdown without
// the title-generation blocker: no known safe signature, so it stays held.
const SENTINEL = 'PRIVATE_PROMPT_RESPONSE_SENTINEL_7731';
const stuckTest = fixture('stuck-after-complete', { stackSignature: 'none', logSentinel: SENTINEL }); stuckTest.env.SCIREPL_TRANSLATION_POST_COMPLETION_GRACE_SECONDS = '1';
const stuckResult = stuckTest.run(true); assert.equal(stuckResult.status, 1, stuckResult.stderr);
assert.equal(stuckTest.calls().filter(row => row.review).length, 2, 'A stuck worker is never retried automatically');
assert.equal(JSON.parse(readFileSync(stuckTest.record)).translations['alpha.one'], undefined, 'Complete-looking output from a stopped worker without the title-generation signature is never accepted');
assert(!existsSync(path.join(stuckTest.campaign, 'fr/01/accepted.json')));
const stuckTransport = JSON.parse(readFileSync(path.join(stuckTest.campaign, 'fr/01/review-01.transport.json')));
assert.equal(stuckTransport.stuckAfterCompleteOutput, true); assert.equal(stuckTransport.cancelled, false); assert.equal(stuckTransport.exitCode, 2);
assert.equal(stuckTransport.stuckTerminationSignal, 'SIGQUIT'); assert.equal(stuckTransport.stackRequestedBy, 'controller'); assert.equal(stuckTransport.knownSignature, null);
assert.equal(stuckTransport.postCompletionGraceSeconds, 1);
const stuckSummary = JSON.parse(readFileSync(stuckTransport.stackSummaryPath, 'utf8'));
assert.equal(stuckSummary.found, true); assert.deepEqual(stuckSummary.main.frames, ['background.(*Pool).close', 'cortex.(*backgroundRunner).CancelAndWait', 'cortex.(*CascadeManager).Shutdown', 'main.main']);
assert(!readFileSync(stuckTransport.stackSummaryPath, 'utf8').includes(SENTINEL), 'Stack summaries never keep frame arguments');
assert.equal(JSON.parse(readFileSync(path.join(stuckTest.campaign, 'fr/01/review-01.dispatched.json'))).agyLogPath, path.join(stuckTest.campaign, 'fr/01/review-01.agy.log'));
assert(existsSync(path.join(stuckTest.campaign, 'fr/01/review-01.agy.log')), 'Each worker gets its own --log-file');
assert(Date.parse(stuckTransport.stuckTerminatedAt) >= Date.parse(stuckTransport.completeOutputAt) + 900);
assert.match(JSON.parse(readFileSync(path.join(stuckTest.campaign, 'fr/01/failed.json'))).error, /stuck after complete output/);
const stuckStatus = JSON.parse(readFileSync(path.join(stuckTest.campaign, 'controller-status.json')));
const stuckRow = stuckStatus.phases.find(row => row.chunk === '01' && row.phase === 'review-01');
assert.equal(stuckRow.state, 'held'); assert.equal(stuckRow.stuckAfterCompleteOutput, true); assert.equal(stuckStatus.state, 'held');
assert.throws(() => process.kill(JSON.parse(readFileSync(path.join(stuckTest.campaign, 'fr/01/review-01.child.json'))).pid, 0), error => error.code === 'ESRCH');
assert(!existsSync(path.join(stuckTest.campaign, 'controller.lock')));
console.log('PASS a worker that never exits after a complete envelope is dumped (SIGQUIT) after the grace, recorded as stuck-after-completion and held without a known signature');

// Same, but the dump proves the worker only waited for conversation-title
// generation: the complete output passes every unchanged gate and is accepted,
// flagged for optional manual review.
const titleHang = fixture('stuck-after-complete', { stackSignature: 'title', logSentinel: SENTINEL }); titleHang.env.SCIREPL_TRANSLATION_POST_COMPLETION_GRACE_SECONDS = '1';
const titleResult = titleHang.run(true); assert.equal(titleResult.status, 0, titleResult.stderr);
assert.equal(titleHang.calls().filter(row => row.review).length, 2, 'Accepting held output never adds calls');
const titleRecord = JSON.parse(readFileSync(titleHang.record));
assert.equal(titleRecord.translations['alpha.one'], 'Texte traduit : First prose.');
const titleReceipt = titleRecord.receipts.find(row => row.fields.includes('alpha.one'));
assert.equal(titleReceipt.review.manualReviewSuggested, true); assert.equal(titleReceipt.review.outcome, 'accepted-after-stuck-worker');
assert.deepEqual(titleReceipt.review.manualReviewFields, ['alpha.one', 'alpha.seed', 'alpha.two']);
assert.deepEqual(titleReceipt.review.stuckWorkerAcceptances, [{ phase: 'review-01', outcome: 'accepted-after-stuck-worker', knownSignature: 'title-generation-hang', fields: 3 }]);
const titleTransport = JSON.parse(readFileSync(path.join(titleHang.campaign, 'fr/01/review-01.transport.json')));
assert.equal(titleTransport.knownSignature, 'title-generation-hang'); assert.equal(titleTransport.stuckAfterCompleteOutput, true);
const titleRow = JSON.parse(readFileSync(path.join(titleHang.campaign, 'controller-status.json'))).phases.find(row => row.chunk === '01' && row.phase === 'review-01');
assert.equal(titleRow.state, 'completed'); assert.equal(titleRow.outcome, 'accepted-after-stuck-worker'); assert.equal(titleRow.manualReviewSuggested, true);
assert.equal(titleRow.completeOutput, true); assert.equal(titleRow.completeOutputSummary.status, 'SUCCESS'); assert.equal(titleRow.completeOutputSummary.durationSeconds, 1);
assert(!readFileSync(path.join(titleHang.campaign, 'controller-status.json'), 'utf8').includes('Texte traduit'), 'Phase status never carries response text');
const { inspectLocaleRecord } = await import(pathToFileURL(path.join(titleHang.root, 'scripts/tutorial_locale_status.mjs')).href);
const titleStatus = inspectLocaleRecord(JSON.parse(readFileSync(titleHang.plan.manifestFile.file)), 'fr', titleRecord);
assert.deepEqual(titleStatus.manualReviewSuggested, ['alpha.one', 'alpha.two', 'alpha.seed', 'beta.one']); assert.deepEqual(titleStatus.unreviewed, []);
console.log('PASS a stuck worker whose dump shows only the title-generation hang is accepted through the unchanged gates and flagged for manual review');

const descendant = fixture('stuck-with-descendant'); descendant.env.SCIREPL_TRANSLATION_POST_COMPLETION_GRACE_SECONDS = '1';
try {
  const descendantResult = descendant.run(true); assert.equal(descendantResult.status, 1, descendantResult.stderr);
  const transport = JSON.parse(readFileSync(path.join(descendant.campaign, 'fr/01/review-01.transport.json')));
  assert.equal(transport.stuckAfterCompleteOutput, true); assert.equal(JSON.parse(readFileSync(descendant.record)).translations['alpha.one'], undefined);
  assert(!existsSync(path.join(descendant.campaign, 'controller.lock')));
} finally {
  // Only the fixture's own helper processes, by recorded PID.
  for (const pid of readFileSync(path.join(descendant.root, 'fake-descendants.txt'), 'utf8').trim().split('\n').map(Number)) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
}
console.log('PASS a stopped stuck worker whose descendant holds its pipes still settles and is held');

const slow = fixture('slow-complete'); slow.env.SCIREPL_TRANSLATION_POST_COMPLETION_GRACE_SECONDS = '1';
const slowResult = slow.run(true); assert.equal(slowResult.status, 0, slowResult.stderr);
const slowTransport = JSON.parse(readFileSync(path.join(slow.campaign, 'fr/01/review-01.transport.json')));
assert.equal(slowTransport.stuckAfterCompleteOutput, undefined); assert.equal(slowTransport.exitCode, 0);
assert.equal(JSON.parse(readFileSync(slow.record)).translations['alpha.one'], 'Texte traduit : First prose.');
const expectedPath = [...new Set([path.dirname(process.execPath), path.dirname(slow.fake), '/usr/local/bin', '/usr/bin', '/bin'])].join(':');
assert(slow.calls().every(row => row.workerPath === expectedPath), 'Workers receive the fixed sane PATH');
assert.equal(JSON.parse(readFileSync(path.join(slow.campaign, 'fr/01/review-01.dispatched.json'))).workerPath, expectedPath);
console.log('PASS incomplete output longer than the grace is never stopped; workers get a fixed recorded PATH');
console.log('Section controller: 17 offline groups passed; no provider requests or production writes.');
