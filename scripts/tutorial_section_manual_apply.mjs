#!/usr/bin/env node
// Explicit editorial acceptance of complete independent review sections only.
// No provider calls, automatic repairs, replay, or writes to original evidence.
import assert from 'node:assert/strict';
import { existsSync, lstatSync, readFileSync, readdirSync, mkdirSync, writeFileSync, renameSync, unlinkSync, rmdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, LOCALES, sha, validateKeep } from './tutorial_locale_lib.mjs';
import { parseTransport } from './tutorial_translation_transport.mjs';
import { getProcessStartIdentity } from './tutorial_translation_queue.mjs';
import { gateSection, correctionReviewPrompt } from './tutorial_section_protocol.mjs';

const SCRIPT = fileURLToPath(import.meta.url), HASH = /^[a-f0-9]{64}$/;
const IDENTITY = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}:\d+$/i;
const CONVERSATION = /^[\w.-]{1,200}$/;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const tokens = value => value.match(/\{\{P\d{3}\}\}/g) || [];
const keys = (value, allowed) => assert(plain(value) && Object.keys(value).every(key => allowed.includes(key)), 'Unexpected manual correction schema');
const jsonBytes = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const localePath = (root, locale) => path.join(root, 'docs/tutorial-localization/translations', locale + '.json');
const phaseName = index => 'review-' + String(index + 1).padStart(2, '0');

function editField(field, original, edit) {
  keys(edit, ['id', 'kind', 'beforeHash', 'afterHash', 'before', 'after', 'reason', 'replaceOne']);
  assert.equal(edit.id, field.id, 'Editorial edit field differs');
  assert(typeof edit.reason === 'string' && edit.reason.trim().length >= 20, 'Editorial correction requires a substantive explicit reason');
  assert(typeof edit.before === 'string' && typeof edit.after === 'string' && edit.before !== edit.after, 'Editorial correction requires explicit distinct full before/after text');
  assert(HASH.test(edit.beforeHash) && HASH.test(edit.afterHash), 'Editorial correction needs full-text hashes');
  assert.equal(sha(original), edit.beforeHash, 'Original reviewed field changed');
  assert.equal(original, edit.before, 'Explicit editorial before text differs from independent review');
  assert.equal(sha(edit.after), edit.afterHash, 'Editorial after text differs from its pin');
  if (edit.kind === 'source-aligned-clause') {
    keys(edit.replaceOne, ['before', 'after']);
    const from = edit.replaceOne.before, to = edit.replaceOne.after;
    assert(typeof from === 'string' && from.length && typeof to === 'string' && to.length && from !== to, 'Explicit clause replacement is required');
    assert(from.length <= 1500 && to.length <= 2000, 'Editorial clause replacement is not tightly bounded');
    const offset = original.indexOf(from);
    assert(offset >= 0 && original.indexOf(from, offset + 1) === -1, 'Editorial clause must match exactly once');
    assert.equal(edit.after, original.slice(0, offset) + to + original.slice(offset + from.length), 'Editorial text changed outside the explicit clause');
    assert.deepEqual(tokens(edit.after).sort(), tokens(original).sort(), 'Editorial correction changed the protected-token multiset');
  } else {
    assert.equal(edit.kind, 'translate-unchanged-label', 'Unknown editorial correction kind');
    if (edit.replaceOne !== undefined) {
      keys(edit.replaceOne, ['before', 'after']);
      assert.equal(edit.replaceOne.before, original, 'Label replacement must pin the complete unchanged label');
      assert.equal(edit.replaceOne.after, edit.after, 'Label replacement differs from the explicit complete translation');
    }
    assert.equal(original.trim(), field.text.trim(), 'Only an unchanged source label may receive this explicit translation');
    validateKeep(field, 'Eligibility check only; this does not authorize a keep.');
    assert.equal(tokens(original).length, 0, 'Protected labels need a source-aligned clause correction');
  }
  return edit.after;
}

/**
 * Pure supplied-evidence audit. No filesystem/process reads or writes occur.
 * files: [{file:absolutePath,bytes:Buffer|string}]; directoryEntries maps paths
 * to exact saved names; missingFiles proves explicitly checked absence;
 * processIdentities maps every observed PID to boot:start or verified null.
 * Private reviewed text remains in the returned receipt payloads, never logs.
 */
export function auditManualSectionApply({ spec, files, directoryEntries = {}, missingFiles = [], processIdentities = {}, bootId, root = ROOT }) {
  keys(spec, ['schema', 'kind', 'sourceJob', 'plan', 'acceptedSnapshots', 'reviewer', 'reviewScope', 'nativeLanguageReview', 'pages']);
  assert.equal(spec.schema, 1); assert.equal(spec.kind, 'explicit-section-editorial-correction');
  assert.equal(spec.nativeLanguageReview, 'pending', 'Editorial acceptance cannot claim native-language approval');
  assert(typeof spec.reviewer === 'string' && spec.reviewer.trim().length >= 12 && typeof spec.reviewScope === 'string' && spec.reviewScope.trim().length >= 20, 'Explicit editorial reviewer and review scope are required');
  assert(typeof bootId === 'string' && IDENTITY.test(bootId + ':1'), 'Current boot identity is required');
  root = path.resolve(root);
  const documents = new Map();
  for (const row of files) {
    assert(typeof row.file === 'string' && path.isAbsolute(row.file) && !documents.has(row.file), 'Duplicate or invalid evidence file');
    documents.set(row.file, Buffer.from(row.bytes));
  }
  const missing = new Set(missingFiles), evidence = new Map();
  const bytes = file => { assert(documents.has(file), 'Required evidence is missing'); const value = documents.get(file); evidence.set(file, { file, sha256: sha(value) }); return value; };
  const read = file => { const value = JSON.parse(bytes(file).toString('utf8')); assert(plain(value), 'Evidence must be an object'); return value; };
  const readArray = file => { const value = JSON.parse(bytes(file).toString('utf8')); assert(Array.isArray(value), 'Evidence must be an array'); return value; };
  const absent = file => assert(missing.has(file) && !documents.has(file), 'Expected absence has not been verified');
  const pinned = pin => { assert(plain(pin) && typeof pin.file === 'string' && path.isAbsolute(pin.file) && HASH.test(pin.sha256), 'Invalid evidence pin'); const value = bytes(pin.file); assert.equal(sha(value), pin.sha256, 'Pinned evidence changed'); return value; };
  const pinnedJson = pin => JSON.parse(pinned(pin).toString('utf8'));
  const semantic = plan => { const { planHash, ...unsigned } = plan; assert.equal(plan.schema, 1); assert.equal(plan.kind, 'tutorial-coherent-section-plan'); assert.equal(sha(JSON.stringify(unsigned)), planHash, 'Semantic plan changed'); return planHash; };
  const dead = (owner, full = false) => {
    assert(plain(owner) && Number.isSafeInteger(owner.pid) && owner.pid > 0, 'Unverifiable saved ownership');
    assert(typeof owner.startIdentity === 'string' && (IDENTITY.test(owner.startIdentity) || !full && /^\d+$/.test(owner.startIdentity)), 'Malformed saved ownership identity');
    assert(Object.hasOwn(processIdentities, owner.pid), 'Saved process liveness was not observed');
    const observed = processIdentities[owner.pid];
    assert(observed === null || typeof observed === 'string' && IDENTITY.test(observed) && observed.startsWith(bootId + ':'), 'Unknown current process identity');
    if (observed !== null) assert.notEqual(full || owner.startIdentity.includes(':') ? observed : observed.split(':').at(-1), owner.startIdentity, 'An original owner or worker is still live');
  };
  const success = (transport, proposal) => {
    assert(plain(transport) && typeof transport.stdout === 'string' && typeof transport.stderr === 'string', 'Incomplete transport evidence');
    assert.equal(transport.exitCode, 0); assert.equal(transport.persistenceFailure, false, 'Transport persistence must explicitly have succeeded');
    for (const name of ['timedOut', 'outputLimited', 'cancelled', 'cliTimeoutWarning']) assert.equal(transport[name], false, 'Incomplete or failed transport flags');
    assert.deepEqual(transport.unexpectedFiles, [], 'Reviewer unexpectedly wrote files');
    const envelope = JSON.parse(transport.stdout);
    assert(plain(envelope) && !envelope.error && !envelope.is_error, 'Contradictory successful envelope');
    assert.deepEqual(parseTransport(transport), proposal, 'Complete SUCCESS result differs from saved proposal');
    assert(typeof envelope.conversation_id === 'string' && CONVERSATION.test(envelope.conversation_id), 'Missing independent conversation identity');
    return envelope;
  };
  const sourceJob = path.resolve(spec.sourceJob), config = read(path.join(sourceJob, 'config.json'));
  assert.equal(config.schema, 1); assert.equal(config.job, sourceJob); assert.equal(config.root, root);
  assert.equal(config.sectionsPlan, spec.plan.file); assert.equal(config.controller, path.join(root, 'scripts/run_tutorial_section_translations.mjs'));
  assert.equal(config.printTimeout, '0s'); assert.equal(config.watchdogTimeout, '0s');
  assert(typeof config.nonce === 'string' && /^[a-f0-9-]{36}$/.test(config.nonce), 'Invalid durable owner nonce');
  const campaign = path.resolve(config.campaign), result = read(path.join(sourceJob, 'result.json'));
  assert.equal(result.state, 'held', 'Manual correction requires terminal held work'); assert.equal(result.exitCode, 1);
  assert(Number.isFinite(Date.parse(result.finishedAt)), 'Missing saved terminal time');
  const status = read(path.join(campaign, 'controller-status.json'));
  assert.equal(status.state, 'held'); assert.equal(status.unit, 'pages'); dead(status.controller, true);
  absent(path.join(campaign, 'controller.lock'));
  for (const name of ['owner.json', 'controller.json', 'launch.json']) {
    const value = read(path.join(sourceJob, name)); assert.equal(value.nonce, config.nonce); dead(value);
  }
  for (const phase of status.phases || []) if (phase.worker) dead(phase.worker, true);
  for (const pin of config.pins) {
    assert(typeof pin.file === 'string' && HASH.test(pin.hash), 'Invalid configured source pin');
    assert.equal(sha(bytes(pin.file)), pin.hash, 'Frozen job source/runtime changed');
  }
  assert(config.pins.some(pin => pin.file === spec.plan.file && pin.hash === spec.plan.sha256), 'Job did not pin this exact correction plan');
  const plan = pinnedJson(spec.plan), planHash = semantic(plan);
  assert.equal(plan.recovery?.kind, 'explicit-bounded-section-correction', 'Manual correction cannot silently promote a different generation');
  assert.equal(plan.recovery.automaticRetries, false); assert.equal(plan.recovery.bounds.maxDraftCalls, 0);
  const oldPlan = pinnedJson(plan.recovery.sourcePlan);
  assert.equal(semantic(oldPlan), plan.recovery.sourcePlanHash, 'Correction ancestry changed');
  const manifest = pinnedJson(plan.manifestFile);
  assert.equal(manifest.manifestHash, plan.manifestHash, 'Source manifest differs');
  for (const pin of plan.sources) pinned(pin);
  for (const item of plan.campaignEvidence || []) {
    if (item.request) pinned(item.request);
    for (const pin of item.files || []) pinned(pin);
  }
  const sourceFields = new Map([...manifest.pages.flatMap(page => page.fields), ...manifest.chrome].map(field => [field.id, field]));
  const current = new Map();
  assert(Array.isArray(spec.acceptedSnapshots), 'Exact current accepted snapshots are required');
  for (const pin of spec.acceptedSnapshots) {
    assert(LOCALES.includes(pin.locale) && pin.locale !== 'en' && !current.has(pin.locale), 'Invalid accepted snapshot locale');
    assert.equal(pin.file, localePath(root, pin.locale), 'Accepted snapshot path differs');
    const record = pin.sha256 === null ? (absent(pin.file), { schema: 1, locale: pin.locale, manifestHash: plan.manifestHash, translations: {}, receipts: [] }) : pinnedJson(pin);
    assert.equal(record.locale, pin.locale); assert.equal(record.manifestHash, plan.manifestHash);
    assert(plain(record.translations) && Array.isArray(record.receipts), 'Malformed accepted locale record'); current.set(pin.locale, record);
  }
  for (const [locale, baseline] of Object.entries(plan.recovery.acceptedBaseline)) {
    assert(current.has(locale), 'Accepted baseline snapshot is missing');
    for (const [id, value] of Object.entries(baseline)) assert.equal(current.get(locale).translations[id], value, 'Immutable accepted baseline changed');
  }
  const jobs = new Map();
  for (const locale of plan.locales) for (const [index, page] of locale.pages.entries()) {
    const key = locale.locale + '/' + page.route; assert(!jobs.has(key), 'Repeated planned page');
    jobs.set(key, { locale: locale.locale, page, key: locale.locale + '/' + String(index + 1).padStart(2, '0') });
  }
  assert.equal(status.counts.planned, jobs.size); assert.equal(status.counts.completed + status.counts.held, jobs.size); assert.equal(status.counts.skipped || 0, 0);
  assert(Array.isArray(spec.pages) && spec.pages.length, 'Select explicit complete review sections');
  const selectedPages = new Set(), selectedIds = new Set(), receipts = [];
  const remember = (set, value) => { if (value === null || value === undefined) return; assert(typeof value === 'string' && CONVERSATION.test(value), 'Malformed historical identity'); set.add(value); };
  const draftIds = new Set();
  for (const job of jobs.values()) for (const seed of job.page.draftSeeds) {
    const transport = pinnedJson(seed.source.transport), proposal = pinnedJson(seed.source.proposal);
    // Old successful draft evidence may predate explicit false flags. It is
    // reference-only input, never accepted here without a complete review.
    assert.deepEqual(parseTransport(transport), proposal); assert(!transport.persistenceFailure); assert.deepEqual(transport.unexpectedFiles || [], []);
    assert.equal(proposal.translations?.[seed.id], seed.translation); assert.equal(seed.text, sourceFields.get(seed.id)?.text);
    try { remember(draftIds, JSON.parse(transport.stdout).conversation_id); } catch { /* Older draft identities are also frozen in priorConversationIds. */ }
  }
  const reviewChain = ({ directory, phase, expectedPlanHash, previous, forbidden, expectedPrompt, controller }) => {
    const docs = Object.fromEntries(['transport', 'proposal', 'session', 'dispatched', 'queued', 'child'].map(kind => [kind, read(path.join(directory, phase + '.' + kind + '.json'))]));
    assert.equal(docs.queued.planHash, expectedPlanHash); assert.equal(docs.queued.phase, phase);
    assert(Number.isFinite(Date.parse(docs.queued.at)), 'Malformed queue provenance');
    assert.equal(docs.dispatched.planHash, expectedPlanHash); assert.equal(docs.dispatched.conversationId, previous?.id ?? null, 'Dispatch continuation changed');
    assert.equal(docs.dispatched.model, config.model); assert.equal(docs.dispatched.printTimeout, '0s');
    dead(docs.child, true); if (controller) { dead(controller, true); assert.deepEqual(docs.child.controller, controller, 'Worker controller provenance changed'); }
    const envelope = success(docs.transport, docs.proposal), id = docs.session.conversationId;
    assert.equal(envelope.conversation_id, id); assert(!forbidden.has(id), 'Reviewer reused an old draft/review identity');
    assert(typeof docs.session.workspace === 'string' && docs.session.workspace.length, 'Missing reviewer workspace');
    if (previous) { assert.equal(id, previous.id); assert.equal(docs.session.workspace, previous.workspace); }
    if (expectedPrompt !== undefined) assert.equal(sha(bytes(path.join(directory, phase + '.prompt.txt'))), sha(expectedPrompt), 'Saved review prompt differs from exact frozen inputs');
    return { id, workspace: docs.session.workspace, proposal: docs.proposal,
      evidence: Object.fromEntries(['transport', 'proposal', 'session', 'dispatched', 'queued', 'child'].map(kind => { const file = path.join(directory, phase + '.' + kind + '.json'); return [kind, { file, sha256: sha(bytes(file)) }]; })) };
  };
  const addReceipt = (job, fieldIds, normalized, provenance, edits) => {
    assert(fieldIds.length && new Set(fieldIds).size === fieldIds.length, 'Repeated receipt fields');
    for (const id of fieldIds) { const key = job.locale + '/' + id; assert(!selectedIds.has(key), 'Selected sections overlap'); selectedIds.add(key); assert(!Object.hasOwn(current.get(job.locale).translations, id), 'Refusing accepted translation overwrite'); }
    receipts.push({ locale: job.locale, route: job.page.route, manifestHash: plan.manifestHash,
      translations: normalized.translations, review: { status: 'accepted',
        reviewer: edits.length ? 'Controller editorial correction after independent machine section review' : config.model + ' (pinned independent complete section review)',
        draftModel: config.model, nativeLanguageReview: 'pending', keptFields: normalized.keptFields, planHash,
        source: edits.length ? 'explicit-editorial-correction-after-independent-machine-review' : 'preserved-independent-section-review',
        scope: 'complete-independent-review-section', machineApprovedEditorialChanges: false,
        controllerEditorialReviewer: spec.reviewer, editorialReviewScope: spec.reviewScope,
        originalMachineReview: provenance, editorialCorrections: edits.map(edit => ({ id: edit.id, kind: edit.kind, beforeHash: edit.beforeHash, afterHash: edit.afterHash, reason: edit.reason })) } });
  };
  for (const selection of spec.pages) {
    keys(selection, ['locale', 'route', 'includeReviewSeeds', 'sections']);
    const key = selection.locale + '/' + selection.route, job = jobs.get(key);
    assert(job && !selectedPages.has(key), 'Unknown or repeated selected page'); selectedPages.add(key);
    assert(current.has(job.locale), 'Selected locale snapshot is missing');
    assert.equal(selection.includeReviewSeeds, true, 'Preserved complete reviews must remain explicit');
    const directory = path.join(campaign, job.key), started = read(path.join(directory, 'started.json')), failed = read(path.join(directory, 'failed.json'));
    assert.equal(started.planHash, planHash); assert.equal(started.locale, job.locale); assert.equal(started.route, job.page.route); assert.equal(started.explicitCorrection, true);
    assert.equal(failed.planHash, planHash); assert.equal(failed.noAutomaticRetry, true); assert(/^review-\d{2}$/.test(failed.phase), 'Unknown held phase');
    absent(path.join(directory, 'completed.json')); absent(path.join(directory, 'accepted.json'));
    assert.deepEqual(readArray(path.join(directory, 'review.seeds.json')), job.page.reviewSeeds, 'Preserved review seed evidence changed');
    assert.deepEqual(readArray(path.join(directory, 'draft.seeds.json')), job.page.draftSeeds, 'Original saved draft evidence changed');
    for (const context of job.page.context) { assert.equal(context.readonly, true); assert.equal(context.text, sourceFields.get(context.id)?.text); assert.equal(current.get(job.locale).translations[context.id], context.translation, 'Accepted terminology context changed'); }
    const pageIds = new Set(job.page.route === '@chrome' ? manifest.chrome.map(field => field.id) : manifest.pages.find(page => page.route === job.page.route)?.fields.map(field => field.id));
    const allIds = [...job.page.draftSeeds.map(seed => seed.id), ...job.page.reviewSeeds.flatMap(seed => seed.fieldIds)];
    assert(allIds.length === new Set(allIds).size && allIds.every(id => pageIds.has(id)), 'Plan source fields overlap or cross pages');
    const originalSourcePage = oldPlan.locales.find(row => row.locale === job.locale)?.pages.find(page => page.route === job.page.route);
    assert(originalSourcePage, 'Preserved review ancestry is missing');
    const seedForbidden = new Set([...draftIds, ...originalSourcePage.recovery.priorConversationIds]);
    let priorSeed = null;
    for (const seed of job.page.reviewSeeds) {
      const seedDir = path.join(seed.source.campaign, seed.source.locale, seed.source.chunk);
      for (const name of ['transport', 'proposal', 'session', 'dispatched']) pinned(seed.source[name]);
      const chain = reviewChain({ directory: seedDir, phase: seed.source.phase, expectedPlanHash: plan.recovery.sourcePlanHash, previous: priorSeed, forbidden: seedForbidden,
        controller: read(path.join(seed.source.campaign, 'controller-status.json')).controller });
      const fields = seed.fieldIds.map(id => sourceFields.get(id)), normalized = gateSection(fields, chain.proposal, sourceFields);
      assert.deepEqual(normalized.translations, seed.translations); assert.deepEqual(normalized.keptFields, seed.keptFields);
      addReceipt(job, seed.fieldIds, normalized, { kind: 'preserved-complete-review', evidence: chain.evidence }, []); priorSeed = chain;
    }
    assert(Array.isArray(selection.sections) && selection.sections.length, 'Select at least one complete current review section');
    const selections = new Map();
    for (const section of selection.sections) { keys(section, ['phase', 'edits']); assert(/^review-\d{2}$/.test(section.phase) && !selections.has(section.phase), 'Unknown/repeated manual review phase'); assert(Array.isArray(section.edits), 'Explicit section edits are required'); selections.set(section.phase, section); }
    const names = directoryEntries[directory]; assert(Array.isArray(names), 'Current page directory inventory is missing');
    const allowedPhases = new Set(job.page.correctionReviews.map((_, index) => phaseName(index)));
    for (const name of names) if (/^(?:draft|review)-\d+\./.test(name)) assert(allowedPhases.has(name.slice(0, name.indexOf('.'))), 'Unknown dispatched phase evidence');
    assert([...selections.keys()].every(phase => allowedPhases.has(phase)), 'Selected phase is outside the frozen review partitions');
    const draftValues = Object.fromEntries(job.page.draftSeeds.map(seed => [seed.id, seed.translation]));
    const forbidden = new Set([...draftIds, ...job.page.recovery.priorConversationIds]);
    let previous = null, sawMissing = false;
    for (const [index, partition] of job.page.correctionReviews.entries()) {
      const phase = phaseName(index), prefix = phase + '.', present = names.some(name => name.startsWith(prefix));
      if (!present) { sawMissing = true; assert(!selections.has(phase), 'Undispatched future review cannot be accepted'); continue; }
      assert(!sawMissing, 'Review history contains an ambiguous dispatch gap');
      const fields = partition.fieldIds.map(id => { assert(sourceFields.has(id), 'Unknown review field'); return sourceFields.get(id); });
      const prompt = correctionReviewPrompt(job, fields, draftValues, index === 0);
      const chain = reviewChain({ directory, phase, expectedPlanHash: planHash, previous, forbidden, expectedPrompt: prompt, controller: status.controller });
      keys(chain.proposal, ['translations', 'keptFields']);
      assert(plain(chain.proposal.translations), 'Complete review translations object is required');
      assert.deepEqual(Object.keys(chain.proposal.translations).sort(), [...partition.fieldIds].sort(), 'Missing or extra original review fields cannot be repaired manually');
      assert(Object.values(chain.proposal.translations).every(value => typeof value === 'string' && value.trim()), 'Complete review string values are required');
      if (chain.proposal.keptFields !== undefined) assert(plain(chain.proposal.keptFields), 'Invalid original reviewed keeps');
      if (selections.has(phase)) {
        const section = selections.get(phase), amended = { translations: { ...chain.proposal.translations }, keptFields: { ...(chain.proposal.keptFields || {}) } }, edited = new Set();
        for (const edit of section.edits) { assert(partition.fieldIds.includes(edit.id) && !edited.has(edit.id), 'Repeated or out-of-section editorial edit'); edited.add(edit.id); assert(!Object.hasOwn(amended.keptFields, edit.id), 'Manual edits cannot invent or repurpose keep approvals'); amended.translations[edit.id] = editField(sourceFields.get(edit.id), amended.translations[edit.id], edit); }
        const normalized = gateSection(fields, amended, sourceFields);
        addReceipt(job, partition.fieldIds, normalized, { kind: 'complete-successful-independent-review-before-editorial-correction', evidence: chain.evidence,
          prompt: { file: path.join(directory, phase + '.prompt.txt'), sha256: sha(prompt) }, originalProposalHash: sha(JSON.stringify(chain.proposal)) }, section.edits);
      } else gateSection(fields, chain.proposal, sourceFields);
      previous = chain;
    }
  }
  const totals = receipts.reduce((sum, receipt) => sum + Object.keys(receipt.translations).length, 0);
  assert(totals > 0, 'No complete reviewed fields selected');
  return { summary: { mode: 'checked-editorial-sections', pages: selectedPages.size, sections: receipts.length, fields: totals,
    editedFields: receipts.reduce((sum, receipt) => sum + receipt.review.editorialCorrections.length, 0), noModelsCalled: true, nativeLanguageReview: 'pending' },
    receipts, current: Object.fromEntries(current), evidence: [...evidence.values()], absenceChecks: [...missing],
    directoryInventories: structuredClone(directoryEntries), specHash: sha(JSON.stringify(spec)), planHash, finishedAt: result.finishedAt };
}

// Read-only loader. Captures stable regular-file bytes and explicit absence;
// no status subprocess, locks, temporary files, or directory creation occurs.
export function loadManualSectionAudit(specFile, { root = ROOT } = {}) {
  const records = new Map(), missingFiles = new Set(), directoryEntries = {}, observed = {};
  const capture = (file, optional = false) => {
    file = path.resolve(file); if (records.has(file)) return records.get(file).bytes;
    let info;
    try { info = lstatSync(file); } catch (error) { if (optional && error.code === 'ENOENT') { missingFiles.add(file); return null; } throw error; }
    // The pinned Node executable is larger than request/metadata files.
    assert(info.isFile() && !info.isSymbolicLink() && info.size <= 256 * 1024 * 1024, 'Evidence must be a bounded regular file');
    for (let parent = path.dirname(file); parent !== path.dirname(parent); parent = path.dirname(parent)) assert(!lstatSync(parent).isSymbolicLink(), 'Evidence parent must not be a symlink');
    const bytes = readFileSync(file), after = lstatSync(file);
    assert.equal(after.size, info.size); assert.equal(after.mtimeMs, info.mtimeMs, 'Evidence changed during observation');
    records.set(file, { file, bytes }); return bytes;
  };
  const read = (file, optional = false) => { const value = capture(file, optional); return value === null ? null : JSON.parse(value.toString('utf8')); };
  const observe = owner => {
    if (!owner || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 || Object.hasOwn(observed, owner.pid)) return;
    try { observed[owner.pid] = getProcessStartIdentity(owner.pid); }
    catch (error) { if (['ENOENT', 'ESRCH'].includes(error.code)) observed[owner.pid] = null; else throw error; }
  };
  const phaseDirectory = directory => {
    const entries = readdirSync(directory, { withFileTypes: true }); directoryEntries[directory] = entries.map(entry => entry.name);
    for (const entry of entries) if (/^(?:draft|review)-\d+\.(?:queued|dispatched|child|session|transport|proposal)\.json$/.test(entry.name) || /^(?:draft|review)-\d+\.prompt\.txt$/.test(entry.name)) {
      assert(entry.isFile() && !entry.isSymbolicLink(), 'Phase evidence must be regular');
      if (entry.name.endsWith('.prompt.txt')) capture(path.join(directory, entry.name));
      else { const value = read(path.join(directory, entry.name)); if (entry.name.endsWith('.child.json')) { observe(value); observe(value.controller); } }
    }
  };
  const spec = read(specFile), config = read(path.join(spec.sourceJob, 'config.json')), plan = read(spec.plan.file), campaign = config.campaign;
  read(path.join(spec.sourceJob, 'result.json'));
  for (const name of ['owner.json', 'controller.json', 'launch.json']) observe(read(path.join(spec.sourceJob, name)));
  const status = read(path.join(campaign, 'controller-status.json')); observe(status.controller);
  for (const phase of status.phases || []) observe(phase.worker);
  capture(path.join(campaign, 'controller.lock'), true);
  for (const pin of config.pins) capture(pin.file);
  for (const pin of [plan.manifestFile, ...plan.sources, plan.recovery.sourcePlan]) capture(pin.file);
  for (const item of plan.campaignEvidence || []) for (const pin of [item.request, ...(item.files || [])].filter(Boolean)) capture(pin.file);
  for (const pin of spec.acceptedSnapshots) capture(pin.file, pin.sha256 === null);
  for (const locale of plan.locales) for (const [index, page] of locale.pages.entries()) {
    const directory = path.join(campaign, locale.locale, String(index + 1).padStart(2, '0'));
    phaseDirectory(directory);
    for (const name of ['started.json', 'failed.json', 'completed.json', 'accepted.json', 'review.seeds.json', 'draft.seeds.json']) capture(path.join(directory, name), true);
    for (const seed of page.draftSeeds) for (const kind of ['transport', 'proposal']) capture(seed.source[kind].file);
    for (const seed of page.reviewSeeds) {
      for (const kind of ['transport', 'proposal', 'session', 'dispatched']) capture(seed.source[kind].file);
      const oldStatus = read(path.join(seed.source.campaign, 'controller-status.json')); observe(oldStatus.controller);
      phaseDirectory(path.join(seed.source.campaign, seed.source.locale, seed.source.chunk));
    }
  }
  const bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  const audit = auditManualSectionApply({ spec, files: [...records.values()], missingFiles: [...missingFiles], directoryEntries, processIdentities: observed, bootId, root });
  return { ...audit, specFile: path.resolve(specFile), specFileHash: sha(records.get(path.resolve(specFile)).bytes), spec };
}

function ownLock(directory) {
  mkdirSync(directory, { mode: 0o700 });
  const owner = { pid: process.pid, startIdentity: getProcessStartIdentity(), nonce: randomUUID() }, file = path.join(directory, 'owner.json');
  writeFileSync(file, jsonBytes(owner), { flag: 'wx', mode: 0o600 });
  return () => { assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), owner, 'Writer lock ownership changed'); assert.equal(getProcessStartIdentity(), owner.startIdentity); unlinkSync(file); rmdirSync(directory); };
}

export function applyManualSectionAudit(specFile, output, { root = ROOT } = {}) {
  const prepared = loadManualSectionAudit(specFile, { root });
  output = path.resolve(output);
  assert(output.startsWith('/tmp/scirepl-tutorial-manual-correction-') && path.dirname(output) === '/tmp' && !existsSync(output), 'Use a new private manual-correction output directory');
  const locales = [...new Set(prepared.receipts.map(receipt => receipt.locale))].sort(), releases = [];
  const lockRoot = path.join(tmpdir(), 'scirepl-tutorial-apply-locks', sha(root));
  mkdirSync(lockRoot, { recursive: true, mode: 0o700 });
  try {
    for (const locale of locales) releases.push(ownLock(path.join(lockRoot, locale)));
    const audit = loadManualSectionAudit(specFile, { root });
    assert.equal(audit.specFileHash, prepared.specFileHash, 'Correction spec changed before apply');
    assert.equal(audit.specHash, prepared.specHash); assert.deepEqual(audit.evidence, prepared.evidence, 'Evidence changed before apply');
    mkdirSync(output, { mode: 0o700 });
    const save = (name, value) => writeFileSync(path.join(output, name), jsonBytes(value), { flag: 'wx', mode: 0o600 });
    save('editorial-spec.json', audit.spec);
    save('evidence.json', { schema: 1, sourcePlanHash: audit.planHash, originalJobFinishedAt: audit.finishedAt, specHash: audit.specHash, evidence: audit.evidence,
      nativeLanguageReview: 'pending', machineApprovedEditorialChanges: false });
    save('apply-started.json', { schema: 1, locales, atomicity: 'one-locale-at-a-time; no cross-locale rollback',
      recovery: 'Inspect per-locale intent/applied records and record hashes; never replay accepted fields.' });
    const byLocale = new Map(locales.map(locale => [locale, []]));
    for (const [index, receipt] of audit.receipts.entries()) {
      const name = 'accepted-' + String(index + 1).padStart(3, '0') + '.json'; save(name, receipt);
      byLocale.get(receipt.locale).push({ receipt, name });
    }
    for (const locale of locales) {
      // Recheck every original immutable file immediately before each locale
      // write, excluding only locale records already changed by this apply.
      const changed = new Set(locales.slice(0, locales.indexOf(locale)).map(value => localePath(root, value)));
      for (const pin of audit.evidence) if (!changed.has(pin.file)) assert.equal(sha(readFileSync(pin.file)), pin.sha256, 'Evidence or accepted snapshot changed before locale apply');
      for (const file of audit.absenceChecks) if (!changed.has(file)) assert(!existsSync(file), 'Previously absent evidence or controller lock appeared');
      for (const [directory, names] of Object.entries(audit.directoryInventories)) assert.deepEqual(readdirSync(directory).sort(), [...names].sort(), 'Phase inventory changed before locale apply');
      assert.equal(sha(readFileSync(specFile)), prepared.specFileHash, 'Correction authorization changed');
      const record = structuredClone(audit.current[locale]);
      for (const { receipt, name } of byLocale.get(locale)) {
        assert(Object.keys(receipt.translations).every(id => !Object.hasOwn(record.translations, id)), 'Accepted overwrite is forbidden');
        Object.assign(record.translations, receipt.translations);
        record.receipts.push({ source: path.join(output, name), fields: Object.keys(receipt.translations).sort(), review: receipt.review });
      }
      const file = localePath(root, locale), temporary = file + '.' + randomUUID() + '.manual.tmp';
      // Intent and receipt evidence precede the atomic rename. If the process
      // stops between rename and applied marker, exact before/after hashes make
      // that partial success diagnosable without claiming a global rollback.
      save('intent-' + locale + '.json', { schema: 1, locale, beforeHash: existsSync(file) ? sha(readFileSync(file)) : null,
        afterHash: sha(jsonBytes(record)), receiptFiles: byLocale.get(locale).map(row => row.name), nativeLanguageReview: 'pending' });
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(temporary, jsonBytes(record), { flag: 'wx', mode: 0o600 }); renameSync(temporary, file);
      save('applied-' + locale + '.json', { schema: 1, locale, fields: byLocale.get(locale).reduce((sum, row) => sum + Object.keys(row.receipt.translations).length, 0), recordHash: sha(readFileSync(file)), nativeLanguageReview: 'pending' });
    }
    save('completed.json', { schema: 1, ...audit.summary, completedAt: new Date().toISOString(), nativeLanguageReview: 'pending' });
    return { ...audit.summary, mode: 'applied-editorial-sections', output };
  } finally { for (const release of releases.reverse()) release(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT) {
  try {
    const args = process.argv.slice(2), options = {};
    while (args.length) {
      const key = args.shift(); assert(['--spec', '--output', '--check', '--apply'].includes(key) && !Object.hasOwn(options, key), 'Invalid manual correction option');
      if (['--check', '--apply'].includes(key)) options[key] = true;
      else { const value = args.shift(); assert(value && !value.startsWith('--')); options[key] = value; }
    }
    assert(options['--spec'] && Boolean(options['--check']) !== Boolean(options['--apply']), 'Select exactly one of --check or --apply');
    assert(!options['--check'] || !options['--output'], 'Read-only check does not create output');
    const summary = options['--check'] ? loadManualSectionAudit(options['--spec']).summary : applyManualSectionAudit(options['--spec'], options['--output']);
    console.log(JSON.stringify(summary, null, 2));
  } catch {
    console.error('Manual editorial acceptance held: evidence, ownership, authorization or deterministic validation did not pass. No model calls were made.');
    process.exitCode = 1;
  }
}
