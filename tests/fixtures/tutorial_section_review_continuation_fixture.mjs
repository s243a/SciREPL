// Synthetic original correction plus a consumed, accepted review and untouched tail.
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { ROOT, sha } from '../../scripts/tutorial_locale_lib.mjs';
import { correctionReviewPrompt } from '../../scripts/tutorial_section_protocol.mjs';
import { prepareSectionReviewContinuationPlan } from '../../scripts/tutorial_section_review_continuation_plan.mjs';
import { correctionFixture, deadCorrectionOwner } from './tutorial_section_correction_fixture.mjs';

export function continuationFixture({ mode = 'success', copyRuntime = true } = {}) {
  const base = correctionFixture({ mode, copyRuntime: false }), { root, temporary, write, read, env, calls } = base;
  const sourceJob = mkdtempSync(path.join(tmpdir(), 'scirepl-tutorial-translation-job-unused-source-fixture-'));
  const sourceCampaign = mkdtempSync(path.join(tmpdir(), 'scirepl-tutorial-translation-unused-source-fixture-'));
  const sourceDirectory = path.join(sourceCampaign, 'fr/01'), sourcePlanFile = path.join(root, 'unused-source-plan.json');
  const sourcePlan = structuredClone(base.plan), entry = sourcePlan.locales.find(row => row.locale === 'fr'), page = entry.pages[0];
  const editable = page.draftSeeds.map(seed => seed.id), cut = Math.max(1, Math.floor(editable.length / 2));
  const consumed = editable.slice(0, cut), untouched = editable.slice(cut);
  if (!untouched.length) throw Error('Fixture requires untouched review fields');
  page.correctionReviews = [{ fieldIds: consumed }, { fieldIds: untouched }]; page.recovery.maxReviewCalls = 2;
  sourcePlan.recovery.bounds.maxReviewCalls = 2; sourcePlan.recovery.bounds.pages = 1;
  delete sourcePlan.planHash; sourcePlan.planHash = sha(JSON.stringify(sourcePlan)); const sourcePlanPin = write(sourcePlanFile, sourcePlan);
  write(path.join(sourceDirectory, 'started.json'), { planHash: sourcePlan.planHash, locale: 'fr', route: page.route, sections: 0, preservedDraftFields: page.draftSeeds.length, explicitCorrection: true });
  const machineProposal = { translations: Object.fromEntries(consumed.map(id => [id, 'Traduction contrôlée sans modification.'])) };
  const phase = 'review-01', session = 'fixture-current-correction-review', proof = {}, model = 'gemini-3.8-flash-medium';
  proof.queued = write(path.join(sourceDirectory, phase + '.queued.json'), { planHash: sourcePlan.planHash, phase, at: '2026-10-17T00:00:00Z' });
  proof.dispatched = write(path.join(sourceDirectory, phase + '.dispatched.json'), { planHash: sourcePlan.planHash, conversationId: null, model, printTimeout: '0s' });
  proof.child = write(path.join(sourceDirectory, phase + '.child.json'), { ...deadCorrectionOwner, controller: deadCorrectionOwner });
  proof.session = write(path.join(sourceDirectory, phase + '.session.json'), { conversationId: session, workspace: path.join(temporary, 'old-correction-review-workspace') });
  proof.transport = write(path.join(sourceDirectory, phase + '.transport.json'), { exitCode: 0, timedOut: false, outputLimited: false, cancelled: false, persistenceFailure: false, unexpectedFiles: [], stderr: '',
    stdout: JSON.stringify({ status: 'SUCCESS', conversation_id: session, response: JSON.stringify(machineProposal) }) });
  proof.proposal = write(path.join(sourceDirectory, phase + '.proposal.json'), machineProposal);
  const fields = new Map([...base.manifest.pages.flatMap(page => page.fields), ...base.manifest.chrome].map(field => [field.id, field]));
  write(path.join(sourceDirectory, phase + '.prompt.txt'), correctionReviewPrompt({ locale: 'fr', page }, consumed.map(id => fields.get(id)), Object.fromEntries(page.draftSeeds.map(seed => [seed.id, seed.translation])), true));
  write(path.join(sourceDirectory, 'failed.json'), { planHash: sourcePlan.planHash, phase, error: 'Synthetic held complete review explicitly accepted afterward.', noAutomaticRetry: true });
  write(path.join(sourceCampaign, 'controller-status.json'), { schema: 1, unit: 'pages', state: 'held', controller: deadCorrectionOwner,
    counts: { planned: 1, completed: 0, held: 1, skipped: 0 }, phases: [{ locale: 'fr', chunk: '01', route: page.route, phase, state: 'held', worker: deadCorrectionOwner }],
    recoveryBudget: { pages: 1, maxDraftCalls: 0, maxReviewCalls: 2, usedDraftCalls: 0, usedReviewCalls: 1 } });
  write(path.join(sourceJob, 'config.json'), { schema: 1, root, job: sourceJob, campaign: sourceCampaign, sectionsPlan: sourcePlanFile,
    controller: path.join(root, 'scripts/run_tutorial_section_translations.mjs'), nonce: deadCorrectionOwner.nonce, model,
    pins: [sourcePlanPin, sourcePlan.manifestFile, ...sourcePlan.sources].map(row => ({ file: row.file, hash: row.sha256 })) });
  write(path.join(sourceJob, 'owner.json'), deadCorrectionOwner); write(path.join(sourceJob, 'controller.json'), deadCorrectionOwner);
  write(path.join(sourceJob, 'result.json'), { state: 'held', exitCode: 1, finishedAt: '2026-10-17T00:01:00Z' });
  const recordFile = base.recordFiles.fr, record = read(recordFile), manualReceipts = [];
  function accept(translations, keptFields, originalEvidence, kind) {
    const receipt = { locale: 'fr', route: page.route, manifestHash: sourcePlan.manifestHash, translations,
      review: { status: 'accepted', reviewer: 'Independent controller source-aligned editorial review', draftModel: model,
        nativeLanguageReview: 'pending', keptFields, planHash: sourcePlan.planHash, source: 'preserved-independent-section-review', scope: 'complete-independent-review-section',
        machineApprovedEditorialChanges: false, originalMachineReview: { kind, evidence: originalEvidence }, editorialCorrections: [] } };
    const file = path.join(root, 'manual', 'accepted-' + String(manualReceipts.length + 1).padStart(3, '0') + '.json'), saved = write(file, receipt); manualReceipts.push(saved);
    Object.assign(record.translations, translations); record.receipts.push({ source: file, fields: Object.keys(translations).sort(), review: receipt.review });
  }
  for (const seed of page.reviewSeeds) {
    const original = {};
    for (const kind of ['transport', 'proposal', 'session', 'dispatched']) original[kind] = seed.source[kind];
    for (const kind of ['queued', 'child']) { const file = path.join(path.dirname(seed.source.transport.file), seed.source.phase + '.' + kind + '.json'); original[kind] = { file, sha256: sha(readFileSync(file)) }; }
    accept(seed.translations, seed.keptFields, original, 'preserved-complete-review');
  }
  accept(machineProposal.translations, {}, proof, 'complete-successful-independent-review'); write(recordFile, record);
  for (const name of ['evidence.json', 'editorial-spec.json', 'completed.json']) write(path.join(root, 'manual', name), { schema: 1, syntheticOnly: true });
  const acceptedCount = sourcePlan.accepted.reduce((sum, row) => sum + Object.keys(row.locale === 'fr' ? record.translations : base.records[row.locale]?.translations || {}).length, 0);
  const prepareOptions = { root, sourceJob, expectedAcceptedFields: acceptedCount, expectedRemainingFields: untouched.length, expectedPages: 1, maxReviewCalls: 5, manualReceipts };
  const prepare = overrides => prepareSectionReviewContinuationPlan({ ...prepareOptions, ...overrides });
  if (copyRuntime) {
    mkdirSync(path.join(root, 'scripts'), { recursive: true });
    for (const name of ['run_tutorial_section_translations.mjs', 'tutorial_locale_section_plan.mjs', 'tutorial_section_recovery_plan.mjs', 'tutorial_locale_lib.mjs', 'tutorial_locale_status.mjs', 'tutorial_locale_apply.mjs',
      'tutorial_translation_transport.mjs', 'tutorial_translation_queue.mjs', 'tutorial_section_protocol.mjs', 'tutorial_review_batching.mjs', 'tutorial_section_correction_plan.mjs', 'tutorial_section_review_continuation_plan.mjs']) copyFileSync(path.join(ROOT, 'scripts', name), path.join(root, 'scripts', name));
  }
  const plan = prepare(), planFile = path.join(root, 'continuation-plan.json'); write(planFile, plan);
  const campaign = mkdtempSync(path.join(tmpdir(), 'scirepl-tutorial-translation-unused-execution-fixture-'));
  const args = [path.join(root, 'scripts/run_tutorial_section_translations.mjs'), '--plan', planFile, '--campaign', campaign];
  const run = execute => spawnSync(process.execPath, [...args, ...(execute ? ['--execute'] : [])], { cwd: root, env, encoding: 'utf8', timeout: 30000 });
  return { ...base, root, temporary, sourceJob, sourceCampaign, sourceDirectory, sourcePlan, sourcePlanFile, forbiddenSourcePhase: 'review-02', manualReceipts, recordFile,
    plan, planFile, campaign, args, env, calls, run, prepareOptions, prepare, write, read };
}
