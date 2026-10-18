#!/usr/bin/env node
// Observation only. This deliberately is not imported by a pinned live owner.
import { readFileSync, readdirSync, lstatSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { captureActivitySnapshot, assessTranslationActivity, recommendTranslationRecovery } from './tutorial_translation_activity.mjs';
import { inspectInflightCoverage } from './tutorial_translation_inflight.mjs';
import { readWorkerActivity } from './tutorial_translation_process_activity.mjs';

const SCRIPT = fileURLToPath(import.meta.url);
const ROOT = path.dirname(path.dirname(SCRIPT));
const finite = value => typeof value === 'number' && Number.isFinite(value);
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const safeDate = value => finite(value) && Math.abs(value) <= 8.64e15 ? new Date(value).toISOString() : null;
const MAX_METADATA_BYTES = 8 * 1024 * 1024;
const WORKFLOW_STATUSES = new Set(['starting', 'running', 'running_with_holds', 'waiting_for_capacity', 'needs_recovery', 'needs_workers', 'needs_inspection', 'completed', 'cancelled', 'cancelling']);
const OUTCOME_FLAGS = ['timedOut', 'outputLimited', 'cancelled', 'persistenceFailure', 'cliTimeoutWarning'];
const ACTIONS = {
  login_required: 'Check AGY authentication and sign in if requested; do not replay automatically.',
  authentication_attention: 'Authentication failed or is required. Inspect AGY session and refresh status; interactive sign-in has not been established.',
  token_refresh_unknown: 'Token expiry was reported; automatic refresh may exist. Check authentication metadata before deciding that sign-in is needed.',
  forbidden_ambiguous: 'Inspect account authorization or provider policy; a forbidden response alone does not prove login is needed.',
  rate_limit: 'Inspect the provider rate limit and existing queue; do not exceed the shared concurrency cap or retry automatically.',
  quota_or_billing: 'Inspect provider quota or billing; additional workers will not resolve this evidence.',
  capacity_unavailable: 'Observe provider availability; an existing failed attempt is not permission for automatic replay.',
  network_transport: 'Inspect the connection or transport failure before any explicitly authorized recovery.',
  timeout: 'Inspect the recorded timeout failure; do not impose a new deadline on live or queued workers.',
  output_limit: 'The recorded output limit was reached; preserve partial evidence and inspect batch size before any authorized recovery.',
  cancelled: 'The attempt was explicitly cancelled; inspect its ownership and dispatch history before any authorized replacement.',
  validation_keep: 'Correct or independently justify eligible unchanged labels in an explicitly authorized bounded recovery.',
  validation_numeric: 'Correct numeric preservation without weakening the validation gate.',
  validation_placeholder: 'Correct protected placeholders without weakening the validation gate.',
  validation_incomplete: 'Inspect incomplete output evidence before any explicitly authorized bounded recovery.',
  validation_identity: 'Audit conversation ownership and identity before any replay.',
  validation_other: 'Inspect the held validation phase before any explicitly authorized recovery.',
  provider_unknown: 'Inspect safe provider error metadata; this evidence does not establish authentication, quota or rate limiting.',
  metadata_unknown: 'Some structured metadata is unavailable or incomplete; do not infer that no error or no dispatch occurred.',
};

// Pure classifier. Arbitrary field numbers and the validator phrase
// "automatic retry forbidden" are not HTTP/authentication evidence.
export function classifyDiagnostic({ message = '', codes = [], origin = 'provider' } = {}) {
  const text = typeof message === 'string' ? message : '';
  const values = codes.filter(value => typeof value === 'string' || typeof value === 'number').map(value => String(value).trim().toUpperCase());
  const code = n => values.some(value => value === String(n) || new RegExp(`^HTTP[_ -]?${n}$`).test(value)) ||
    new RegExp(`\\b(?:HTTP(?:\\/\\d(?:\\.\\d)?)?|HTTP status|status(?: code)?|response code)\\s*[:=]?\\s*${n}\\b`, 'i').test(text);
  let category;
  if (origin === 'validation' && /keep declaration|keptfields|unchanged English|label keeps/i.test(text)) category = 'validation_keep';
  else if (origin === 'validation' && /numeric|number.*(?:added|changed|order|preserv)/i.test(text)) category = 'validation_numeric';
  else if (origin === 'validation' && /protected|placeholder|token.*order/i.test(text)) category = 'validation_placeholder';
  else if (origin === 'validation' && /not complete.*JSON|incomplete.*JSON|fields incomplete|incomplete field/i.test(text)) category = 'validation_incomplete';
  else if (origin === 'validation' && /conversation.*identity|identity.*conversation/i.test(text)) category = 'validation_identity';
  else if (origin === 'validation') category = /transport|envelope/i.test(text) ? 'provider_unknown' : 'validation_other';
  else if (values.some(value => /^(?:LOGIN_REQUIRED|NOT_LOGGED_IN)$/.test(value)) ||
    /\b(?:login|log[ -]in|sign[ -]?in)[ _-]required\b|\bnot (?:logged|signed) in\b|\b(?:please|must|need to|required to) (?:log in|sign in)\b/i.test(text)) category = 'login_required';
  else if (code(401) || values.some(value => /^(?:UNAUTHENTICATED|AUTHENTICATION_REQUIRED|SESSION_EXPIRED|INVALID_GRANT)$/.test(value)) ||
    /\bunauthenticated\b|\bauthentication[ _-]required\b|\bsession[ _-](?:has[ _-])?expired\b|\bexpired[ _-]session\b|\bnot authenticated\b|\binvalid_grant\b|\brevoked[ _-]refresh[ _-]token\b|\brefresh[ _-]token.{0,20}revoked\b/i.test(text)) category = 'authentication_attention';
  else if (/\b(?:token|credential)[ _-](?:has[ _-])?expir(?:ed|y|ation)\b|\bexpired[ _-](?:access[ _-])?token\b/i.test(text) || values.some(value => /^(?:TOKEN_EXPIRED|EXPIRED_TOKEN)$/.test(value))) category = 'token_refresh_unknown';
  else if (code(403) || values.includes('PERMISSION_DENIED') || /\bpermission denied\b|\bforbidden\b/i.test(text) && !/automatic (?:repair|retry).*forbidden/i.test(text)) category = 'forbidden_ambiguous';
  else if (code(429) || /\brate[ _-]?limit(?:ed|ing)?\b|\btoo many requests\b/i.test(text)) category = 'rate_limit';
  else if (/\bquota\b|\bresource[ _-]exhausted\b|\binsufficient credits?\b|\bbilling\b/i.test(text) || values.includes('RESOURCE_EXHAUSTED')) category = 'quota_or_billing';
  else if (code(503) || /\boverload(?:ed)?\b|\bcapacity\b|\bunavailable\b/i.test(text)) category = 'capacity_unavailable';
  else if (/\btimeout\b|\btimed out\b|\bdeadline exceeded\b/i.test(text)) category = 'timeout';
  else if (/\bconnection\b|\bnetwork\b|\bsocket\b|\bfetch failed\b|\bECONN\w*\b|\bstream.*(?:closed|error|reset)\b/i.test(text)) category = 'network_transport';
  else category = origin === 'validation' && !/transport|envelope/i.test(text) ? 'validation_other' : 'provider_unknown';
  return { category, attentionRequired: category !== 'token_refresh_unknown',
    loginRequired: category === 'login_required' ? true : null, recommendedAction: ACTIONS[category] };
}

export function summarizeLatencies(seconds) {
  const values = seconds.filter(value => finite(value) && value >= 0).sort((a, b) => a - b);
  const round = value => Math.round(value * 1000) / 1000;
  return { samples: values.length, medianSeconds: values.length ? round(values[Math.ceil(values.length * .5) - 1]) : null,
    p90Seconds: values.length ? round(values[Math.ceil(values.length * .9) - 1]) : null,
    maximumSeconds: values.length ? round(values.at(-1)) : null };
}

function stat(file) {
  try { const value = lstatSync(file); return value.isFile() && !value.isSymbolicLink() ? value : null; }
  catch { return null; }
}
function read(file) {
  const before = stat(file);
  if (!before) return { state: 'unavailable', value: null, mtimeMs: null };
  if (before.size > MAX_METADATA_BYTES) return { state: 'unknown', value: null, mtimeMs: before.mtimeMs };
  try {
    const value = JSON.parse(readFileSync(file, 'utf8')), after = stat(file);
    if (!after || before.size !== after.size || before.mtimeMs !== after.mtimeMs || !value || typeof value !== 'object' || Array.isArray(value)) return { state: 'unknown', value: null, mtimeMs: after?.mtimeMs ?? null };
    return { state: 'readable', value, mtimeMs: after.mtimeMs };
  } catch { return { state: 'unknown', value: null, mtimeMs: before.mtimeMs }; }
}
function entries(directory) {
  try { const info = lstatSync(directory); if (!info.isDirectory() || info.isSymbolicLink()) return { readable: false, values: [] }; return { readable: true, values: readdirSync(directory, { withFileTypes: true }) }; }
  catch { return { readable: false, values: [] }; }
}
function outerError(envelope) {
  // Never inspect envelope.response, including on failed calls.
  const messages = [], codes = [];
  for (const value of [envelope, envelope?.error]) {
    if (typeof value === 'string') { messages.push(value); continue; }
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    for (const name of ['code', 'status', 'status_code', 'statusCode', 'http_status', 'httpStatus', 'error_code', 'error_type', 'type']) if (['string', 'number'].includes(typeof value[name])) codes.push(value[name]);
    for (const name of ['message', 'reason', 'description']) if (typeof value[name] === 'string') messages.push(value[name]);
  }
  return classifyDiagnostic({ message: messages.join(' '), codes });
}
function transportError(transport, envelope) {
  const outer = envelope ? outerError(envelope) : null;
  if (outer && outer.category !== 'provider_unknown') return outer;
  // Failed-call stderr is private diagnostic evidence, never public output.
  // Do not inspect it for a successful outer transport or scan response bodies.
  const stderr = classifyDiagnostic({ message: typeof transport.stderr === 'string' ? transport.stderr : '' });
  if (stderr.category !== 'provider_unknown') return stderr;
  const category = transport.timedOut === true || transport.cliTimeoutWarning === true ? 'timeout' :
    transport.outputLimited === true ? 'output_limit' : transport.cancelled === true ? 'cancelled' :
    transport.persistenceFailure === true || !envelope ? 'metadata_unknown' : 'provider_unknown';
  return { category, attentionRequired: true, loginRequired: null, recommendedAction: ACTIONS[category] };
}
function workflowSummary(snapshot) {
  const value = snapshot?.workflow, workers = value?.workers, units = value?.units;
  return { status: WORKFLOW_STATUSES.has(value?.status) ? value.status : 'unknown',
    attentionRequired: typeof value?.attentionRequired === 'boolean' ? value.attentionRequired : null,
    canAdvance: typeof value?.canAdvance === 'boolean' ? value.canAdvance : null,
    supervisorAlive: typeof snapshot?.supervisorAlive === 'boolean' ? snapshot.supervisorAlive : null,
    controllerAlive: typeof snapshot?.controllerAlive === 'boolean' ? snapshot.controllerAlive : null,
    workers: { live: count(workers?.live), queued: count(workers?.queued), unverifiable: count(workers?.unverifiable) },
    units: Object.fromEntries(['planned', 'completed', 'held', 'skipped', 'remaining'].map(key => [key, count(units?.[key])])) };
}

// Only allowlisted counts, timestamps and classifications leave this function.
// Private IDs are used transiently solely to difference cumulative counters.
export function inspectCampaign(campaign, snapshot = null) {
  const coverage = { pageDirectories: 0, transportRecords: 0, readableTransports: 0, failedPageRecords: 0, unknownRecords: 0, unreadableDirectories: 0 };
  const pages = [], top = entries(campaign);
  if (!top.readable) coverage.unreadableDirectories++;
  coverage.unreadableDirectories += top.values.filter(entry => entry.isSymbolicLink()).length;
  for (const locale of top.values.filter(entry => entry.isDirectory() && !entry.isSymbolicLink())) {
    const level = entries(path.join(campaign, locale.name));
    if (!level.readable) coverage.unreadableDirectories++;
    coverage.unreadableDirectories += level.values.filter(entry => entry.isSymbolicLink()).length;
    for (const page of level.values.filter(entry => entry.isDirectory() && !entry.isSymbolicLink())) pages.push(path.join(campaign, locale.name, page.name));
  }
  const phases = new Map(), rows = [], failures = [];
  let latestSuccess = null, outerSuccesses = 0;
  for (const directory of pages) {
    const listing = entries(directory);
    if (!listing.readable) { coverage.unreadableDirectories++; continue; }
    coverage.unknownRecords += listing.values.filter(entry => entry.isSymbolicLink() && /^(?:(?:draft|review)-\d+\.transport|failed|started)\.json$/.test(entry.name)).length;
    if (!listing.values.some(entry => entry.name === 'started.json')) continue;
    coverage.pageDirectories++;
    for (const entry of listing.values.filter(entry => entry.isFile() && !entry.isSymbolicLink() && /^(?:draft|review)-\d+\.transport\.json$/.test(entry.name))) {
      coverage.transportRecords++;
      const phase = entry.name.slice(0, -'.transport.json'.length), key = directory + '/' + phase, record = read(path.join(directory, entry.name));
      if (record.state !== 'readable') { coverage.unknownRecords++; phases.set(key, { category: 'metadata_unknown', at: record.mtimeMs }); continue; }
      coverage.readableTransports++;
      const transport = record.value;
      let envelope;
      try { envelope = JSON.parse(transport.stdout); } catch { envelope = null; }
      const envelopeValid = envelope && typeof envelope === 'object' && !Array.isArray(envelope);
      const outcomeComplete = Number.isInteger(transport.exitCode) && typeof transport.stdout === 'string' && typeof transport.stderr === 'string' && OUTCOME_FLAGS.every(flag => typeof transport[flag] === 'boolean');
      const hasError = envelopeValid && (envelope.is_error === true || envelope.is_error === 'true' || envelope.error !== undefined && envelope.error !== null && envelope.error !== false && envelope.error !== '' && envelope.error !== 0);
      const explicitFailure = Number.isInteger(transport.exitCode) && transport.exitCode !== 0 || OUTCOME_FLAGS.some(flag => transport[flag] === true) ||
        envelopeValid && (hasError || ['error', 'failed', 'failure', 'unauthenticated', 'login_required', 'not_logged_in', 'authentication_required', 'session_expired', 'invalid_grant'].includes(String(envelope.status).toLowerCase()) || finite(envelope.status) && envelope.status >= 400);
      if (!outcomeComplete || !envelopeValid) coverage.unknownRecords++;
      if (!envelopeValid) { phases.set(key, explicitFailure ? { ...transportError(transport, null), at: record.mtimeMs } : { category: 'metadata_unknown', at: record.mtimeMs }); continue; }
      const success = outcomeComplete && String(envelope.status).toLowerCase() === 'success' && !hasError && transport.exitCode === 0 && !OUTCOME_FLAGS.some(flag => transport[flag] === true);
      if (success) { outerSuccesses++; if (latestSuccess === null || record.mtimeMs > latestSuccess) latestSuccess = record.mtimeMs; }
      else phases.set(key, explicitFailure ? { ...transportError(transport, envelope), at: record.mtimeMs } : { category: 'metadata_unknown', at: record.mtimeMs });
      const child = stat(path.join(directory, phase + '.child.json'));
      const wallSeconds = child ? (record.mtimeMs - child.mtimeMs) / 1000 : null;
      rows.push({ group: typeof envelope.conversation_id === 'string' ? envelope.conversation_id : null,
        at: record.mtimeMs, wallSeconds: finite(wallSeconds) && wallSeconds >= 0 ? wallSeconds : null,
        duration: finite(envelope.duration_seconds) && envelope.duration_seconds >= 0 ? envelope.duration_seconds : null,
        turns: count(envelope.num_turns), phase: phase.startsWith('draft') ? 'draft' : 'review' });
    }
    if (listing.values.some(entry => entry.name === 'failed.json')) {
      coverage.failedPageRecords++;
      const failed = read(path.join(directory, 'failed.json'));
      if (failed.state !== 'readable') { coverage.unknownRecords++; failures.push({ category: 'metadata_unknown', at: failed.mtimeMs }); continue; }
      if (typeof failed.value.error !== 'string' || typeof failed.value.phase !== 'string') { coverage.unknownRecords++; failures.push({ category: 'metadata_unknown', at: failed.mtimeMs }); continue; }
      const phase = /^(?:draft|review)-\d+$/.test(failed.value.phase) ? failed.value.phase : null;
      const key = directory + '/' + phase, prior = phase ? phases.get(key) : null;
      const diagnostic = classifyDiagnostic({ message: failed.value.error, origin: 'validation' });
      // Specific structured provider evidence wins over a generic controller error.
      if (prior && !['provider_unknown', 'metadata_unknown'].includes(prior.category)) failures.push(prior);
      else failures.push({ ...diagnostic, at: failed.mtimeMs });
      if (phase) phases.delete(key);
    }
  }
  failures.push(...phases.values());
  const categories = {};
  for (const failure of failures) categories[failure.category] = (categories[failure.category] ?? 0) + 1;
  const timeOf = category => failures.filter(row => row.category === category && finite(row.at)).reduce((latest, row) => latest === null ? row.at : Math.max(latest, row.at), null);
  const lastFailure = failures.filter(row => finite(row.at)).reduce((latest, row) => latest === null ? row.at : Math.max(latest, row.at), null);
  const loginAt = timeOf('login_required'), authAttentionAt = timeOf('authentication_attention'), tokenAt = timeOf('token_refresh_unknown'), forbiddenAt = timeOf('forbidden_ambiguous');
  const authAt = loginAt === null ? authAttentionAt : authAttentionAt === null ? loginAt : Math.max(loginAt, authAttentionAt);
  const newerThanSuccess = at => at !== null && (latestSuccess === null || at >= latestSuccess);
  let authStatus = 'unknown';
  if (newerThanSuccess(loginAt)) authStatus = 'login_required_evidence';
  else if (newerThanSuccess(authAttentionAt)) authStatus = 'authentication_attention';
  else if (newerThanSuccess(tokenAt)) authStatus = 'refresh_status_unknown';
  else if (newerThanSuccess(forbiddenAt)) authStatus = 'authorization_or_policy_ambiguous';
  else if (latestSuccess !== null) authStatus = authAt !== null ? 'worked_after_recorded_auth_failure' : 'worked_at_last_success';
  const byGroup = new Map();
  for (const row of rows.filter(row => row.group !== null).sort((a, b) => a.at - b.at)) {
    const previous = byGroup.get(row.group);
    row.delta = row.duration !== null && row.turns === 1 ? row.duration :
      previous && row.duration !== null && previous.duration !== null && row.turns === previous.turns + 1 && row.duration >= previous.duration ? row.duration - previous.duration : null;
    byGroup.set(row.group, row);
  }
  const latencies = rows.map(row => ({ ...row, seconds: row.wallSeconds ?? row.delta ?? null,
    source: row.wallSeconds !== null ? 'child_to_receipt' : row.delta != null ? 'cumulative_delta' : 'unknown' }));
  const ownerWorkflow = workflowSummary(snapshot);
  const activity = assessTranslationActivity(captureActivitySnapshot(snapshot, { readWorker: readWorkerActivity }));
  const inflight = inspectInflightCoverage(campaign, snapshot);
  const workflow = activity.attentionRequired && ['running', 'running_with_holds', 'starting'].includes(ownerWorkflow.status)
    ? { ...ownerWorkflow, status: 'needs_inspection', attentionRequired: true, canAdvance: null,
      reasonCode: activity.reasonCode, recommendedAction: 'Inspect progress independently of process liveness; do not cancel or replace automatically.' }
    : ownerWorkflow;
  const requiredCategory = authStatus === 'login_required_evidence' ? 'login_required' :
    authStatus === 'authentication_attention' ? 'authentication_attention' :
    authStatus === 'authorization_or_policy_ambiguous' ? 'forbidden_ambiguous' : null;
  const authentication = { status: authStatus, loginRequired: authStatus === 'login_required_evidence' ? true : null,
    currentAuthenticationGuaranteed: false, lastSuccessAt: safeDate(latestSuccess), lastAuthenticationFailureAt: safeDate(authAt), lastLoginRequiredAt: safeDate(loginAt),
    lastTokenExpiryAt: safeDate(tokenAt),
    completedMetadataComplete: coverage.readableTransports > 0 && coverage.unknownRecords === 0 && coverage.unreadableDirectories === 0,
    metadataComplete: coverage.readableTransports > 0 && coverage.unknownRecords === 0 && coverage.unreadableDirectories === 0 && inflight.complete === true,
    scope: 'Completed transport receipts only; outstanding requests and present authentication are not verified.' };
  const orchestration = recommendTranslationRecovery({ activity, workflow: ownerWorkflow,
    budget: snapshot?.progress?.recoveryBudget, authentication, failureCategories: categories });
  return { schema: 1, observationOnly: true, workflow, ownerWorkflow, activity, inflight, orchestration, coverage,
    authentication,
    calls: { transportRecordsFound: coverage.transportRecords, readableTransportRecords: coverage.readableTransports, outerSuccesses, lastSuccessAt: safeDate(latestSuccess), lastFailureAt: safeDate(lastFailure),
      failureCategories: categories, unknownOutcomeRecords: coverage.unknownRecords },
    throughput: { ...summarizeLatencies(latencies.map(row => row.seconds)),
      draft: summarizeLatencies(latencies.filter(row => row.phase === 'draft').map(row => row.seconds)),
      review: summarizeLatencies(latencies.filter(row => row.phase === 'review').map(row => row.seconds)),
      childToReceiptSamples: latencies.filter(row => row.source === 'child_to_receipt').length,
      cumulativeDeltaSamples: latencies.filter(row => row.source === 'cumulative_delta').length,
      unknownLatencySamples: coverage.transportRecords - latencies.filter(row => row.source !== 'unknown').length,
      timingCaveat: 'Filesystem timings approximate child-to-receipt wall time. Envelope durations are cumulative per conversation and are never summed as per-request durations.' },
    attentionRequired: requiredCategory !== null || coverage.unknownRecords > 0 || coverage.unreadableDirectories > 0 || failures.length > 0 || workflow.attentionRequired || activity.attentionRequired,
    recommendedAction: requiredCategory ? ACTIONS[requiredCategory] : authStatus === 'refresh_status_unknown' ? ACTIONS.token_refresh_unknown :
      coverage.unknownRecords || coverage.unreadableDirectories ? ACTIONS.metadata_unknown :
      activity.attentionRequired ? 'Inspect the existing request: process liveness and a fresh heartbeat do not verify progress. Do not cancel, replay or add replacement workers automatically.' :
      workflow.canAdvance === true ? failures.length ? 'Existing live work can continue. Inspect the held subset using the failure categories; do not replay phases or modify live owners.' : 'Observe existing work; do not replay failed phases, add workers or modify live owners.' :
      'Use the workflow status and failure categories to scope an explicitly authorized inspection or bounded recovery.',
    scope: 'Current campaign structured metadata only; outer successes are not translation acceptance, and no model or authentication network request was made.' };
}

export function readJobDiagnostics(job) {
  const resolved = path.resolve(job);
  if (!resolved.startsWith('/tmp/scirepl-tutorial-translation-job-') || resolved.includes('\0')) throw new Error('Provide a task-scoped translation job directory.');
  const config = read(path.join(resolved, 'config.json'));
  if (config.state !== 'readable' || typeof config.value.campaign !== 'string' || !path.resolve(config.value.campaign).startsWith('/tmp/scirepl-tutorial-translation-')) throw new Error('Job configuration metadata is unavailable or invalid.');
  let snapshot = null;
  const result = spawnSync(process.execPath, [path.join(ROOT, 'scripts/tutorial_translation_background.mjs'), 'status', '--job', resolved], { cwd: ROOT, encoding: 'utf8', timeout: 15000, maxBuffer: 8 * 1024 * 1024 });
  if (result.status === 0) { try { snapshot = JSON.parse(result.stdout); } catch { /* Unknown, never missing or zero. */ } }
  const summary = inspectCampaign(path.resolve(config.value.campaign), snapshot);
  return { ...summary, statusReadable: snapshot !== null };
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT) {
  try {
    if (process.argv.length !== 4 || process.argv[2] !== '--job') throw new Error('Usage: node scripts/tutorial_translation_diagnostics.mjs --job DIRECTORY');
    console.log(JSON.stringify(readJobDiagnostics(process.argv[3]), null, 2));
  } catch {
    console.log(JSON.stringify({ schema: 1, observationOnly: true, statusReadable: false, attentionRequired: true,
      authentication: { status: 'unknown', loginRequired: null, currentAuthenticationGuaranteed: false },
      reasonCode: 'diagnostic_metadata_unavailable', recommendedAction: ACTIONS.metadata_unknown }));
    process.exitCode = 1;
  }
}
