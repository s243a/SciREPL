#!/usr/bin/env node
// Offline-only AGY double. It never imports networking or calls a provider.
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
const root = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('0.0.1'); process.exit(0); }
const config = JSON.parse(readFileSync(path.join(root, 'fake-config.json')));
const prompt = args[args.indexOf('-p') + 1], review = prompt.includes('BEGIN UNTRUSTED REVIEW SECTION');
// Fake AGY per-run log (glog-style lines, local time). Like a real log it may
// contain private text; inspectors must only ever extract fixed markers.
const logFile = args.includes('--log-file') ? args[args.indexOf('--log-file') + 1] : null;
const glog = (offsetSeconds, message, level = 'I') => {
  const at = new Date(Date.now() + offsetSeconds * 1000), two = n => String(n).padStart(2, '0');
  return `${level}${two(at.getMonth() + 1)}${two(at.getDate())} ${two(at.getHours())}:${two(at.getMinutes())}:${two(at.getSeconds())}.${String(at.getMilliseconds()).padStart(3, '0')}000       1 fake.go:1] ${message}\n`;
};
const log = lines => { if (logFile) appendFileSync(logFile, lines.join('')); };
const modelAgo = config.modelRequestAgoSeconds ?? 0;
log([glog(-modelAgo - 5, 'You are not logged into Antigravity', 'W'), glog(-modelAgo - 4, 'Print mode: starting'), glog(-modelAgo - 3, 'Print mode: silent auth succeeded'),
  glog(-modelAgo - 2, 'sending message ' + (config.logSentinel || '')), glog(-modelAgo, 'URL: https://example.invalid/v1:streamGenerateContent?alt=sse Trace: 0x1'),
  glog(-modelAgo, 'request failed ' + (config.logSentinel || ''), 'E')]);
const goroutineDump = signature => [
  'SIGQUIT: quit', 'PC=0x1 m=0 sigcode=0', '',
  'goroutine 1 gp=0x1 m=nil [select]:', 'runtime.gopark(0x1?, 0x2?)', '\tthird_party/go/runtime/proc.go:1 +0x1',
  ...(signature === 'stream'
    ? ['example/codeassistclient.(*CodeAssistClient).streamGenerateContentFromCCPA({0x1, 0x2}, {"' + (config.logSentinel || '') + '"})', '\tfile.go:1 +0x1', 'main.main()', '\tmain.go:1 +0x1', '']
    : ['example/background.(*Pool).close(0x1)', '\tbackground.go:1 +0x1', 'example/cortex.(*backgroundRunner).CancelAndWait(0x1)', '\tcortex.go:1 +0x1',
      'example/cortex.(*CascadeManager).Shutdown(0x1, {"' + (config.logSentinel || '') + '"})', '\tcortex.go:2 +0x1', 'main.main()', '\tmain.go:1 +0x1', '']),
  ...(signature === 'title' ? ['goroutine 414 gp=0x2 m=nil [chan receive, 2 minutes]:', 'runtime.gopark(0x1?)', '\tproc.go:1 +0x1', 'runtime.chanrecv2(0x1?)', '\tchan.go:1 +0x1',
    'example/codeassistclient.(*channelModelResponseStream).Err(0x1)', '\tstream.go:51 +0xa5', 'example/modelapiinterface.GenerateNonStreaming({0x1, 0x2})', '\thelpers.go:33 +0x1',
    'example/cortex.(*CascadeManager).maybeGenerateConversationTitle.func1({0x1, 0x2})', '\tconversation_title.go:166 +0x1', 'example/background.(*Pool).Go.func2({0x1})', '\tbackground.go:121 +0x1',
    'created by example/background.(*Pool).Go in goroutine 1', '\tbackground.go:110 +0x1', ''] : []),
  'goroutine 20 gp=0x3 m=nil [IO wait, 3 minutes]:', 'runtime.gopark(0x1?)', '\tproc.go:1 +0x1', 'example/jsonrpc2.(*Connection).readIncoming(0x1)', '\tconn.go:1 +0x1', '',
].join('\n');
// On SIGQUIT, like Go: write a goroutine dump to the crashes dir, then exit 2.
if (config.crashesDir && config.stackSignature) process.on('SIGQUIT', () => {
  writeFileSync(path.join(config.crashesDir, `crash_${process.pid}_${randomUUID()}.log`), goroutineDump(config.stackSignature));
  process.exit(2);
});
const raw = prompt.split(review ? 'BEGIN UNTRUSTED REVIEW SECTION\n' : 'BEGIN UNTRUSTED SECTION\n')[1].split('\nEND UNTRUSTED')[0];
const request = JSON.parse(raw), conversation = args.includes('--conversation') ? args[args.indexOf('--conversation') + 1] : null;
if (args.includes('--continue') || args.includes('-c')) throw new Error('Implicit continuation is forbidden');
const sessionFile = path.join(root, 'fake-sessions.json');
const sessions = existsSync(sessionFile) ? JSON.parse(readFileSync(sessionFile)) : {};
let id = conversation || randomUUID();
if (conversation && (!sessions[id] || sessions[id].review !== review || sessions[id].route !== request.route || sessions[id].workspace !== process.cwd())) throw new Error('Wrong conversation identity');
if (!sessions[id]) sessions[id] = { review, route: request.route, workspace: process.cwd(), turns: 0 };
sessions[id].turns++; writeFileSync(sessionFile, JSON.stringify(sessions));
appendFileSync(path.join(root, 'fake-calls.jsonl'), JSON.stringify({ id, resumed: Boolean(conversation), review, route: request.route, workspace: process.cwd(), fieldIds: request.fields.map(field => field.id), argvHasImplicitContinue: false, workerPath: process.env.PATH,
  ...(review ? { reviewFields: request.fields, explicitKeepReview: prompt.includes('for EVERY such unchanged eligible label'), exactNumericReview: prompt.includes('preserve every exact sequence in order') } : {}) }) + '\n');
if (config.mode === 'hang') { console.log('offline fake pending'); setInterval(() => {}, 1000); }
// Inspector fixtures: a worker still waiting on its model stream (no output).
else if (config.mode === 'stream-wait') { process.stdout.write('{"status":'); setInterval(() => {}, 1000); }
else {
  if (config.mode === 'drift' && !review) appendFileSync(config.driftFile, '\n');
  if (config.mode === 'evidence-drift' && !review) appendFileSync(config.evidenceFile, '\n');
  if (config.mode === 'helper-drift' && !review) appendFileSync(config.helperFile, '\n');
  if (config.mode === 'correction-evidence-drift' && review) appendFileSync(config.evidenceFile, '\n');
  if (config.mode === 'correction-helper-drift' && review) appendFileSync(config.helperFile, '\n');
  if (config.mode === 'correction-baseline-drift' && review) {
    const record = JSON.parse(readFileSync(config.baselineFile));
    record.translations[Object.keys(record.translations)[0]] = 'Une valeur approuvée a changé.';
    writeFileSync(config.baselineFile, JSON.stringify(record));
  }
  if (config.mode === 'write-file') writeFileSync(path.join(process.cwd(), 'unexpected.txt'), 'offline fixture');
  if (config.mode === 'wrong-id' && conversation) id = randomUUID();
  if (config.mode === 'prior-id' && review) id = 'historical-review-' + request.route;
  const translations = Object.fromEntries(request.fields.map(field => [field.id, request.translations?.[field.id] || 'Texte traduit : ' + field.text]));
  if (config.mode === 'invalid-review' && review) Object.keys(translations).forEach(key => { translations[key] += ' 987654321'; });
  if (config.mode === 'numeric-order' && review && translations['alpha.one']) translations['alpha.one'] = 'Valeurs 10 puis 2.';
  if (config.mode === 'numeric-script' && review && translations['alpha.one']) translations['alpha.one'] = 'Valeurs ٢ puis ١٠.';
  const keptFields = {};
  if (['label-keep', 'missing-label-keep'].includes(config.mode) && review) for (const field of request.fields.filter(field => field.id === 'alpha.one')) {
    translations[field.id] = field.text;
    if (config.mode === 'label-keep') keptFields[field.id] = 'Independent offline reviewer confirms this is the customary borrowed label.';
  }
  const envelope = JSON.stringify({ status: config.mode === 'failed-review' && review ? 'ERROR' : 'SUCCESS', conversation_id: id, response: JSON.stringify({ translations, ...(Object.keys(keptFields).length ? { keptFields } : {}) }), duration_seconds: 1, usage: { input_tokens: 1, output_tokens: 1 } });
  // Complete final envelope, then the process never exits (field-observed hang).
  // Like an MCP helper: a descendant inherits stdout/stderr and outlives the worker.
  const stuckLog = () => log([glog(0, 'Stream goroutine exited for ' + (config.logSentinel || 'conversation')), glog(0, 'MCP server connection closed unexpectedly', 'E')]);
  const normalLog = () => log([glog(0, 'Stream goroutine exited for conversation'), glog(0, 'Language server shutting down')]);
  if (config.mode === 'stuck-with-descendant' && review) {
    stuckLog();
    const helper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 'inherit', 'inherit'] });
    appendFileSync(path.join(root, 'fake-descendants.txt'), helper.pid + '\n');
    process.stdout.write(envelope + '\n'); setInterval(() => {}, 1000);
  } else if (config.mode === 'stuck-after-complete' && review) { stuckLog(); process.stdout.write(envelope + '\n'); setInterval(() => {}, 1000); }
  // Slow but working: half an envelope, a pause longer than the grace, the rest.
  else if (config.mode === 'slow-complete' && review) { process.stdout.write(envelope.slice(0, 20)); setTimeout(() => console.log(envelope.slice(20)), 2500); }
  else { normalLog(); console.log(envelope); }
}
