#!/usr/bin/env node
// Unpinned observer: bounded sampling, no persistent state, signals or requests.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJobDiagnostics } from './tutorial_translation_diagnostics.mjs';
import { captureActivitySnapshot, assessTranslationActivity, recommendTranslationRecovery } from './tutorial_translation_activity.mjs';
import { readWorkerActivity } from './tutorial_translation_process_activity.mjs';
export { readWorkerActivity } from './tutorial_translation_process_activity.mjs';

const SCRIPT = fileURLToPath(import.meta.url), ROOT = path.dirname(path.dirname(SCRIPT));
function readSnapshot(job) {
  const result = spawnSync(process.execPath, [path.join(ROOT, 'scripts/tutorial_translation_background.mjs'), 'status', '--job', job], { cwd: ROOT, encoding: 'utf8', timeout: 15000, maxBuffer: 8 * 1024 * 1024 });
  if (result.status !== 0) throw new Error('Status unavailable');
  return JSON.parse(result.stdout);
}
export async function observeTranslationJob(job, { sampleSeconds = 35 } = {}, dependencies = {}) {
  if (!Number.isSafeInteger(sampleSeconds) || sampleSeconds < 10 || sampleSeconds > 60) throw new Error('Sampling must take 10–60 seconds');
  const now = dependencies.now || Date.now;
  const sleep = dependencies.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const snapshotReader = dependencies.snapshotReader || readSnapshot;
  const diagnosticReader = dependencies.diagnosticReader || readJobDiagnostics;
  const workerReader = dependencies.workerReader || readWorkerActivity;
  const before = captureActivitySnapshot(snapshotReader(job), { nowMs: now(), readWorker: workerReader });
  await sleep(sampleSeconds * 1000);
  const snapshot = snapshotReader(job), current = captureActivitySnapshot(snapshot, { nowMs: now(), readWorker: workerReader });
  const diagnostics = diagnosticReader(job);
  const activity = assessTranslationActivity(current, before);
  const ownerWorkflow = { ...diagnostics.ownerWorkflow, supervisorAlive: snapshot.supervisorAlive, controllerAlive: snapshot.controllerAlive };
  const workflow = activity.attentionRequired && ['running', 'running_with_holds', 'starting'].includes(ownerWorkflow.status)
    ? { ...ownerWorkflow, status: 'needs_inspection', attentionRequired: true, canAdvance: null, reasonCode: activity.reasonCode }
    : diagnostics.workflow;
  const orchestration = recommendTranslationRecovery({ activity, workflow: ownerWorkflow, budget: snapshot.progress?.recoveryBudget,
    authentication: diagnostics.authentication, failureCategories: diagnostics.calls?.failureCategories });
  return { schema: 1, observationOnly: true, observedAt: new Date(now()).toISOString(),
    effects: { writes: false, workerSignals: false, providerRequests: false, authenticationProbes: false },
    workflow, ownerWorkflow, activity, orchestration, inflight: diagnostics.inflight,
    authentication: diagnostics.authentication, calls: diagnostics.calls, throughput: diagnostics.throughput,
    attentionRequired: diagnostics.attentionRequired || activity.attentionRequired,
    recommendedAction: diagnostics.authentication?.loginRequired === true ? diagnostics.recommendedAction : orchestration.recommendedAction };
}
if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT) {
  try {
    const args = process.argv.slice(2);
    if (args[0] !== '--job' || !args[1] || ![2, 4].includes(args.length) || args.length === 4 && args[2] !== '--sample-seconds') throw new Error('Invalid options');
    const job = path.resolve(args[1]);
    if (!job.startsWith('/tmp/scirepl-tutorial-translation-job-') || job.includes('\0')) throw new Error('Invalid job');
    console.log(JSON.stringify(await observeTranslationJob(job, { sampleSeconds: args.length === 4 ? Number(args[3]) : 35 }), null, 2));
  } catch {
    console.log(JSON.stringify({ schema: 1, observationOnly: true, attentionRequired: true, reasonCode: 'observer_metadata_unavailable',
      activity: { status: 'unknown', providerProgress: 'unknown' }, orchestration: { decision: 'hold', replacementAllowed: false, automaticRecovery: false },
      recommendedAction: 'Inspect existing metadata and ownership; do not infer no dispatch, cancel or replace a worker.' }));
    process.exitCode = 1;
  }
}
