// Offline only: synthetic stopped continuation, fixture-only queue and fake CLI.
// A NEW user-approved review allowance follows a held page without extending the
// exhausted source lineage, never drafts, and cannot exceed its pinned ceiling.
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { ROOT, sha } from '../scripts/tutorial_locale_lib.mjs';
import { prepareSectionReviewAllowancePlan } from '../scripts/tutorial_section_review_allowance_plan.mjs';
import { deadCorrectionOwner } from './fixtures/tutorial_section_correction_fixture.mjs';
import { continuationFixture } from './fixtures/tutorial_section_review_continuation_fixture.mjs';

let passed = 0;
const check = async (name, body) => { await body(); passed++; console.log('PASS ' + name); };
const setMode = (f, mode) => { const file = path.join(f.root, 'fake-config.json'); f.write(file, { ...f.read(file), mode }); };

// Wrap a finished controller run in the durable-owner job record shape.
function jobFor(f, { planFile, campaign, state = 'held' }) {
  const job = mkdtempSync(path.join(tmpdir(), 'scirepl-tutorial-translation-job-allowance-fixture-'));
  const planPin = { file: planFile, sha256: sha(readFileSync(planFile)) };
  f.write(path.join(job, 'config.json'), { schema: 1, root: f.root, job, campaign, sectionsPlan: planFile, nonce: deadCorrectionOwner.nonce,
    pins: [{ file: planPin.file, hash: planPin.sha256 }] });
  f.write(path.join(job, 'owner.json'), deadCorrectionOwner); f.write(path.join(job, 'controller.json'), deadCorrectionOwner);
  f.write(path.join(job, 'result.json'), { state, exitCode: state === 'held' ? 1 : 143, finishedAt: '2026-10-17T20:00:00Z' });
  return job;
}
function heldContinuation() {
  const f = continuationFixture({ mode: 'failed-review' });
  copyFileSync(path.join(ROOT, 'scripts/tutorial_section_review_allowance_plan.mjs'), path.join(f.root, 'scripts/tutorial_section_review_allowance_plan.mjs'));
  const held = f.run(true); assert.equal(held.status, 1, held.stderr);
  const sourceJob = jobFor(f, { planFile: f.planFile, campaign: f.campaign });
  const page = f.plan.locales.find(locale => locale.pages.length);
  const approval = (overrides = {}) => f.write(path.join(f.root, 'approval-' + Math.random().toString(16).slice(2) + '.json'), { schema: 1, kind: 'user-approved-review-allowance',
    allowanceId: 'offline-fixture-allowance-01', approvedBy: 'offline fixture owner', approvedAt: '2026-10-17T21:00:00Z', maxDraftCalls: 0, maxReviewCalls: 2,
    scope: [{ locale: page.locale, route: page.pages[0].route }], originSourceJob: sourceJob, automaticRetries: false, ...overrides });
  return { f, sourceJob, approval, scope: { locale: page.locale, route: page.pages[0].route } };
}
function execute(f, plan) {
  const planFile = path.join(f.root, 'allowance-plan-' + plan.planHash.slice(0, 12) + '.json'); f.write(planFile, plan);
  const campaign = mkdtempSync(path.join(tmpdir(), 'scirepl-tutorial-translation-allowance-offline-'));
  const result = spawnSync(process.execPath, [path.join(f.root, 'scripts/run_tutorial_section_translations.mjs'), '--plan', planFile, '--campaign', campaign, '--execute'], { cwd: f.root, env: f.env, encoding: 'utf8', timeout: 30000 });
  return { result, planFile, campaign, status: () => f.read(path.join(campaign, 'controller-status.json')) };
}

await check('first generation follows the exact stopped job, never drafts, and records a new explicit lineage', () => {
  const { f, sourceJob, approval, scope } = heldContinuation(), approved = approval();
  const before = f.calls().length, plan = prepareSectionReviewAllowancePlan({ root: f.root, sourceJob, allowanceFile: approved.file });
  assert.equal(plan.recovery.kind, 'explicit-approved-review-allowance'); assert.deepEqual(plan.recovery.bounds, { pages: 1, maxDraftCalls: 0, maxReviewCalls: 1 });
  assert.deepEqual(plan.recovery.allowance, approved); assert.equal(plan.recovery.reviewBudgetLineage.priorAllowanceCharged, 0);
  assert.equal(plan.recovery.reviewBudgetLineage.allowanceMaximum, 2); assert.equal(plan.recovery.reviewBudgetLineage.sourceKind, 'explicit-never-dispatched-review-continuation');
  const priorReviewer = f.calls().find(row => row.review).id;
  assert(plan.locales.flatMap(locale => locale.pages).every(page => page.recovery.priorConversationIds.includes(priorReviewer)), 'Held reviewer identity is excluded');
  setMode(f, 'success'); const run = execute(f, plan); assert.equal(run.result.status, 0, run.result.stderr);
  const calls = f.calls().slice(before); assert.equal(calls.length, 1); assert(calls[0].review); assert.notEqual(calls[0].id, priorReviewer);
  const record = f.read(f.recordFiles[scope.locale]), receipt = record.receipts.at(-1).review;
  assert.equal(receipt.source, 'explicit-approved-review-allowance'); assert.equal(receipt.allowanceId, 'offline-fixture-allowance-01'); assert.equal(receipt.requests.draft, 0);
  const budget = run.status().recoveryBudget; assert.equal(budget.allowanceUsedReviewCalls, 1); assert.equal(budget.allowanceMaxReviewCalls, 2);
});

await check('a failed attempt consumes the allowance; one later generation may spend the remainder, never more', () => {
  const { f, sourceJob, approval } = heldContinuation(), approved = approval();
  const first = prepareSectionReviewAllowancePlan({ root: f.root, sourceJob, allowanceFile: approved.file });
  const run1 = execute(f, first); assert.equal(run1.result.status, 1); assert.equal(run1.status().recoveryBudget.allowanceUsedReviewCalls, 1);
  const job1 = jobFor(f, { planFile: run1.planFile, campaign: run1.campaign });
  const second = prepareSectionReviewAllowancePlan({ root: f.root, sourceJob: job1, allowanceFile: approved.file });
  assert.equal(second.recovery.reviewBudgetLineage.priorAllowanceCharged, 1); assert.equal(second.recovery.reviewBudgetLineage.remainingBeforeThisPlan, 1);
  const run2 = execute(f, second); assert.equal(run2.result.status, 1); assert.equal(run2.status().recoveryBudget.allowanceUsedReviewCalls, 2);
  const job2 = jobFor(f, { planFile: run2.planFile, campaign: run2.campaign });
  assert.throws(() => prepareSectionReviewAllowancePlan({ root: f.root, sourceJob: job2, allowanceFile: approved.file }), /exhausted/);
  // A different approval cannot be spliced into the same lineage to reset it.
  assert.throws(() => prepareSectionReviewAllowancePlan({ root: f.root, sourceJob: job2, allowanceFile: approval({ maxReviewCalls: 5 }).file }), /same pinned approval/);
});

await check('scope, origin, drafting and retry flags in the approval are strict', () => {
  const { f, sourceJob, approval, scope } = heldContinuation();
  for (const overrides of [{ scope: [{ locale: scope.locale, route: 'other/route' }] }, { scope: [] }, { originSourceJob: '/tmp/scirepl-tutorial-translation-job-other' },
    { maxDraftCalls: 1 }, { maxReviewCalls: 0 }, { automaticRetries: true }, { approvedBy: '' }]) {
    assert.throws(() => prepareSectionReviewAllowancePlan({ root: f.root, sourceJob, allowanceFile: approval(overrides).file }));
  }
  const tight = prepareSectionReviewAllowancePlan({ root: f.root, sourceJob, allowanceFile: approval({ maxReviewCalls: 1 }).file });
  assert.equal(tight.recovery.bounds.maxReviewCalls, 1);
});

await check('tampered approval, budget or plan is rejected before claims or dispatch', () => {
  const { f, sourceJob, approval } = heldContinuation(), approved = approval();
  const plan = prepareSectionReviewAllowancePlan({ root: f.root, sourceJob, allowanceFile: approved.file });
  setMode(f, 'success');
  for (const mutate of [p => { p.recovery.reviewBudgetLineage.allowanceMaximum = 9; }, p => { p.recovery.bounds.maxReviewCalls++; }, p => { p.recovery.dispatchPolicy.minimumDispatchGapMs = 0; }]) {
    const copy = structuredClone(plan); mutate(copy); delete copy.planHash; copy.planHash = sha(JSON.stringify(copy));
    const before = f.calls().length, run = execute(f, copy); assert.equal(run.result.status, 1); assert.equal(f.calls().length, before);
  }
  f.write(approved.file, readFileSync(approved.file, 'utf8') + '\n');
  const before = f.calls().length, run = execute(f, plan); assert.equal(run.result.status, 1); assert.equal(f.calls().length, before);
  assert(!existsSync(path.join(run.campaign, 'controller.lock')));
});

console.log(`Approved review allowance: ${passed} offline groups passed; no provider requests or production writes.`);
