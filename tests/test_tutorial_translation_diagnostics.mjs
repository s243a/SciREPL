#!/usr/bin/env node
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, rmSync, utimesSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { classifyDiagnostic, inspectCampaign, readJobDiagnostics, summarizeLatencies } from '../scripts/tutorial_translation_diagnostics.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SECRET = 'PRIVATE_RESPONSE_CREDENTIAL_CONVERSATION_SENTINEL';
const BASE = Date.parse('2026-10-16T00:00:00.000Z');
const save = (file, value, seconds = 0) => { writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); utimesSync(file, new Date(BASE + seconds * 1000), new Date(BASE + seconds * 1000)); };
const workflow = { supervisorAlive: true, controllerAlive: true, workflow: { status: 'running', attentionRequired: false, canAdvance: true, workers: { live: 2, queued: 0, unverifiable: 0 }, units: { planned: 20, completed: 1, held: 0, skipped: 0, remaining: 19 } } };
function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'scirepl-tutorial-translation-diagnostics-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const page = path.join(root, 'ar', '01'); mkdirSync(page, { recursive: true }); save(path.join(page, 'started.json'), {});
  return { root, page };
}
function transport(page, phase, { at = 10, childAt = 0, success = true, error = undefined, response = SECRET, duration = 10, turns = 1, group = SECRET, child = true, code, flags = {} } = {}) {
  if (child) save(path.join(page, phase + '.child.json'), { pid: 12345678, startIdentity: SECRET }, childAt);
  const envelope = { status: success ? 'SUCCESS' : 'ERROR', response, conversation_id: group, duration_seconds: duration, num_turns: turns, ...(error === undefined ? {} : { error }), ...(code === undefined ? {} : { code }) };
  save(path.join(page, phase + '.transport.json'), { stdout: JSON.stringify(envelope), stderr: SECRET, exitCode: 0, timedOut: false, outputLimited: false, cancelled: false, persistenceFailure: false, cliTimeoutWarning: false, ...flags }, at);
}
const category = args => classifyDiagnostic(args).category;

test('explicit login instructions require attention and distinguish interactive sign-in', () => {
  for (const args of [{ codes: ['LOGIN_REQUIRED'] }, { message: 'Login required' }, { message: 'You must log in' }, { message: 'Please log in' }, { message: 'You must sign in' }, { message: 'Not logged in' }]) {
    const result = classifyDiagnostic(args); assert.equal(result.category, 'login_required'); assert.equal(result.loginRequired, true); assert.equal(result.attentionRequired, true);
  }
});
test('401, unauthenticated and expired/revoked session evidence needs auth attention, not assumed login', () => {
  for (const args of [{ codes: [401] }, { codes: ['HTTP_401'] }, { codes: ['UNAUTHENTICATED'] }, { codes: ['INVALID_GRANT'] }, { message: 'HTTP status: 401' }, { message: 'HTTP/1.1 401 Unauthorized' }, { message: 'Session has expired' }, { message: 'Expired session' }, { message: 'Authentication required' }, { message: 'Invalid_grant' }, { message: 'Revoked refresh token' }, { message: 'Refresh token has been revoked' }]) {
    const result = classifyDiagnostic(args); assert.equal(result.category, 'authentication_attention'); assert.equal(result.loginRequired, null); assert.equal(result.attentionRequired, true);
  }
});
test('field numbers and automatic retry forbidden are not HTTP/auth evidence', () => {
  assert.equal(category({ message: 'field.0401 missing', origin: 'validation' }), 'validation_other');
  assert.equal(category({ message: 'field 401 differs', origin: 'validation' }), 'validation_other');
  assert.equal(category({ message: 'Inner translation result is not complete JSON; partial repair/retry is forbidden', origin: 'validation' }), 'validation_incomplete');
  assert.equal(category({ message: 'Transport failed; automatic retry is forbidden', origin: 'validation' }), 'provider_unknown');
});
test('token expiry alone does not prove login is needed', () => {
  for (const args of [{ message: 'Access token has expired; refresh pending' }, { message: 'Expired access token' }, { codes: ['TOKEN_EXPIRED'] }]) {
    const result = classifyDiagnostic(args); assert.equal(result.category, 'token_refresh_unknown'); assert.equal(result.loginRequired, null); assert.equal(result.attentionRequired, false);
  }
  assert.equal(category({ codes: [401], message: 'Token expired' }), 'authentication_attention');
});
test('forbidden/policy is ambiguous and distinct from authentication', () => {
  for (const args of [{ codes: [403] }, { message: 'HTTP 403' }, { codes: ['PERMISSION_DENIED'] }, { message: 'Forbidden' }]) {
    const result = classifyDiagnostic(args); assert.equal(result.category, 'forbidden_ambiguous'); assert.equal(result.loginRequired, null);
  }
});
test('rate, quota, capacity, connection and timeout remain distinct', () => {
  const cases = [[{ codes: [429] }, 'rate_limit'], [{ message: 'Too many requests' }, 'rate_limit'], [{ message: 'Quota exhausted' }, 'quota_or_billing'], [{ codes: ['RESOURCE_EXHAUSTED'] }, 'quota_or_billing'], [{ codes: [503] }, 'capacity_unavailable'], [{ message: 'Connection reset' }, 'network_transport'], [{ message: 'ECONNRESET' }, 'network_transport'], [{ message: 'Deadline exceeded' }, 'timeout']];
  for (const [args, expected] of cases) assert.equal(category(args), expected);
});
test('validation classes are not collapsed into transport failures', () => {
  for (const [message, expected] of [['Keep declaration missing for field 403', 'validation_keep'], ['unprotected numeric values added or changed', 'validation_numeric'], ['protected token order differs', 'validation_placeholder'], ['Draft fields incomplete or added', 'validation_incomplete'], ['Continuation changed conversation identity', 'validation_identity']]) assert.equal(category({ message, origin: 'validation' }), expected);
});
test('classifications never echo supplied raw error text', () => {
  assert(!JSON.stringify(classifyDiagnostic({ message: 'Login required ' + SECRET })).includes(SECRET));
});
test('validation-origin source snippets cannot imply provider authentication failure', () => {
  for (const message of ['Expected source label: please sign in', 'Expected source label: Login required', 'Expected source label: Authentication required', 'Expected source label: HTTP401', 'Expected source label: HTTP 401']) assert.equal(category({ message, origin: 'validation' }), 'validation_other');
});
test('latency summary uses observed samples and nearest-rank quantiles', () => {
  assert.deepEqual(summarizeLatencies([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, null, -1, NaN]), { samples: 10, medianSeconds: 5, p90Seconds: 9, maximumSeconds: 10 });
  assert.deepEqual(summarizeLatencies([]), { samples: 0, medianSeconds: null, p90Seconds: null, maximumSeconds: null });
});
test('successful inner response is never scanned for auth or other diagnostic text', t => {
  const { root, page } = fixture(t); transport(page, 'review-01', { response: 'Login required HTTP 401 token expired ' + SECRET });
  const result = inspectCampaign(root, workflow);
  assert.equal(result.authentication.status, 'worked_at_last_success'); assert.equal(result.authentication.loginRequired, null);
  assert.equal(result.authentication.currentAuthenticationGuaranteed, false); assert.deepEqual(result.calls.failureCategories, {});
  assert(!JSON.stringify(result).includes(SECRET));
});
test('structured provider auth error wins over generic controller hold', t => {
  const { root, page } = fixture(t); transport(page, 'review-01', { success: false, error: { code: 401, message: SECRET }, at: 10 });
  save(path.join(page, 'failed.json'), { phase: 'review-01', error: 'Transport did not report success' }, 11);
  const result = inspectCampaign(root, workflow);
  assert.equal(result.authentication.status, 'authentication_attention'); assert.equal(result.authentication.loginRequired, null); assert.equal(result.attentionRequired, true);
  assert.deepEqual(result.calls.failureCategories, { authentication_attention: 1 }); assert.equal(result.calls.lastFailureAt, new Date(BASE + 10000).toISOString());
  assert(!JSON.stringify(result).includes(SECRET));
});
test('provider error string is classified without inspecting inner response', t => {
  const { root, page } = fixture(t); transport(page, 'review-01', { success: false, error: 'Connection reset ' + SECRET, response: 'HTTP 401 Login required' });
  const result = inspectCampaign(root); assert.deepEqual(result.calls.failureCategories, { network_transport: 1 }); assert.equal(result.authentication.status, 'unknown');
});
test('direct outer login/authentication statuses are explicit failure evidence', t => {
  const { root, page } = fixture(t);
  for (const [index, status] of ['LOGIN_REQUIRED', 'NOT_LOGGED_IN', 'AUTHENTICATION_REQUIRED'].entries()) save(path.join(page, 'review-0' + (index + 1) + '.transport.json'), { stdout: JSON.stringify({ status, response: SECRET }), stderr: '', exitCode: 0, timedOut: false, outputLimited: false, cancelled: false, persistenceFailure: false, cliTimeoutWarning: false }, 10 + index);
  const result = inspectCampaign(root, workflow); assert.deepEqual(result.calls.failureCategories, { login_required: 2, authentication_attention: 1 }); assert.equal(result.attentionRequired, true); assert.equal(result.calls.outerSuccesses, 0); assert.equal(result.authentication.lastSuccessAt, null);
});
test('a later successful call establishes auth worked then, not permanent login health', t => {
  const { root, page } = fixture(t); transport(page, 'review-01', { success: false, code: 401, at: 10 }); transport(page, 'review-02', { at: 20, childAt: 10, duration: 20, turns: 2 });
  const result = inspectCampaign(root, workflow); assert.equal(result.authentication.status, 'worked_after_recorded_auth_failure'); assert.equal(result.authentication.loginRequired, null); assert.equal(result.authentication.currentAuthenticationGuaranteed, false);
});
test('token-expiry warning surfaces refresh uncertainty without claiming required sign-in', t => {
  const { root, page } = fixture(t); transport(page, 'review-01', { success: false, error: 'Token expired' });
  const result = inspectCampaign(root, workflow); assert.equal(result.authentication.status, 'refresh_status_unknown'); assert.equal(result.authentication.loginRequired, null); assert.match(result.recommendedAction, /automatic refresh/);
  assert.equal(result.attentionRequired, true);
});
test('403 surfaces authorization/policy uncertainty rather than login-required', t => {
  const { root, page } = fixture(t); transport(page, 'review-01', { success: false, error: { statusCode: 403 } });
  const result = inspectCampaign(root, workflow); assert.equal(result.authentication.status, 'authorization_or_policy_ambiguous'); assert.equal(result.authentication.loginRequired, null); assert.equal(result.attentionRequired, true);
});
test('completed transport and subsequent validation hold are counted once', t => {
  const { root, page } = fixture(t); transport(page, 'review-01'); save(path.join(page, 'failed.json'), { phase: 'review-01', error: 'field.0403: unprotected numeric values added or changed' }, 11);
  const result = inspectCampaign(root, workflow); assert.equal(result.calls.outerSuccesses, 1); assert.deepEqual(result.calls.failureCategories, { validation_numeric: 1 }); assert.equal(result.authentication.status, 'worked_at_last_success');
});
test('partial/racing JSON is unknown, never zero successful or error outcomes inferred', t => {
  const { root, page } = fixture(t); save(path.join(page, 'review-01.transport.json'), '{"stdout":', 10); save(path.join(page, 'failed.json'), '{', 11);
  const result = inspectCampaign(root); assert.equal(result.coverage.unknownRecords, 2); assert.equal(result.calls.unknownOutcomeRecords, 2); assert.equal(result.authentication.status, 'unknown'); assert.equal(result.authentication.metadataComplete, false); assert.equal(result.workflow.workers.live, null); assert.equal(result.throughput.medianSeconds, null); assert.equal(result.throughput.unknownLatencySamples, 1);
});
test('malformed explicitly failed outer envelope may carry login diagnostic in private stderr', t => {
  const { root, page } = fixture(t); save(path.join(page, 'review-01.transport.json'), { stdout: '{', stderr: 'Login required ' + SECRET, exitCode: 1 }, 10);
  const result = inspectCampaign(root); assert.equal(result.coverage.unknownRecords, 1); assert.equal(result.authentication.status, 'login_required_evidence'); assert.equal(result.authentication.loginRequired, true); assert(!JSON.stringify(result).includes(SECRET));
});
test('missing success outcome flags remain unknown and cannot authorize stderr scanning', t => {
  const { root, page } = fixture(t); save(path.join(page, 'review-01.transport.json'), { stdout: JSON.stringify({ status: 'SUCCESS', response: SECRET }), stderr: 'Please log in ' + SECRET, exitCode: 0 }, 10);
  const result = inspectCampaign(root, workflow); assert.equal(result.calls.outerSuccesses, 0); assert.equal(result.authentication.lastSuccessAt, null); assert.equal(result.authentication.status, 'unknown'); assert.equal(result.authentication.loginRequired, null); assert.equal(result.coverage.unknownRecords, 1); assert.equal(result.attentionRequired, true); assert.equal(result.workflow.workers.live, 2);
});
test('malformed stdout without an explicit failed outcome remains unknown despite misleading stderr', t => {
  const { root, page } = fixture(t); save(path.join(page, 'review-01.transport.json'), { stdout: '{', stderr: 'Please log in', exitCode: 0, timedOut: false, outputLimited: false, cancelled: false, persistenceFailure: false, cliTimeoutWarning: false }, 10);
  const result = inspectCampaign(root, workflow); assert.equal(result.authentication.status, 'unknown'); assert.equal(result.authentication.loginRequired, null); assert.equal(result.attentionRequired, true);
});
test('non-JSON failed stderr HTTP401 is authentication attention rather than assumed login', t => {
  const { root, page } = fixture(t); save(path.join(page, 'review-01.transport.json'), { stdout: '', stderr: 'HTTP 401 Unauthorized ' + SECRET, exitCode: 1 }, 10);
  const result = inspectCampaign(root); assert.equal(result.authentication.status, 'authentication_attention'); assert.equal(result.authentication.loginRequired, null); assert.equal(result.coverage.unknownRecords, 1); assert(!JSON.stringify(result).includes(SECRET));
});
test('timeout and output-limit flags have explicit categories even without JSON', t => {
  const { root, page } = fixture(t); save(path.join(page, 'review-01.transport.json'), { stdout: '', stderr: '', exitCode: 1, timedOut: true }, 10); save(path.join(page, 'review-02.transport.json'), { stdout: '', stderr: '', exitCode: 1, outputLimited: true }, 20);
  const result = inspectCampaign(root); assert.deepEqual(result.calls.failureCategories, { timeout: 1, output_limit: 1 }); assert.equal(result.authentication.status, 'unknown');
});
test('contradictory SUCCESS plus error payload or is_error never establishes auth success', t => {
  const { root, page } = fixture(t); transport(page, 'review-01', { success: true, error: { code: 401, message: SECRET } });
  save(path.join(page, 'review-02.transport.json'), { stdout: JSON.stringify({ status: 'SUCCESS', is_error: true, error: 'Please log in ' + SECRET, response: SECRET }), exitCode: 0, stderr: '' }, 20);
  const result = inspectCampaign(root); assert.equal(result.calls.outerSuccesses, 0); assert.equal(result.authentication.lastSuccessAt, null); assert.equal(result.authentication.status, 'login_required_evidence'); assert.equal(result.authentication.loginRequired, true); assert(!JSON.stringify(result).includes(SECRET));
});
test('oversized metadata is unknown and never parsed', t => {
  const { root, page } = fixture(t); save(path.join(page, 'review-01.transport.json'), ' '.repeat(8 * 1024 * 1024 + 1), 10);
  const result = inspectCampaign(root); assert.equal(result.coverage.unknownRecords, 1); assert.equal(result.coverage.readableTransports, 0); assert.equal(result.authentication.status, 'unknown');
});
test('mtime latency wins over cumulative duration counters', t => {
  const { root, page } = fixture(t); transport(page, 'review-01', { at: 110, childAt: 100, duration: 300, turns: 1 }); transport(page, 'review-02', { at: 130, childAt: 110, duration: 700, turns: 2 });
  const result = inspectCampaign(root); assert.equal(result.throughput.samples, 2); assert.equal(result.throughput.medianSeconds, 10); assert.equal(result.throughput.maximumSeconds, 20); assert.equal(result.throughput.childToReceiptSamples, 2);
});
test('cumulative durations are differenced privately when child timing is absent', t => {
  const { root, page } = fixture(t); transport(page, 'review-01', { at: 110, duration: 100, turns: 1, child: false }); transport(page, 'review-02', { at: 130, duration: 125, turns: 2, child: false });
  const result = inspectCampaign(root); assert.equal(result.throughput.maximumSeconds, 100); assert.equal(result.throughput.medianSeconds, 25); assert.equal(result.throughput.cumulativeDeltaSamples, 2); assert(!JSON.stringify(result).includes(SECRET));
});
test('missing conversation turns and backwards clocks do not fabricate per-call latency', t => {
  const { root, page } = fixture(t); transport(page, 'review-01', { at: 10, childAt: 20, duration: 100, turns: 3 }); transport(page, 'review-02', { at: 20, childAt: 30, duration: 125, turns: 5 });
  const result = inspectCampaign(root); assert.equal(result.throughput.samples, 0); assert.equal(result.throughput.unknownLatencySamples, 2); assert.equal(result.throughput.maximumSeconds, null);
});
test('symlinked records and directories are not followed', t => {
  const { root, page } = fixture(t); const outside = path.join(root, 'outside.json'); save(outside, { stdout: JSON.stringify({ status: 'ERROR', error: 'Login required' }) }); symlinkSync(outside, path.join(page, 'review-01.transport.json')); symlinkSync(page, path.join(root, 'alias'));
  const result = inspectCampaign(root); assert.equal(result.calls.transportRecordsFound, 0); assert.equal(result.authentication.status, 'unknown');
  assert(result.coverage.unknownRecords > 0); assert.equal(result.authentication.metadataComplete, false); assert.equal(result.attentionRequired, true);
});
test('unreadable campaign is explicitly unknown rather than empty verified history', t => {
  const { root } = fixture(t); const result = inspectCampaign(path.join(root, 'does-not-exist'));
  assert.equal(result.coverage.unreadableDirectories, 1); assert.equal(result.authentication.metadataComplete, false); assert.equal(result.workflow.canAdvance, null);
  assert.equal(result.attentionRequired, true);
});
test('no transport records means authentication was not checked', t => {
  const { root } = fixture(t); const result = inspectCampaign(root, workflow); assert.equal(result.authentication.status, 'unknown'); assert.equal(result.authentication.metadataComplete, false); assert.equal(result.authentication.lastSuccessAt, null);
});
test('only fixed workflow status values are exposed', t => {
  const { root } = fixture(t); const result = inspectCampaign(root, { workflow: { status: 'private_sentinel_status' } }); assert.equal(result.workflow.status, 'unknown'); assert.equal(result.workflow.workers.live, null);
});
function hashes(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name); return entry.isDirectory() ? hashes(file) : [[file, createHash('sha256').update(readFileSync(file)).digest('hex')]];
  });
}
test('campaign inspection is read-only and ignores worker logs, prompts and proposals', t => {
  const { root, page } = fixture(t); transport(page, 'review-01');
  for (const name of ['worker.log', 'review-01.prompt.txt', 'review-01.proposal.json']) save(path.join(page, name), 'Login required ' + SECRET);
  const before = hashes(root); const result = inspectCampaign(root, workflow); assert.deepEqual(hashes(root), before); assert.equal(result.authentication.status, 'worked_at_last_success'); assert(!JSON.stringify(result).includes(SECRET));
});
test('CLI uses read-only local status and prints only allowlisted metadata', t => {
  const { root: campaign, page } = fixture(t); transport(page, 'review-01');
  const job = mkdtempSync(path.join(tmpdir(), 'scirepl-tutorial-translation-job-diagnostics-test-')); t.after(() => rmSync(job, { recursive: true, force: true }));
  save(path.join(job, 'config.json'), { schema: 1, root: ROOT, job, campaign, sectionsPlan: path.join(campaign, 'plan.json'), controller: path.join(ROOT, 'scripts/run_tutorial_section_translations.mjs'), printTimeout: '0s', watchdogTimeout: '0s', pollIntervalSeconds: 30, nonce: randomUUID() });
  const beforeJob = hashes(job), beforeCampaign = hashes(campaign); const result = readJobDiagnostics(job); assert.equal(result.statusReadable, true); assert.equal(result.workflow.status, 'needs_inspection'); assert.equal(result.authentication.status, 'worked_at_last_success');
  const cli = spawnSync(process.execPath, [path.join(ROOT, 'scripts/tutorial_translation_diagnostics.mjs'), '--job', job], { encoding: 'utf8' }); assert.equal(cli.status, 0); assert.equal(cli.stderr, ''); const output = JSON.parse(cli.stdout); assert.equal(output.observationOnly, true); assert(!cli.stdout.includes(SECRET)); assert.deepEqual(hashes(job), beforeJob); assert.deepEqual(hashes(campaign), beforeCampaign);
});
test('CLI unavailable metadata is sanitized and remains unknown', () => {
  const cli = spawnSync(process.execPath, [path.join(ROOT, 'scripts/tutorial_translation_diagnostics.mjs'), '--job', '/tmp/scirepl-tutorial-translation-job-does-not-exist-' + randomUUID()], { encoding: 'utf8' }); assert.equal(cli.status, 1); assert.equal(cli.stderr, ''); const value = JSON.parse(cli.stdout); assert.equal(value.authentication.status, 'unknown'); assert.equal(value.authentication.loginRequired, null); assert.equal(value.reasonCode, 'diagnostic_metadata_unavailable');
});

test('live long review now requires progress inspection and excludes in-flight auth coverage', t => {
  const { root, page } = fixture(t); transport(page, 'review-01');
  for (const phase of ['review-01', 'review-02']) save(path.join(page, phase + '.dispatched.json'), { private: SECRET });
  save(path.join(page, 'review-02.child.json'), { private: SECRET });
  const raw = readFileSync(`/proc/${process.pid}/stat`, 'utf8'), values = raw.slice(raw.lastIndexOf(')') + 2).trim().split(/\s+/);
  const worker = { pid: process.pid, startIdentity: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() + ':' + values[19] };
  const snapshot = { ...workflow, state: 'running', progress: {
    updatedAt: new Date().toISOString(), recoveryBudget: { usedDraftCalls: 0, maxDraftCalls: 0, usedReviewCalls: 2, maxReviewCalls: 2 },
    phases: [
      { locale: 'ar', chunk: '01', phase: 'review-01', state: 'completed' },
      { locale: 'ar', chunk: '01', phase: 'review-02', state: 'running', elapsedSeconds: 52000, stdoutBytes: 10, stderrBytes: 1, worker },
    ],
  } };
  const before = hashes(root), result = inspectCampaign(root, snapshot);
  assert.equal(result.ownerWorkflow.status, 'running'); assert.equal(result.workflow.status, 'needs_inspection');
  assert.equal(result.workflow.canAdvance, null); assert.equal(result.attentionRequired, true);
  assert.equal(result.activity.status, 'progress_unknown'); assert.equal(result.activity.lastOutputAt, null);
  assert.equal(result.orchestration.reasonCode, 'review_budget_exhausted'); assert.equal(result.orchestration.replacementAllowed, false);
  assert.equal(result.inflight.outstandingDispatches, 1); assert.equal(result.inflight.outstandingChildren, 1);
  assert.equal(result.authentication.completedMetadataComplete, true); assert.equal(result.authentication.metadataComplete, false);
  assert.equal(result.authentication.currentAuthenticationGuaranteed, false);
  assert(!JSON.stringify(result).includes(SECRET)); assert.deepEqual(hashes(root), before);
});

test('a running worker with no model request beyond the advisory asks for the inspector; stuck-worker outcomes and reports are surfaced', t => {
  const { root, page } = fixture(t);
  const glog = ms => { const at = new Date(ms), two = n => String(n).padStart(2, '0'); return `I${two(at.getMonth() + 1)}${two(at.getDate())} ${two(at.getHours())}:${two(at.getMinutes())}:${two(at.getSeconds())}.000000 1 h.go:1] `; };
  const log = path.join(page, 'review-02.agy.log');
  writeFileSync(log, glog(Date.now() - 7200000) + 'URL: https://x/v1:streamGenerateContent ' + SECRET + '\n' + glog(Date.now() - 60000) + 'token refreshed\n');
  save(path.join(page, 'review-02.dispatched.json'), { agyLogPath: log });
  save(path.join(page, 'review-01.inspect-2026-10-18T00-00-00-000Z.json'), { classification: 'complete-not-exited', reasonCode: 'complete-output-stream-exited-no-shutdown', stack: { knownSignature: 'title-generation-hang' }, recommendation: { action: 'review-held-output', rationale: SECRET } });
  const snapshot = { ...workflow, state: 'running', progress: { updatedAt: new Date().toISOString(), phases: [
    { locale: 'ar', chunk: '01', phase: 'review-01', state: 'completed', outcome: 'accepted-after-stuck-worker', manualReviewSuggested: true, knownSignature: 'title-generation-hang' },
    { locale: 'ar', chunk: '01', phase: 'review-02', state: 'running', elapsedSeconds: 7300 },
  ] } };
  const result = inspectCampaign(root, snapshot, { job: '/tmp/scirepl-tutorial-translation-job-example' });
  assert.equal(result.workerInspection.attentionRequired, true); assert.equal(result.attentionRequired, true);
  assert.match(result.workerInspection.recommendedAction, /tutorial_translation_inspect\.mjs --job \/tmp\/scirepl-tutorial-translation-job-example --phase ar\/01\/review-02/);
  const running = result.workerInspection.phases.find(row => row.phase === 'ar/01/review-02');
  assert.equal(running.noRecentModelRequest, true); assert(running.secondsSinceModelRequest > 7000);
  const done = result.workerInspection.phases.find(row => row.phase === 'ar/01/review-01');
  assert.equal(done.outcome, 'accepted-after-stuck-worker'); assert.equal(done.manualReviewSuggested, true);
  assert.equal(done.latestInspection.classification, 'complete-not-exited'); assert.equal(done.latestInspection.knownSignature, 'title-generation-hang'); assert.equal(done.latestInspection.recommendation, 'review-held-output');
  assert(!JSON.stringify(result).includes(SECRET));
});
