#!/usr/bin/env node
// Worker inspection for an idle-looking translation phase. Default mode is
// strictly observational: verified process facts, numeric/boolean output
// metadata, and a fixed allowlist of AGY log markers (name + timestamp only).
// It never reads prompts, response bodies, conversation IDs or free log text.
//
// --stack is opt-in: it asks AGY for a Go goroutine dump (SIGQUIT, which also
// terminates it) and keeps only a parsed summary. Without --confirm-terminate
// it is allowed only when the worker already printed complete output and the
// controller is not about to do the same thing itself. An agent must pass
// --confirm-terminate only with the user's explicit approval: terminating an
// incomplete call loses that (already charged) call.
//
// The report recommends; it never accepts, retries, or changes allowances.
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectCrashSummary, crashesDirectory, STUCK_ACCEPTANCE_SIGNATURE } from './tutorial_translation_transport.mjs';

const SCRIPT = fileURLToPath(import.meta.url);
export const INSPECT_POLICY = Object.freeze({ idleAfterSeconds: 600, sampleSeconds: 5, advisoryAfterSeconds: 1800 });
const RUNNING = new Set(['running', 'launching', 'stuck-after-completion']);
const finite = value => typeof value === 'number' && Number.isFinite(value);
const iso = ms => finite(ms) ? new Date(ms).toISOString() : null;
const seconds = ms => finite(ms) ? Math.round(ms / 100) / 10 : null;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function readJson(file) {
  try { const info = lstatSync(file); if (!info.isFile() || info.isSymbolicLink() || info.size > 8 * 1024 * 1024) return null; return JSON.parse(readFileSync(file, 'utf8')); }
  catch { return null; }
}

// ---- AGY log markers (fixed allowlist; never free text) ----
export const LOG_MARKERS = Object.freeze([
  ['silentAuthSucceeded', /silent auth succeeded/],
  ['tokenRefreshed', /\btoken refreshed\b/i],
  ['printModeStarting', /Print mode: starting\b/],
  ['sendingMessage', /\bsending message\b/],
  ['streamGenerateContent', /streamGenerateContent/],
  ['streamGoroutineExited', /Stream goroutine exited/],
  ['languageServerShuttingDown', /Language server shutting down/],
  ['gotSignal', /\bGot signal\b/],
  ['mcpStart', /\bMCP\b.{0,80}\b(?:start(?:ed|ing)?|launch(?:ed|ing)?|initiali[sz]ed)\b/i],
  ['mcpClose', /\bMCP\b.{0,80}\bclose[ds]?\b|\bclose MCP\b/i],
]);
// glog "I1017 17:15:28.758894 ..." (local time, no year) or an ISO prefix.
export function parseLogTimestamp(line, referenceMs = Date.now()) {
  const glog = line.match(/^[IWEF](\d{2})(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?\b/);
  if (glog) {
    const [, month, day, hour, minute, second, fraction = '0'] = glog, reference = new Date(referenceMs);
    let at = new Date(reference.getFullYear(), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second), Number(fraction.padEnd(3, '0').slice(0, 3))).getTime();
    if (at > referenceMs + 86400000) at = new Date(reference.getFullYear() - 1, Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second), Number(fraction.padEnd(3, '0').slice(0, 3))).getTime();
    return at;
  }
  const isoMatch = line.match(/^\[?(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)/);
  if (isoMatch) { const at = Date.parse(isoMatch[1].replace(' ', 'T')); return Number.isFinite(at) ? at : null; }
  return null;
}
export function scanAgyLog(text, { referenceMs = Date.now() } = {}) {
  const markers = Object.fromEntries(LOG_MARKERS.map(([name]) => [name, { count: 0, firstAt: null, lastAt: null }]));
  let errorLines = 0, lines = 0;
  const first = {}, last = {};
  for (const line of String(text).split('\n')) {
    if (!line) continue; lines++;
    const at = parseLogTimestamp(line, referenceMs);
    if (/^E\d{4} /.test(line) || /\blevel=error\b/i.test(line)) errorLines++;
    for (const [name, pattern] of LOG_MARKERS) if (pattern.test(line)) {
      markers[name].count++;
      if (at !== null) { first[name] ??= at; last[name] = at; }
    }
  }
  for (const [name] of LOG_MARKERS) { markers[name].firstAt = iso(first[name]); markers[name].lastAt = iso(last[name]); }
  const lastModel = Math.max(last.streamGenerateContent ?? -Infinity, last.sendingMessage ?? -Infinity);
  const streamExited = last.streamGoroutineExited ?? null, shutdown = last.languageServerShuttingDown ?? null;
  const shutdownAfterStream = shutdown !== null && (streamExited === null || shutdown >= streamExited);
  const mainIdleSince = streamExited !== null && !shutdownAfterStream ? streamExited : finite(lastModel) ? lastModel : null;
  return { lines, errorLines, markers, lastModelRequestMs: finite(lastModel) ? lastModel : null, streamExitedMs: streamExited, shutdownMs: shutdown, shutdownAfterStream, mainIdleSinceMs: mainIdleSince };
}
export function readAgyLog(file, nowMs = Date.now()) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) return { path: null, readable: false };
  try {
    const info = lstatSync(file); if (!info.isFile() || info.isSymbolicLink()) return { path: file, readable: false };
    const limit = 64 * 1024 * 1024, buffer = readFileSync(file);
    const text = buffer.length > limit ? buffer.subarray(buffer.length - limit).toString('utf8') : buffer.toString('utf8');
    const scan = scanAgyLog(text, { referenceMs: info.mtimeMs });
    return { path: file, readable: true, truncatedToTail: buffer.length > limit, lines: scan.lines, errorLines: scan.errorLines, markers: scan.markers,
      lastModelRequestAt: iso(scan.lastModelRequestMs), secondsSinceModelRequest: scan.lastModelRequestMs !== null ? seconds(nowMs - scan.lastModelRequestMs) : null,
      streamExitedAt: iso(scan.streamExitedMs), secondsSinceStreamExited: scan.streamExitedMs !== null ? seconds(nowMs - scan.streamExitedMs) : null,
      languageServerShutdownAt: iso(scan.shutdownMs), shutdownAfterStream: scan.shutdownAfterStream,
      mainIdleSinceAt: iso(scan.mainIdleSinceMs), mainIdleSeconds: scan.mainIdleSinceMs !== null ? seconds(nowMs - scan.mainIdleSinceMs) : null,
      lastWriteAt: iso(info.mtimeMs) };
  } catch { return { path: file, readable: false }; }
}

// ---- Process facts (Linux /proc; never cmdline or environment) ----
const bootId = () => readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
function procStat(pid) {
  const raw = readFileSync(`/proc/${pid}/stat`, 'utf8'), end = raw.lastIndexOf(')');
  const values = raw.slice(end + 2).trim().split(/\s+/);
  return { comm: raw.slice(raw.indexOf('(') + 1, end), state: values[0], ppid: Number(values[1]), cpuTicks: Number(values[11]) + Number(values[12]), threads: Number(values[17]), starttime: values[19] };
}
export function verifyWorkerIdentity(worker) {
  if (!Number.isSafeInteger(worker?.pid) || worker.pid < 2 || typeof worker?.startIdentity !== 'string') return { status: 'unknown' };
  try {
    const stat = procStat(worker.pid);
    if (stat.state === 'Z') return { status: 'gone' };
    return `${bootId()}:${stat.starttime}` === worker.startIdentity ? { status: 'verified', stat } : { status: 'mismatch' };
  } catch (error) { return { status: ['ENOENT', 'ESRCH'].includes(error.code) ? 'gone' : 'unknown' }; }
}
let clockTicks = null;
function ticksPerSecond() {
  if (clockTicks === null) { const result = spawnSync('getconf', ['CLK_TCK'], { encoding: 'utf8', timeout: 2000 }); clockTicks = Number(result.stdout?.trim()) > 0 ? Number(result.stdout.trim()) : 100; }
  return clockTicks;
}
function bootTimeMs() { const line = readFileSync('/proc/stat', 'utf8').split('\n').find(row => row.startsWith('btime ')); return Number(line.split(/\s+/)[1]) * 1000; }
function processTable() {
  const rows = [];
  for (const name of readdirSync('/proc')) if (/^\d+$/.test(name)) { try { const stat = procStat(Number(name)); rows.push({ pid: Number(name), ppid: stat.ppid, name: stat.comm }); } catch { /* exited */ } }
  return rows;
}
function descendants(pid) {
  const table = processTable(), out = [], queue = [[pid, 0]];
  while (queue.length) {
    const [parent, depth] = queue.shift();
    for (const row of table.filter(item => item.ppid === parent)) { out.push({ pid: row.pid, name: /^[\w .:@/+-]{1,32}$/.test(row.name) ? row.name : 'other', depth: depth + 1 }); if (depth < 8) queue.push([row.pid, depth + 1]); }
  }
  return out;
}
function establishedTcp(pid) {
  try {
    const inodes = new Set();
    for (const fd of readdirSync(`/proc/${pid}/fd`)) { try { const target = readlinkSync(`/proc/${pid}/fd/${fd}`); const match = target.match(/^socket:\[(\d+)\]$/); if (match) inodes.add(match[1]); } catch { /* closed */ } }
    let count = 0;
    for (const table of ['tcp', 'tcp6']) {
      let text = ''; try { text = readFileSync(`/proc/${pid}/net/${table}`, 'utf8'); } catch { continue; }
      for (const line of text.split('\n').slice(1)) { const cols = line.trim().split(/\s+/); if (cols[3] === '01' && inodes.has(cols[9])) count++; }
    }
    return count;
  } catch { return null; }
}
export async function inspectProcess(worker, { sampleSeconds = INSPECT_POLICY.sampleSeconds, nowMs = Date.now() } = {}) {
  const identity = verifyWorkerIdentity(worker);
  if (identity.status !== 'verified') return { pid: worker?.pid ?? null, identity: identity.status, alive: identity.status === 'gone' ? false : null };
  const before = identity.stat;
  let wchan = null; try { wchan = readFileSync(`/proc/${worker.pid}/wchan`, 'utf8').trim() || null; if (wchan && !/^[\w.]{1,64}$/.test(wchan)) wchan = 'other'; } catch { /* unreadable */ }
  if (sampleSeconds > 0) await sleep(sampleSeconds * 1000);
  const after = verifyWorkerIdentity(worker);
  if (after.status !== 'verified') return { pid: worker.pid, identity: after.status, alive: after.status === 'gone' ? false : null };
  const children = descendants(worker.pid), ticks = ticksPerSecond();
  const childTcp = children.map(row => establishedTcp(row.pid)).filter(value => value !== null);
  return { pid: worker.pid, identity: 'verified', alive: true, state: after.stat.state, wchan, threads: after.stat.threads,
    cpuTicksDelta: after.stat.cpuTicks - before.cpuTicks, sampleSeconds, ageSeconds: Math.round((nowMs - (bootTimeMs() + Number(after.stat.starttime) / ticks * 1000)) / 1000),
    children: children.map(({ name, depth }) => ({ name, depth })),
    establishedTcpSockets: { worker: establishedTcp(worker.pid), descendants: childTcp.reduce((sum, value) => sum + value, 0) } };
}

// ---- Classification and recommendation (pure) ----
export function classifyWorker({ identity, transportRecorded = false, output = {}, log = {}, ageSeconds = null, nowMs = Date.now(), idleAfterSeconds = INSPECT_POLICY.idleAfterSeconds }) {
  if (identity === 'mismatch') return { classification: 'unknown', reasonCode: 'pid-identity-mismatch' };
  if (transportRecorded || identity === 'gone') return { classification: 'exited', reasonCode: transportRecorded ? 'transport-recorded' : 'worker-process-gone' };
  if (identity !== 'verified') return { classification: 'unknown', reasonCode: 'worker-identity-unverifiable' };
  const complete = output.completeOutput === true || typeof output.completeOutputAt === 'string';
  if (complete) {
    if (!log.readable) return { classification: 'unknown', reasonCode: 'complete-output-log-unavailable' };
    if (log.streamExitedAt && !log.shutdownAfterStream) return { classification: 'complete-not-exited', reasonCode: 'complete-output-stream-exited-no-shutdown' };
    return { classification: 'unknown', reasonCode: log.shutdownAfterStream ? 'complete-output-shutdown-in-progress' : 'complete-output-stream-not-exited' };
  }
  const since = log.lastModelRequestAt ? (nowMs - Date.parse(log.lastModelRequestAt)) / 1000 : null;
  if (since !== null) return since <= idleAfterSeconds ? { classification: 'streaming', reasonCode: 'model-request-recent' } : { classification: 'idle-no-output', reasonCode: 'no-model-request-within-idle-window' };
  if (!log.readable) return { classification: 'unknown', reasonCode: 'agy-log-unavailable' };
  return finite(ageSeconds) && ageSeconds > idleAfterSeconds ? { classification: 'idle-no-output', reasonCode: 'no-model-request-logged' } : { classification: 'streaming', reasonCode: 'starting-no-model-request-yet' };
}
export function recommend({ classification, policy, gracePending, graceExpiresAt, stack = null, complete = false, transport = null }) {
  const remaining = policy.remainingReviewCalls;
  const followUp = remaining === 0 ? 'A follow-up prompt needs a NEW user-approved allowance (none remaining); ask the user.' : remaining === null ? 'A follow-up prompt needs an explicit bounded allowance; confirm the remaining calls first.' : `A follow-up prompt would spend one of ${remaining} remaining allowance calls; the user/agent decides.`;
  if (stack?.knownSignature) {
    if (stack.knownSignature === STUCK_ACCEPTANCE_SIGNATURE && complete) return { action: 'review-held-output', rationale: 'Dump shows only the conversation-title hang after complete output; the controller applies the stuck-worker acceptance rule (unchanged review gates, manual review suggested).' };
    if (stack.suggestedAction === 'review-held-output' && complete) return { action: 'review-held-output', rationale: `Known signature ${stack.knownSignature} after complete output; the held output is the evidence to review. ${followUp}` };
    return { action: 'follow-up-prompt', rationale: `Known signature ${stack.knownSignature} without usable output. ${followUp}` };
  }
  if (stack) return complete ? { action: 'review-held-output', rationale: 'Dump matched no known signature; the output is held. Review the summary before any acceptance decision.' } : { action: 'follow-up-prompt', rationale: `Dump matched no known signature and there was no complete output. ${followUp}` };
  switch (classification) {
    case 'streaming': return { action: 'wait', rationale: 'Model requests are still recent and output is incomplete; incomplete calls are never timed out.' };
    case 'complete-not-exited': return gracePending
      ? { action: 'wait', rationale: `Complete output is in hand; the controller will dump the stack and decide at grace expiry (${graceExpiresAt}).` }
      : { action: 'inspect-stack', rationale: 'Complete output is in hand and the worker never shut down; --stack is allowed without confirmation (terminating loses nothing).' };
    case 'idle-no-output': return { action: 'inspect-stack', rationale: `No model request recently and no complete output. A dump terminates the worker and loses this charged call, so it needs --confirm-terminate WITH user approval; otherwise keep waiting. ${followUp}` };
    case 'exited': return transport?.stuckAfterCompleteOutput && transport.knownSignature !== STUCK_ACCEPTANCE_SIGNATURE
      ? { action: 'review-held-output', rationale: 'The worker was stopped after complete output without the title-generation signature; its output is held for an owner decision.' }
      : { action: 'wait', rationale: 'The worker has exited; the controller settles the phase. Use diagnostics for the outcome.' };
    default: return { action: 'wait', rationale: 'Evidence is insufficient to classify; re-inspect later. Never act on unknown evidence.' };
  }
}
export function budgetFacts(budget) {
  const pairs = [[budget?.maxReviewCalls, budget?.usedReviewCalls], [budget?.allowanceMaxReviewCalls, budget?.allowanceUsedReviewCalls], [budget?.jointMaxReviewCalls, budget?.jointUsedReviewCalls]]
    .filter(([max, used]) => Number.isSafeInteger(max) && Number.isSafeInteger(used));
  return { remainingReviewCalls: pairs.length ? Math.max(0, Math.min(...pairs.map(([max, used]) => max - used))) : null,
    allowanceId: typeof budget?.allowanceId === 'string' ? budget.allowanceId : null,
    retryAllowed: false, automaticRetry: false,
    acceptanceRule: 'Only the controller accepts: complete SUCCESS envelope + unchanged gates, and for a stopped worker only with the title-generation-hang stack signature (manual review suggested). This report never accepts.' };
}

// ---- Campaign plumbing ----
function phaseFiles(campaign, rel) {
  const parts = rel.split('/');
  if (parts.length !== 3 || !/^[a-zA-Z-]{2,5}$/.test(parts[0]) || !/^\d{2}$/.test(parts[1]) || !/^(?:draft|review)-\d{2}$/.test(parts[2])) throw new Error('Phase must be LOCALE/CHUNK/PHASE, for example ru/01/review-01');
  const dir = path.join(campaign, parts[0], parts[1]);
  return { dir, base: path.join(dir, parts[2]), locale: parts[0], chunk: parts[1], phase: parts[2] };
}
function newestReport(dir, phase) {
  try { return readdirSync(dir).filter(name => name.startsWith(phase + '.inspect-') && name.endsWith('.json')).sort().at(-1) ?? null; } catch { return null; }
}
// Latest inspection + stack summary for a status row (used by status/diagnostics).
export function latestInspection(campaign, row) {
  if (!row?.locale || !row?.chunk || !row?.phase) return null;
  let files; try { files = phaseFiles(campaign, `${row.locale}/${row.chunk}/${row.phase}`); } catch { return null; }
  const name = newestReport(files.dir, files.phase), report = name ? readJson(path.join(files.dir, name)) : null;
  const stack = readJson(files.base + '.stack-summary.json');
  if (!report && !stack) return null;
  return { reportPath: name ? path.join(files.dir, name) : null, inspectedAt: report?.inspectedAt ?? null, classification: report?.classification ?? null, reasonCode: report?.reasonCode ?? null,
    knownSignature: report?.stack?.knownSignature ?? stack?.knownSignature ?? null, stackSummaryPath: stack ? files.base + '.stack-summary.json' : null, recommendation: report?.recommendation?.action ?? null };
}
export function phaseLogActivity(campaign, row, nowMs = Date.now()) {
  let files; try { files = phaseFiles(campaign, `${row.locale}/${row.chunk}/${row.phase}`); } catch { return null; }
  const dispatched = readJson(files.base + '.dispatched.json');
  const log = readAgyLog(typeof dispatched?.agyLogPath === 'string' ? dispatched.agyLogPath : files.base + '.agy.log', nowMs);
  return log.readable ? { lastModelRequestAt: log.lastModelRequestAt, secondsSinceModelRequest: log.secondsSinceModelRequest, streamExitedAt: log.streamExitedAt, mainIdleSeconds: log.mainIdleSeconds } : null;
}

export async function inspectPhase({ campaign, rel, row = null, budget = null, nowMs = Date.now(), sampleSeconds = INSPECT_POLICY.sampleSeconds, idleAfterSeconds = INSPECT_POLICY.idleAfterSeconds, stack = false, confirmTerminate = false, crashes = null, write = true }) {
  const files = phaseFiles(campaign, rel);
  const child = readJson(files.base + '.child.json'), dispatched = readJson(files.base + '.dispatched.json'), transportFile = readJson(files.base + '.transport.json');
  // Outer metadata only from a recorded transport; stdout/stderr never leave here.
  const transport = transportFile ? { exitCode: Number.isInteger(transportFile.exitCode) ? transportFile.exitCode : null, signal: typeof transportFile.signal === 'string' ? transportFile.signal : null,
    stuckAfterCompleteOutput: transportFile.stuckAfterCompleteOutput === true, knownSignature: typeof transportFile.knownSignature === 'string' ? transportFile.knownSignature : null } : null;
  const worker = child ? { pid: child.pid, startIdentity: child.startIdentity } : row?.worker ?? null;
  const processInfo = transport ? { pid: worker?.pid ?? null, identity: 'not-checked-transport-recorded', alive: false } : await inspectProcess(worker, { sampleSeconds, nowMs });
  const output = { phaseState: typeof row?.state === 'string' ? row.state : null, completeOutput: row?.completeOutput === true || typeof row?.completeOutputAt === 'string',
    completeOutputAt: typeof row?.completeOutputAt === 'string' ? row.completeOutputAt : null,
    envelopeStatus: typeof row?.completeOutputSummary?.status === 'string' ? row.completeOutputSummary.status : null,
    durationSeconds: finite(row?.completeOutputSummary?.durationSeconds) ? row.completeOutputSummary.durationSeconds : null,
    usage: row?.completeOutputSummary?.usage && typeof row.completeOutputSummary.usage === 'object' ? Object.fromEntries(Object.entries(row.completeOutputSummary.usage).filter(([key, value]) => /^[a-z_]{1,40}$/.test(key) && finite(value))) : null,
    stdoutBytes: Number.isSafeInteger(row?.stdoutBytes) ? row.stdoutBytes : null, stderrBytes: Number.isSafeInteger(row?.stderrBytes) ? row.stderrBytes : null,
    elapsedSeconds: Number.isSafeInteger(row?.elapsedSeconds) ? row.elapsedSeconds : null, transportRecorded: Boolean(transport), transport };
  const log = readAgyLog(typeof dispatched?.agyLogPath === 'string' ? dispatched.agyLogPath : files.base + '.agy.log', nowMs);
  const graceSeconds = finite(row?.postCompletionGraceSeconds) ? row.postCompletionGraceSeconds : finite(dispatched?.postCompletionGraceSeconds) ? dispatched.postCompletionGraceSeconds : null;
  const graceExpiresMs = output.completeOutputAt && graceSeconds !== null ? Date.parse(output.completeOutputAt) + graceSeconds * 1000 : null;
  const gracePending = graceExpiresMs !== null && graceExpiresMs > nowMs || output.phaseState === 'stuck-after-completion';
  const { classification, reasonCode } = classifyWorker({ identity: processInfo.identity === 'not-checked-transport-recorded' ? 'gone' : processInfo.identity, transportRecorded: Boolean(transport), output, log, ageSeconds: processInfo.ageSeconds ?? null, nowMs, idleAfterSeconds });
  const policy = { ...budgetFacts(budget), postCompletionGraceSeconds: graceSeconds, graceExpiresAt: iso(graceExpiresMs), controllerWillDump: gracePending,
    stackAllowedWithoutConfirmation: classification === 'complete-not-exited' && !gracePending, idleAfterSeconds };
  const report = { schema: 1, kind: 'tutorial-translation-worker-inspection', phase: rel, inspectedAt: iso(nowMs), mode: stack ? 'stack' : 'observe',
    observationOnly: !stack, process: processInfo, output, agyLog: log, classification, reasonCode, policy, stack: null, refused: null, recommendation: null };
  if (processInfo.identity === 'mismatch') report.refused = { reasonCode: 'pid-identity-mismatch', detail: 'The recorded PID now belongs to a different process; nothing was signalled.' };
  else if (stack) {
    const refuse = (code, detail) => { report.refused = { reasonCode: code, detail }; };
    if (classification === 'exited' || processInfo.identity !== 'verified') refuse('worker-not-running', 'No verified live worker to dump.');
    else if (output.completeOutput && gracePending) refuse('controller-grace-pending', `The controller dumps and decides at grace expiry (${policy.graceExpiresAt}); avoid racing it.`);
    else if (!policy.stackAllowedWithoutConfirmation && !confirmTerminate) refuse('termination-needs-user-approval', 'This worker has no complete output; a dump terminates it and loses the charged call. Re-run with --confirm-terminate only with explicit user approval.');
    else {
      const requestedAt = Date.now();
      writeFileSync(files.base + '.stack-request.json', JSON.stringify({ schema: 1, pid: worker.pid, startIdentity: worker.startIdentity, requestedAt: iso(requestedAt), classification, confirmedTermination: confirmTerminate }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      if (verifyWorkerIdentity(worker).status !== 'verified') refuse('pid-identity-changed', 'Identity changed before signalling; nothing was signalled.');
      else {
        process.kill(worker.pid, 'SIGQUIT');
        const summary = await collectCrashSummary({ pid: worker.pid, sinceMs: requestedAt, directory: crashes || crashesDirectory(), timeoutMs: 10000, completeOutput: output.completeOutput });
        writeFileSync(files.base + '.stack-summary.json', JSON.stringify({ ...summary, phase: rel, requestedBy: 'inspector', requestedAt: iso(requestedAt) }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
        for (let i = 0; i < 50 && verifyWorkerIdentity(worker).status === 'verified'; i++) await sleep(100);
        let killed = false;
        if (verifyWorkerIdentity(worker).status === 'verified') { process.kill(worker.pid, 'SIGKILL'); killed = true; }
        report.stack = { ...summary, stackSummaryPath: files.base + '.stack-summary.json', sigkillFallback: killed };
      }
    }
  }
  report.recommendation = recommend({ classification, policy, gracePending, graceExpiresAt: policy.graceExpiresAt, stack: report.stack, complete: output.completeOutput, transport });
  if (write) {
    const reportPath = files.base + '.inspect-' + iso(Date.now()).replace(/[:.]/g, '-') + '.json';
    writeFileSync(reportPath, JSON.stringify({ ...report, reportPath }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    report.reportPath = reportPath;
  }
  return report;
}

export async function runInspector(argv = process.argv.slice(2)) {
  const options = {}, flags = new Set();
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (['--stack', '--confirm-terminate'].includes(key)) { flags.add(key); continue; }
    if (!['--job', '--campaign', '--phase', '--sample-seconds', '--idle-seconds'].includes(key) || Object.hasOwn(options, key)) throw new Error('Usage: --job DIR | --campaign DIR [--phase LOCALE/CHUNK/PHASE] [--stack [--confirm-terminate]] [--sample-seconds 0-30] [--idle-seconds 60-86400]');
    const value = argv[++i]; if (!value || value.startsWith('--')) throw new Error('Missing option value'); options[key] = value;
  }
  if (Boolean(options['--job']) === Boolean(options['--campaign'])) throw new Error('Provide exactly one of --job or --campaign');
  if (flags.has('--confirm-terminate') && !flags.has('--stack')) throw new Error('--confirm-terminate only applies to --stack');
  let campaign;
  if (options['--job']) {
    const job = path.resolve(options['--job']);
    if (!job.startsWith('/tmp/scirepl-tutorial-translation-job-')) throw new Error('Use a task-scoped job directory');
    campaign = readJson(path.join(job, 'config.json'))?.campaign;
    if (typeof campaign !== 'string') throw new Error('Job configuration is unavailable');
  } else campaign = options['--campaign'];
  campaign = path.resolve(campaign);
  if (!campaign.startsWith('/tmp/scirepl-tutorial-translation-')) throw new Error('Use a task-scoped campaign');
  const sampleSeconds = options['--sample-seconds'] === undefined ? INSPECT_POLICY.sampleSeconds : Number(options['--sample-seconds']);
  const idleAfterSeconds = options['--idle-seconds'] === undefined ? INSPECT_POLICY.idleAfterSeconds : Number(options['--idle-seconds']);
  if (!Number.isInteger(sampleSeconds) || sampleSeconds < 0 || sampleSeconds > 30) throw new Error('--sample-seconds must be 0-30');
  if (!Number.isInteger(idleAfterSeconds) || idleAfterSeconds < 60 || idleAfterSeconds > 86400) throw new Error('--idle-seconds must be 60-86400');
  const status = readJson(path.join(campaign, 'controller-status.json'));
  const rows = Array.isArray(status?.phases) ? status.phases : [];
  const key = row => `${row.locale}/${row.chunk}/${row.phase}`;
  let targets;
  if (options['--phase']) targets = [{ rel: options['--phase'], row: rows.find(row => key(row) === options['--phase']) ?? null }];
  else targets = rows.filter(row => RUNNING.has(row.state) && row.worker).map(row => ({ rel: key(row), row }));
  if (flags.has('--stack') && targets.length !== 1) throw new Error('--stack requires exactly one phase (use --phase)');
  const reports = [];
  for (const target of targets) reports.push(await inspectPhase({ campaign, rel: target.rel, row: target.row, budget: status?.recoveryBudget ?? null, sampleSeconds, idleAfterSeconds,
    stack: flags.has('--stack'), confirmTerminate: flags.has('--confirm-terminate') }));
  return { schema: 1, kind: 'tutorial-translation-inspection-run', campaign, inspectedPhases: reports.length, reports, ...(reports.length ? {} : { note: 'No running phase with a recorded worker.' }) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT) {
  runInspector().then(result => {
    console.log(JSON.stringify(result, null, 2));
    if (result.reports.some(report => report.refused)) process.exitCode = 2;
  }).catch(error => { console.error(JSON.stringify({ schema: 1, error: error.message })); process.exitCode = 1; });
}
