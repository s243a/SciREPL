// In-memory status fixtures and injected liveness only: never launch a worker,
// read a campaign, acquire a shared slot, or make a provider/model request.
import assert from 'node:assert/strict';
import { summarizeTranslationWorkflow } from '../scripts/tutorial_translation_health.mjs';

const UPDATED = '2026-10-16T06:04:00.000Z';
const FINISHED = '2026-10-16T06:05:00.000Z';
const WORKER = { pid: 12345, startIdentity: 'test-start-a' };
const OTHER_WORKER = { pid: 12346, startIdentity: 'test-start-b' };
const fixture = (overrides = {}) => ({
  state: 'running', supervisorAlive: true, controllerAlive: true,
  cancelRequested: false,
  progress: {
    unit: 'pages', updatedAt: UPDATED,
    counts: { planned: 68, completed: 48, held: 0, skipped: 0 },
    phases: [],
  },
  ...overrides,
});
const withProgress = (progress = {}, overrides = {}) => {
  const value = fixture(overrides);
  value.progress = { ...value.progress, ...progress };
  return value;
};
const alive = worker => worker.pid === WORKER.pid && worker.startIdentity === WORKER.startIdentity;
const summarize = (snapshot, isWorkerAlive = alive) => summarizeTranslationWorkflow(snapshot, { isWorkerAlive });
const assertions = [];
const check = (name, fn) => {
  fn(); assertions.push(name); console.log('PASS ' + name);
};
const assertStatus = (result, status, attentionRequired, canAdvance) => {
  assert.equal(result.schema, 1);
  assert.equal(result.status, status);
  assert.equal(result.attentionRequired, attentionRequired);
  if (canAdvance !== undefined) assert.equal(result.canAdvance, canAdvance);
  assert.equal(result.automaticRecovery, false, 'A status indicator never grants automatic recovery authority');
  assert.equal(typeof result.reasonCode, 'string'); assert(result.reasonCode.length > 0);
  assert.equal(typeof result.recommendedAction, 'string'); assert(result.recommendedAction.length > 0);
};

check('a live, arbitrarily slow worker remains running without a retry alarm', () => {
  const result = summarize(withProgress({
    updatedAt: '2000-01-01T00:00:00.000Z',
    phases: [{ state: 'running', worker: WORKER, elapsedSeconds: 864000, stdoutBytes: 0 }],
  }));
  assertStatus(result, 'running', false, true);
  assert.deepEqual(result.workers, { live: 1, queued: 0, unverifiable: 0 });
});

check('a live controller may be between provider phases without needing more workers', () => {
  const result = summarize(fixture());
  assertStatus(result, 'running', false, true);
  assert.equal(result.workers.live, 0);
});

check('legitimate queued work waits for capacity and is never a replacement signal', () => {
  const result = summarize(withProgress({ phases: [{ state: 'queued', position: 3, elapsedSeconds: 864000 }] }));
  assertStatus(result, 'waiting_for_capacity', false);
  assert.equal(result.workers.queued, 1);
  assert.equal(result.workers.live, 0);
});

check('blocked queue ownership requires inspection while preserving other live work', () => {
  for (const state of ['running', 'blocked']) {
    const result = summarize(withProgress({ state, phases: [
      { state: 'blocked' }, { state: 'running', worker: WORKER },
    ] }));
    assertStatus(result, 'needs_inspection', true, null);
    assert.equal(result.workers.live, 1);
    assert.match(result.recommendedAction, /ownership/);
  }
});

check('a supervisor starting its controller is a normal starting state', () => {
  const result = summarize(fixture({ state: 'starting', controllerAlive: false }));
  assertStatus(result, 'starting', false);
});

check('initial controller metadata may precede the first progress snapshot', () => {
  for (const controllerAlive of [false, true]) {
    const result = summarize(fixture({ state: 'starting', controllerAlive, progress: null }));
    assertStatus(result, 'starting', false, true);
    assert.equal(result.units.planned, null);
    assert.equal(result.units.remaining, null);
  }
});

check('a live owner can keep advancing other pages while reporting existing holds', () => {
  const result = summarize(withProgress({
    counts: { planned: 68, completed: 48, held: 2, skipped: 0 },
    phases: [{ state: 'running', worker: WORKER }],
  }));
  assertStatus(result, 'running_with_holds', true, true);
  assert.equal(result.units.held, 2);
});

check('the actual 48-passed / 20-held shape needs recovery, not additional generic workers', () => {
  const result = summarize(withProgress({
    counts: { planned: 68, completed: 48, held: 20, skipped: 0 },
    // Finished phase rows can retain historical running states and identities.
    phases: [{ state: 'running', worker: OTHER_WORKER }],
  }, { state: 'held', supervisorAlive: false, controllerAlive: false, finishedAt: FINISHED }));
  assertStatus(result, 'needs_recovery', true, false);
  assert.deepEqual(result.workers, { live: 0, queued: 0, unverifiable: 0 });
  assert.deepEqual(result.units, { planned: 68, completed: 48, held: 20, skipped: 0, remaining: 20 });
  assert.equal(result.lastStatusAt, UPDATED);
  assert.equal(result.finishedAt, FINISHED);
});

check('terminal failure needs a deliberate recovery decision and never silently resumes', () => {
  const result = summarize(fixture({ state: 'failed', supervisorAlive: false, controllerAlive: false }));
  assertStatus(result, 'needs_recovery', true, false);
});

check('an unowned untouched job signals a need for workers only after dispatch-history inspection', () => {
  const result = summarize(withProgress({
    counts: { planned: 68, completed: 0, held: 0, skipped: 0 }, phases: [],
  }, { state: 'interrupted', supervisorAlive: false, controllerAlive: false }));
  assertStatus(result, 'needs_workers', true, false);
  assert.match(result.recommendedAction, /inspect|history|dispatch/i,
    'The recommendation must not present status as authorization to replay work');
});

check('unowned consumed or ambiguous phase evidence needs inspection before any replacement', () => {
  for (const state of ['running', 'dispatched', 'launching', 'completed']) {
    const result = summarize(withProgress({ phases: [{ state, worker: OTHER_WORKER }] }, {
      state: 'interrupted', supervisorAlive: false, controllerAlive: false,
    }));
    assertStatus(result, 'needs_inspection', true, false);
    assert.equal(result.workers.live, 0, 'A historical phase state is not proof of process liveness');
  }
});

check('cancelled jobs never become needs_workers and never auto-resume', () => {
  const result = summarize(withProgress({ phases: [{ state: 'running', worker: OTHER_WORKER }] }, {
    state: 'cancelled', cancelRequested: true, supervisorAlive: false, controllerAlive: false, finishedAt: FINISHED,
  }));
  assertStatus(result, 'cancelled', false, false);
});

check('a live cancellation request is observed without adding replacement workers', () => {
  const result = summarize(withProgress({ phases: [{ state: 'running', worker: WORKER }] }, {
    cancelRequested: true,
  }));
  assertStatus(result, 'cancelling', false, false);
  assert.equal(result.workers.live, 1);
});

check('completed counts describe this job only, including explicitly skipped units', () => {
  const result = summarize(withProgress({
    counts: { planned: 68, completed: 67, held: 0, skipped: 1 },
  }, { state: 'completed', supervisorAlive: false, controllerAlive: false, finishedAt: FINISHED }));
  assertStatus(result, 'completed', false, false);
  assert.equal(result.units.remaining, 0);
  assert.equal(result.units.completed, 67);
  assert.equal(result.units.skipped, 1);
  assert(!('translationsComplete' in result));
  assert(!('publicationComplete' in result));
  assert(!('releaseReady' in result));
});

check('a completed record cannot hide unfinished or held units', () => {
  const result = summarize(withProgress({
    counts: { planned: 68, completed: 48, held: 20, skipped: 0 },
  }, { state: 'completed', supervisorAlive: false, controllerAlive: false }));
  assertStatus(result, 'needs_inspection', true, false);
  assert.equal(result.units.remaining, 20);
});

check('held and failed records with invalid counts require reconciliation before recovery', () => {
  for (const state of ['held', 'failed']) {
    for (const counts of [null, { planned: 68, completed: 68, held: 20, skipped: 0 }]) {
      const result = summarize(withProgress({ counts }, {
        state, supervisorAlive: false, controllerAlive: false,
      }));
      assertStatus(result, 'needs_inspection', true, null);
      assert.equal(result.units.remaining, null);
    }
  }
});

check('an orphaned controller requires inspection even when its provider worker is live', () => {
  const result = summarize(withProgress({ phases: [{ state: 'running', worker: WORKER }] }, {
    state: 'orphaned-running', supervisorAlive: false, controllerAlive: true,
  }));
  assertStatus(result, 'needs_inspection', true, null);
  assert.equal(result.workers.live, 1);
});

check('a terminal record with a live worker is contradictory and needs inspection', () => {
  for (const state of ['held', 'failed', 'completed']) {
    const result = summarize(withProgress({ phases: [{ state: 'running', worker: WORKER }] }, {
      state, supervisorAlive: false, controllerAlive: false,
    }));
    assertStatus(result, 'needs_inspection', true, null);
    assert.equal(result.workers.live, 1);
  }
});

check('workers are deduplicated by PID plus start identity, not phase row or PID alone', () => {
  const result = summarize(withProgress({ phases: [
    { state: 'running', worker: WORKER },
    { state: 'running', worker: { ...WORKER } },
    { state: 'running', worker: { pid: WORKER.pid, startIdentity: 'a-reused-pid' } },
    { state: 'running', worker: OTHER_WORKER },
  ] }));
  assertStatus(result, 'running', false, true);
  assert.equal(result.workers.live, 1);
  assert.equal(result.workers.unverifiable, 0);
});

check('unknown worker liveness is visible and never treated as absence', () => {
  const snapshot = withProgress({ phases: [
    { state: 'running', worker: WORKER },
    { state: 'running', worker: { ...WORKER } },
  ] });
  const result = summarizeTranslationWorkflow(snapshot);
  assertStatus(result, 'needs_inspection', true, null);
  assert.equal(result.workers.live, 0);
  assert.equal(result.workers.unverifiable, 1);
});

check('failed liveness probes and malformed identities are unverifiable, not dead', () => {
  const failed = summarize(withProgress({ phases: [{ state: 'running', worker: WORKER }] }), () => {
    throw new Error('Private probe diagnostics');
  });
  assertStatus(failed, 'needs_inspection', true, null);
  assert.equal(failed.workers.unverifiable, 1);
  assert(!JSON.stringify(failed).includes('Private probe diagnostics'));
  for (const worker of [{ pid: 0, startIdentity: 'x' }, { pid: 12345 }, { pid: '12345', startIdentity: 'x' }]) {
    let probed = false;
    const malformed = summarize(withProgress({ phases: [{ state: 'running', worker }] }), () => {
      probed = true; return false;
    });
    assert.equal(probed, false, 'Do not attempt to verify an invalid process identity');
    assertStatus(malformed, 'needs_inspection', true, null);
    assert.equal(malformed.workers.unverifiable, 1);
  }
});

check('terminal held work requires inspection when historical worker liveness is unknown', () => {
  const result = summarize(withProgress({
    counts: { planned: 68, completed: 48, held: 20, skipped: 0 },
    phases: [{ state: 'running', worker: WORKER }],
  }, { state: 'held', supervisorAlive: false, controllerAlive: false }), () => null);
  assertStatus(result, 'needs_inspection', true, null);
  assert.equal(result.workers.unverifiable, 1);
});

check('invalid counts stay unknown instead of inventing progress or completion', () => {
  for (const planned of [null, undefined, '68', -1, 1.5, NaN, Infinity]) {
    const result = summarize(withProgress({ counts: { planned, completed: 0, held: 0, skipped: 0 } }));
    assertStatus(result, 'needs_inspection', true, null);
    assert.equal(result.units.planned, null);
    assert.equal(result.units.remaining, null);
    assert(!JSON.stringify(result).includes('NaN'));
    assert(!JSON.stringify(result).includes('Infinity'));
  }
  for (const completed of [-1, 0.1, '48', NaN, Infinity]) {
    const result = summarize(withProgress({ counts: { planned: 68, completed, held: 0, skipped: 0 } }));
    assertStatus(result, 'needs_inspection', true, null);
    assert.equal(result.units.completed, null);
    assert.equal(result.units.remaining, null);
  }
  for (const key of ['held', 'skipped']) {
    for (const invalid of [null, -1, 0.1, '0', NaN, Infinity]) {
      const result = summarize(withProgress({ counts: { planned: 68, completed: 48, held: 0, skipped: 0, [key]: invalid } }));
      assertStatus(result, 'needs_inspection', true, null);
      assert.equal(result.units[key], null, 'Only absent legacy counts may default to zero');
      assert.equal(result.units.remaining, null);
    }
  }
});

check('legacy valid counts can omit zero held/skipped, but absent totals remain unknown', () => {
  const legacy = summarize(withProgress({ counts: { planned: 68, completed: 48 } }));
  assertStatus(legacy, 'running', false, true);
  assert.deepEqual(legacy.units, { planned: 68, completed: 48, held: 0, skipped: 0, remaining: 20 });
  const absent = summarize(withProgress({ counts: {} }));
  assertStatus(absent, 'needs_inspection', true, null);
  assert.equal(absent.units.planned, null);
  assert.equal(absent.units.remaining, null);
});

check('contradictory totals cannot imply completion or a negative remaining count', () => {
  for (const counts of [
    { planned: 68, completed: 69, held: 0, skipped: 0 },
    { planned: 68, completed: 48, held: 21, skipped: 0 },
    { planned: 68, completed: 67, held: 0, skipped: 2 },
  ]) {
    const result = summarize(withProgress({ counts }));
    assertStatus(result, 'needs_inspection', true, null);
    assert.equal(result.units.remaining, null);
  }
});

check('status output is strictly allowlisted and does not mutate its input', () => {
  const secret = 'PRIVATE_PROMPT_RESPONSE_CONVERSATION_CREDENTIAL_LOG';
  const snapshot = withProgress({
    prompt: secret, response: secret, conversationId: secret, stderr: secret,
    phases: [{ state: 'running', worker: { ...WORKER, credential: secret }, rawLog: secret }],
  }, { error: secret, rawResponse: secret, workerLog: secret });
  const before = structuredClone(snapshot);
  const result = summarize(snapshot);
  assert.deepEqual(snapshot, before, 'Read-only summarization must not modify saved evidence');
  assert.deepEqual(Object.keys(result).sort(), [
    'schema', 'status', 'attentionRequired', 'canAdvance', 'reasonCode', 'recommendedAction',
    'workers', 'units', 'lastStatusAt', 'finishedAt', 'automaticRecovery',
  ].sort());
  assert.deepEqual(Object.keys(result.workers).sort(), ['live', 'queued', 'unverifiable'].sort());
  assert.deepEqual(Object.keys(result.units).sort(), ['planned', 'completed', 'held', 'skipped', 'remaining'].sort());
  assert(!JSON.stringify(result).includes(secret));
  assert(!JSON.stringify(result).includes(String(WORKER.pid)));
  assert(!JSON.stringify(result).includes(WORKER.startIdentity));
});

console.log(`Translation workflow health: ${assertions.length} offline scenarios passed; no workers, model calls, shared locks or recovery.`);
