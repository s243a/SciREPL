// Additive, read-only observation. Not imported by a pinned controller.
// Presence of a final transport file is NOT validation, acceptance, or live auth.
import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';

const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const ACTIVE = new Set(['running', 'queued', 'launching', 'waiting', 'acquired']);
const TERMINAL = new Set(['completed', 'held', 'failed', 'cancelled', 'interrupted']);
const STATES = [...ACTIVE, ...TERMINAL, 'blocked', 'unknown'];
const PHASE_FILE = /^((?:draft|review)-\d{1,6})\.(queued|dispatched|child|transport)\.json$/;
const SAFE_COMPONENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,159}$/;

function chargedCalls(budget) {
  const drafts = count(budget?.usedDraftCalls), reviews = count(budget?.usedReviewCalls);
  return drafts === null || reviews === null || !Number.isSafeInteger(drafts + reviews) ? null : drafts + reviews;
}

/**
 * Pure reconciliation of normalized phase metadata. Callers may supply only
 * state and boolean file-presence flags; no names, IDs, paths or errors escape.
 * Unknown/missing metadata is not evidence that no request was dispatched.
 */
export function summarizeInflightCoverage({ phases, budget, metadataUnknown = 0, phaseSnapshotKnown = true } = {}) {
  let unknown = count(metadataUnknown) ?? 1;
  if (!Array.isArray(phases)) { phases = []; unknown++; }
  if (phaseSnapshotKnown !== true) unknown++;
  const phaseStates = Object.fromEntries(STATES.map(state => [state, 0]));
  let queued = 0, dispatched = 0, children = 0, transportReceipts = 0, consumedPhaseEvidence = 0;
  let outstandingDispatches = 0, outstandingChildren = 0, activeWithoutReceipt = 0;
  let terminalWithoutReceipt = 0, unknownWithoutReceipt = 0, activeWithReceipt = 0, phasesWithoutEvidence = 0;
  for (const row of phases) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) { unknown++; continue; }
    const state = STATES.includes(row.state) ? row.state : 'unknown';
    phaseStates[state]++;
    if (state === 'unknown') unknown++;
    const flagNames = ['queued', 'dispatched', 'child', 'transport'];
    if (flagNames.some(key => row[key] !== undefined && typeof row[key] !== 'boolean')) unknown++;
    const flags = Object.fromEntries(flagNames.map(key => [key, row[key] === true]));
    if (flags.queued) queued++;
    if (flags.dispatched) dispatched++;
    if (flags.child) children++;
    if (flags.transport) transportReceipts++;
    if (flags.dispatched || flags.child || flags.transport) consumedPhaseEvidence++;
    if (!Object.values(flags).some(Boolean)) phasesWithoutEvidence++;
    if (!flags.transport) {
      if (flags.dispatched) outstandingDispatches++;
      if (flags.child) outstandingChildren++;
      if (ACTIVE.has(state)) activeWithoutReceipt++;
      else if (TERMINAL.has(state)) terminalWithoutReceipt++;
      else unknownWithoutReceipt++;
    } else if (ACTIVE.has(state)) activeWithReceipt++;
  }
  const charged = chargedCalls(budget);
  const unaccountedChargedCalls = charged === null ? null : Math.max(0, charged - consumedPhaseEvidence);
  const evidenceBeyondCharge = charged === null ? null : Math.max(0, consumedPhaseEvidence - charged);
  const unresolved = outstandingDispatches > 0 || outstandingChildren > 0 || activeWithoutReceipt > 0 ||
    terminalWithoutReceipt > 0 || unknownWithoutReceipt > 0 || activeWithReceipt > 0 || phasesWithoutEvidence > 0;
  const budgetMatches = charged !== null && charged === consumedPhaseEvidence;
  const complete = unknown === 0 && !unresolved && budgetMatches;
  return {
    schema: 1, observationOnly: true, scope: 'phase_record_presence_only',
    phases: Object.values(phaseStates).reduce((total, value) => total + value, 0), phaseStates,
    queuedRecords: queued, activeQueuedPhases: phaseStates.queued, dispatched, children, transportReceipts, consumedPhaseEvidence,
    outstandingDispatches, outstandingChildren, activeWithoutReceipt, terminalWithoutReceipt,
    unknownWithoutReceipt, activeWithReceipt, phasesWithoutEvidence,
    chargedCalls: charged, unaccountedChargedCalls, evidenceBeyondCharge,
    metadataUnknown: unknown, countsAreLowerBounds: unknown > 0, complete,
    confidence: unknown > 0 ? 'unknown' : unresolved || !budgetMatches ? 'partial' : 'reconciled_record_presence',
    providerOutcomesInspected: false, acceptedReviewsVerified: false,
    authenticationEvidenceScope: 'completed_transport_receipts_only',
    authenticationCoversActiveRequest: false, currentAuthenticationGuaranteed: false,
    campaignOutcomeComplete: null, replacementSafe: false, automaticRecovery: false,
  };
}

function identity(info) { return [info.dev, info.ino, info.mode, info.size, info.mtimeMs, info.ctimeMs].join(':'); }
function directoryListing(directory, observations) {
  try {
    const before = lstatSync(directory);
    if (before.isSymbolicLink() || !before.isDirectory()) return null;
    const rows = readdirSync(directory, { withFileTypes: true });
    const after = lstatSync(directory);
    if (after.isSymbolicLink() || !after.isDirectory() || identity(before) !== identity(after)) return null;
    observations.push({ target: directory, stamp: identity(after) });
    return rows;
  } catch { return null; }
}
function regularRecord(file, observations) {
  try {
    const before = lstatSync(file), after = lstatSync(file);
    const regular = before.isFile() && after.isFile() && !before.isSymbolicLink() && !after.isSymbolicLink() &&
      identity(before) === identity(after);
    if (regular) observations.push({ target: file, stamp: identity(after) });
    return regular;
  } catch { return false; }
}
function snapshotKey(row) {
  if (![row?.locale, row?.chunk, row?.phase].every(value => typeof value === 'string' && SAFE_COMPONENT.test(value))) return null;
  if (!/^(?:draft|review)-\d{1,6}$/.test(row.phase)) return null;
  return row.locale + '/' + row.chunk + '/' + row.phase;
}

/**
 * Reconcile phase-state rows with local filename/stat metadata only. Never reads
 * prompt/response/transport/child contents, follows file symlinks, or mutates a
 * campaign. This is a best-effort observation, not an atomic owner snapshot.
 */
export function inspectInflightCoverage(campaign, snapshot = {}) {
  const sourcePhases = snapshot?.progress?.phases ?? snapshot?.phases;
  const budget = snapshot?.progress?.recoveryBudget ?? snapshot?.budget;
  const phases = new Map();
  let metadataUnknown = 0;
  const phaseSnapshotKnown = Array.isArray(sourcePhases);
  if (phaseSnapshotKnown) {
    for (const row of sourcePhases) {
      const key = snapshotKey(row);
      if (!key) { metadataUnknown++; continue; }
      if (phases.has(key)) metadataUnknown++;
      phases.set(key, { ...phases.get(key), state: row.state });
    }
  }
  const observations = [];
  let root = typeof campaign === 'string' && path.isAbsolute(campaign) ? path.resolve(campaign) : null;
  // Reject symlinks in ancestors as well as the campaign directory itself.
  try { if (root && realpathSync(root) !== root) root = null; } catch { root = null; }
  const locales = root ? directoryListing(root, observations) : null;
  if (!locales) metadataUnknown++;
  for (const locale of locales || []) {
    if (locale.isSymbolicLink()) { metadataUnknown++; continue; }
    if (!locale.isDirectory()) continue;
    const localeDir = path.join(root, locale.name), pages = directoryListing(localeDir, observations);
    if (!pages) { metadataUnknown++; continue; }
    for (const page of pages) {
      if (page.isSymbolicLink()) { metadataUnknown++; continue; }
      if (!page.isDirectory()) continue;
      const directory = path.join(localeDir, page.name), files = directoryListing(directory, observations);
      if (!files) { metadataUnknown++; continue; }
      for (const file of files) {
        const match = PHASE_FILE.exec(file.name);
        if (!match) continue;
        if (!file.isFile() || file.isSymbolicLink() || !regularRecord(path.join(directory, file.name), observations)) { metadataUnknown++; continue; }
        const key = locale.name + '/' + page.name + '/' + match[1];
        const row = phases.get(key) || { state: 'unknown' };
        row[match[2] === 'transport' ? 'transport' : match[2]] = true;
        phases.set(key, row);
      }
    }
  }
  // Detect mutation after an earlier directory listing/stat. Concurrent owner
  // finalization is legitimate, but makes this observation partial, not proof of
  // missing dispatch. No metadata files are opened or parsed to resolve a race.
  for (const { target, stamp } of observations) {
    try { if (identity(lstatSync(target)) !== stamp) metadataUnknown++; }
    catch { metadataUnknown++; }
  }
  return summarizeInflightCoverage({ phases: [...phases.values()], budget, metadataUnknown, phaseSnapshotKnown });
}
