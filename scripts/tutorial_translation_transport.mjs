import assert from 'node:assert/strict';
import { readdirSync, lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const WORKER_POLL_INTERVAL_SECONDS = 30;

export function timeoutSettings(env = process.env) {
  const seconds = (value, name) => {
    assert(/^\d+s$/.test(value), `${name} must use integer seconds, for example 180s`);
    return Number(value.slice(0, -1));
  };
  const printTimeout = env.SCIREPL_TRANSLATION_PRINT_TIMEOUT || '0s';
  const printSeconds = seconds(printTimeout, 'Print timeout');
  assert(printSeconds === 0 || printSeconds >= 30 && printSeconds <= 600, 'Print timeout must be 0s or between 30s and 600s');
  const watchdogTimeout = env.SCIREPL_TRANSLATION_WATCHDOG_TIMEOUT || (printSeconds === 0 ? '0s' : `${printSeconds + 30}s`);
  const watchdogSeconds = seconds(watchdogTimeout, 'Watchdog timeout');
  if (printSeconds === 0) assert.equal(watchdogSeconds, 0, 'Wait-until-completion requires both print timeout and watchdog to be 0s');
  else assert(watchdogSeconds >= printSeconds + 15 && watchdogSeconds <= printSeconds + 60, 'A finite watchdog must allow 15–60 seconds beyond the CLI print timeout; mixed zero/nonzero profiles are forbidden');
  const effort = env.SCIREPL_TRANSLATION_EFFORT || 'medium';
  assert(['low', 'medium', 'high', 'xhigh', 'max'].includes(effort), 'Invalid translation effort');
  return { printTimeout, printSeconds, watchdogTimeout, watchdogSeconds, effort };
}

// Deliberately whitelist numeric progress only: never log a prompt, model
// response, stderr contents, environment, credentials, or arbitrary metadata.
export function workerProgress({ startedAt, stdoutBytes, stderrBytes }, now = Date.now()) {
  assert(Number.isFinite(startedAt) && Number.isFinite(now) && now >= startedAt, 'Invalid worker elapsed time');
  assert(Number.isSafeInteger(stdoutBytes) && stdoutBytes >= 0, 'Invalid stdout byte count');
  assert(Number.isSafeInteger(stderrBytes) && stderrBytes >= 0, 'Invalid stderr byte count');
  return { elapsedSeconds: Math.floor((now - startedAt) / 1000), stdoutBytes, stderrBytes };
}

// A CLI warning is not harmless just because its outer JSON says SUCCESS.
// Match conservatively; never include raw stderr in a user-facing exception.
export function hasCliTimeoutWarning(stderr) {
  return /\b(?:timed?\s*out|time[\s-]?out|deadline\s+exceeded|print.{0,30}limit.{0,20}(?:reached|expired))\b/i.test(stderr);
}

export function parseTransport({ stdout, stderr, exitCode, timedOut = false, outputLimited = false, cancelled = false }) {
  assert(!cancelled, 'Translation cancelled; no partial result may be applied');
  assert(!timedOut && !outputLimited && exitCode === 0, 'Transport failed; automatic retry is forbidden');
  assert(!hasCliTimeoutWarning(stderr), 'CLI print timeout warning; reported SUCCESS is not completion evidence');
  let raw;
  try { raw = JSON.parse(stdout); } catch { throw new Error('Transport envelope is not complete JSON'); }
  assert.equal(String(raw.status).toLowerCase(), 'success', 'Transport did not report success');
  let proposal;
  try {
    proposal = typeof raw.response === 'object' && raw.response !== null ? raw.response : JSON.parse(String(raw.response));
  } catch {
    const zeroDuration = Number(raw.duration_seconds) === 0;
    const usageValues = Object.values(raw.usage || {});
    const zeroUsage = usageValues.length > 0 && usageValues.every(value => Number(value) === 0);
    if (zeroDuration && zeroUsage) throw new Error('Incomplete inner JSON with zero completion metadata; hold as an ambiguous CLI timeout');
    throw new Error('Inner translation result is not complete JSON; partial repair/retry is forbidden');
  }
  return proposal;
}

// Numeric/boolean metadata of a complete outer envelope, for status files and
// inspection. Never returns the response body, conversation identity or stderr.
export function envelopeMetadata(stdout) {
  let value; try { value = JSON.parse(String(stdout).trim()); } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const status = typeof value.status === 'string' && /^[A-Za-z_]{1,32}$/.test(value.status) ? value.status : value.status === undefined ? null : 'other';
  const usage = value.usage && typeof value.usage === 'object' && !Array.isArray(value.usage) ? Object.fromEntries(Object.entries(value.usage)
    .filter(([key, number]) => /^[a-z_]{1,40}$/.test(key) && typeof number === 'number' && Number.isFinite(number)).slice(0, 12)) : null;
  return { status, durationSeconds: typeof value.duration_seconds === 'number' && Number.isFinite(value.duration_seconds) ? value.duration_seconds : null, usage };
}

// ---- Stuck-worker stack evidence (Go SIGQUIT goroutine dumps) ----
// AGY writes a goroutine dump to <crashes>/crash_<pid>_<uuid>.log on SIGQUIT,
// then exits. Only a parsed summary (function names, states, wait minutes) is
// ever kept; the raw dump is never copied. SCIREPL_AGY_CRASHES_DIR exists for
// offline tests.
export const STUCK_ACCEPTANCE_SIGNATURE = 'title-generation-hang';
export const KNOWN_STACK_SIGNATURES = Object.freeze({
  'title-generation-hang': { meaning: 'The worker finished the call and is shutting down, but waits for a background conversation-title request that never returns (maybeGenerateConversationTitle under Pool.close). The translation result was already complete.', suggestedAction: 'review-held-output' },
  'mcp-close-wait': { meaning: 'Shutdown is waiting for an MCP helper to close. If output was complete, the translation call itself had finished.', suggestedAction: 'review-held-output' },
  'model-stream-wait': { meaning: 'The worker is still waiting on a model response stream and has no complete output.', suggestedAction: 'follow-up-prompt' },
});
export function crashesDirectory(env = process.env) {
  if (env.SCIREPL_AGY_CRASHES_DIR !== undefined) {
    assert(path.isAbsolute(env.SCIREPL_AGY_CRASHES_DIR) && !env.SCIREPL_AGY_CRASHES_DIR.includes('\0'), 'Crashes directory must be absolute');
    return env.SCIREPL_AGY_CRASHES_DIR;
  }
  assert(typeof env.HOME === 'string' && path.isAbsolute(env.HOME), 'HOME is required to locate AGY crash logs');
  return path.join(env.HOME, '.gemini', 'antigravity-cli', 'crashes');
}
// "pkg/path/pkg.(*T).Method(0x1, {0x2, ...})" -> "pkg.(*T).Method". No arguments.
export function stackFunctionName(line) {
  let text = line.trim(), end = text.length;
  if (text.endsWith(')')) {
    let depth = 0;
    for (let i = text.length - 1; i >= 0; i--) {
      if (text[i] === ')') depth++;
      else if (text[i] === '(' && --depth === 0) { end = i; break; }
    }
  }
  text = text.slice(0, end);
  const firstParen = text.indexOf('('), slash = text.lastIndexOf('/', firstParen === -1 ? text.length : firstParen);
  text = text.slice(slash + 1);
  return /^[\w.*()[\]-]{1,200}$/.test(text) ? text : '<unparsed>';
}
const runtimeFrame = name => /^(?:runtime|internal)\b/.test(name);
export function parseGoroutineDump(text) {
  const goroutines = []; let current = null;
  for (const raw of String(text).split('\n')) {
    const line = raw.replace(/\r$/, '');
    const header = line.match(/^goroutine (\d+)\b[^[]*\[([^\]]*)\]:\s*$/);
    if (header) {
      const parts = header[2].split(',').map(part => part.trim()), minutes = parts.map(part => part.match(/^(\d+) minutes?$/)).find(Boolean);
      current = { id: Number(header[1]), state: /^[\w .()-]{1,40}$/.test(parts[0]) ? parts[0] : 'other', waitMinutes: minutes ? Number(minutes[1]) : null,
        lockedToThread: parts.includes('locked to thread'), frames: [], createdBy: null };
      goroutines.push(current); continue;
    }
    if (!line) { current = null; continue; }
    if (!current || /^\s/.test(line) || line.startsWith('...')) continue;
    if (line.startsWith('created by ')) { current.createdBy = stackFunctionName(line.slice(11).replace(/ in goroutine \d+$/, '')); continue; }
    current.frames.push(stackFunctionName(line));
  }
  return goroutines;
}
export function matchStackSignature(goroutines, { completeOutput = false } = {}) {
  const main = goroutines.find(row => row.id === 1)?.frames || [];
  const shuttingDown = main.some(name => /Pool\)\.close\b|CancelAndWait|\)\.Shutdown$/.test(name));
  const any = test => goroutines.some(row => row.frames.some(test));
  if (shuttingDown && any(name => /maybeGenerateConversationTitle/.test(name))) return 'title-generation-hang';
  if (shuttingDown && any(name => /mcp/i.test(name) && /close/i.test(name))) return 'mcp-close-wait';
  if (!completeOutput && any(name => /streamGenerateContent|ResponseStream|StreamGenerate/.test(name))) return 'model-stream-wait';
  return null;
}
export function summarizeGoroutineDump(text, { completeOutput = false } = {}) {
  const goroutines = parseGoroutineDump(text), main = goroutines.find(row => row.id === 1);
  const blocked = goroutines.filter(row => row.id !== 1 && row.waitMinutes !== null && row.frames.some(name => !runtimeFrame(name)))
    // Signature-relevant goroutines first, so a cap never hides the blocker.
    .map(row => ({ row, relevant: row.frames.some(name => /maybeGenerateConversationTitle/.test(name)) ? 2 : row.frames.some(name => /mcp|ResponseStream|streamGenerate|GenerateNonStreaming/i.test(name)) ? 1 : 0 }))
    .sort((a, b) => b.relevant - a.relevant || b.row.waitMinutes - a.row.waitMinutes || a.row.id - b.row.id).slice(0, 40).map(({ row }) => row)
    .map(row => ({ id: row.id, state: row.state, waitMinutes: row.waitMinutes, frames: row.frames.filter(name => !runtimeFrame(name)).slice(0, 6), createdBy: row.createdBy }));
  const signature = matchStackSignature(goroutines, { completeOutput });
  return { schema: 1, totalGoroutines: goroutines.length,
    main: main ? { state: main.state, waitMinutes: main.waitMinutes, frames: main.frames.filter(name => !runtimeFrame(name)).slice(0, 12) } : null,
    blocked, completeOutput: completeOutput === true, knownSignature: signature,
    ...(signature ? KNOWN_STACK_SIGNATURES[signature] : { meaning: 'No known signature matched; inspect the blocked goroutines before deciding.', suggestedAction: null }) };
}
// Waits briefly for AGY's crash log for exactly this PID, written at or after
// the dump request. Returns only the parsed summary, never raw dump text.
export async function collectCrashSummary({ pid, sinceMs, directory = crashesDirectory(), timeoutMs = 3000, completeOutput = false }) {
  assert(Number.isSafeInteger(pid) && pid > 1, 'Invalid crash-log PID');
  const deadline = Date.now() + timeoutMs, prefix = `crash_${pid}_`;
  for (;;) {
    let candidates = [];
    try {
      candidates = readdirSync(directory).filter(name => name.startsWith(prefix) && name.endsWith('.log')).map(name => {
        const stat = lstatSync(path.join(directory, name));
        return stat.isFile() && !stat.isSymbolicLink() && stat.mtimeMs >= sinceMs - 2000 ? { name, mtimeMs: stat.mtimeMs, size: stat.size } : null;
      }).filter(Boolean).sort((a, b) => b.mtimeMs - a.mtimeMs);
    } catch { /* The directory may not exist yet. */ }
    const found = candidates[0];
    if (found && found.size > 0 && found.size <= 32 * 1024 * 1024) {
      const summary = summarizeGoroutineDump(readFileSync(path.join(directory, found.name), 'utf8'), { completeOutput });
      if (summary.totalGoroutines > 0 && summary.main || Date.now() >= deadline) return { found: true, crashLogPid: pid, ...summary };
    }
    if (Date.now() >= deadline) return { schema: 1, found: false, crashLogPid: pid, knownSignature: null, completeOutput: completeOutput === true,
      meaning: 'No crash log for this PID appeared; the worker may not be AGY or did not write a goroutine dump.', suggestedAction: null };
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

// The ONLY path that accepts output from a worker that had to be stopped. It
// requires a complete envelope observed before termination and a stack summary
// proving the worker was merely waiting for conversation-title generation.
// Every other transport check (status, CLI timeout warning, inner JSON) is the
// unchanged parseTransport; review/validation gates are applied by the caller.
export function acceptStuckAfterCompletion(transport, stackSummary) {
  assert(transport?.stuckAfterCompleteOutput === true, 'Not a stuck-after-completion transport');
  const completeAt = Date.parse(transport.completeOutputAt), stoppedAt = Date.parse(transport.stuckTerminatedAt);
  assert(Number.isFinite(completeAt) && Number.isFinite(stoppedAt) && completeAt <= stoppedAt, 'Complete output must precede termination');
  assert(stackSummary?.knownSignature === STUCK_ACCEPTANCE_SIGNATURE && stackSummary.completeOutput === true,
    'Worker stuck after complete output; stopped and held as failed (no automatic retry)');
  assert(!transport.timedOut && !transport.outputLimited && !transport.cancelled && !transport.persistenceFailure, 'Stuck transport has another failure flag');
  // The non-zero exit status is solely the stop that followed complete output.
  return parseTransport({ ...transport, exitCode: 0 });
}
