// Synthetic metadata only: no paid calls, claims, queue locks, or applies.
import assert from 'node:assert/strict';
import { existsSync, lstatSync, readFileSync, readdirSync, mkdtempSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { sha } from '../scripts/tutorial_locale_lib.mjs';
import { writeSectionPlan } from '../scripts/tutorial_locale_section_plan.mjs';
import { correctionPlanSummary } from '../scripts/tutorial_section_correction_plan.mjs';
import { getProcessStartIdentity } from '../scripts/tutorial_translation_queue.mjs';
import { correctionFixture } from './fixtures/tutorial_section_correction_fixture.mjs';

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log('PASS ' + name); };
const snapshot = directories => directories.flatMap(directory => {
  const walk = dir => readdirSync(dir).sort().flatMap(name => {
    const file = path.join(dir, name), info = lstatSync(file);
    return info.isDirectory() ? walk(file) : [[file, info.mode & 0o777, sha(readFileSync(file))]];
  });
  return walk(directory);
});
const fixture = () => correctionFixture({ copyRuntime: false });
const mutateJSON = (f, file, mutate) => { const data = f.read(file); mutate(data); f.write(file, data); };

check('preparation is deterministic and changes no source or campaign files', () => {
  const f = fixture(), before = snapshot([f.root, f.sourceJob, f.sourceCampaign]);
  assert.deepEqual(f.prepare(), f.plan); assert.deepEqual(f.prepare(), f.plan);
  assert.deepEqual(snapshot([f.root, f.sourceJob, f.sourceCampaign]), before);
  assert(!existsSync(path.join(f.temporary, 'scirepl-tutorial-section-claims')));
});
check('preserves independently passed reviews and drafts with zero drafting', () => {
  const f = fixture(), summary = correctionPlanSummary(f.plan);
  assert.deepEqual(summary.bounds, { pages: 1, maxDraftCalls: 0, maxReviewCalls: 1 });
  assert.equal(summary.preservedReviewFields, f.parts[0].length);
  assert.equal(summary.preservedDraftFields, f.pending.length - f.parts[0].length);
  assert.equal(summary.pendingReviews, 1);
  const page = f.plan.locales.find(locale => locale.locale === 'fr').pages[0];
  assert.deepEqual(page.sections, []);
  assert.deepEqual([...page.draftSeeds.map(seed => seed.id), ...page.reviewSeeds.flatMap(seed => seed.fieldIds)].sort(), f.pending.map(field => field.id).sort());
  assert.deepEqual(page.correctionReviews.flatMap(part => part.fieldIds).sort(), page.draftSeeds.map(seed => seed.id).sort());
  assert(!JSON.stringify(f.plan).includes('POISONED_FAILED_PHASE_VALUE'));
});
check('review provenance binds successful response session dispatch and original request', () => {
  const f = fixture(), page = f.plan.locales.find(locale => locale.locale === 'fr').pages[0], seed = page.reviewSeeds[0];
  assert.deepEqual(seed.translations, f.savedReview.translations);
  for (const name of ['transport', 'proposal', 'session', 'dispatched']) assert.equal(seed.source[name].sha256, sha(readFileSync(seed.source[name].file)));
  assert(f.plan.campaignEvidence[0].files.some(row => row.file === path.join(f.alphaDir, 'review-01.prompt.txt')));
  assert.deepEqual(f.plan.recovery.dispatchPolicy, { maxConcurrent: 2, minimumDispatchGapMs: 15000 });
});
check('all accepted locales and all known historical identities remain protected', () => {
  const f = fixture(), baseline = f.plan.recovery.acceptedBaseline;
  assert.equal(Object.keys(baseline).length, 12);
  for (const [locale, record] of Object.entries(f.records)) assert.deepEqual(baseline[locale], record.translations);
  const prior = f.plan.locales.find(locale => locale.locale === 'fr').pages[0].recovery.priorConversationIds;
  for (const id of ['fixture-legacy-draft', 'fixture-ancestor-review', 'fixture-current-draft', 'fixture-current-review']) assert(prior.includes(id));
});
check('a live prior supervisor or provider worker blocks preparation', () => {
  for (const fileName of ['owner.json', 'child']) {
    const f = fixture(), file = fileName === 'child' ? path.join(f.alphaDir, 'review-01.child.json') : path.join(f.sourceJob, fileName);
    mutateJSON(f, file, record => { record.pid = process.pid; record.startIdentity = getProcessStartIdentity(); });
    assert.throws(() => f.prepare(), /still live/);
  }
});
check('missing successful review evidence or edited saved request is never salvaged', () => {
  const absent = fixture(); unlinkSync(path.join(absent.alphaDir, 'review-01.transport.json')); assert.throws(() => absent.prepare());
  const changed = fixture(); const file = path.join(changed.alphaDir, 'review-01.prompt.txt'); changed.write(file, readFileSync(file, 'utf8') + '\n');
  assert.throws(() => changed.prepare(), /review request differs/);
});
check('failed or contradictory historical review envelopes cannot become review seeds', () => {
  for (const mode of ['error', 'contradictory']) {
    const f = fixture(), file = path.join(f.alphaDir, 'review-01.transport.json');
    mutateJSON(f, file, transport => { const envelope = JSON.parse(transport.stdout); if (mode === 'error') envelope.status = 'ERROR'; else envelope.is_error = true; transport.stdout = JSON.stringify(envelope); });
    assert.throws(() => f.prepare());
  }
});
check('successful drafts must still match their complete transport and source', () => {
  const f = fixture(), file = path.join(f.alphaDir, 'draft-01.proposal.json');
  mutateJSON(f, file, proposal => { proposal.translations[Object.keys(proposal.translations)[0]] = 'Valeur modifiée.'; });
  assert.throws(() => f.prepare(), /differs/);
  const g = fixture(), oldSeed = g.alpha.draftSeeds[0];
  g.write(oldSeed.source.proposal.file, { translations: {} }); assert.throws(() => g.prepare(), /evidence changed/);
});
check('source and existing accepted values cannot change', () => {
  const f = fixture(); f.write(f.sources[0].file, readFileSync(f.sources[0].file, 'utf8') + '\n'); assert.throws(() => f.prepare(), /source changed/);
  const g = fixture(); mutateJSON(g, g.recordFiles.fr, record => { record.translations[g.acceptedId] = 'Introduction modifiée.'; });
  assert.throws(() => g.prepare(), /baseline value changed/);
});
check('ambiguous later dispatch and unexpected authorization bounds are rejected', () => {
  const f = fixture(); f.write(path.join(f.alphaDir, 'review-03.queued.json'), { planHash: f.sourcePlan.planHash });
  assert.throws(() => f.prepare(), /ambiguous dispatch/);
  const g = fixture();
  assert.throws(() => g.prepare({ expectedHeldPages: 2 }));
  assert.throws(() => g.prepare({ expectedAcceptedFields: g.prepareOptions.expectedAcceptedFields + 1 }));
  assert.throws(() => g.prepare({ maximumReviewPromptBytes: 200000 }));
});
check('a correction generation cannot be used as an automatic recovery source', () => {
  const f = fixture(), plan = f.read(f.sourcePlanFile); plan.recovery.kind = 'explicit-bounded-section-correction';
  delete plan.planHash; plan.planHash = sha(JSON.stringify(plan)); const pin = f.write(f.sourcePlanFile, plan);
  mutateJSON(f, path.join(f.sourceJob, 'config.json'), config => { config.pins.find(row => row.file === f.sourcePlanFile).hash = pin.sha256; });
  assert.throws(() => f.prepare(), /cannot recurse/);
});
check('plan export is private exclusive and never replaces existing evidence', () => {
  const f = fixture(), directory = mkdtempSync(path.join(tmpdir(), 'scirepl-tutorial-section-correction-export-')), file = path.join(directory, 'plan.json');
  const result = writeSectionPlan(f.plan, file); assert.equal(result.sha256, sha(readFileSync(file)));
  assert.equal(lstatSync(file).mode & 0o777, 0o600); assert.throws(() => writeSectionPlan(f.plan, file));
});
console.log(`Correction planner: ${passed} offline groups passed; no provider requests or applies.`);
