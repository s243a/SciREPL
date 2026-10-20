import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { once } from 'node:events';
import { observeTranslationJob, readWorkerActivity } from '../scripts/tutorial_translation_observe.mjs';
import { assessTranslationActivity } from '../scripts/tutorial_translation_activity.mjs';

test('bounded fake sampling raises a stall advisory and never calls an executor', async () => {
  let clock = Date.parse('2026-10-17T20:00:00Z'), reads = 0, sleeps = 0;
  const ownerWorkflow = { status: 'running', canAdvance: true, attentionRequired: false, units: { completed: 2, remaining: 1 }, workers: { live: 1, unverifiable: 0 } };
  const diagnostic = { ownerWorkflow, workflow: ownerWorkflow, attentionRequired: true, authentication: { loginRequired: null }, calls: { failureCategories: {} }, inflight: { outstandingDispatches: 1 } };
  const output = await observeTranslationJob('/private/fake-job', {}, {
    now: () => clock,
    sleep: async ms => { assert.equal(ms, 35000); clock += ms; sleeps++; },
    snapshotReader: () => { reads++; return { state: 'running', supervisorAlive: true, controllerAlive: true, workflow: ownerWorkflow,
      progress: { updatedAt: new Date(clock).toISOString(), recoveryBudget: { usedReviewCalls: 5, maxReviewCalls: 5 },
        phases: [{ state: 'running', elapsedSeconds: 52000, stdoutBytes: 10, stderrBytes: 2, worker: { pid: 123, startIdentity: 'PRIVATE_ID' } }] } }; },
    diagnosticReader: () => diagnostic,
    workerReader: () => ({ alive: true, cpuTicks: 10, ioOperations: 10 }),
  });
  assert.equal(reads, 2); assert.equal(sleeps, 1); assert.equal(output.activity.status, 'suspected_stall');
  assert.equal(output.workflow.status, 'needs_inspection'); assert.equal(output.ownerWorkflow.status, 'running');
  assert.equal(output.orchestration.reasonCode, 'review_budget_exhausted'); assert.equal(output.orchestration.replacementAllowed, false);
  assert.deepEqual(output.effects, { writes: false, workerSignals: false, providerRequests: false, authenticationProbes: false });
  assert(!JSON.stringify(output).includes('PRIVATE_ID')); assert(!JSON.stringify(output).includes('/private/'));
});
test('invalid sampling bounds fail before reading or sleeping', async () => {
  for (const seconds of [0, 9, 61, NaN, 10.5]) await assert.rejects(observeTranslationJob('/unused', { sampleSeconds: seconds }, { snapshotReader() { throw Error('must not read'); } }), /10–60/);
});
test('unverifiable process metadata is unknown rather than evidence of healthy progress', () => {
  assert.deepEqual(readWorkerActivity({ pid: 'wrong', startIdentity: 'x' }), { alive: null });
});

test('isolated silent fake process is alive but does not verify provider progress', async () => {
  const child = spawn(process.execPath, ['-e', 'process.stdout.write("ready");setInterval(()=>{},1000)'], { stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    await once(child.stdout, 'data');
    const raw = readFileSync(`/proc/${child.pid}/stat`, 'utf8'), values = raw.slice(raw.lastIndexOf(')') + 2).trim().split(/\s+/);
    const worker = { pid: child.pid, startIdentity: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() + ':' + values[19] };
    const result = readWorkerActivity(worker); assert.equal(result.alive, true); assert(Number.isSafeInteger(result.cpuTicks));
    assert.equal(readWorkerActivity({ ...worker, startIdentity: worker.startIdentity + '-reused' }).alive, false);
    assert.equal(result.providerProgress, undefined);
  } finally { child.kill('SIGTERM'); await once(child, 'close'); }
});

test('fake direct child exits before inherited pipes close: inspection, not replacement', async () => {
  const program = 'const{spawn}=require("node:child_process");const c=spawn(process.execPath,["-e","setTimeout(()=>{},1500)"],{stdio:["ignore",process.stdout,process.stderr]});c.unref();process.stdout.write("ready");setTimeout(()=>process.exit(0),100);';
  const child = spawn(process.execPath, ['-e', program], { stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = once(child, 'close'); let didClose = false; closed.then(() => { didClose = true; });
  try {
    await once(child.stdout, 'data');
    const raw = readFileSync(`/proc/${child.pid}/stat`, 'utf8'), values = raw.slice(raw.lastIndexOf(')') + 2).trim().split(/\s+/);
    const worker = { pid: child.pid, startIdentity: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() + ':' + values[19] };
    await once(child, 'exit'); assert.equal(didClose, false);
    assert.equal(readWorkerActivity(worker).alive, false);
    const now = Date.now(), phase = { key: 'fake', identity: 'fake', state: 'running', elapsedSeconds: 100, alive: false, stdoutBytes: 5, stderrBytes: 0 };
    const result = assessTranslationActivity({ atMs: now, heartbeatAtMs: now, state: 'running', workflowStatus: 'running', phases: [phase] },
      { atMs: now - 35000, heartbeatAtMs: now - 30000, phases: [phase] });
    assert.equal(result.reasonCode, 'active_worker_missing_or_waiting_for_close'); assert.equal(result.automaticRecovery, false);
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); await closed; }
});
