import assert from 'node:assert/strict';
import { timeoutSettings, hasCliTimeoutWarning, parseTransport, workerProgress, WORKER_POLL_INTERVAL_SECONDS } from '../scripts/tutorial_translation_transport.mjs';

let checks = 0;
const verify = (name, fn) => { fn(); checks++; console.log('PASS ' + name); };
verify('future default waits until completion, with no forced timeout and medium effort', () => assert.deepEqual(timeoutSettings({}), { printTimeout: '0s', printSeconds: 0, watchdogTimeout: '0s', watchdogSeconds: 0, effort: 'medium' }));
verify('timing configuration has finite validated bounds', () => {
  for (const value of ['29s', '601s', 'Infinity', '3m', '-90s']) assert.throws(() => timeoutSettings({ SCIREPL_TRANSLATION_PRINT_TIMEOUT: value }));
  for (const value of ['190s', '241s', '0s']) assert.throws(() => timeoutSettings({ SCIREPL_TRANSLATION_PRINT_TIMEOUT: '180s', SCIREPL_TRANSLATION_WATCHDOG_TIMEOUT: value }));
  assert.equal(timeoutSettings({ SCIREPL_TRANSLATION_PRINT_TIMEOUT: '120s' }).watchdogSeconds, 150);
  assert.deepEqual(timeoutSettings({ SCIREPL_TRANSLATION_PRINT_TIMEOUT: '180s', SCIREPL_TRANSLATION_WATCHDOG_TIMEOUT: '210s' }), { printTimeout: '180s', printSeconds: 180, watchdogTimeout: '210s', watchdogSeconds: 210, effort: 'medium' });
  assert.throws(() => timeoutSettings({ SCIREPL_TRANSLATION_EFFORT: 'unknown' }));
});
verify('zero profiles are paired and never silently mixed with finite limits', () => {
  assert.equal(timeoutSettings({ SCIREPL_TRANSLATION_PRINT_TIMEOUT: '0s', SCIREPL_TRANSLATION_WATCHDOG_TIMEOUT: '0s' }).watchdogSeconds, 0);
  assert.throws(() => timeoutSettings({ SCIREPL_TRANSLATION_PRINT_TIMEOUT: '0s', SCIREPL_TRANSLATION_WATCHDOG_TIMEOUT: '210s' }));
  assert.throws(() => timeoutSettings({ SCIREPL_TRANSLATION_PRINT_TIMEOUT: '180s', SCIREPL_TRANSLATION_WATCHDOG_TIMEOUT: '0s' }));
});
verify('30-second polling publishes elapsed and byte counts only, never raw content', () => {
  assert.equal(WORKER_POLL_INTERVAL_SECONDS, 30);
  assert.deepEqual(workerProgress({ startedAt: 1000, stdoutBytes: Buffer.byteLength('✓'), stderrBytes: 17, stdout: 'private prompt', stderr: 'private diagnostic' }, 31999), { elapsedSeconds: 30, stdoutBytes: 3, stderrBytes: 17 });
  for (const changes of [{ startedAt: -Infinity }, { stdoutBytes: -1 }, { stderrBytes: NaN }, { stdoutBytes: 1.5 }]) assert.throws(() => workerProgress({ startedAt: 1000, stdoutBytes: 0, stderrBytes: 0, ...changes }, 31000));
});
verify('CLI timeout warnings are detected conservatively', () => {
  for (const value of ['print mode timed out after 180s', 'Warning: print-timeout reached', 'deadline exceeded', 'Print limit expired']) assert.ok(hasCliTimeoutWarning(value));
  assert.equal(hasCliTimeoutWarning('Normal diagnostic without private content.'), false);
});
const good = { exitCode: 0, stdout: JSON.stringify({ status: 'SUCCESS', response: JSON.stringify({ translations: { example: 'Texte' } }), duration_seconds: 1, usage: { total_tokens: 1 } }), stderr: '' };
verify('valid complete transport passes without interpreting worker code', () => assert.deepEqual(parseTransport(good), { translations: { example: 'Texte' } }));
verify('SUCCESS with a CLI timeout warning is rejected and stderr is not leaked', () => {
  assert.throws(() => parseTransport({ ...good, stderr: 'private sentinel: timeout' }), error => /CLI print timeout warning/.test(error.message) && !error.message.includes('sentinel'));
});
verify('cancelled, killed or capped transports never yield partial proposals', () => {
  for (const change of [{ cancelled: true }, { timedOut: true }, { outputLimited: true }, { exitCode: 2 }]) assert.throws(() => parseTransport({ ...good, ...change }));
});
verify('zero metadata and empty/truncated JSON fail as an ambiguous CLI timeout', () => {
  for (const response of ['', '{"translations":{"a":"unfinished']) assert.throws(() => parseTransport({ ...good, stdout: JSON.stringify({ status: 'SUCCESS', response, duration_seconds: 0, usage: { input_tokens: 0, output_tokens: 0 } }) }), /ambiguous CLI timeout/);
});
verify('malformed outer JSON and failed status are never repaired', () => {
  assert.throws(() => parseTransport({ ...good, stdout: '{"status":' }), /not complete JSON/);
  assert.throws(() => parseTransport({ ...good, stdout: JSON.stringify({ status: 'FAILED', response: '{}' }) }), /did not report success/);
});
console.log(`Tutorial transport: ${checks} offline checks passed; no model calls or applies.`);
