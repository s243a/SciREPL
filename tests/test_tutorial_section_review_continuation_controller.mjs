// Synthetic histories, fixture-only queue leases, and an offline CLI double.
// This suite never reads live campaigns, calls a provider, or edits production.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, mkdirSync, unlinkSync, rmdirSync, mkdtempSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { sha } from '../scripts/tutorial_locale_lib.mjs';
import { getProcessStartIdentity } from '../scripts/tutorial_translation_queue.mjs';
import { continuationFixture } from './fixtures/tutorial_section_review_continuation_fixture.mjs';

let passed = 0;
const check = async (name, body) => { await body(); passed++; console.log('PASS ' + name); };
const baseline = f => Object.fromEntries(f.plan.accepted.map(pin => [pin.locale, pin.sha256 === null ? {} : f.read(pin.file).translations]));
const campaignOf = f => f.args[f.args.indexOf('--campaign') + 1];
const rewrite = f => { delete f.plan.planHash; f.plan.planHash = sha(JSON.stringify(f.plan)); f.write(f.planFile, f.plan); };
const pendingIds = f => f.plan.locales.flatMap(locale => locale.pages.flatMap(page => page.draftSeeds.map(seed => seed.id)));
const queuedFile = f => path.join(campaignOf(f), f.plan.locales.find(locale => locale.pages.length).locale, '01/review-01.queued.json');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

await check('prepare rechecks exact stopped evidence without calls locks or claims', () => {
  const f = continuationFixture(), before = baseline(f), result = f.run(false);
  assert.equal(result.status, 0, result.stderr); const info = JSON.parse(result.stdout);
  assert.equal(info.draftTurns, 0); assert.equal(info.recovery.kind, 'explicit-never-dispatched-review-continuation');
  assert.equal(f.calls().length, 0); assert.deepEqual(baseline(f), before);
  assert(!existsSync(path.join(f.temporary, 'scirepl-tutorial-section-claims')));
  assert(!existsSync(path.join(campaignOf(f), 'controller.lock')));
});

await check('one untouched independent review accepts only pending fields and respects original joint cap', () => {
  const f = continuationFixture(), before = baseline(f), pending = pendingIds(f), result = f.run(true);
  assert.equal(result.status, 0, result.stderr); const calls = f.calls();
  assert.equal(calls.length, 1); assert(calls[0].review); assert.equal(calls[0].resumed, false);
  assert.deepEqual([...calls[0].fieldIds].sort(), [...pending].sort());
  const pendingLocale = f.plan.locales.find(locale => locale.pages.length).locale;
  const currentAccepted = new Set(Object.keys(before[pendingLocale]));
  assert(calls[0].fieldIds.every(id => !currentAccepted.has(id)), 'Already accepted/reviewed fields must not be sent again');
  for (const locale of f.plan.locales) for (const page of locale.pages) assert(!page.recovery.priorConversationIds.includes(calls[0].id));
  for (const [locale, values] of Object.entries(before)) {
    const pin = f.plan.accepted.find(row => row.locale === locale);
    const after = pin.sha256 === null && !existsSync(pin.file) ? {} : f.read(pin.file).translations;
    for (const [id, value] of Object.entries(values)) assert.equal(after[id], value);
  }
  const locale = f.plan.locales.find(row => row.pages.length).locale;
  const record = f.read(f.plan.accepted.find(pin => pin.locale === locale).file), receipt = record.receipts.at(-1).review;
  assert.equal(receipt.requests.draft, 0); assert.equal(receipt.requests.freshReview, 1); assert.equal(receipt.explicitUntouchedContinuation, true);
  assert.equal(receipt.nativeLanguageReview, 'pending'); assert.equal(receipt.source, 'explicit-never-dispatched-review-continuation');
  const status = f.read(path.join(campaignOf(f), 'controller-status.json')), lineage = f.plan.recovery.reviewBudgetLineage;
  assert.equal(status.state, 'completed'); assert.equal(status.recoveryBudget.usedDraftCalls, 0); assert.equal(status.recoveryBudget.usedReviewCalls, 1);
  assert.equal(status.recoveryBudget.sourceUsedReviewCalls, lineage.sourceCharged);
  assert.equal(status.recoveryBudget.jointUsedReviewCalls, lineage.sourceCharged + 1);
  assert.equal(status.recoveryBudget.jointMaxReviewCalls, lineage.sourceMaximum);
  assert(lineage.sourceCharged + 1 <= lineage.sourceMaximum);
  const dispatch = f.read(path.join(campaignOf(f), locale, '01/review-01.dispatched.json'));
  assert.deepEqual(dispatch.dispatchPolicy, { maxConcurrent: 2, minimumDispatchGapMs: 15000 });
});

await check('provider and validation failures consume one call without apply or retry', () => {
  for (const mode of ['failed-review', 'invalid-review']) {
    const f = continuationFixture({ mode }), before = baseline(f), result = f.run(true);
    assert.equal(result.status, 1); assert.equal(f.calls().length, 1); assert.deepEqual(baseline(f), before);
    const status = f.read(path.join(campaignOf(f), 'controller-status.json'));
    assert.equal(status.state, 'held'); assert.equal(status.recoveryBudget.usedReviewCalls, 1);
    assert.equal(status.recoveryBudget.jointUsedReviewCalls, f.plan.recovery.reviewBudgetLineage.sourceCharged + 1);
    assert(!existsSync(path.join(campaignOf(f), 'fr/01/accepted.json')));
    assert.equal(f.run(true).status, 1); assert.equal(f.calls().length, 1);
  }
});

await check('dispatch-record persistence failure stays charged even without a fake provider call', () => {
  const f = continuationFixture(), before = baseline(f);
  // A directory at the new fixture dispatch-record path makes exclusive save
  // fail after charging but before spawn. No original evidence is modified.
  mkdirSync(path.join(campaignOf(f), 'fr/01/review-01.dispatched.json'), { recursive: true });
  assert.equal(f.run(true).status, 1); assert.equal(f.calls().length, 0); assert.deepEqual(baseline(f), before);
  const status = f.read(path.join(campaignOf(f), 'controller-status.json'));
  assert.equal(status.state, 'held'); assert.equal(status.recoveryBudget.usedReviewCalls, 1);
  assert.equal(status.recoveryBudget.jointUsedReviewCalls, f.plan.recovery.reviewBudgetLineage.sourceCharged + 1);
  assert.equal(f.run(true).status, 1); assert.equal(f.calls().length, 0);
});

await check('altering a derived evidence hash cannot free the source-keyed continuation claim', () => {
  const f = continuationFixture({ mode: 'failed-review' }); assert.equal(f.run(true).status, 1);
  const originalHash = f.plan.planHash, config = path.join(f.sourceJob, 'config.json');
  f.write(config, readFileSync(config, 'utf8') + '\n');
  f.plan = f.prepare(); f.write(f.planFile, f.plan); assert.notEqual(f.plan.planHash, originalHash);
  const campaign = mkdtempSync(path.join(tmpdir(), 'scirepl-tutorial-translation-continuation-duplicate-offline-'));
  const args = [...f.args]; args[args.indexOf('--campaign') + 1] = campaign;
  const result = spawnSync(process.execPath, [...args, '--execute'], { cwd: f.root, env: f.env, encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 1); assert.equal(f.calls().length, 1); assert(!existsSync(path.join(campaign, 'controller.lock')));
  const claims = readdirSync(path.join(f.temporary, 'scirepl-tutorial-section-claims', sha(f.root)));
  assert.equal(claims.filter(name => name.startsWith('continuation-')).length, 1);
});

await check('joint bounds source charges partitions and cadence cannot be expanded', () => {
  for (const mutate of [
    plan => { plan.recovery.bounds.maxReviewCalls++; },
    plan => { plan.recovery.reviewBudgetLineage.sourceCharged--; },
    plan => { plan.recovery.reviewBudgetLineage.sourceMaximum++; },
    plan => { plan.recovery.dispatchPolicy.minimumDispatchGapMs = 0; },
    plan => { plan.locales.find(locale => locale.pages.length).pages[0].correctionReviews[0].fieldIds.pop(); },
  ]) {
    const f = continuationFixture(); mutate(f.plan); rewrite(f);
    assert.equal(f.run(true).status, 1); assert.equal(f.calls().length, 0);
    assert(!existsSync(path.join(f.temporary, 'scirepl-tutorial-section-claims')));
  }
});

await check('source history helper source bytes and accepted baseline drift block apply', () => {
  for (const target of ['history', 'helper', 'source', 'baseline']) {
    const mode = target === 'helper' ? 'correction-helper-drift' : target === 'baseline' ? 'correction-baseline-drift' : 'correction-evidence-drift';
    const f = continuationFixture({ mode }), before = baseline(f), configFile = path.join(f.root, 'fake-config.json'), config = f.read(configFile);
    config.helperFile = path.join(f.root, 'scripts/tutorial_section_protocol.mjs');
    config.evidenceFile = target === 'source' ? f.plan.sources[0].file : path.join(f.sourceDirectory, 'failed.json');
    config.baselineFile = f.plan.accepted.find(pin => pin.sha256 !== null && pin.locale !== 'fr').file;
    f.write(configFile, config);
    assert.equal(f.run(true).status, 1); assert.equal(f.calls().length, 1);
    const fr = f.plan.accepted.find(pin => pin.locale === 'fr'), current = f.read(fr.file).translations;
    assert(pendingIds(f).every(id => !Object.hasOwn(current, id)));
    assert.deepEqual(current, before.fr); assert(!existsSync(path.join(campaignOf(f), 'fr/01/accepted.json')));
  }
});

await check('formerly absent source phase appearing during queue wait blocks dispatch', async () => {
  const f = continuationFixture(), queueFile = path.join(f.root, 'scripts/tutorial_translation_queue.mjs');
  const queue = readFileSync(queueFile, 'utf8');
  assert(queue.includes('TRANSLATION_QUEUE_POLL_INTERVAL_MS = 30000'));
  // Shorten only this copied synthetic runtime; never edit production/shared files.
  f.write(queueFile, queue.replace('TRANSLATION_QUEUE_POLL_INTERVAL_MS = 30000', 'TRANSLATION_QUEUE_POLL_INTERVAL_MS = 20'));
  const slotRoot = path.join(f.temporary, 'scirepl-example-gemini-slots'), slots = [];
  mkdirSync(slotRoot, { recursive: true });
  const owner = { pid: process.pid, startIdentity: getProcessStartIdentity(), nonce: randomUUID() };
  for (let i = 0; i < 2; i++) { const slot = path.join(slotRoot, 'slot-' + i); mkdirSync(slot); f.write(path.join(slot, 'owner.json'), owner); slots.push(slot); }
  const child = spawn(process.execPath, [...f.args, '--execute'], { cwd: f.root, env: f.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '', finished = false; child.stderr.setEncoding('utf8'); child.stderr.on('data', text => { stderr += text; }); child.stdout.resume();
  const ended = new Promise(resolve => { child.once('error', error => { finished = true; resolve({ error }); }); child.once('close', code => { finished = true; resolve({ code }); }); });
  const release = () => {
    for (const slot of slots.splice(0)) { assert.deepEqual(f.read(path.join(slot, 'owner.json')), owner); unlinkSync(path.join(slot, 'owner.json')); rmdirSync(slot); }
  };
  try {
    let attempts = 0;
    while (!existsSync(queuedFile(f)) && !finished && attempts++ < 2000) await sleep(5);
    assert(existsSync(queuedFile(f)), 'Fixture controller did not reach queued phase: ' + stderr);
    assert.equal(f.calls().length, 0);
    f.write(path.join(f.sourceDirectory, f.forbiddenSourcePhase + '.queued.json'), { offlineFixture: true });
    release();
    const result = await Promise.race([ended, sleep(10000).then(() => ({ timeout: true }))]);
    assert.equal(result.code, 1, stderr); assert.equal(f.calls().length, 0);
    assert(!existsSync(path.join(campaignOf(f), 'fr/01/review-01.dispatched.json')));
  } finally {
    release(); if (!finished) { child.kill('SIGTERM'); await ended; }
  }
});

console.log(`Untouched review continuation controller: ${passed} offline groups passed; no live model calls or writes.`);
