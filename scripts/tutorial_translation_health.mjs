// Pure, allowlisted observation. A recommendation never authorizes dispatch,
// retries, cancellation, lock changes, or relaxing validation.
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const timestamp = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value)
  && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;

export function summarizeTranslationWorkflow(snapshot, { isWorkerAlive = () => null } = {}) {
  const progress = snapshot?.progress, source = progress?.counts;
  const planned = count(source?.planned), completed = count(source?.completed);
  const held = count(source?.held === undefined ? 0 : source.held);
  const skipped = count(source?.skipped === undefined ? 0 : source.skipped);
  const countsValid = [planned, completed, held, skipped].every(value => value !== null)
    && completed + skipped <= planned && held <= planned - completed - skipped;
  const units = { planned, completed, held, skipped,
    remaining: countsValid ? planned - completed - skipped : null };
  const phases = Array.isArray(progress?.phases) ? progress.phases : [];
  const supervisor = snapshot?.supervisorAlive === true, controller = snapshot?.controllerAlive === true;
  const identities = new Map();
  for (const [index, phase] of phases.entries()) {
    if (!phase?.worker) continue;
    const worker = phase.worker;
    const valid = Number.isSafeInteger(worker.pid) && worker.pid > 1
      && typeof worker.startIdentity === 'string' && worker.startIdentity.length > 0;
    const key = valid ? `${worker.pid}:${worker.startIdentity}` : `invalid:${index}`;
    if (identities.has(key)) continue;
    let live = null;
    if (valid) { try { live = isWorkerAlive(worker); } catch { /* Unknown is not dead. */ } }
    identities.set(key, live === true ? true : live === false ? false : null);
  }
  const workers = {
    live: [...identities.values()].filter(value => value === true).length,
    // Historical queued rows do not represent a live queue without its owner.
    queued: controller ? phases.filter(phase => phase?.state === 'queued').length : 0,
    unverifiable: [...identities.values()].filter(value => value === null).length,
  };
  const observed = { schema: 1, workers, units,
    lastStatusAt: timestamp(progress?.updatedAt), finishedAt: timestamp(snapshot?.finishedAt),
    automaticRecovery: false };
  const result = (status, attentionRequired, canAdvance, reasonCode, recommendedAction) => ({
    ...observed, status, attentionRequired, canAdvance, reasonCode, recommendedAction,
  });
  const terminal = ['completed', 'cancelled', 'held', 'failed'].includes(snapshot?.state);
  if (terminal && (controller || workers.live > 0)) return result('needs_inspection', true, null,
    'terminal_result_has_live_processes', 'Inspect the existing live processes; do not launch replacement workers.');
  if (workers.unverifiable > 0) return result('needs_inspection', true, null,
    'worker_identity_unverifiable', 'Inspect worker identity and dispatch evidence; do not retry or replace uncertain workers.');
  if (snapshot?.state === 'cancelled') return result('cancelled', false, false,
    'explicitly_cancelled', 'Remain stopped until the user authorizes further work.');
  if (terminal && !countsValid) return result('needs_inspection', true, null,
    'terminal_progress_counts_missing_or_invalid', 'Reconcile terminal progress counts and dispatch evidence before preparing any recovery.');
  if (snapshot?.state === 'blocked' || progress?.state === 'blocked' || phases.some(phase => phase?.state === 'blocked')) {
    return result('needs_inspection', true, null, 'queue_ownership_blocked',
      'Inspect the blocked queue ownership without reclaiming locks, adding duplicate workers or interrupting other live work.');
  }
  if (['held', 'failed'].includes(snapshot?.state)) return result('needs_recovery', true, false,
    'finite_pass_stopped_with_holds_or_failure',
    'Prepare an explicitly authorized, bounded recovery preserving accepted translations and successful drafts. Adding workers alone cannot clear holds.');
  if (snapshot?.cancelRequested) return result(controller || supervisor || workers.live > 0 ? 'cancelling' : 'needs_inspection',
    !controller && !supervisor && workers.live === 0, false, 'cancellation_requested',
    'Observe the requested cancellation and verify its terminal result; do not add workers or resume work.');
  if (!supervisor && (controller || workers.live > 0)) return result('needs_inspection', true, null,
    'durable_owner_missing_with_live_work', 'Inspect the orphaned live work and preserve its dispatch history; do not launch duplicate workers.');
  if (!progress && supervisor && !terminal) return result('starting', false, true,
    'verified_owner_waiting_for_initial_status', 'Observe the verified owner while its controller writes initial status; do not start another owner.');
  if (!countsValid) return result('needs_inspection', true, null,
    'progress_counts_missing_or_invalid', 'Inspect the saved progress counts before deciding whether work is complete or needs workers.');
  if (snapshot?.state === 'completed') return result(held > 0 || units.remaining > 0 ? 'needs_inspection' : 'completed',
    held > 0 || units.remaining > 0, false,
    held > 0 || units.remaining > 0 ? 'completed_result_disagrees_with_counts' : 'finite_job_completed',
    held > 0 || units.remaining > 0 ? 'Reconcile the terminal result with unfinished units before further dispatch.'
      : 'This finite job is complete; separately verify overall translation coverage, browser/link validation and publication.');
  if (controller) {
    if (held > 0) return result('running_with_holds', true, true, 'live_work_continues_with_held_units',
      'Let existing workers finish; prepare bounded recovery for held units without interrupting live or queued work.');
    if (workers.live === 0 && (workers.queued > 0 || snapshot?.state === 'queued' || progress?.state === 'queued')) {
      return result('waiting_for_capacity', false, true, 'legitimate_queue_wait',
        'Wait for the existing shared-worker queue; respect its concurrency cap and do not cancel, retry or add duplicate workers.');
    }
    return result('running', false, true, 'verified_controller_active',
      'Observe existing work; a slow worker or a controller between phases does not require replacement workers.');
  }
  if (supervisor) return result('starting', false, true, 'verified_supervisor_active',
    'Observe the durable supervisor while it starts or finalizes its controller; do not start another owner.');
  if (held > 0) return result('needs_recovery', true, false, 'held_units_have_no_live_owner',
    'Prepare an explicitly authorized, bounded recovery preserving accepted translations and successful drafts.');
  if (phases.length > 0) return result('needs_inspection', true, false, 'owner_missing_after_phase_activity',
    'Audit consumed phases and provider dispatch history before any authorized recovery; do not blindly replay this job.');
  if (units.remaining > 0) return result('needs_workers', true, false, 'unfinished_job_has_no_live_owner',
    'Inspect dispatch history first, then assign an authorized durable owner to verified untouched work. This status is not permission to start or replay workers.');
  return result('needs_inspection', true, false, 'terminal_result_missing',
    'Verify the finite job result and accepted receipts; zero remaining units alone is not proof of completion.');
}
