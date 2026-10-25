// Only synthetic histories, an isolated queue, and an offline fake provider.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { sha } from '../scripts/tutorial_locale_lib.mjs';
import { correctionFixture } from './fixtures/tutorial_section_correction_fixture.mjs';

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log('PASS ' + name); };
const rewrite = f => { delete f.plan.planHash; f.plan.planHash = sha(JSON.stringify(f.plan)); f.write(f.planFile, f.plan); };
const baseline = f => Object.fromEntries(Object.entries(f.recordFiles).map(([locale, file]) => [locale, f.read(file).translations]));

check('prepare-only independently reconstructs evidence without claims or calls', () => {
  const f = correctionFixture(), before = baseline(f), result = f.run(false);
  assert.equal(result.status, 0, result.stderr); const info = JSON.parse(result.stdout);
  assert.equal(info.draftTurns, 0); assert.equal(info.preservedReviewFields, f.parts[0].length);
  assert.equal(info.recovery.bounds.maxReviewCalls, 1); assert.equal(f.calls().length, 0);
  assert.deepEqual(baseline(f), before); assert(!existsSync(path.join(f.temporary, 'scirepl-tutorial-section-claims')));
});
check('one fresh review accepts the whole page while preserving earlier independent reviews', () => {
  const f = correctionFixture(), before = baseline(f), result = f.run(true);
  assert.equal(result.status, 0, result.stderr); const calls = f.calls(); assert.equal(calls.length, 1); assert(calls[0].review);
  const preserved = new Set(f.parts[0].map(field => field.id)); assert(calls[0].fieldIds.every(id => !preserved.has(id)));
  assert(!['fixture-legacy-draft', 'fixture-current-draft', 'fixture-current-review'].includes(calls[0].id));
  const current = f.read(f.recordFiles.fr), receipt = current.receipts.at(-1).review;
  for (const [locale, values] of Object.entries(before)) for (const [id, value] of Object.entries(values)) assert.equal(f.read(f.recordFiles[locale]).translations[id], value);
  for (const [id, value] of Object.entries(f.savedReview.translations)) assert.equal(current.translations[id], value);
  assert.equal(receipt.requests.draft, 0); assert.equal(receipt.requests.freshReview, 1);
  assert.equal(receipt.preservedReviewFields, preserved.size); assert.equal(receipt.explicitBoundedCorrection, true);
  assert.equal(receipt.nativeLanguageReview, 'pending'); assert(!JSON.stringify(current).includes('POISONED_FAILED_PHASE_VALUE'));
  const status = f.read(path.join(f.campaign, 'controller-status.json'));
  assert.equal(status.state, 'completed'); assert.equal(status.recoveryBudget.usedDraftCalls, 0); assert.equal(status.recoveryBudget.usedReviewCalls, 1);
  const dispatched = f.read(path.join(f.campaign, 'fr/01/review-01.dispatched.json'));
  assert.deepEqual(dispatched.dispatchPolicy, { maxConcurrent: 2, minimumDispatchGapMs: 15000 });
  assert(Number.isFinite(Date.parse(dispatched.dispatchedAt)));
});
check('failed provider or validation consumes its call but never applies or retries', () => {
  for (const mode of ['failed-review', 'invalid-review']) {
    const f = correctionFixture({ mode }), before = baseline(f), result = f.run(true);
    assert.equal(result.status, 1); assert.equal(f.calls().length, 1); assert.deepEqual(baseline(f), before);
    const status = f.read(path.join(f.campaign, 'controller-status.json'));
    assert.equal(status.state, 'held'); assert.equal(status.recoveryBudget.usedReviewCalls, 1);
    assert(!existsSync(path.join(f.campaign, 'fr/01/accepted.json')));
    assert.equal(f.run(true).status, 1); assert.equal(f.calls().length, 1);
  }
});
check('changing derived evidence hashes never frees a second correction generation', () => {
  const f = correctionFixture({ mode: 'failed-review' }); assert.equal(f.run(true).status, 1);
  const configFile = path.join(f.sourceJob, 'config.json'); f.write(configFile, readFileSync(configFile, 'utf8') + '\n');
  f.plan = f.prepare(); f.write(f.planFile, f.plan);
  const campaign = mkdtempSync(path.join(tmpdir(), 'scirepl-tutorial-translation-correction-duplicate-'));
  const args = [...f.args]; args[args.indexOf('--campaign') + 1] = campaign;
  const result = spawnSync(process.execPath, [...args, '--execute'], { cwd: f.root, env: f.env, encoding: 'utf8' });
  assert.equal(result.status, 1); assert.equal(f.calls().length, 1); assert(!existsSync(path.join(campaign, 'controller.lock')));
});
check('changed caps partitions seeds or rate policy reject before any claim or dispatch', () => {
  for (const mutate of [
    plan => { plan.recovery.bounds.maxReviewCalls++; },
    plan => { plan.locales.find(locale => locale.pages.length).pages[0].correctionReviews[0].fieldIds.pop(); },
    plan => { const seed = plan.locales.find(locale => locale.pages.length).pages[0].reviewSeeds[0]; seed.translations[seed.fieldIds[0]] = 'Une modification non autorisée.'; },
    plan => { plan.recovery.dispatchPolicy.minimumDispatchGapMs = 0; },
  ]) {
    const f = correctionFixture(); mutate(f.plan); rewrite(f); assert.equal(f.run(true).status, 1);
    assert.equal(f.calls().length, 0); assert(!existsSync(path.join(f.temporary, 'scirepl-tutorial-section-claims')));
  }
});
check('preserved review evidence helper pins and accepted values are rechecked before apply', () => {
  for (const mode of ['correction-evidence-drift', 'correction-helper-drift', 'correction-baseline-drift']) {
    const f = correctionFixture({ mode }), config = f.read(path.join(f.root, 'fake-config.json'));
    config.evidenceFile = path.join(f.alphaDir, 'review-01.proposal.json'); config.helperFile = path.join(f.root, 'scripts/tutorial_section_protocol.mjs'); config.baselineFile = f.recordFiles.de;
    f.write(path.join(f.root, 'fake-config.json'), config);
    assert.equal(f.run(true).status, 1); assert.equal(f.calls().length, 1);
    const current = f.read(f.recordFiles.fr).translations;
    assert(f.pending.every(field => !Object.hasOwn(current, field.id)));
    assert(!existsSync(path.join(f.campaign, 'fr/01/accepted.json')));
  }
});
console.log(`Correction controller: ${passed} offline groups passed; no production requests or writes.`);
