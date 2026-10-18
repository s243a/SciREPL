// Private synthetic histories and fake workers only. Never use real campaigns.
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { ROOT, LOCALES, extractPage, sha } from '../../scripts/tutorial_locale_lib.mjs';
import { prepareSectionPlan, classifySections } from '../../scripts/tutorial_locale_section_plan.mjs';
import { prepareSectionCorrectionPlan } from '../../scripts/tutorial_section_correction_plan.mjs';
import { reviewPrompt } from '../../scripts/tutorial_section_protocol.mjs';

export const deadCorrectionOwner = { pid: 2147483647, startIdentity: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:123', nonce: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' };
export function correctionFixture({ mode = 'success', copyRuntime = true } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'scirepl-tutorial-section-correction-fixture-')), temporary = path.join(root, 'tmp'); mkdirSync(temporary);
  const write = (file, value) => {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value) + '\n', { mode: 0o600 });
    return { file, sha256: sha(readFileSync(file)) };
  };
  const read = file => JSON.parse(readFileSync(file, 'utf8'));
  const description = 'This explanatory paragraph describes a safe local calculation and the resulting value. ';
  const alphaHtml = '<html><head><title>Alpha tutorial</title></head><body><h1>Alpha</h1><p>Accepted introduction.</p>'
    + ['A', 'B', 'C', 'D'].map(letter => '<h2>Activity ' + letter + '</h2><p>' + description.repeat(2) + '</p><p>' + description.repeat(2) + '</p>').join('') + '</body></html>';
  const betaHtml = '<html><head><title>Beta tutorial</title></head><body><h1>Beta</h1><p>A complete accepted page.</p></body></html>';
  const pages = [extractPage('alpha/tutorial', alphaHtml), extractPage('beta/tutorial', betaHtml)];
  const unsigned = { schema: 1, sourceLocale: 'en', locales: LOCALES, pages, chrome: [] }, manifest = { ...unsigned, manifestHash: sha(JSON.stringify(unsigned)) };
  const manifestPin = write(path.join(root, 'docs/tutorial-localization/source.json'), manifest);
  const sources = [alphaHtml, betaHtml].map((html, index) => write(path.join(root, 'www/help', pages[index].route, 'index.html'), html));
  const allFields = pages.flatMap(page => page.fields), acceptedId = pages[0].fields[0].id, records = {}, recordFiles = {};
  for (const locale of LOCALES.filter(locale => locale !== 'en')) {
    const selected = locale === 'fr' ? [pages[0].fields[0]] : allFields;
    records[locale] = { schema: 1, locale, manifestHash: manifest.manifestHash,
      translations: Object.fromEntries(selected.map(field => [field.id, 'Traduction sûre déjà acceptée.'])),
      receipts: [{ fields: selected.map(field => field.id), review: { status: 'accepted', reviewer: 'offline reviewer', draftModel: 'offline draft', nativeLanguageReview: 'pending' } }] };
    recordFiles[locale] = path.join(root, 'docs/tutorial-localization/translations', locale + '.json'); write(recordFiles[locale], records[locale]);
  }
  const acceptedBefore = Object.fromEntries(Object.entries(records).map(([locale, record]) => [locale, { ...record.translations }]));
  const initial = prepareSectionPlan({ root, locales: ['fr'], maxChars: 500, minChars: 0 });
  const ancestor = write(path.join(root, 'ancestor-plan.json'), initial), old = JSON.parse(JSON.stringify(initial));
  const alpha = old.locales[0].pages.find(page => page.route === 'alpha/tutorial');
  const pending = pages[0].fields.filter(field => field.id !== acceptedId), newSection = alpha.sections.at(-1), newIds = new Set(newSection.fieldIds);
  const legacyFields = pending.filter(field => !newIds.has(field.id));
  const legacyProposal = { translations: Object.fromEntries(legacyFields.map(field => [field.id, 'Proposition ancienne conservée.'])) };
  const legacyProposalPin = write(path.join(root, 'legacy/draft.proposal.json'), legacyProposal);
  const legacyTransportPin = write(path.join(root, 'legacy/draft.transport.json'), { exitCode: 0, timedOut: false, outputLimited: false, cancelled: false, persistenceFailure: false, unexpectedFiles: [], stderr: '',
    stdout: JSON.stringify({ status: 'SUCCESS', conversation_id: 'fixture-legacy-draft', response: JSON.stringify(legacyProposal) }) });
  alpha.sections = [newSection];
  alpha.draftSeeds = legacyFields.map(field => ({ locale: 'fr', id: field.id, text: field.text, translation: legacyProposal.translations[field.id], draftValid: true,
    source: { campaign: path.join(root, 'legacy'), chunk: '01', transport: legacyTransportPin, proposal: legacyProposalPin } }));
  const priorIds = ['fixture-legacy-draft', 'fixture-ancestor-review'];
  for (const page of old.locales[0].pages) page.recovery = { maxDraftCalls: page.sections.length,
    maxReviewCalls: classifySections(pages.find(source => source.route === page.route), page.route === 'alpha/tutorial' ? alphaHtml : betaHtml, { maxChars: 500, minChars: 0 }).length, priorConversationIds: priorIds };
  const sourceJob = mkdtempSync(path.join(tmpdir(), 'scirepl-tutorial-translation-job-correction-source-fixture-'));
  const sourceCampaign = mkdtempSync(path.join(tmpdir(), 'scirepl-tutorial-translation-correction-source-fixture-'));
  const sourcePlanFile = path.join(root, 'source-plan/plan.json');
  old.campaignEvidence = [{ request: ancestor, files: [legacyTransportPin, legacyProposalPin] }];
  old.recovery = { kind: 'single-bounded-section-recovery', sourcePlanHash: initial.planHash, sourcePlan: ancestor,
    sourceCampaign: path.join(root, 'ancestor-campaign'), sourceJob: path.join(root, 'ancestor-job'), acceptedBaseline: acceptedBefore,
    bounds: { pages: 2, maxDraftCalls: old.locales[0].pages.reduce((sum, page) => sum + page.sections.length, 0), maxReviewCalls: old.locales[0].pages.reduce((sum, page) => sum + page.recovery.maxReviewCalls, 0) } };
  delete old.planHash; old.planHash = sha(JSON.stringify(old)); const planPin = write(sourcePlanFile, old);
  const alphaDir = path.join(sourceCampaign, 'fr/01'), betaDir = path.join(sourceCampaign, 'fr/02');
  for (const [index, page] of old.locales[0].pages.entries()) write(path.join(sourceCampaign, 'fr', String(index + 1).padStart(2, '0'), 'started.json'), {
    planHash: old.planHash, locale: 'fr', route: page.route, sections: page.sections.length, preservedDraftFields: page.draftSeeds.length });
  let originalCandidates;
  function phase(phaseName, fieldList, { id, previous = null, review = false, poison = false } = {}) {
    const proposal = { translations: Object.fromEntries(fieldList.map(field => [field.id, poison ? 'POISONED_FAILED_PHASE_VALUE' : review ? 'Révision déjà vérifiée.' : 'Proposition nouvelle conservée.'])) };
    write(path.join(alphaDir, phaseName + '.queued.json'), { planHash: old.planHash, phase: phaseName, at: '2026-10-16T00:00:00Z' });
    write(path.join(alphaDir, phaseName + '.dispatched.json'), { planHash: old.planHash, conversationId: previous });
    write(path.join(alphaDir, phaseName + '.child.json'), deadCorrectionOwner);
    write(path.join(alphaDir, phaseName + '.session.json'), { conversationId: id, workspace: path.join(root, review ? 'old-review-workspace' : 'old-draft-workspace') });
    write(path.join(alphaDir, phaseName + '.proposal.json'), proposal);
    write(path.join(alphaDir, phaseName + '.transport.json'), { exitCode: 0, timedOut: false, outputLimited: false, cancelled: false, persistenceFailure: false, unexpectedFiles: [], stderr: '',
      stdout: JSON.stringify({ status: 'SUCCESS', conversation_id: id, response: JSON.stringify(proposal) }) });
    if (review) write(path.join(alphaDir, phaseName + '.prompt.txt'), reviewPrompt({ locale: 'fr', page: alpha }, fieldList, originalCandidates, previous === null));
    return proposal;
  }
  const newDraft = phase('draft-01', newSection.request.fields, { id: 'fixture-current-draft' });
  originalCandidates = { ...legacyProposal.translations, ...newDraft.translations };
  const pendingIds = new Set(pending.map(field => field.id));
  const parts = classifySections(pages[0], alphaHtml, { maxChars: 500, minChars: 0 }).map(part => part.fields.filter(field => pendingIds.has(field.id))).filter(fields => fields.length);
  const savedReview = phase('review-01', parts[0], { id: 'fixture-current-review', review: true });
  phase('review-02', parts[1], { id: 'fixture-current-review', previous: 'fixture-current-review', review: true, poison: true });
  write(path.join(alphaDir, 'failed.json'), { planHash: old.planHash, phase: 'review-02', error: 'Missing or extra section fields', noAutomaticRetry: true });
  const betaIds = pages[1].fields.map(field => field.id);
  Object.assign(records.fr.translations, Object.fromEntries(betaIds.map(id => [id, 'Page terminée déjà acceptée.'])));
  records.fr.receipts.push({ fields: betaIds, review: { status: 'accepted', reviewer: 'offline reviewer', draftModel: 'offline draft', nativeLanguageReview: 'pending' } });
  write(recordFiles.fr, records.fr);
  const acceptedBeta = write(path.join(betaDir, 'accepted.json'), { manifestHash: manifest.manifestHash, translations: Object.fromEntries(betaIds.map(id => [id, records.fr.translations[id]])), review: records.fr.receipts.at(-1).review });
  write(path.join(betaDir, 'completed.json'), { planHash: old.planHash, acceptedHash: acceptedBeta.sha256, locale: 'fr', route: 'beta/tutorial', fields: betaIds.length });
  write(path.join(sourceCampaign, 'controller-status.json'), { schema: 1, unit: 'pages', state: 'held', controller: deadCorrectionOwner,
    counts: { planned: 2, completed: 1, held: 1, skipped: 0 }, phases: [{ locale: 'fr', chunk: '01', route: 'alpha/tutorial', phase: 'review-02', state: 'held', worker: deadCorrectionOwner }] });
  write(path.join(sourceJob, 'config.json'), { schema: 1, root, job: sourceJob, campaign: sourceCampaign, sectionsPlan: sourcePlanFile,
    controller: path.join(root, 'scripts/run_tutorial_section_translations.mjs'), nonce: deadCorrectionOwner.nonce, printTimeout: '0s', watchdogTimeout: '0s', pollIntervalSeconds: 30,
    pins: [planPin, manifestPin, ...sources].map(row => ({ file: row.file, hash: row.sha256 })) });
  write(path.join(sourceJob, 'owner.json'), deadCorrectionOwner); write(path.join(sourceJob, 'controller.json'), deadCorrectionOwner);
  write(path.join(sourceJob, 'result.json'), { state: 'held', exitCode: 1, finishedAt: '2026-10-16T00:10:00Z' });
  const expectedAcceptedFields = Object.values(records).reduce((sum, record) => sum + Object.keys(record.translations).length, 0);
  const prepareOptions = { root, sourceJob, expectedHeldPages: 1, expectedAcceptedFields }, prepare = overrides => prepareSectionCorrectionPlan({ ...prepareOptions, ...overrides });
  if (copyRuntime) {
    mkdirSync(path.join(root, 'scripts'));
    for (const name of ['run_tutorial_section_translations.mjs', 'tutorial_locale_section_plan.mjs', 'tutorial_section_recovery_plan.mjs', 'tutorial_locale_lib.mjs', 'tutorial_locale_status.mjs', 'tutorial_locale_apply.mjs', 'tutorial_translation_transport.mjs', 'tutorial_translation_queue.mjs', 'tutorial_section_protocol.mjs', 'tutorial_review_batching.mjs', 'tutorial_section_correction_plan.mjs', 'tutorial_section_review_continuation_plan.mjs']) copyFileSync(path.join(ROOT, 'scripts', name), path.join(root, 'scripts', name));
  }
  const fake = path.join(root, 'offline-agy.mjs'); copyFileSync(path.join(ROOT, 'tests/fixtures/tutorial_section_fake_cli.mjs'), fake); chmodSync(fake, 0o700);
  write(path.join(root, 'fake-config.json'), { mode, driftFile: sources[0].file });
  const env = { ...process.env, TMPDIR: temporary, SCIREPL_TRANSLATION_AGY: fake };
  const calls = () => existsSync(path.join(root, 'fake-calls.jsonl')) ? readFileSync(path.join(root, 'fake-calls.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  const plan = prepare(), planFile = path.join(root, 'correction-plan.json'); write(planFile, plan);
  const campaign = mkdtempSync(path.join(tmpdir(), 'scirepl-tutorial-translation-correction-offline-'));
  const args = [path.join(root, 'scripts/run_tutorial_section_translations.mjs'), '--plan', planFile, '--campaign', campaign];
  const run = execute => spawnSync(process.execPath, [...args, ...(execute ? ['--execute'] : [])], { cwd: root, env, encoding: 'utf8', timeout: 30000 });
  return { root, temporary, sourceJob, sourceCampaign, sourcePlanFile, sourcePlan: old, manifest, sources, records, recordFiles, alphaDir, betaDir, alpha,
    acceptedId, pending, parts, savedReview, legacyFields, newSection, prepareOptions, prepare, write, read, plan, planFile, campaign, args, env, calls, run };
}
