#!/usr/bin/env node
// Offline only: fake AGY workers started by this test, a fixture crashes dir,
// and synthetic campaigns. No provider calls; only our own fakes are signalled.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { getProcessStartIdentity } from '../scripts/tutorial_translation_queue.mjs';
import { summarizeGoroutineDump, acceptStuckAfterCompletion, stackFunctionName, envelopeMetadata } from '../scripts/tutorial_translation_transport.mjs';
import { scanAgyLog, parseLogTimestamp, classifyWorker } from '../scripts/tutorial_translation_inspect.mjs';
import { validateStuckApproval } from '../scripts/tutorial_section_stuck_acceptance.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const INSPECT = path.join(ROOT, 'scripts/tutorial_translation_inspect.mjs');
const SENTINEL = 'PRIVATE_PROMPT_RESPONSE_SENTINEL_4417';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const started = [];
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function worker(mode, config = {}, row = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'scirepl-inspect-fixture-')), crashes = path.join(root, 'crashes'); mkdirSync(crashes);
  const fake = path.join(root, 'offline-agy.mjs'); copyFileSync(path.join(ROOT, 'tests/fixtures/tutorial_section_fake_cli.mjs'), fake);
  writeFileSync(path.join(root, 'fake-config.json'), JSON.stringify({ mode, crashesDir: crashes, logSentinel: SENTINEL, ...config }));
  const campaign = mkdtempSync('/tmp/scirepl-tutorial-translation-inspect-test-'), dir = path.join(campaign, 'fr', '01'); mkdirSync(dir, { recursive: true });
  const logFile = path.join(dir, 'review-01.agy.log'), workspace = mkdtempSync(path.join(tmpdir(), 'scirepl-inspect-workspace-'));
  const prompt = 'Rules ' + SENTINEL + '\nBEGIN UNTRUSTED REVIEW SECTION\n' + JSON.stringify({ route: 'alpha', fields: [{ id: 'alpha.one', text: SENTINEL }] }) + '\nEND UNTRUSTED REVIEW SECTION';
  const child = spawn(process.execPath, [fake, '--output-format', 'json', '--log-file', logFile, '-p', prompt], { cwd: workspace, stdio: ['ignore', 'pipe', 'pipe'] });
  started.push(child); let stdout = ''; child.stdout.on('data', text => { stdout += text; });
  const exited = new Promise(resolve => child.on('exit', (code, signal) => resolve({ code, signal })));
  for (let i = 0; i < 200 && !(stdout.length && existsSync(logFile)); i++) await sleep(25);
  assert(stdout.length > 0, 'fake worker produced output');
  const workerRecord = { pid: child.pid, startIdentity: config.wrongIdentity ? 'ffffffff-ffff-ffff-ffff-ffffffffffff:1' : getProcessStartIdentity(child.pid) };
  writeFileSync(path.join(dir, 'review-01.child.json'), JSON.stringify(workerRecord));
  writeFileSync(path.join(dir, 'review-01.dispatched.json'), JSON.stringify({ agyLogPath: logFile, postCompletionGraceSeconds: 90 }));
  writeFileSync(path.join(campaign, 'controller-status.json'), JSON.stringify({ schema: 1, state: 'running', recoveryBudget: { maxReviewCalls: 3, usedReviewCalls: 1, allowanceMaxReviewCalls: 5, allowanceUsedReviewCalls: 4, allowanceId: 'offline-allowance' },
    phases: [{ locale: 'fr', chunk: '01', phase: 'review-01', state: 'running', worker: workerRecord, stdoutBytes: Buffer.byteLength(stdout), stderrBytes: 0, ...row }] }));
  return { root, crashes, campaign, dir, child, exited, stdout: () => stdout };
}
function inspect(test, extra = []) {
  const result = spawnSync(process.execPath, [INSPECT, '--campaign', test.campaign, '--phase', 'fr/01/review-01', '--sample-seconds', '1', ...extra],
    { encoding: 'utf8', env: { ...process.env, SCIREPL_AGY_CRASHES_DIR: test.crashes }, timeout: 60000 });
  assert(result.stdout, result.stderr);
  return { status: result.status, run: JSON.parse(result.stdout), report: JSON.parse(result.stdout).reports[0], raw: result.stdout };
}
function assertNoPrivateText(test, raw) {
  assert(!raw.includes(SENTINEL), 'printed report carries no prompt/response/log text');
  for (const name of readdirSync(test.dir).filter(name => /\.(?:inspect-.*|stack-summary|stack-request)\.json$/.test(name))) {
    assert(!readFileSync(path.join(test.dir, name), 'utf8').includes(SENTINEL), name + ' carries no private text');
  }
  assert(!raw.includes('Texte traduit'), 'no response translation text');
}

try {
  // ---- Pure units ----
  assert.equal(stackFunctionName('google3/x/cortex/cortex.(*CascadeManager).Shutdown(0x1, {0x2, 0x3})'), 'cortex.(*CascadeManager).Shutdown');
  assert.equal(stackFunctionName('google3/go/context/detach.Go.func1()'), 'detach.Go.func1');
  const titleDump = ['goroutine 1 gp=0x1 m=nil [select]:', 'runtime.gopark(0x1)', '\tproc.go:1', 'x/background.(*Pool).close(0x1)', '\tb.go:1', 'x/cortex.(*CascadeManager).Shutdown(0x1, {"' + SENTINEL + '"})', '\tc.go:1', '',
    'goroutine 9 gp=0x2 m=nil [chan receive, 7 minutes]:', 'runtime.gopark(0x1)', '\tproc.go:1', 'x/codeassistclient.(*channelModelResponseStream).Err(0x1)', '\ts.go:1', 'x/cortex.(*CascadeManager).maybeGenerateConversationTitle.func1({0x1})', '\tt.go:1', 'created by x/background.(*Pool).Go in goroutine 1', '\tb.go:2', ''].join('\n');
  const title = summarizeGoroutineDump(titleDump, { completeOutput: true });
  assert.equal(title.knownSignature, 'title-generation-hang'); assert.equal(title.totalGoroutines, 2);
  assert.deepEqual(title.main.frames, ['background.(*Pool).close', 'cortex.(*CascadeManager).Shutdown']);
  assert.deepEqual(title.blocked, [{ id: 9, state: 'chan receive', waitMinutes: 7, frames: ['codeassistclient.(*channelModelResponseStream).Err', 'cortex.(*CascadeManager).maybeGenerateConversationTitle.func1'], createdBy: 'background.(*Pool).Go' }]);
  assert(!JSON.stringify(title).includes(SENTINEL));
  const mcp = summarizeGoroutineDump(titleDump.replace('maybeGenerateConversationTitle.func1', 'run').replace('(*channelModelResponseStream).Err', 'mcp.(*Instance).Close'), { completeOutput: true });
  assert.equal(mcp.knownSignature, 'mcp-close-wait');
  const stream = summarizeGoroutineDump('goroutine 1 [select]:\nx/codeassistclient.(*CodeAssistClient).streamGenerateContentFromCCPA(0x1)\n\tf.go:1\n', { completeOutput: false });
  assert.equal(stream.knownSignature, 'model-stream-wait');
  assert.equal(summarizeGoroutineDump('goroutine 1 [select]:\nmain.main()\n\tm.go:1\n').knownSignature, null);
  console.log('PASS goroutine dumps parse to function names only and match title/MCP/model-stream signatures');

  const reference = new Date(2026, 9, 18, 12, 0, 0).getTime();
  assert.equal(parseLogTimestamp('I1018 11:59:30.250000       1 a.go:1] x', reference), new Date(2026, 9, 18, 11, 59, 30, 250).getTime());
  assert.equal(parseLogTimestamp('I1231 23:00:00.000000 1 a.go:1] x', reference), new Date(2025, 11, 31, 23, 0, 0).getTime(), 'year rolls back for future-dated glog');
  const scan = scanAgyLog(['I1018 11:00:00.000000 1 p.go:1] Print mode: starting', 'I1018 11:00:01.000000 1 p.go:1] Print mode: silent auth succeeded', 'I1018 11:00:02.000000 1 s.go:1] sending message ' + SENTINEL,
    'I1018 11:00:03.000000 1 h.go:1] URL: https://x/v1:streamGenerateContent?alt=sse', 'E1018 11:00:04.000000 1 m.go:1] MCP server connection closed ' + SENTINEL, 'I1018 11:01:00.000000 1 s.go:1] Stream goroutine exited for ' + SENTINEL].join('\n'), { referenceMs: reference });
  assert.equal(scan.markers.streamGenerateContent.count, 1); assert.equal(scan.markers.mcpClose.count, 1); assert.equal(scan.errorLines, 1);
  assert.equal(scan.shutdownAfterStream, false); assert.equal(scan.mainIdleSinceMs, new Date(2026, 9, 18, 11, 1, 0).getTime());
  assert(!JSON.stringify(scan).includes(SENTINEL));
  const now = new Date(2026, 9, 18, 11, 2, 0).getTime();
  assert.equal(classifyWorker({ identity: 'verified', output: { completeOutput: true }, log: { readable: true, streamExitedAt: 'x', shutdownAfterStream: false }, nowMs: now }).classification, 'complete-not-exited');
  assert.equal(classifyWorker({ identity: 'verified', output: {}, log: { readable: true, lastModelRequestAt: new Date(now - 30000).toISOString() }, nowMs: now }).classification, 'streaming');
  assert.equal(classifyWorker({ identity: 'verified', output: {}, log: { readable: true, lastModelRequestAt: new Date(now - 3600000).toISOString() }, nowMs: now }).classification, 'idle-no-output');
  assert.equal(classifyWorker({ identity: 'mismatch' }).reasonCode, 'pid-identity-mismatch');
  console.log('PASS AGY log markers are counted with timestamps only, and pure classification covers each class');

  const envelope = JSON.stringify({ status: 'SUCCESS', conversation_id: SENTINEL, response: JSON.stringify({ translations: { a: SENTINEL } }), duration_seconds: 3.5, usage: { input_tokens: 2, note: SENTINEL } });
  assert.deepEqual(envelopeMetadata(envelope), { status: 'SUCCESS', durationSeconds: 3.5, usage: { input_tokens: 2 } });
  const stuck = { stdout: envelope, stderr: '', exitCode: 2, timedOut: false, outputLimited: false, cancelled: false, persistenceFailure: false, stuckAfterCompleteOutput: true, completeOutputAt: '2026-10-18T00:00:00.000Z', stuckTerminatedAt: '2026-10-18T00:01:30.000Z' };
  assert.deepEqual(acceptStuckAfterCompletion(stuck, title), { translations: { a: SENTINEL } });
  assert.throws(() => acceptStuckAfterCompletion(stuck, mcp), /stuck after complete output/);
  assert.throws(() => acceptStuckAfterCompletion(stuck, null), /stuck after complete output/);
  assert.throws(() => acceptStuckAfterCompletion({ ...stuck, stuckAfterCompleteOutput: false }, title), /Not a stuck/);
  assert.throws(() => acceptStuckAfterCompletion({ ...stuck, completeOutputAt: '2026-10-18T00:02:00.000Z' }, title), /precede/);
  assert.throws(() => acceptStuckAfterCompletion({ ...stuck, stdout: envelope.replace('SUCCESS', 'ERROR') }, title), /did not report success/);
  assert.throws(() => acceptStuckAfterCompletion({ ...stuck, stderr: 'print timeout reached' }, title), /timeout warning/);
  const approval = { schema: 1, kind: 'user-approved-stuck-worker-acceptance', approvalId: 'offline-approval-1', approvedBy: 'offline owner', approvedAt: '2026-10-18T00:00:00.000Z',
    sourceJob: '/tmp/scirepl-tutorial-translation-job-offline', phase: 'ru/01/review-01', outcome: 'accepted-after-stuck-worker', manualReviewSuggested: true, automaticRetries: false, modelCalls: 0,
    transport: { file: '/tmp/x', sha256: 'a'.repeat(64) }, evidence: { stackSummary: title } };
  assert.equal(validateStuckApproval(approval).approvalId, 'offline-approval-1');
  assert.throws(() => validateStuckApproval({ ...approval, evidence: { stackSummary: mcp } }), /title-generation-hang/);
  assert.throws(() => validateStuckApproval({ ...approval, evidence: { stackSummary: { ...mcp, knownSignature: 'title-generation-hang' } } }), /do not show/);
  assert.throws(() => validateStuckApproval({ ...approval, modelCalls: 1 }));
  console.log('PASS stuck-worker acceptance requires title-generation-hang and still runs every transport check; one-off approvals re-match the signature');

  // ---- Live fakes ----
  const streaming = await worker('stream-wait', { modelRequestAgoSeconds: 0, stackSignature: 'stream' });
  const s1 = inspect(streaming);
  assert.equal(s1.status, 0); assert.equal(s1.report.classification, 'streaming'); assert.equal(s1.report.recommendation.action, 'wait');
  assert.equal(s1.report.process.identity, 'verified'); assert.equal(typeof s1.report.process.cpuTicksDelta, 'number'); assert.equal(s1.report.policy.remainingReviewCalls, 1);
  assert.equal(s1.report.policy.retryAllowed, false); assert.equal(s1.report.agyLog.markers.silentAuthSucceeded.count, 1);
  assert(existsSync(s1.report.reportPath) && s1.report.reportPath.startsWith(streaming.dir + '/review-01.inspect-'));
  const refused = inspect(streaming, ['--stack']);
  assert.equal(refused.status, 2); assert.equal(refused.report.refused.reasonCode, 'termination-needs-user-approval'); assert(alive(streaming.child.pid), 'refusal never signals');
  assertNoPrivateText(streaming, s1.raw + refused.raw);
  console.log('PASS a streaming worker is classified wait, and --stack without completion is refused without a signal');

  const idle = await worker('stream-wait', { modelRequestAgoSeconds: 7200, stackSignature: 'stream' });
  const i1 = inspect(idle);
  assert.equal(i1.report.classification, 'idle-no-output'); assert.equal(i1.report.recommendation.action, 'inspect-stack');
  assert.match(i1.report.recommendation.rationale, /--confirm-terminate WITH user approval/);
  const dumped = inspect(idle, ['--stack', '--confirm-terminate']);
  assert.equal(dumped.status, 0); assert.equal(dumped.report.stack.knownSignature, 'model-stream-wait'); assert.equal(dumped.report.recommendation.action, 'follow-up-prompt');
  assert.deepEqual(await idle.exited, { code: 2, signal: null });
  assertNoPrivateText(idle, i1.raw + dumped.raw);
  console.log('PASS an idle worker without output is classified idle-no-output; a user-approved dump shows model-stream-wait');

  const pending = await worker('stuck-after-complete', { stackSignature: 'title' }, { completeOutput: true, completeOutputAt: new Date().toISOString(), completeOutputSummary: { status: 'SUCCESS', durationSeconds: 1, usage: { input_tokens: 1 } }, postCompletionGraceSeconds: 90 });
  const p1 = inspect(pending, ['--stack']);
  assert.equal(p1.report.classification, 'complete-not-exited'); assert.equal(p1.report.refused.reasonCode, 'controller-grace-pending'); assert.equal(p1.report.recommendation.action, 'wait');
  assert(alive(pending.child.pid));
  assert.equal(p1.report.output.envelopeStatus, 'SUCCESS'); assert.equal(p1.report.output.durationSeconds, 1);
  console.log('PASS complete output inside the controller grace is left to the controller (no race)');

  const complete = await worker('stuck-after-complete', { stackSignature: 'title' }, { completeOutput: true, completeOutputAt: new Date(Date.now() - 600000).toISOString(), postCompletionGraceSeconds: 90 });
  const c1 = inspect(complete);
  assert.equal(c1.report.classification, 'complete-not-exited'); assert.equal(c1.report.recommendation.action, 'inspect-stack'); assert.equal(c1.report.policy.stackAllowedWithoutConfirmation, true);
  const c2 = inspect(complete, ['--stack']);
  assert.equal(c2.status, 0); assert.equal(c2.report.stack.knownSignature, 'title-generation-hang'); assert.equal(c2.report.recommendation.action, 'review-held-output');
  assert(existsSync(path.join(complete.dir, 'review-01.stack-request.json')) && existsSync(path.join(complete.dir, 'review-01.stack-summary.json')));
  assert.deepEqual(await complete.exited, { code: 2, signal: null });
  assert(!readdirSync(complete.dir).some(name => name.startsWith('crash_')), 'raw crash logs are never copied into the campaign');
  assertNoPrivateText(complete, c1.raw + c2.raw);
  console.log('PASS complete-not-exited allows a dump without confirmation and recognises the title-generation hang');

  const mismatch = await worker('stream-wait', { wrongIdentity: true, stackSignature: 'stream' });
  const m1 = inspect(mismatch, ['--stack', '--confirm-terminate']);
  assert.equal(m1.status, 2); assert.equal(m1.report.refused.reasonCode, 'pid-identity-mismatch'); assert(alive(mismatch.child.pid), 'identity mismatch is never signalled');
  assert(!existsSync(path.join(mismatch.dir, 'review-01.stack-request.json')));
  console.log('PASS a PID whose start identity differs is refused and never signalled');
  console.log('Worker inspector: 8 offline groups passed; no provider requests.');
} finally {
  for (const child of started) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}
