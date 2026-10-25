import assert from 'node:assert/strict';
import { test } from 'node:test';
import { captureActivitySnapshot, assessTranslationActivity, recommendTranslationRecovery } from '../scripts/tutorial_translation_activity.mjs';

const NOW = Date.parse('2026-10-17T20:00:00Z');
const current = overrides => ({ atMs: NOW, state: 'running', workflowStatus: 'running', controllerAlive: true, supervisorAlive: true,
  heartbeatAtMs: NOW, completedPages: 2, phases: [{ key: 'private-key', identity: 'private-identity', state: 'running', elapsedSeconds: 52000,
    stdoutBytes: 6946, stderrBytes: 78, alive: true, cpuTicks: 10, ioOperations: 100 }], ...overrides });
const previous = overrides => current({ atMs: NOW - 35000, heartbeatAtMs: NOW - 30000, ...overrides });
const budget = { usedReviewCalls: 5, maxReviewCalls: 5, sourceUsedReviewCalls: 8, jointUsedReviewCalls: 13, jointMaxReviewCalls: 13 };
const workflow = { status: 'running', supervisorAlive: true, controllerAlive: true, workers: { live: 1, unverifiable: 0 }, units: { remaining: 1 } };
const policy = input => recommendTranslationRecovery({ activity: { status: 'suspected_stall', attentionRequired: true }, workflow, budget, ...input });

test('silent long live request raises inspection, not permission to retry', () => {
  const result = assessTranslationActivity(current(), previous());
  assert.equal(result.status, 'suspected_stall'); assert.equal(result.attentionRequired, true);
  assert.equal(result.noOutputObservedSeconds, 30); assert.equal(result.sampleSeconds, 35);
  assert.equal(result.lastOutputAt, null); assert.equal(result.providerProgress, 'unknown'); assert.equal(result.automaticRecovery, false);
  assert(!JSON.stringify(result).includes('private'));
});
test('first legacy snapshot cannot invent silence duration or provider health', () => {
  const result = assessTranslationActivity(current());
  assert.equal(result.status, 'progress_unknown'); assert.equal(result.attentionRequired, true);
  assert.equal(result.noOutputObservedSeconds, null); assert.equal(result.lastOutputAt, null);
});
test('two reads of the same published heartbeat do not establish output silence', () => {
  const result = assessTranslationActivity(current(), previous({ heartbeatAtMs: NOW }));
  assert.equal(result.status, 'progress_unknown'); assert.equal(result.outputDeltaBytes, null);
});
test('noisy stderr and busy CPU prove only local activity, not provider/task advancement', () => {
  for (const changes of [{ stderrBytes: 99 }, { cpuTicks: 999 }, { ioOperations: 999 }]) {
    const value = current(); Object.assign(value.phases[0], changes);
    const result = assessTranslationActivity(value, previous());
    assert.equal(result.attentionRequired, true); assert.equal(result.providerProgress, 'unknown'); assert.equal(result.taskProgress, 'unknown');
  }
});
test('short quiet requests are progress unknown without a premature stall alarm', () => {
  const value = current(); value.phases[0].elapsedSeconds = 100;
  assert.equal(assessTranslationActivity(value, previous()).attentionRequired, false);
});
test('arbitrarily long legitimate queue wait is not a stall or cancellation signal', () => {
  const value = current({ phases: [{ state: 'queued', elapsedSeconds: 864000 }] });
  const result = assessTranslationActivity(value, previous());
  assert.equal(result.status, 'waiting_for_capacity'); assert.equal(result.attentionRequired, false);
});
test('stale or missing heartbeat cannot be masked by process liveness', () => {
  assert.equal(assessTranslationActivity(current({ heartbeatAtMs: NOW - 121000 })).reasonCode, 'controller_heartbeat_stale');
  assert.equal(assessTranslationActivity(current({ heartbeatAtMs: null })).status, 'unknown');
});
test('dead active worker with live controller flags possible finalization/ownership wait', () => {
  const a = current(), b = previous(); a.phases[0].alive = false; b.phases[0].alive = false;
  assert.equal(assessTranslationActivity(a, b).reasonCode, 'active_worker_missing_or_waiting_for_close');
});
test('changed identities, unknown identity and regressing counters never establish a stall', () => {
  const a = current(); a.phases[0].identity = 'new-worker';
  assert.equal(assessTranslationActivity(a, previous()).status, 'progress_unknown');
  const b = current(); b.phases[0].alive = null;
  assert.equal(assessTranslationActivity(b, previous()).status, 'needs_inspection');
  const c = current(); c.phases[0].stdoutBytes--;
  assert.equal(assessTranslationActivity(c, previous()).status, 'unknown');
});
test('clock changes and invalid policy fail closed', () => {
  assert.equal(assessTranslationActivity(current({ atMs: NOW - 100000 }), previous()).status, 'unknown');
  assert.throws(() => assessTranslationActivity(current(), null, { advisoryAfterSeconds: 0 }));
});
test('terminal historical phase rows are not live stall evidence', () => {
  assert.equal(assessTranslationActivity(current({ state: 'completed' }), previous()).status, 'terminal');
});
test('capture handles unreadable process metadata without leaking private records', () => {
  const value = captureActivitySnapshot({ state: 'running', progress: { updatedAt: new Date(NOW).toISOString(), phases: [{ state: 'running', worker: { pid: 123, startIdentity: 'secret' } }] } }, { nowMs: NOW, readWorker() { throw Error('PRIVATE'); } });
  const result = assessTranslationActivity(value); assert.equal(result.providerProgress, 'unknown'); assert(!JSON.stringify(result).includes('secret'));
});
test('exhausted tail and joint budgets both block replacement, even after old owner disappears', () => {
  assert.equal(policy().reasonCode, 'review_budget_exhausted');
  assert.equal(policy({ budget: { ...budget, maxReviewCalls: 6 } }).reasonCode, 'review_budget_exhausted');
  assert.equal(policy({ workflow: { ...workflow, supervisorAlive: false, controllerAlive: false, workers: { live: 0, unverifiable: 0 } } }).replacementAllowed, false);
});
test('unknown and inconsistent allocation cannot authorize a new agent', () => {
  for (const value of [null, {}, { ...budget, jointUsedReviewCalls: 12 }, { usedReviewCalls: 6, maxReviewCalls: 5 }]) assert.equal(policy({ budget: value }).reasonCode, 'review_budget_unknown_or_inconsistent');
});
test('spare allowance still cannot duplicate a live owner', () => {
  const result = policy({ budget: { ...budget, maxReviewCalls: 6, jointMaxReviewCalls: 14 } });
  assert.equal(result.decision, 'inspect_existing_owner'); assert.equal(result.replacementAllowed, false);
});
test('a shared provider/auth blocker must be inspected instead of spawning another agent', () => {
  const spare = { ...budget, maxReviewCalls: 6, jointMaxReviewCalls: 14 };
  assert.equal(policy({ budget: spare, authentication: { loginRequired: true } }).reasonCode, 'explicit_login_required');
  for (const category of ['quota_or_billing', 'rate_limit', 'network_transport', 'authentication_attention', 'forbidden_ambiguous', 'capacity_unavailable']) assert.equal(policy({ budget: spare, failureCategories: { [category]: 1 } }).decision, 'inspect_shared_blocker');
});
test('queued workers wait rather than trigger replacement even with spare calls', () => {
  assert.equal(policy({ budget: { usedReviewCalls: 0, maxReviewCalls: 1 }, activity: { status: 'waiting_for_capacity' } }).decision, 'wait');
});
test('recovery needs verified absent owners and every explicit evidence/authority gate', () => {
  const input = { budget: { usedReviewCalls: 0, maxReviewCalls: 1 }, workflow: { status: 'needs_recovery', supervisorAlive: false, controllerAlive: false, workers: { live: 0, unverifiable: 0 }, units: { planned: 1, completed: 0, skipped: 0, held: 1, remaining: 1 } },
    audit: { dispatchHistoryReconciled: true, pinsAndAcceptedBaselinePreserved: true, boundedRecoveryPlanValidated: true, blockerAddressed: true, replacementAuthorized: true } };
  assert.equal(policy(input).decision, 'bounded_recovery_eligible'); assert.equal(policy(input).automaticRecovery, false);
  for (const key of Object.keys(input.audit)) assert.equal(policy({ ...input, audit: { ...input.audit, [key]: false } }).replacementAllowed, false);
  assert.equal(policy({ ...input, workflow: { ...input.workflow, workers: { live: 0, unverifiable: 1 } } }).reasonCode, 'ownership_unresolved');
  for (const status of [undefined, 'needs_inspection', 'cancelled', 'cancelling', 'completed', 'running']) assert.equal(policy({ ...input, workflow: { ...input.workflow, status } }).replacementAllowed, false);
  for (const units of [undefined, {}, { ...input.workflow.units, remaining: 0 }, { ...input.workflow.units, planned: 2 }]) assert.equal(policy({ ...input, workflow: { ...input.workflow, units } }).replacementAllowed, false);
});

test('short running requests still require valid identity and non-regressing process counters', () => {
  const value = current(); value.phases[0].elapsedSeconds = 100; value.phases[0].identity = null;
  assert.equal(assessTranslationActivity(value, previous()).attentionRequired, true);
  const regressed = current(); regressed.phases[0].cpuTicks = 1;
  assert.equal(assessTranslationActivity(regressed, previous()).reasonCode, 'process_counters_regressed');
  const launching = current({ phases: [{ state: 'launching', elapsedSeconds: 1, identity: null, alive: null }] });
  assert.equal(assessTranslationActivity(launching).attentionRequired, false);
});
