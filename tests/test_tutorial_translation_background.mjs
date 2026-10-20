// Fresh minimal fixture repos + fake controllers only; no models/app data.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const fixture = mkdtempSync(path.join(tmpdir(), 'scirepl-background-fixture-'));
const scripts = path.join(fixture, 'scripts'); mkdirSync(scripts);
const script = path.join(scripts, 'tutorial_translation_background.mjs');
copyFileSync(path.join(ROOT, 'scripts/tutorial_translation_background.mjs'), script);
copyFileSync(path.join(ROOT, 'scripts/tutorial_translation_health.mjs'), path.join(scripts, 'tutorial_translation_health.mjs'));
copyFileSync(path.join(ROOT, 'tests/fixtures/tutorial_background_controller.mjs'), path.join(scripts, 'run_tutorial_translations.mjs'));
copyFileSync(path.join(ROOT, 'tests/fixtures/tutorial_background_controller.mjs'), path.join(scripts, 'run_tutorial_section_translations.mjs'));
for (const name of ['tutorial_translation_queue.mjs', 'tutorial_translation_transport.mjs', 'tutorial_locale_lib.mjs', 'tutorial_locale_apply.mjs', 'tutorial_translation_recovery.mjs', 'tutorial_locale_section_plan.mjs', 'tutorial_section_protocol.mjs', 'tutorial_review_batching.mjs', 'tutorial_section_correction_plan.mjs', 'tutorial_section_review_continuation_plan.mjs']) writeFileSync(path.join(scripts, name), '// Offline pin-only fixture; never imported.\n');
const manifest = JSON.parse(readFileSync(path.join(ROOT, 'docs/tutorial-localization/source.json')));
mkdirSync(path.join(fixture, 'docs/tutorial-localization'), { recursive: true });
copyFileSync(path.join(ROOT, 'docs/tutorial-localization/source.json'), path.join(fixture, 'docs/tutorial-localization/source.json'));
for (const page of manifest.pages) {
  const target = path.join(fixture, 'www/help', page.route, 'index.html'); mkdirSync(path.dirname(target), { recursive: true });
  copyFileSync(path.join(ROOT, 'www/help', page.route, 'index.html'), target);
}
const requests = mkdtempSync('/tmp/scirepl-tutorial-translation-background-requests-');
mkdirSync(path.join(requests, 'fr')); writeFileSync(path.join(requests, 'fr/01.json'), '{"offlineFixture":true}\n');
const agy = path.join(fixture, 'never-call-provider'); writeFileSync(agy, 'Offline placeholder, not executable.\n');
const env = { ...process.env, SCIREPL_TRANSLATION_AGY: agy, SCIREPL_TRANSLATION_MODEL: 'offline-background-fixture' };
const invoke = (command, job, extra = [], allowFailure = false) => {
  const result = spawnSync(process.execPath, [script, command, '--job', job, ...extra], { env, cwd: fixture, encoding: 'utf8' });
  if (!allowFailure) assert.equal(result.status, 0, result.stderr);
  return result;
};
const json = (command, job, extra = []) => JSON.parse(invoke(command, job, extra).stdout);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const waitFor = async (job, predicate) => {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) { const value = json('status', job); if (predicate(value)) return value; await sleep(100); }
  throw new Error('Offline background fixture did not reach expected state');
};
const make = suffix => {
  const container = mkdtempSync('/tmp/scirepl-tutorial-translation-job-test-');
  const job = path.join(container, 'job');
  const campaign = '/tmp/scirepl-tutorial-translation-background-test-' + path.basename(container) + '-' + suffix;
  const started = json('start', job, ['--requests', requests, '--campaign', campaign]);
  assert.equal(started.state, 'started-in-background'); return { job, campaign };
};
const active = [];
try {
  const completed = make('complete'); active.push(completed.job);
  // start returned from a separate, now-exited CLI process. The detached owner
  // and fake controller keep running independently while we poll fresh CLIs.
  const running = await waitFor(completed.job, value => value.controllerAlive && ['queued', 'running'].includes(value.state));
  assert(running.supervisorAlive); assert(['queued', 'running'].includes(running.state));
  assert(['running', 'waiting_for_capacity'].includes(running.workflow.status));
  assert.equal(running.workflow.attentionRequired, false);
  const working = await waitFor(completed.job, value => value.workflow.workers.live === 1);
  assert.equal(working.workflow.status, 'running', 'Worker identity includes boot ID and start ticks');
  assert(!JSON.stringify(running).includes('PRIVATE_FIXTURE_OUTPUT'));
  const done = await waitFor(completed.job, value => value.state === 'completed');
  assert.equal(done.exitCode, 0); assert.equal(done.controllerAlive, false);
  assert.equal(done.workflow.status, 'completed'); assert.equal(done.workflow.canAdvance, false);
  const config = JSON.parse(readFileSync(path.join(completed.job, 'config.json')));
  assert.equal(config.printTimeout, '0s'); assert.equal(config.watchdogTimeout, '0s');
  assert(config.pins.some(row => row.file === path.join(requests, 'fr/01.json')));
  assert(config.pins.some(row => row.file === path.join(scripts, 'tutorial_translation_recovery.mjs')));
  assert(config.pins.some(row => row.file === path.join(scripts, 'tutorial_translation_health.mjs')));
  assert.equal(config.pins.some(row => row.file === agy), false, 'An auto-updating runner is provenance, not a source pin');
  const before = readdirSync(completed.job).sort(); json('status', completed.job);
  assert.deepEqual(readdirSync(completed.job).sort(), before, 'Status must not create or mutate evidence');
  assert.notEqual(invoke('start', completed.job, ['--requests', requests, '--campaign', completed.campaign], true).status, 0, 'Never replay a job');
  console.log('PASS detached background owner survives launcher exit; status polls without logs, retries or model calls');

  const cancelled = make('hang'); active.push(cancelled.job);
  await waitFor(cancelled.job, value => value.controllerAlive);
  const requested = json('stop', cancelled.job); assert.equal(requested.verifiedOwnerSignalled, true);
  const stopped = await waitFor(cancelled.job, value => value.state === 'cancelled');
  assert.equal(stopped.controllerAlive, false); assert(stopped.cancelRequested);
  assert.equal(stopped.workflow.status, 'cancelled');
  console.log('PASS explicit cancellation stops the verified owner and its controller, not a polling observer');

  const foreign = make('hang'); active.push(foreign.job);
  await waitFor(foreign.job, value => value.controllerAlive);
  const ownerFile = path.join(foreign.job, 'owner.json'), controllerFile = path.join(foreign.job, 'controller.json');
  const owner = readFileSync(ownerFile), controller = readFileSync(controllerFile);
  const raw = readFileSync(`/proc/${process.pid}/stat`, 'utf8'); const startIdentity = raw.slice(raw.lastIndexOf(')') + 2).trim().split(/\s+/)[19];
  for (const file of [ownerFile, controllerFile]) { const value = JSON.parse(readFileSync(file)); value.pid = process.pid; value.startIdentity = startIdentity; writeFileSync(file, JSON.stringify(value)); }
  const refused = json('stop', foreign.job); assert.equal(refused.verifiedOwnerSignalled, false); process.kill(process.pid, 0);
  writeFileSync(ownerFile, owner); writeFileSync(controllerFile, controller); json('stop', foreign.job);
  await waitFor(foreign.job, value => value.state === 'cancelled' && !value.controllerAlive);
  console.log('PASS PID/start identity alone cannot signal an unrelated process; argv and job ownership must match');

  const held = make('held'); active.push(held.job);
  const heldResult = await waitFor(held.job, value => value.state === 'held');
  assert.equal(heldResult.exitCode, 1); assert.equal(heldResult.controllerAlive, false);
  assert.equal(heldResult.workflow.status, 'needs_recovery');
  assert.equal(heldResult.workflow.attentionRequired, true); assert.equal(heldResult.workflow.canAdvance, false);
  assert.equal(heldResult.workflow.workers.live, 0);
  assert(heldResult.workflow.finishedAt);
  console.log('PASS a held job is reported as held, never silently restarted or called completed');

  const runnerUpdated = make('complete'); active.push(runnerUpdated.job);
  await waitFor(runnerUpdated.job, value => value.controllerAlive);
  writeFileSync(agy, 'Offline placeholder after an ordinary runner update.\n');
  const updateDone = await waitFor(runnerUpdated.job, value => value.state === 'completed');
  assert.equal(updateDone.exitCode, 0);
  console.log('PASS ordinary runner updates do not invalidate the background job\'s immutable source/request/helper pins');

  const sectionContainer = mkdtempSync('/tmp/scirepl-tutorial-translation-job-test-');
  const sectionJob = path.join(sectionContainer, 'job'); active.push(sectionJob);
  const sectionPlan = path.join(requests, 'section-plan.json'); writeFileSync(sectionPlan, '{"offlineFixture":true}\n');
  const sectionCampaign = '/tmp/scirepl-tutorial-translation-background-test-' + path.basename(sectionContainer) + '-complete';
  json('start', sectionJob, ['--sections-plan', sectionPlan, '--campaign', sectionCampaign]);
  const sectionDone = await waitFor(sectionJob, value => value.state === 'completed');
  assert.equal(sectionDone.exitCode, 0); assert.equal(sectionDone.controllerAlive, false);
  const sectionConfig = JSON.parse(readFileSync(path.join(sectionJob, 'config.json')));
  assert.equal(sectionConfig.controller, path.join(scripts, 'run_tutorial_section_translations.mjs'));
  assert.equal(sectionConfig.sectionsPlan, sectionPlan); assert.equal(sectionConfig.requests, null);
  assert(sectionConfig.pins.some(row => row.file === sectionPlan));
  assert(sectionConfig.pins.some(row => row.file === path.join(scripts, 'tutorial_locale_section_plan.mjs')));
  const sectionBefore = readdirSync(sectionJob).sort(); json('status', sectionJob);
  assert.deepEqual(readdirSync(sectionJob).sort(), sectionBefore);
  console.log('PASS explicit section plans use the durable owner and strict plan pins with read-only status');

  const originalWrapper = readFileSync(script, 'utf8');
  const writeMarker = "exclusive(file('controller.json'), childOwner);";
  assert.equal(originalWrapper.split(writeMarker).length, 2);
  writeFileSync(script, originalWrapper.replace(writeMarker,
    "exclusive(file('injected-child.json'), childOwner); throw new Error('Offline metadata-write fault');"));
  const faulted = make('hang'); active.push(faulted.job);
  const failure = await waitFor(faulted.job, value => value.state === 'failed');
  const injected = JSON.parse(readFileSync(path.join(faulted.job, 'injected-child.json')));
  assert.equal(failure.controllerAlive, false);
  assert(['needs_recovery', 'needs_inspection'].includes(failure.workflow.status));
  assert.equal(failure.workflow.attentionRequired, true);
  assert.throws(() => process.kill(injected.pid, 0), error => error.code === 'ESRCH', 'A metadata-write failure must not leave the owned child alive');
  writeFileSync(script, originalWrapper);
  console.log('PASS failed controller-record persistence cancels and waits for the in-memory owned child');
} finally {
  for (const job of active) invoke('stop', job, [], true);
}
console.log('Background lifecycle: 7 offline scenarios passed; no provider or translation calls.');
