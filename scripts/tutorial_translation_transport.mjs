import assert from 'node:assert/strict';

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
