// Pure advisory policy. Liveness, local activity and task progress are distinct.
// This module never starts/stops workers, releases leases or authorizes spending.
const count = n => Number.isSafeInteger(n) && n >= 0 ? n : null;
const time = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const finite = n => typeof n === 'number' && Number.isFinite(n);
const ACTIVE = new Set(['running', 'launching']);
const TERMINAL = new Set(['completed', 'cancelled', 'held', 'failed']);
export const DEFAULT_ACTIVITY_POLICY = Object.freeze({ advisoryAfterSeconds: 1800, heartbeatStaleSeconds: 120, minimumSampleSeconds: 10 });

// Private comparison keys never leave assessTranslationActivity's public result.
export function captureActivitySnapshot(snapshot, { nowMs = Date.now(), readWorker = () => ({ alive: null }) } = {}) {
  return {
    atMs: nowMs, state: snapshot?.state, workflowStatus: snapshot?.workflow?.status,
    supervisorAlive: snapshot?.supervisorAlive, controllerAlive: snapshot?.controllerAlive,
    heartbeatAtMs: time(snapshot?.progress?.updatedAt),
    completedPages: count(snapshot?.workflow?.units?.completed),
    phases: (Array.isArray(snapshot?.progress?.phases) ? snapshot.progress.phases : []).map((phase, index) => {
      let worker = { alive: null };
      if (phase?.worker) { try { worker = readWorker(phase.worker) || worker; } catch { /* Unknown is not dead. */ } }
      return {
        key: `${phase?.locale}/${phase?.chunk}/${phase?.phase}/${index}`,
        identity: phase?.worker ? `${phase.worker.pid}:${phase.worker.startIdentity}` : null,
        state: phase?.state, elapsedSeconds: count(phase?.elapsedSeconds),
        stdoutBytes: count(phase?.stdoutBytes), stderrBytes: count(phase?.stderrBytes),
        alive: worker.alive === true ? true : worker.alive === false ? false : null,
        cpuTicks: count(worker.cpuTicks), ioOperations: count(worker.ioOperations),
      };
    }),
  };
}

export function assessTranslationActivity(current, previous = null, policy = DEFAULT_ACTIVITY_POLICY) {
  const settings = { ...DEFAULT_ACTIVITY_POLICY, ...policy };
  for (const name of Object.keys(DEFAULT_ACTIVITY_POLICY)) if (!finite(settings[name]) || settings[name] <= 0) throw new Error('Invalid activity policy');
  const interval = previous && finite(current?.atMs) && finite(previous?.atMs) ? (current.atMs - previous.atMs) / 1000 : null;
  const heartbeatAge = finite(current?.atMs) && finite(current?.heartbeatAtMs) ? (current.atMs - current.heartbeatAtMs) / 1000 : null;
  const phases = Array.isArray(current?.phases) ? current.phases : [];
  const running = phases.filter(p => ACTIVE.has(p.state)), queued = phases.filter(p => p.state === 'queued');
  const base = { schema: 1, observationOnly: true, automaticRecovery: false,
    providerProgress: 'unknown', taskProgress: 'unknown', lastOutputAt: null,
    requestElapsedSeconds: running.length && running.every(p => count(p.elapsedSeconds) !== null) ? Math.max(...running.map(p => p.elapsedSeconds)) : null,
    sampleSeconds: interval !== null && interval >= 0 ? interval : null,
    heartbeatAgeSeconds: heartbeatAge !== null && heartbeatAge >= 0 ? heartbeatAge : null,
    runningPhases: running.length, queuedPhases: queued.length,
    outputDeltaBytes: null, cpuTickDelta: null, ioOperationDelta: null,
    noOutputObservedSeconds: null,
    advisoryAfterSeconds: settings.advisoryAfterSeconds,
    caveat: 'Byte/CPU/I/O changes prove local activity only, not provider progress or accepted translations. Legacy last-output time is unknown.',
  };
  const result = (status, attentionRequired, reasonCode, localActivity = 'unknown', extra = {}) => ({ ...base, status, attentionRequired, reasonCode, localActivity, ...extra });
  if (!finite(current?.atMs) || interval !== null && interval < 0 || heartbeatAge !== null && heartbeatAge < 0) return result('unknown', true, 'clock_or_metadata_invalid');
  if (current?.workflowStatus === 'needs_inspection') return result('needs_inspection', true, 'ownership_or_metadata_needs_inspection');
  if (TERMINAL.has(current?.state)) return result('terminal', false, 'finite_job_terminal');
  if (heartbeatAge === null) return result('unknown', true, 'heartbeat_age_unknown');
  if (heartbeatAge > settings.heartbeatStaleSeconds) return result('needs_inspection', true, 'controller_heartbeat_stale');
  if (phases.some(p => p.state === 'blocked')) return result('needs_inspection', true, 'queue_ownership_blocked');
  if (queued.length && !running.length && current?.controllerAlive === true) return result('waiting_for_capacity', false, 'legitimate_queue_wait', 'queue_wait');
  if (!running.length) return result('progress_unknown', false, 'between_phases_or_finalizing');
  const before = new Map((previous?.phases || []).map(p => [p.key, p]));
  const matched = running.map(p => ({ after: p, before: before.get(p.key) }));
  const comparable = interval !== null && interval >= settings.minimumSampleSeconds && matched.every(({ after: a, before: b }) => b && b.state === a.state && b.identity === a.identity);
  if (comparable && matched.some(({ after: a, before: b }) => a.alive === false && b.alive === false)) return result('needs_inspection', true, 'active_worker_missing_or_waiting_for_close');
  if (running.some(p => p.state === 'running' && (p.identity === null || p.alive !== true))) return result('needs_inspection', true, 'running_worker_identity_unverified');
  if (comparable && matched.some(({ after: a, before: b }) => ['cpuTicks', 'ioOperations'].some(k => count(a[k]) !== null && count(b[k]) !== null && a[k] < b[k]))) return result('unknown', true, 'process_counters_regressed');
  const counters = ['stdoutBytes', 'stderrBytes'];
  // Counters are published on a 30-second timer. Two reads of the same saved
  // snapshot are not independent output observations, however long we sampled.
  const outputWindow = previous && finite(current.heartbeatAtMs) && finite(previous.heartbeatAtMs) ? (current.heartbeatAtMs - previous.heartbeatAtMs) / 1000 : null;
  const outputKnown = comparable && outputWindow > 0 && matched.every(({ after: a, before: b }) => counters.every(k => count(a[k]) !== null && count(b[k]) !== null));
  if (outputKnown && matched.some(({ after: a, before: b }) => counters.some(k => a[k] < b[k]))) return result('unknown', true, 'worker_counters_regressed');
  const deltas = { outputDeltaBytes: outputKnown ? matched.reduce((n, { after: a, before: b }) => n + a.stdoutBytes + a.stderrBytes - b.stdoutBytes - b.stderrBytes, 0) : null };
  for (const [key, output] of [['cpuTicks', 'cpuTickDelta'], ['ioOperations', 'ioOperationDelta']]) {
    deltas[output] = comparable && matched.every(({ after: a, before: b }) => count(a[key]) !== null && count(b[key]) !== null && a[key] >= b[key]) ? matched.reduce((n, { after: a, before: b }) => n + a[key] - b[key], 0) : null;
  }
  deltas.noOutputObservedSeconds = deltas.outputDeltaBytes === 0 ? outputWindow : null;
  const taskProgress = count(current?.completedPages) !== null && count(previous?.completedPages) !== null && current.completedPages > previous.completedPages ? 'completed_page_count_increased' : 'unknown';
  const local = deltas.outputDeltaBytes > 0 ? 'output_observed' : deltas.cpuTickDelta > 0 || deltas.ioOperationDelta > 0 ? 'process_activity_observed' : outputKnown ? 'no_output_observed' : 'unknown';
  if (base.requestElapsedSeconds !== null && base.requestElapsedSeconds >= settings.advisoryAfterSeconds) {
    const silent = outputKnown && deltas.outputDeltaBytes === 0 && matched.every(({ after: a, before: b }) => a.alive === true && b.alive === true);
    return result(silent ? 'suspected_stall' : 'progress_unknown', true, silent ? 'long_request_no_output_during_sample' : 'long_request_progress_unverified', local, { ...deltas, taskProgress });
  }
  return result(local === 'output_observed' ? 'local_activity_observed' : 'progress_unknown', false, comparable ? 'sample_does_not_prove_provider_progress' : 'comparable_activity_sample_unavailable', local, { ...deltas, taskProgress });
}

export function recommendTranslationRecovery({ activity, workflow, budget, authentication, failureCategories = {}, audit = {} } = {}) {
  const used = count(budget?.usedReviewCalls), max = count(budget?.maxReviewCalls);
  const source = count(budget?.sourceUsedReviewCalls), jointUsed = count(budget?.jointUsedReviewCalls), jointMax = count(budget?.jointMaxReviewCalls);
  const lineage = ['sourceUsedReviewCalls', 'jointUsedReviewCalls', 'jointMaxReviewCalls'].some(k => budget?.[k] !== undefined);
  const valid = used !== null && max !== null && used <= max && (!lineage || source !== null && jointUsed === source + used && jointMax !== null && jointUsed <= jointMax);
  const remaining = valid ? Math.min(max - used, lineage ? jointMax - jointUsed : max - used) : null;
  const common = { schema: 1, observationOnly: true, automaticRecovery: false, replacementAllowed: false,
    remainingReviewCalls: remaining, liveOwnerMustNotBeDuplicated: true, failedAttemptsConsumeAllowance: true };
  const decision = (value, reasonCode, recommendedAction, extra = {}) => ({ ...common, decision: value, reasonCode, recommendedAction, ...extra });
  if (workflow?.status === 'completed' && workflow?.units?.remaining === 0) return decision('no_replacement', 'finite_job_completed', 'Verify the larger workflow separately.');
  if (!valid) return decision('hold', 'review_budget_unknown_or_inconsistent', 'Reconcile the explicit tail and joint call allocation; unknown metadata never permits replacement.');
  if (remaining === 0) return decision('hold', 'review_budget_exhausted', 'Inspect the existing request without duplicating it. A replacement requires a new explicit bounded call allowance; cancellation refunds nothing.');
  if (authentication?.loginRequired === true) return decision('inspect_shared_blocker', 'explicit_login_required', 'Resolve explicit sign-in evidence before considering replacement; do not probe or sign in automatically.');
  const shared = ['authentication_attention', 'forbidden_ambiguous', 'rate_limit', 'quota_or_billing', 'capacity_unavailable', 'network_transport'].some(k => count(failureCategories[k]) > 0);
  if (shared) return decision('inspect_shared_blocker', 'recorded_provider_or_transport_blocker', 'Investigate the recorded blocker; another agent may encounter the same failure.');
  if (workflow?.status === 'waiting_for_capacity' || activity?.status === 'waiting_for_capacity') return decision('wait', 'legitimate_queue_wait', 'Preserve the legitimate shared queue; do not cancel, retry or add duplicate workers.');
  if (workflow?.workers?.live > 0 || workflow?.supervisorAlive === true || workflow?.controllerAlive === true) return decision(activity?.attentionRequired ? 'inspect_existing_owner' : 'observe', 'existing_owner_retained', 'Observe or inspect the existing owner; an activity warning does not authorize cancellation or replacement.');
  if (workflow?.workers?.live !== 0 || workflow?.workers?.unverifiable !== 0 || workflow?.supervisorAlive !== false || workflow?.controllerAlive !== false) return decision('hold', 'ownership_unresolved', 'Verify every previous owner and worker identity before replacement.');
  const units = workflow?.units;
  const unitsValid = ['planned', 'completed', 'held', 'skipped', 'remaining'].every(k => count(units?.[k]) !== null)
    && units.completed + units.skipped <= units.planned && units.remaining === units.planned - units.completed - units.skipped
    && units.held <= units.remaining && units.remaining > 0;
  if (!['needs_recovery', 'needs_workers'].includes(workflow?.status) || !unitsValid) return decision('hold', 'unfinished_stopped_workflow_unverified', 'Reconcile an explicitly recoverable stopped workflow and unfinished page counts; cancellation or an inspection status never implies permission to resume.');
  const gates = ['dispatchHistoryReconciled', 'pinsAndAcceptedBaselinePreserved', 'boundedRecoveryPlanValidated', 'blockerAddressed', 'replacementAuthorized'];
  if (!gates.every(k => audit[k] === true)) return decision('prepare_bounded_recovery', 'recovery_evidence_or_authority_missing', 'Prepare an evidence-backed finite recovery; do not replay a consumed phase or silently retry the same blocker.');
  return decision('bounded_recovery_eligible', 'all_recovery_gates_satisfied', 'An authorized executor may launch only the validated bounded recovery, preserving evidence and the shared cap.', { replacementAllowed: true });
}
