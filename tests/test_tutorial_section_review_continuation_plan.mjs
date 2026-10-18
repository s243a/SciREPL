// Synthetic histories only; preparation never calls a provider or writes.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, lstatSync } from 'node:fs';
import path from 'node:path';
import { sha } from '../scripts/tutorial_locale_lib.mjs';
import { getProcessStartIdentity } from '../scripts/tutorial_translation_queue.mjs';
import { correctionReviewPrompt } from '../scripts/tutorial_section_protocol.mjs';
import { reviewContinuationPlanSummary, splitContinuationReviewSections } from '../scripts/tutorial_section_review_continuation_plan.mjs';
import { continuationFixture } from './fixtures/tutorial_section_review_continuation_fixture.mjs';

let passed = 0;
const check = (name, body) => { body(); passed++; console.log('PASS ' + name); };
const snapshot = root => {
  const rows = [];
  function visit(dir) { for (const name of readdirSync(dir).sort()) { const file = path.join(dir, name), info = lstatSync(file); if (info.isDirectory()) visit(file); else rows.push([file, info.mode & 0o777, sha(readFileSync(file))]); } }
  visit(root); return JSON.stringify(rows);
};
function rejected(mutate, options) {
  const f = continuationFixture({ copyRuntime: false }); mutate(f);
  const before = [snapshot(f.root), snapshot(f.sourceJob), snapshot(f.sourceCampaign)];
  assert.throws(() => f.prepare(options)); assert.deepEqual([snapshot(f.root), snapshot(f.sourceJob), snapshot(f.sourceCampaign)], before);
}
check('preparation is deterministic read-only and carries only the original unused allocation', () => {
  const f = continuationFixture({ copyRuntime: false }), before = [snapshot(f.root), snapshot(f.sourceJob), snapshot(f.sourceCampaign)], p = f.prepare();
  assert.deepEqual(f.prepare(), p); assert.deepEqual([snapshot(f.root), snapshot(f.sourceJob), snapshot(f.sourceCampaign)], before);
  assert.equal(p.recovery.kind, 'explicit-never-dispatched-review-continuation');
  assert.deepEqual(p.recovery.reviewBudgetLineage, { sourceMaximum: 2, sourceCharged: 1, sourceDispatchRecords: 1, maxAdditional: 1, jointMaximum: 2 });
  assert.equal(p.recovery.bounds.maxDraftCalls, 0); assert.equal(p.recovery.bounds.maxReviewCalls, 1); assert.equal(p.recovery.automaticRetries, false);
  assert.deepEqual(p.recovery.dispatchPolicy, { maxConcurrent: 2, minimumDispatchGapMs: 15000 });
  const ids = p.locales.flatMap(locale => locale.pages.flatMap(page => { assert.deepEqual(page.sections, []); assert.deepEqual(page.reviewSeeds, []);
    assert(page.recovery.priorConversationIds.includes('fixture-current-correction-review')); return page.draftSeeds.map(seed => seed.id); }));
  assert.equal(ids.length, f.prepareOptions.expectedRemainingFields); assert.equal(new Set(ids).size, ids.length);
  assert.equal(reviewContinuationPlanSummary(p).pendingReviews, 1); assert(!existsSync(path.join(f.temporary, 'scirepl-tutorial-section-claims')));
});
check('oversized reviews split only between fields and retain the complete original context', () => {
  const f = continuationFixture({ copyRuntime: false }), page = f.sourcePlan.locales.find(locale => locale.pages.length).pages[0];
  const fields = f.manifest.pages[0].fields.slice(0, 3), job = { locale: 'fr', page }, before = JSON.stringify(job);
  const candidates = Object.fromEntries(fields.map(field => [field.id, 'é'.repeat(20000)]));
  assert(Buffer.byteLength(correctionReviewPrompt(job, fields, candidates, true)) > 100000);
  const pieces = splitContinuationReviewSections({ sections: [fields], job, candidates });
  assert(pieces.length > 1); assert.deepEqual(pieces.flatMap(fields => fields.map(field => field.id)), fields.map(field => field.id));
  assert.equal(JSON.stringify(job), before);
  for (const [index, part] of pieces.entries()) assert(Buffer.byteLength(correctionReviewPrompt(job, part, candidates, index === 0)) <= 100000);
});
check('any phase prefix including prompt and partial metadata prevents forward dispatch', () => {
  for (const suffix of ['prompt.txt', 'queued.json', 'dispatched.json', 'child.json', 'transport.json.partial']) rejected(f => f.write(path.join(f.sourceDirectory, f.forbiddenSourcePhase + '.' + suffix), suffix.endsWith('.json') ? {} : 'partial'));
});
check('independent queue history prevents continuation even without local phase records', () => {
  rejected(f => mkdirSync(f.plan.recovery.neverDispatchedPhases[0].queueDirectory, { recursive: true }));
});
check('live source owner or boot-bound worker prevents planning', () => {
  rejected(f => { const file = path.join(f.sourceJob, 'owner.json'); f.write(file, { ...f.read(file), pid: process.pid, startIdentity: getProcessStartIdentity() }); });
  rejected(f => f.write(path.join(f.sourceDirectory, 'review-01.child.json'), { pid: process.pid, startIdentity: getProcessStartIdentity() }));
});
check('charged counts must match actual source dispatch records', () => {
  rejected(f => { const file = path.join(f.sourceCampaign, 'controller-status.json'), status = f.read(file); status.recoveryBudget.usedReviewCalls = 0; f.write(file, status); });
});
check('no increase beyond original unused allocation or five-call policy is allowed', () => { rejected(() => {}, { maxReviewCalls: 6 }); rejected(() => {}, { maxReviewCalls: 0 }); });
check('manual acceptance provenance and all accepted baseline values stay mandatory', () => {
  rejected(() => {}, { manualReceipts: [] });
  rejected(f => { const record = f.read(f.recordFile), receipt = f.read(f.manualReceipts[0].file), id = Object.keys(receipt.translations)[0]; record.translations[id] = 'Modification non autorisée.'; f.write(f.recordFile, record); });
});
check('missing complete independent review provenance cannot be repinned into acceptance', () => {
  rejected(f => {
    const file = f.manualReceipts[0].file, receipt = f.read(file); delete receipt.review.originalMachineReview;
    f.prepareOptions.manualReceipts[0] = f.write(file, receipt); const ledger = f.read(f.recordFile);
    ledger.receipts.find(entry => entry.source === file).review = receipt.review; f.write(f.recordFile, ledger);
  });
});
check('changed original draft source request or frozen English bytes prevent planning', () => {
  rejected(f => { const seed = f.plan.locales.flatMap(locale => locale.pages).flatMap(page => page.draftSeeds)[0]; f.write(seed.source.proposal.file, { translations: {} }); });
  rejected(f => f.write(f.plan.sources[0].file, readFileSync(f.plan.sources[0].file, 'utf8') + ' '));
  rejected(f => f.write(path.join(f.sourceDirectory, 'review-01.prompt.txt'), 'changed source request'));
});
check('a continuation cannot itself supply another continuation generation', () => {
  rejected(f => { const p = f.read(f.sourcePlanFile); p.recovery.kind = 'explicit-never-dispatched-review-continuation'; delete p.planHash; p.planHash = sha(JSON.stringify(p));
    const saved = f.write(f.sourcePlanFile, p), config = f.read(path.join(f.sourceJob, 'config.json')); config.pins.find(pin => pin.file === f.sourcePlanFile).hash = saved.sha256; f.write(path.join(f.sourceJob, 'config.json'), config); });
});
check('expected baseline remaining field count and selected pages cannot drift silently', () => {
  rejected(() => {}, { expectedAcceptedFields: 0 }); rejected(() => {}, { expectedRemainingFields: 0 }); rejected(() => {}, { expectedPages: 2 });
});
console.log(`Untouched review continuation planner: ${passed} isolated groups passed; no provider calls or production writes.`);
