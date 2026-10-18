#!/usr/bin/env node
// Durable local job owner. Observers read status; they never own a Gemini turn
// or put a deadline on it. Logs and receipts stay private to the task directory.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, openSync, closeSync, readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { summarizeTranslationWorkflow } from './tutorial_translation_health.mjs';

const SCRIPT = fileURLToPath(import.meta.url), ROOT = path.dirname(path.dirname(SCRIPT));
const sha = value => createHash('sha256').update(value).digest('hex');
const read = file => JSON.parse(readFileSync(file, 'utf8'));
const optional = file => existsSync(file) ? read(file) : null;
const atomic = (file, value) => {
  const temporary = file + '.' + randomUUID() + '.tmp';
  writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  renameSync(temporary, file);
};
const exclusive = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
const safeEnvironment = () => Object.fromEntries(['HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TERM', 'SHELL', 'XDG_RUNTIME_DIR', 'TZ', 'PATH', 'TMPDIR']
  .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
function identity(pid) {
  if (!Number.isInteger(pid) || pid < 2) return null;
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const values = raw.slice(raw.lastIndexOf(')') + 2).trim().split(/\s+/);
    if (values[0] === 'Z') return null;
    return values[19];
  } catch (error) { if (['ENOENT', 'ESRCH'].includes(error.code)) return null; throw error; }
}
function verifiedProcess(record, requiredArgs) {
  if (!record?.startIdentity || identity(record.pid) !== record.startIdentity) return false;
  try {
    const args = readFileSync(`/proc/${record.pid}/cmdline`, 'utf8').split('\0');
    return requiredArgs.every(value => args.includes(value));
  } catch (error) { if (['ENOENT', 'ESRCH'].includes(error.code)) return false; throw error; }
}
const args = process.argv.slice(2), command = args.shift();
assert(['start', 'status', 'stop', 'supervise'].includes(command), 'Use start, status, or stop');
const allowed = command === 'start' ? ['job', 'requests', 'campaign', 'recovery-plan', 'sections-plan', 'locale'] : command === 'supervise' ? ['job', 'nonce'] : ['job'];
const options = {};
while (args.length) {
  const name = args.shift(); assert(name?.startsWith('--') && allowed.includes(name.slice(2)), 'Unknown option');
  assert(!Object.hasOwn(options, name.slice(2)), 'Duplicate option');
  const value = args.shift(); assert(value && !value.startsWith('--'), 'Missing option value'); options[name.slice(2)] = value;
}
assert(options.job, 'Provide --job');
const job = path.resolve(options.job);
assert(job.startsWith('/tmp/scirepl-tutorial-translation-job-') && !job.includes('\0'), 'Use a task-scoped job directory');
const file = name => path.join(job, name);
function checkedConfig() {
  const config = read(file('config.json'));
  assert.equal(config.schema, 1); assert.equal(config.root, ROOT); assert.equal(config.job, job);
  assert.equal(config.controller, path.join(ROOT, 'scripts', config.sectionsPlan ? 'run_tutorial_section_translations.mjs' : 'run_tutorial_translations.mjs'));
  assert.equal(config.printTimeout, '0s'); assert.equal(config.watchdogTimeout, '0s');
  assert.equal(config.pollIntervalSeconds, 30); assert.match(config.nonce, /^[a-f0-9-]{36}$/);
  return config;
}
function verifyPins(config) {
  for (const row of config.pins) assert.equal(sha(readFileSync(row.file)), row.hash, 'Pinned source/runtime changed; no background dispatch');
}
function supervisorAlive(config) {
  const record = optional(file('owner.json')) || optional(file('launch.json'));
  return record?.nonce === config.nonce && verifiedProcess(record, [SCRIPT, 'supervise', job, config.nonce]);
}
function controllerAlive(config) {
  const record = optional(file('controller.json'));
  return record?.nonce === config.nonce && verifiedProcess(record, [config.controller, '--campaign', config.campaign]);
}
function snapshot(config) {
  const result = optional(file('result.json')), supervisor = supervisorAlive(config), controller = controllerAlive(config);
  const status = optional(path.join(config.campaign, 'controller-status.json'));
  const value = { schema: 1, job, campaign: config.campaign,
    state: result?.state || (supervisor ? status?.state || 'starting' : controller ? 'orphaned-running' : 'interrupted'),
    supervisorAlive: supervisor, controllerAlive: controller,
    cancelRequested: existsSync(file('cancel.request.json')),
    exitCode: result?.exitCode ?? null,
    finishedAt: result?.finishedAt ?? null,
    progress: status,
    heartbeat: optional(file('heartbeat.json')),
    logPath: file('worker.log'),
  };
  return { ...value, workflow: summarizeTranslationWorkflow(value, {
    isWorkerAlive: worker => {
      const observed = identity(worker.pid);
      // Queue-owned workers include the boot ID; owner/controller records use
      // this wrapper's older start-tick-only identity. Never compare the two.
      return observed !== null && `${readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()}:${observed}` === worker.startIdentity;
    },
  }) };
}
if (command === 'start') {
  assert(options.campaign && Boolean(options.requests) !== Boolean(options['sections-plan']), 'Provide --campaign and exactly one of --requests or --sections-plan');
  assert(!options['sections-plan'] || !options['recovery-plan'], 'Section plans cannot also replay a chunk recovery plan');
  const campaign = path.resolve(options.campaign), requests = options.requests ? path.resolve(options.requests) : null;
  const sectionsPlan = options['sections-plan'] ? path.resolve(options['sections-plan']) : null;
  assert(campaign.startsWith('/tmp/scirepl-tutorial-translation-'), 'Use a scoped campaign');
  if (requests) assert(requests.startsWith('/tmp/scirepl-tutorial-translation-'), 'Use task-scoped sanitized requests');
  if (sectionsPlan) assert(sectionsPlan.startsWith('/tmp/scirepl-tutorial-translation-') || sectionsPlan.startsWith('/tmp/scirepl-tutorial-section-plan-'), 'Use a task-scoped sanitized section plan');
  assert(!existsSync(job) && !existsSync(campaign), 'Never replace a job or replay a campaign');
  const locale = options.locale || 'all'; assert(['all', 'ar', 'bn', 'de', 'es', 'fr', 'hi', 'id', 'ja', 'ko', 'pt-BR', 'ru', 'zh'].includes(locale));
  const recoveryPlan = options['recovery-plan'] ? path.resolve(options['recovery-plan']) : null;
  const manifestFile = path.join(ROOT, 'docs/tutorial-localization/source.json');
  const manifest = read(manifestFile), controller = path.join(ROOT, 'scripts', sectionsPlan ? 'run_tutorial_section_translations.mjs' : 'run_tutorial_translations.mjs');
  const sectionRecovery = sectionsPlan && read(sectionsPlan).recovery;
  const requestFiles = requests ? readdirSync(requests, { withFileTypes: true }).filter(entry => entry.isDirectory())
    .flatMap(entry => readdirSync(path.join(requests, entry.name)).filter(name => /^\d{2}\.json$/.test(name)).map(name => path.join(requests, entry.name, name))) : [];
  assert(sectionsPlan || requestFiles.length > 0, 'No sanitized requests to run');
  const pinFiles = [process.execPath, SCRIPT, controller, manifestFile,
    ...['tutorial_translation_queue.mjs', 'tutorial_translation_transport.mjs', 'tutorial_translation_health.mjs', 'tutorial_locale_lib.mjs', 'tutorial_locale_apply.mjs'].map(name => path.join(ROOT, 'scripts', name)),
    ...(sectionsPlan ? [sectionsPlan, ...['tutorial_locale_section_plan.mjs', 'tutorial_section_protocol.mjs', 'tutorial_review_batching.mjs', 'tutorial_section_correction_plan.mjs', 'tutorial_section_review_continuation_plan.mjs'].map(name => path.join(ROOT, 'scripts', name))] : existsSync(path.join(ROOT, 'scripts/tutorial_translation_recovery.mjs')) || recoveryPlan ? [path.join(ROOT, 'scripts/tutorial_translation_recovery.mjs')] : []),
    ...(sectionRecovery ? [path.join(ROOT, 'scripts/tutorial_section_recovery_plan.mjs')] : []),
    ...(sectionRecovery?.kind === 'explicit-approved-review-allowance' ? [path.join(ROOT, 'scripts/tutorial_section_review_allowance_plan.mjs')] : []),
    ...manifest.pages.map(page => path.join(ROOT, 'www/help', page.route, 'index.html')),
    ...requestFiles,
    ...(recoveryPlan ? [recoveryPlan] : []),
  ];
  const config = { schema: 1, root: ROOT, job, campaign, requests, sectionsPlan, locale, recoveryPlan, controller,
    nonce: randomUUID(), createdAt: new Date().toISOString(),
    model: process.env.SCIREPL_TRANSLATION_MODEL || 'gemini-3.8-flash-medium',
    effort: process.env.SCIREPL_TRANSLATION_EFFORT || 'medium',
    printTimeout: '0s', watchdogTimeout: '0s', pollIntervalSeconds: 30,
    agy: process.env.SCIREPL_TRANSLATION_AGY || '/home/s243a/.local/bin/agy',
    pins: pinFiles.map(value => ({ file: value, hash: sha(readFileSync(value)) })),
  };
  assert.match(config.model, /^[a-zA-Z0-9._/-]{1,100}$/); assert(['low', 'medium', 'high', 'xhigh', 'max'].includes(config.effort));
  // The runner may auto-update while a job is queued/running. Only its configured
  // path is fixed; each dispatched phase records observed version/hash metadata.
  // Source, requests, helpers and the Node runtime remain immutable inputs.
  mkdirSync(job, { mode: 0o700 }); exclusive(file('config.json'), config);
  const descriptor = openSync(file('worker.log'), 'wx', 0o600);
  const child = spawn(process.execPath, [SCRIPT, 'supervise', '--job', job, '--nonce', config.nonce], { cwd: ROOT, detached: true, stdio: ['ignore', descriptor, descriptor], env: safeEnvironment() });
  try {
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    exclusive(file('launch.json'), { pid: child.pid, startIdentity: identity(child.pid), nonce: config.nonce });
    child.unref();
  } finally { closeSync(descriptor); }
  console.log(JSON.stringify({ job, state: 'started-in-background', supervisorPid: child.pid, pollCommand: `node ${SCRIPT} status --job ${job}` }, null, 2));
} else if (command === 'status') {
  console.log(JSON.stringify(snapshot(checkedConfig()), null, 2));
} else if (command === 'stop') {
  const config = checkedConfig();
  if (!existsSync(file('cancel.request.json'))) exclusive(file('cancel.request.json'), { nonce: config.nonce, requestedAt: new Date().toISOString() });
  let signalled = false;
  if (supervisorAlive(config)) {
    const owner = optional(file('owner.json')) || read(file('launch.json')); process.kill(owner.pid, 'SIGTERM'); signalled = true;
  } else if (controllerAlive(config)) {
    // Only the exact previously owned orphan, never an arbitrary reused PID.
    process.kill(read(file('controller.json')).pid, 'SIGTERM'); signalled = true;
  }
  console.log(JSON.stringify({ job, cancelRequested: true, verifiedOwnerSignalled: signalled }));
} else {
  const config = checkedConfig(); assert.equal(options.nonce, config.nonce);
  let child = null, childOwner = null, childFinished = null, cancelled = existsSync(file('cancel.request.json')), heartbeat = null;
  const ownedChildAlive = () => childOwner?.nonce === config.nonce && verifiedProcess(childOwner, [config.controller, '--campaign', config.campaign]);
  const requestStop = () => { cancelled = true; if (child && ownedChildAlive()) child.kill('SIGTERM'); };
  process.on('SIGTERM', requestStop); process.on('SIGINT', requestStop); process.on('SIGHUP', () => {});
  exclusive(file('owner.json'), { pid: process.pid, startIdentity: identity(process.pid), nonce: config.nonce });
  try {
    verifyPins(config);
    await new Promise(resolve => setImmediate(resolve));
    if (cancelled || existsSync(file('cancel.request.json'))) {
      atomic(file('result.json'), { state: 'cancelled', exitCode: 143, finishedAt: new Date().toISOString() }); process.exitCode = 143;
    } else {
      verifyPins(config); // Recheck after yielding: never adopt changed inputs.
      const controllerArgs = config.sectionsPlan ? [config.controller, '--plan', config.sectionsPlan, '--campaign', config.campaign, '--execute'] : [config.controller, '--locale', config.locale, '--requests', config.requests, '--campaign', config.campaign, '--execute'];
      if (config.recoveryPlan) controllerArgs.push('--recovery-plan', config.recoveryPlan);
      child = spawn(process.execPath, controllerArgs, { cwd: ROOT, stdio: ['ignore', 'inherit', 'inherit'],
        env: { ...safeEnvironment(), SCIREPL_TRANSLATION_MODEL: config.model, SCIREPL_TRANSLATION_EFFORT: config.effort,
          SCIREPL_TRANSLATION_PRINT_TIMEOUT: '0s', SCIREPL_TRANSLATION_WATCHDOG_TIMEOUT: '0s', SCIREPL_TRANSLATION_AGY: config.agy },
      });
      // Track the actual child in memory before any fallible metadata write.
      // Listen before awaiting spawn, so a fast exit/error cannot be missed.
      childFinished = new Promise(resolve => {
        child.once('error', () => resolve({ code: 1, signal: null, spawnError: true }));
        child.once('close', (code, signal) => resolve({ code, signal }));
      });
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      childOwner = { pid: child.pid, startIdentity: identity(child.pid), nonce: config.nonce };
      assert(childOwner.startIdentity, 'Cannot establish controller ownership');
      exclusive(file('controller.json'), childOwner);
      const beat = () => {
        if (existsSync(file('cancel.request.json'))) requestStop();
        atomic(file('heartbeat.json'), { updatedAt: new Date().toISOString(), controllerAlive: controllerAlive(config), cancelled });
      };
      let heartbeatFailed = false;
      heartbeat = setInterval(() => { try { beat(); } catch { heartbeatFailed = true; requestStop(); } }, 30000); beat();
      const result = await childFinished;
      clearInterval(heartbeat);
      assert(!heartbeatFailed, 'Background status persistence failed');
      atomic(file('result.json'), { state: cancelled ? 'cancelled' : result.code === 0 ? 'completed' : 'held', exitCode: result.code, signal: result.signal, finishedAt: new Date().toISOString() });
      process.exitCode = cancelled ? 143 : result.code ?? 1;
    }
  } catch {
    clearInterval(heartbeat);
    if (child && ownedChildAlive()) child.kill('SIGTERM');
    if (childFinished) await childFinished;
    atomic(file('result.json'), { state: 'failed', errorCode: 'SUPERVISOR_FAILURE', exitCode: 1, finishedAt: new Date().toISOString() }); process.exitCode = 1;
  }
}
