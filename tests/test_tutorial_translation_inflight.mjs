#!/usr/bin/env node
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { summarizeInflightCoverage, inspectInflightCoverage } from '../scripts/tutorial_translation_inflight.mjs';

const SECRET = 'DO_NOT_READ_PRIVATE_CONVERSATION_RESPONSE_TOKEN';
const budget = (reviews, drafts = 0) => ({ usedDraftCalls: drafts, usedReviewCalls: reviews });
const observed = (rows, reviews, extra = {}) => summarizeInflightCoverage({ phases: rows, budget: budget(reviews), ...extra });
function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'scirepl-inflight-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const page = path.join(root, 'ru', '01'); mkdirSync(page, { recursive: true });
  return { root, page };
}
const snapshot = (state, reviews = 1) => ({ progress: { phases: [{ locale: 'ru', chunk: '01', phase: 'review-01', state }], recoveryBudget: budget(reviews) } });

test('a live child with no receipt is explicitly outside completed-only diagnostics', () => {
  const row = observed([{ state: 'running', queued: true, dispatched: true, child: true }], 1);
  assert.equal(row.dispatched, 1); assert.equal(row.children, 1); assert.equal(row.transportReceipts, 0);
  assert.equal(row.outstandingDispatches, 1); assert.equal(row.outstandingChildren, 1);
  assert.equal(row.activeWithoutReceipt, 1); assert.equal(row.complete, false); assert.equal(row.confidence, 'partial');
  assert.equal(row.authenticationCoversActiveRequest, false); assert.equal(row.currentAuthenticationGuaranteed, false);
  assert.equal(row.replacementSafe, false); assert.equal(row.automaticRecovery, false);
});
test('complete means phase record presence only, never accepted output or current authentication', () => {
  const row = observed([{ state: 'completed', dispatched: true, child: true, transport: true }], 1);
  assert.equal(row.complete, true); assert.equal(row.scope, 'phase_record_presence_only');
  assert.equal(row.providerOutcomesInspected, false); assert.equal(row.acceptedReviewsVerified, false);
  assert.equal(row.currentAuthenticationGuaranteed, false); assert.equal(row.campaignOutcomeComplete, null);
});
test('queued requests are not classified as provider dispatch or stalled consumed calls', () => {
  const row = observed([{ state: 'queued', queued: true }], 0);
  assert.equal(row.phaseStates.queued, 1); assert.equal(row.activeQueuedPhases, 1); assert.equal(row.queuedRecords, 1); assert.equal(row.activeWithoutReceipt, 1);
  assert.equal(row.consumedPhaseEvidence, 0); assert.equal(row.dispatched, 0); assert.equal(row.outstandingDispatches, 0);
  assert.equal(row.unaccountedChargedCalls, 0); assert.equal(row.complete, false);
});
test('launching and finalizing rows remain unresolved instead of disappearing from coverage', () => {
  const row = observed([{ state: 'launching', dispatched: true }, { state: 'running', dispatched: true, child: true, transport: true }], 2);
  assert.equal(row.outstandingDispatches, 1); assert.equal(row.activeWithReceipt, 1); assert.equal(row.complete, false);
});
test('terminal missing receipts remain unresolved even without any active worker', () => {
  for (const state of ['completed', 'held', 'failed', 'cancelled', 'interrupted']) {
    const row = observed([{ state, dispatched: true, child: true }], 1);
    assert.equal(row.terminalWithoutReceipt, 1); assert.equal(row.complete, false);
    assert.equal(row.outstandingChildren, 1); assert.equal(row.replacementSafe, false);
  }
});
test('charged attempts lacking all on-disk consumption evidence are unknown, not free calls', () => {
  const row = observed([{ state: 'completed', transport: true }], 2);
  assert.equal(row.unaccountedChargedCalls, 1); assert.equal(row.evidenceBeyondCharge, 0); assert.equal(row.complete, false);
});
test('extra evidence, missing and invalid budgets cannot be reported as fully reconciled', () => {
  const phases = [{ state: 'completed', transport: true }];
  assert.equal(observed(phases, 0).evidenceBeyondCharge, 1);
  for (const value of [undefined, {}, { usedDraftCalls: -1, usedReviewCalls: 1 }, { usedDraftCalls: 0, usedReviewCalls: NaN }]) {
    const row = summarizeInflightCoverage({ phases, budget: value });
    assert.equal(row.chargedCalls, null); assert.equal(row.complete, false);
  }
});
test('unknown state or missing phase snapshot cannot imply complete coverage or absent dispatch', () => {
  assert.equal(observed([{ state: 'future-state', transport: true }], 1).metadataUnknown, 1);
  const missing = summarizeInflightCoverage({ budget: budget(1) });
  assert.equal(missing.complete, false); assert.equal(missing.confidence, 'unknown'); assert.equal(missing.unaccountedChargedCalls, 1);
});
test('malformed presence flags are unknown rather than truthy proof of dispatch or transport', () => {
  const row = observed([{ state: 'completed', dispatched: SECRET, transport: 1 }], 1);
  assert.equal(row.dispatched, 0); assert.equal(row.transportReceipts, 0);
  assert.equal(row.metadataUnknown, 1); assert.equal(row.countsAreLowerBounds, true); assert.equal(row.complete, false);
  assert(!JSON.stringify(row).includes(SECRET));
});
test('metadata-only scanner reconciles completed and live phase records without reading their contents', t => {
  const { root, page } = fixture(t);
  for (const suffix of ['queued', 'dispatched', 'child']) writeFileSync(path.join(page, 'review-01.' + suffix + '.json'), SECRET);
  for (const suffix of ['dispatched', 'child', 'transport']) writeFileSync(path.join(page, 'review-02.' + suffix + '.json'), SECRET);
  writeFileSync(path.join(page, 'review-01.prompt.txt'), SECRET);
  writeFileSync(path.join(page, 'review-01.stdout.txt'), SECRET);
  const state = snapshot('running', 2); state.progress.phases.push({ locale: 'ru', chunk: '01', phase: 'review-02', state: 'completed' });
  const row = inspectInflightCoverage(root, state);
  assert.equal(row.dispatched, 2); assert.equal(row.children, 2); assert.equal(row.transportReceipts, 1);
  assert.equal(row.outstandingDispatches, 1); assert.equal(row.outstandingChildren, 1); assert.equal(row.metadataUnknown, 0);
  assert.equal(row.authenticationEvidenceScope, 'completed_transport_receipts_only');
  assert(!JSON.stringify(row).includes(SECRET)); assert(!JSON.stringify(row).includes(root));
});
test('scanner never trusts symlink transport or child records', t => {
  const { root, page } = fixture(t);
  const target = path.join(root, 'private'); writeFileSync(target, SECRET);
  symlinkSync(target, path.join(page, 'review-01.transport.json'));
  symlinkSync(target, path.join(page, 'review-01.child.json'));
  const row = inspectInflightCoverage(root, snapshot('running'));
  assert.equal(row.transportReceipts, 0); assert.equal(row.children, 0); assert.equal(row.metadataUnknown, 2);
  assert.equal(row.complete, false); assert(!JSON.stringify(row).includes(SECRET));
});
test('scanner rejects symlink campaign and page directories rather than following them', t => {
  const { root, page } = fixture(t); writeFileSync(path.join(page, 'review-01.transport.json'), SECRET);
  const link = root + '-link'; symlinkSync(root, link); t.after(() => rmSync(link));
  assert.equal(inspectInflightCoverage(link, snapshot('completed')).transportReceipts, 0);
  assert.equal(inspectInflightCoverage(path.join(link, 'ru'), snapshot('completed')).transportReceipts, 0);
  const pageLink = path.join(root, 'ru', '02'); symlinkSync(page, pageLink);
  const row = inspectInflightCoverage(root, snapshot('completed'));
  assert.equal(row.transportReceipts, 1); assert.equal(row.metadataUnknown, 1); assert.equal(row.complete, false);
});
test('missing or non-directory campaigns return unknown coverage without leaking paths', t => {
  const { root } = fixture(t);
  const secretPath = path.join(root, SECRET); writeFileSync(secretPath, SECRET);
  for (const target of [undefined, 'relative', secretPath, path.join(root, 'missing')]) {
    const row = inspectInflightCoverage(target, snapshot('running'));
    assert(row.metadataUnknown > 0); assert.equal(row.complete, false); assert.equal(row.confidence, 'unknown');
    assert(!JSON.stringify(row).includes(SECRET));
  }
});
test('orphan disk phase is counted with unknown snapshot state, not silently dropped', t => {
  const { root, page } = fixture(t); writeFileSync(path.join(page, 'review-01.child.json'), SECRET);
  const row = inspectInflightCoverage(root, { phases: [], budget: budget(1) });
  assert.equal(row.children, 1); assert.equal(row.phaseStates.unknown, 1); assert.equal(row.metadataUnknown, 1);
  assert.equal(row.outstandingChildren, 1); assert.equal(row.complete, false);
});
test('unsafe snapshot keys and duplicate phase records require inspection without path traversal', t => {
  const { root } = fixture(t); const state = snapshot('running');
  state.progress.phases.push({ locale: '..', chunk: '01', phase: 'review-01', state: 'completed' });
  state.progress.phases.push({ ...state.progress.phases[0] });
  const row = inspectInflightCoverage(root, state);
  assert.equal(row.metadataUnknown, 2); assert.equal(row.phases, 1); assert.equal(row.complete, false);
});
