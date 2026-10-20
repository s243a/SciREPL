// Offline controller lifecycle tests. The fake CLI cannot return an accepted
// review, call a model, or reach the apply phase.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ROOT, readManifest, sha } from '../scripts/tutorial_locale_lib.mjs';

const fixture = path.join(ROOT, 'tests/fixtures/tutorial_fake_cli.mjs');
// Real translations may be running while these tests execute. Use a minimal
// source-pinned fixture repository and its own TMPDIR, never the live records or
// the production two-call semaphore. The fake CLI still has no success mode.
const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'scirepl-tutorial-controller-fixture-'));
const fakeRunner = path.join(fixtureRoot, 'offline-agy.mjs');
copyFileSync(fixture, fakeRunner);
const fixtureTmp = path.join(fixtureRoot, 'tmp');
mkdirSync(fixtureTmp);
for (const relative of ['scripts/run_tutorial_translations.mjs', 'scripts/tutorial_locale_lib.mjs', 'scripts/tutorial_translation_transport.mjs', 'scripts/tutorial_translation_queue.mjs', 'scripts/tutorial_locale_apply.mjs', 'docs/tutorial-localization/source.json']) {
  const target = path.join(fixtureRoot, relative);
  mkdirSync(path.dirname(target), { recursive: true });
  copyFileSync(path.join(ROOT, relative), target);
}
// The root-owned real evidence helper has its own security tests. This explicit
// fixture double tests only controller selection/reuse/claim wiring, never live
// histories or claims. It deliberately cannot return an accepted model review.
writeFileSync(path.join(fixtureRoot, 'scripts/tutorial_translation_recovery.mjs'), `
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
export function loadRecoveryPlan(file) { return new Map(JSON.parse(readFileSync(file)).jobs.map(entry => [entry.locale + '/' + entry.chunk, entry])); }
export function recheckRecoveryJob(entry, job) { assert.equal(job.requestHash, entry.requestHash); }
export function verifyRecoveryJob(entry, job) {
  recheckRecoveryJob(entry, job);
  writeFileSync(entry.claimMarker, 'Claimed once by offline controller fixture.\\n', { flag: 'wx' });
  return entry.execution;
}
`);
const requests = mkdtempSync(path.join(tmpdir(), 'scirepl-tutorial-controller-offline-requests-'));
mkdirSync(path.join(requests, 'fr'));
const manifest = readManifest(), field = manifest.pages[0].fields[0];
for (const page of manifest.pages) {
  const relative = path.join('www/help', page.route, 'index.html');
  const target = path.join(fixtureRoot, relative);
  mkdirSync(path.dirname(target), { recursive: true });
  copyFileSync(path.join(ROOT, relative), target);
}
for (let chunk = 1; chunk <= 4; chunk++) writeFileSync(path.join(requests, 'fr', `${String(chunk).padStart(2, '0')}.json`), JSON.stringify({ schema: 1, locale: 'fr', manifestHash: manifest.manifestHash, chunk, chunks: 4, task: 'Offline lifecycle fixture only; never a provider prompt.', fields: [{ id: field.id, text: field.text }] }));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const currentSlots = () => {
  const dir = path.join(fixtureTmp, 'scirepl-example-gemini-slots');
  return existsSync(dir) ? readdirSync(dir).filter(name => name.startsWith('slot-')).map(name => path.join(dir, name, 'owner.json')).filter(existsSync).map(file => JSON.parse(readFileSync(file))) : [];
};
const start = (model, campaign, profile = { printTimeout: '0s', watchdogTimeout: '0s' }, extra = []) => {
  const child = spawn(process.execPath, [path.join(fixtureRoot, 'scripts/run_tutorial_translations.mjs'), '--locale', 'fr', '--requests', requests, '--campaign', campaign, '--execute', ...extra], {
    cwd: fixtureRoot,
    env: { ...process.env, TMPDIR: fixtureTmp, SCIREPL_TRANSLATION_AGY: fakeRunner, SCIREPL_TRANSLATION_MODEL: model, SCIREPL_TRANSLATION_PRINT_TIMEOUT: profile.printTimeout, SCIREPL_TRANSLATION_WATCHDOG_TIMEOUT: profile.watchdogTimeout, SCIREPL_TRANSLATION_EFFORT: 'medium' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', text => { stdout += text; }); child.stderr.on('data', text => { stderr += text; });
  const finished = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr })); });
  return { child, finished, snapshot: () => ({ stdout, stderr }) };
};
const started = campaign => existsSync(path.join(campaign, 'fr')) ? readdirSync(path.join(campaign, 'fr')).filter(name => existsSync(path.join(campaign, 'fr', name, 'started.json'))).sort() : [];
const fieldRecord = () => path.join(fixtureRoot, 'docs/tutorial-localization/translations/fr.json');
const originalRecord = existsSync(fieldRecord()) ? readFileSync(fieldRecord()) : null;
const checkUntouched = () => assert.equal(existsSync(fieldRecord()) ? readFileSync(fieldRecord()).toString('hex') : null, originalRecord?.toString('hex') ?? null, 'Offline test must not apply translation data');

const timeoutCampaign = mkdtempSync(path.join(tmpdir(), 'scirepl-tutorial-translation-controller-timeout-test-'));
const finiteProfile = { printTimeout: '180s', watchdogTimeout: '210s' };
const timed = start('controller-test-timeout', timeoutCampaign, finiteProfile);
const timedResult = await timed.finished;
assert.equal(timedResult.code, 1);
assert.ok(timedResult.stdout.includes('CLI print timeout warning'));
assert.equal(existsSync(path.join(timeoutCampaign, 'controller.lock')), false);
assert.equal(currentSlots().some(owner => owner.pid === timed.child.pid), false);
for (const chunk of started(timeoutCampaign)) {
  const dir = path.join(timeoutCampaign, 'fr', chunk);
  const transport = JSON.parse(readFileSync(path.join(dir, 'draft.transport.json')));
  assert.equal(transport.cliTimeoutWarning, true); assert.equal(transport.printTimeout, '180s'); assert.equal(transport.watchdogTimeout, '210s');
  assert.equal(existsSync(path.join(dir, 'accepted.json')), false);
  assert.equal(existsSync(path.join(dir, 'review.dispatched.json')), false);
}
const beforeReplay = started(timeoutCampaign);
const replay = start('controller-test-timeout', timeoutCampaign, finiteProfile);
const replayResult = await replay.finished;
assert.equal(replayResult.code, 1); assert.ok(replayResult.stdout.includes('Consumed chunk must not be replayed'));
assert.deepEqual(started(timeoutCampaign), beforeReplay);
assert.equal(existsSync(path.join(timeoutCampaign, 'controller.lock')), false);
checkUntouched();
console.log('PASS fake SUCCESS/timeout is held, not reviewed or applied; consumed chunks cannot replay');

const cancelCampaign = mkdtempSync(path.join(tmpdir(), 'scirepl-tutorial-translation-controller-cancel-test-'));
const hanging = start('controller-test-hang', cancelCampaign);
try {
let childPids = [];
const deadline = Date.now() + 10000;
while (Date.now() < deadline) {
  childPids = started(cancelCampaign).map(chunk => path.join(cancelCampaign, 'fr', chunk, 'draft.child.json')).filter(existsSync).map(file => JSON.parse(readFileSync(file)).pid).filter(Boolean);
  if (childPids.length === 2) break;
  await sleep(50);
}
assert.equal(childPids.length, 2, 'Offline cancellation test expects both bounded workers to start');
const pollDeadline = Date.now() + 35000;
while (Date.now() < pollDeadline && !hanging.snapshot().stdout.includes('[WAIT]') && hanging.child.exitCode === null && hanging.child.signalCode === null) await sleep(100);
assert.equal(hanging.child.exitCode, null, 'The zero profile must not kill a worker with an immediate timeout');
assert.equal(hanging.child.signalCode, null);
const progressLines = hanging.snapshot().stdout.split('\n').filter(line => line.startsWith('[WAIT] '));
assert.ok(progressLines.length > 0, 'A still-running owned worker must publish its 30-second metadata heartbeat');
for (const line of progressLines) {
  const progress = JSON.parse(line.slice('[WAIT] '.length));
  assert.deepEqual(Object.keys(progress), ['elapsedSeconds', 'stdoutBytes', 'stderrBytes']);
  // Whole-second flooring may report 29 when the nominal 30-second timer fires
  // a fraction early. The fixed interval itself is checked in the pure test.
  assert.ok(progress.elapsedSeconds >= 29 && progress.elapsedSeconds <= 35); assert.ok(progress.stdoutBytes > 0); assert.ok(progress.stderrBytes > 0);
}
assert.ok(!hanging.snapshot().stdout.includes('untrusted fixture'), 'Polling must never disclose worker prose or diagnostics');
hanging.child.kill('SIGTERM');
const cancelled = await hanging.finished;
assert.equal(cancelled.code, 143); assert.equal(cancelled.signal, null);
assert.ok(cancelled.stdout.includes('[STOPPING]'));
assert.deepEqual(started(cancelCampaign), ['01', '02'], 'Cancellation must stop dispatching queued chunks');
assert.equal(existsSync(path.join(cancelCampaign, 'controller.lock')), false);
assert.equal(currentSlots().some(owner => owner.pid === hanging.child.pid), false);
for (const pid of childPids) assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH', 'Owned child must be closed before controller exits');
for (const chunk of started(cancelCampaign)) {
  const dir = path.join(cancelCampaign, 'fr', chunk);
  const transport = JSON.parse(readFileSync(path.join(dir, 'draft.transport.json')));
  assert.equal(transport.cancelled, true); assert.equal(transport.cancelReason, 'SIGTERM');
  assert.equal(transport.printTimeout, '0s'); assert.equal(transport.watchdogTimeout, '0s');
  assert.equal(transport.pollIntervalSeconds, 30); assert.equal(transport.timedOut, false); assert.equal(transport.outputLimited, false);
  assert.equal(existsSync(path.join(dir, 'review.dispatched.json')), false);
  assert.equal(existsSync(path.join(dir, 'accepted.json')), false);
}
checkUntouched();
console.log('PASS zero profile waits and polls numeric metadata; SIGTERM closes both owned workers and releases owned locks only');
} finally {
  // A failed assertion must not leave even fake workers holding their fixture
  // slots until the watchdog. The controller closes only its own children.
  if (hanging.child.exitCode === null && hanging.child.signalCode === null) hanging.child.kill('SIGTERM');
  await hanging.finished;
}

const capCampaign = mkdtempSync(path.join(tmpdir(), 'scirepl-tutorial-translation-controller-cap-test-'));
const capped = start('controller-test-output-cap', capCampaign);
const capResult = await capped.finished;
assert.equal(capResult.code, 1);
assert.equal(existsSync(path.join(capCampaign, 'controller.lock')), false);
assert.equal(currentSlots().some(owner => owner.pid === capped.child.pid), false);
for (const chunk of started(capCampaign)) {
  const dir = path.join(capCampaign, 'fr', chunk);
  const transport = JSON.parse(readFileSync(path.join(dir, 'draft.transport.json')));
  assert.equal(transport.outputLimited, true); assert.equal(transport.timedOut, false); assert.equal(transport.printTimeout, '0s');
  assert.ok(transport.stdoutBytes >= 4 * 1024 * 1024);
  assert.equal(existsSync(path.join(dir, 'review.dispatched.json')), false); assert.equal(existsSync(path.join(dir, 'accepted.json')), false);
}
checkUntouched();
console.log('PASS zero profile still enforces output caps and never reviews/applies capped output');
const updateCampaign = mkdtempSync(path.join(tmpdir(), 'scirepl-tutorial-translation-controller-update-test-'));
const updated = start('controller-test-runner-update', updateCampaign, undefined, ['--chunk', '01']);
const updateResult = await updated.finished;
assert.equal(updateResult.code, 1, 'The deliberately failed review still holds the fixture');
const updateDir = path.join(updateCampaign, 'fr/01');
const draftDispatch = JSON.parse(readFileSync(path.join(updateDir, 'draft.dispatched.json')));
const reviewDispatch = JSON.parse(readFileSync(path.join(updateDir, 'review.dispatched.json')));
assert.equal(draftDispatch.runner.version, '0.0.1'); assert.equal(reviewDispatch.runner.version, '0.0.2');
assert.notEqual(draftDispatch.runner.executableSha256, reviewDispatch.runner.executableSha256);
assert.equal(reviewDispatch.runner.path, fakeRunner); assert.equal(reviewDispatch.runner.informational, true);
assert.equal(existsSync(path.join(updateDir, 'review.child.json')), true, 'Runner byte changes must not block the next phase');
assert.deepEqual(JSON.parse(readFileSync(path.join(updateDir, 'review.transport.json'))).runner, reviewDispatch.runner);
assert.equal(existsSync(path.join(updateDir, 'accepted.json')), false);
checkUntouched();
console.log('PASS ordinary fake-runner update between draft and review is recorded, not an immutable content failure');

for (const [kind, driftFile] of [
  ['source', path.join(fixtureRoot, 'www/help', manifest.pages[0].route, 'index.html')],
  ['request', path.join(requests, 'fr/01.json')],
  ['helper', path.join(fixtureRoot, 'scripts/tutorial_translation_transport.mjs')],
]) {
  const requestFile = path.join(requests, 'fr/01.json'), originalRequest = readFileSync(requestFile), originalFile = readFileSync(driftFile);
  try {
    const request = JSON.parse(originalRequest); request.fixtureDriftFile = driftFile;
    writeFileSync(requestFile, JSON.stringify(request));
    const driftCampaign = mkdtempSync(path.join(tmpdir(), 'scirepl-tutorial-translation-controller-drift-test-'));
    const drifting = start('controller-test-drift', driftCampaign, undefined, ['--chunk', '01']);
    const driftResult = await drifting.finished;
    assert.equal(driftResult.code, 1, kind + ' drift must still block');
    const driftDir = path.join(driftCampaign, 'fr/01');
    assert.equal(existsSync(path.join(driftDir, 'draft.transport.json')), true);
    assert.equal(existsSync(path.join(driftDir, 'review.dispatched.json')), false, kind + ' drift must block before another request');
    assert.equal(existsSync(path.join(driftDir, 'accepted.json')), false);
  } finally { writeFileSync(driftFile, originalFile); writeFileSync(requestFile, originalRequest); }
}
checkUntouched();
console.log('PASS English source, sanitized request and validation-helper drift remain strict dispatch blockers');

const reuseCampaign = mkdtempSync(path.join(tmpdir(), 'scirepl-tutorial-translation-controller-reuse-test-'));
const planFile = path.join(fixtureRoot, 'offline-recovery-plan.json'), claimMarker = path.join(fixtureRoot, 'offline-recovery-claim.txt');
const reusedDraft = { translations: { [field.id]: field.text } };
const reuseCounts = { draft: 0, freshReview: 1, repair: 0 };
writeFileSync(planFile, JSON.stringify({ jobs: [{ locale: 'fr', chunk: '01', requestHash: sha(readFileSync(path.join(requests, 'fr/01.json'))), claimMarker,
  maximumNewCalls: reuseCounts, execution: { draft: reusedDraft, provenance: { fixture: 'successful pinned draft; review only' }, requestCounts: reuseCounts } }] }));
const prepared = spawnSync(process.execPath, [path.join(fixtureRoot, 'scripts/run_tutorial_translations.mjs'), '--locale', 'fr', '--requests', requests,
  '--campaign', reuseCampaign, '--recovery-plan', planFile], { cwd: fixtureRoot, encoding: 'utf8', env: { ...process.env, TMPDIR: fixtureTmp, SCIREPL_TRANSLATION_AGY: fakeRunner } });
assert.equal(prepared.status, 0, prepared.stderr); assert.equal(JSON.parse(prepared.stdout).maximumCalls, 1);
assert.equal(existsSync(claimMarker), false, 'Prepare-only must not reserve or consume a recovery job');
const reused = start('controller-test-runner-update', reuseCampaign, undefined, ['--recovery-plan', planFile]);
const reusedResult = await reused.finished;
assert.equal(reusedResult.code, 1, 'The fake review remains an intentional hold');
const reuseDir = path.join(reuseCampaign, 'fr/01');
for (const name of ['draft.prompt.txt', 'draft.queued.json', 'draft.dispatched.json', 'draft.child.json', 'draft.transport.json']) assert.equal(existsSync(path.join(reuseDir, name)), false, 'A reused draft must never be regenerated');
assert.equal(existsSync(path.join(reuseDir, 'draft.reused.json')), true);
assert.deepEqual(JSON.parse(readFileSync(path.join(reuseDir, 'draft.proposal.json'))), reusedDraft);
assert.equal(existsSync(path.join(reuseDir, 'review.child.json')), true);
assert.equal(existsSync(claimMarker), true, 'Execution claims only once despite dispatch rechecks');
assert.deepEqual(JSON.parse(readFileSync(path.join(reuseDir, 'started.json'))).requestCounts, reuseCounts);
assert.deepEqual(started(reuseCampaign), ['01'], 'Only the exact recovery map may dispatch');
checkUntouched();
console.log('PASS finite recovery selection reuses a successful draft, claims once, and starts only its one fresh review');
console.log('Controller lifecycle: 6 offline scenarios passed; no models or translation applies.');
