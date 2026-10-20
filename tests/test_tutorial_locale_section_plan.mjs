// Deterministic offline tests: no CLI/provider calls, queues or live records.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { extractPage, sha } from '../scripts/tutorial_locale_lib.mjs';
import { getProcessStartIdentity } from '../scripts/tutorial_translation_queue.mjs';
import { classifySections, buildSectionPlan, inspectCampaigns, prepareSectionPlan, sectionPlanSummary, writeSectionPlan } from '../scripts/tutorial_locale_section_plan.mjs';

let passes = 0;
const pass = name => { passes++; console.log('PASS ' + name); };
const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'scirepl-tutorial-section-fixture-'));
const write = (file, value) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value) + '\n', { mode: 0o600 }); return file; };
const text = 'This is a sufficiently detailed source explanation of the same example. ';
const html = '<html><head><title>Learning examples</title></head><body><h1>Learn</h1><p>Start here.</p>'
  + '<h2>First activity</h2>' + Array.from({ length: 65 }, () => '<p>' + text + '</p>').join('')
  + '<h2>Second activity</h2><p>' + text.repeat(2) + '</p><h3>A useful detail</h3><p>' + text.repeat(2) + '</p>'
  + '<h2>Final activity</h2><p>' + text.repeat(2) + '</p></body></html>';
const page = extractPage('example/tutorial', html);
const chrome = [{ id: 'chrome.language', text: 'Tutorial language', protectedSpans: [] }];
const unsigned = { schema: 1, sourceLocale: 'en', locales: ['en', 'fr'], pages: [page], chrome };
const manifest = { ...unsigned, manifestHash: sha(JSON.stringify(unsigned)) };
const fields = [...page.fields, ...chrome];
const opts = { maxChars: 15000, minChars: 5000 };
const sections = classifySections(page, html, opts);
assert(sections.some(section => section.fields.length > 40), 'The old forty-field cap must not return');
assert(sections.every(section => section.sourceChars <= opts.maxChars));
assert.deepEqual(sections.flatMap(section => section.fields.map(field => field.id)), page.fields.map(field => field.id));
assert(sections.length < 4, 'Adjacent small headings should share a coherent turn');
pass('coherent section grouping covers every source field, combines short headings and has no forty-field cap');

assert.throws(() => classifySections(page, html + ' ', opts), /Frozen page source changed/);
assert.throws(() => classifySections(page, html, { maxChars: 10, minChars: 0 }), /budget/);
const tiny = classifySections(page, html, { maxChars: 500, minChars: 0 });
assert(tiny.length > sections.length && tiny.every(section => section.sourceChars <= 500));
pass('frozen-source checks and long-section splitting retain complete fields');

const acceptedId = page.fields[0].id, seededId = page.fields[1].id;
const record = { schema: 1, locale: 'fr', manifestHash: manifest.manifestHash, translations: { [acceptedId]: 'Exemple accepté' },
  receipts: [{ fields: [acceptedId], review: { status: 'accepted', reviewer: 'offline independent fixture', draftModel: 'offline fixture', nativeLanguageReview: 'pending' } }] };
const seed = { locale: 'fr', id: seededId, text: page.fields[1].text, translation: 'Brouillon réussi', draftValid: true,
  source: { campaign: '/tmp/offline-original', chunk: '01', transport: { file: '/tmp/offline-original/draft.transport.json', sha256: 'fixture' }, proposal: { file: '/tmp/offline-original/draft.proposal.json', sha256: 'fixture' } } };
const build = overrides => buildSectionPlan({ manifest, htmlByRoute: { [page.route]: html }, records: { fr: record }, draftSeeds: [seed], locales: ['fr'], ...opts, ...overrides });
const plan = build();
const targets = plan.locales[0].pages.flatMap(page => page.sections.flatMap(section => section.fieldIds));
assert(!targets.includes(acceptedId) && !targets.includes(seededId));
assert.equal(plan.locales[0].preservedDraftCount, 1);
assert.equal(plan.locales[0].pages[0].context[0].readonly, true);
assert.equal(plan.locales[0].pages[0].context[0].translation, record.translations[acceptedId]);
assert.equal(plan.locales[0].missingCount, fields.length - 1);
assert.equal(plan.locales[0].plannedCount + plan.locales[0].preservedDraftCount, plan.locales[0].missingCount);
assert(targets.includes('chrome.language'));
assert.equal(JSON.stringify(build()), JSON.stringify(plan));
for (const page of plan.locales[0].pages) for (const section of page.sections) assert.equal(section.requestHash, sha(JSON.stringify(section.request)));
const { planHash, ...unhashed } = plan;
assert.equal(planHash, sha(JSON.stringify(unhashed)));
pass('accepted context stays read-only, successful drafts are reused and all missing fields are covered once, including shared navigation');

assert.throws(() => build({ records: { fr: { ...record, receipts: [] } } }), /valid and reviewed/);
assert.throws(() => build({ records: { fr: { ...record, manifestHash: 'wrong' } } }), /valid and reviewed/);
assert.throws(() => build({ locales: ['fr', 'fr'] }), /Duplicate locale/);
pass('unreviewed/stale accepted records and duplicate locale choices fail before any work');

const requestsRoot = path.join(fixtureRoot, 'requests'), campaign = path.join(fixtureRoot, 'campaign');
const request = { schema: 1, locale: 'fr', manifestHash: manifest.manifestHash, fields: [page.fields[1]].map(field => ({ id: field.id, text: field.text })) };
const requestFile = write(path.join(requestsRoot, 'fr/01.json'), request);
const attempt = path.join(campaign, 'fr/01');
write(path.join(attempt, 'started.json'), { manifestHash: manifest.manifestHash, locale: 'fr', chunk: '01', requestHash: sha(readFileSync(requestFile)) });
const draft = { translations: { [seededId]: 'Une bonne proposition' } };
write(path.join(attempt, 'draft.proposal.json'), draft);
write(path.join(attempt, 'draft.transport.json'), { exitCode: 0, timedOut: false, outputLimited: false, cancelled: false, unexpectedFiles: [], stderr: '', stdout: JSON.stringify({ status: 'SUCCESS', response: JSON.stringify(draft) }) });
write(path.join(attempt, 'review.transport.json'), { exitCode: 1, cancelled: true, stdout: 'Not completion evidence' });
let history = inspectCampaigns({ manifest, campaigns: [campaign], requestsRoot });
assert.equal(history.draftSeeds.length, 1);
assert.equal(history.draftSeeds[0].translation, draft.translations[seededId]);
assert.equal(history.evidence[0].successfulDraft, true);
assert(history.evidence[0].files.every(file => /^[a-f0-9]{64}$/.test(file.sha256)));
pass('complete successful draft is preserved even if its review was cancelled, and all evidence is hashed');

write(path.join(attempt, 'draft.transport.json'), { exitCode: 0, cancelled: true, stderr: '', stdout: JSON.stringify({ status: 'SUCCESS', response: JSON.stringify(draft) }) });
history = inspectCampaigns({ manifest, campaigns: [campaign], requestsRoot });
assert.equal(history.draftSeeds.length, 0);
assert.equal(history.evidence[0].successfulDraft, false);
pass('a cancelled/error draft never becomes a reused successful draft merely because its JSON looks complete');

write(path.join(attempt, 'draft.transport.json'), { exitCode: 0, cancelled: false, stderr: '', stdout: JSON.stringify({ status: 'SUCCESS', response: JSON.stringify({ translations: {} }) }) });
history = inspectCampaigns({ manifest, campaigns: [campaign], requestsRoot });
assert.equal(history.draftSeeds.length, 0);
pass('saved proposal must match its complete successful provider envelope and original field set');

write(path.join(attempt, 'draft.child.json'), { pid: process.pid, startIdentity: getProcessStartIdentity() });
assert.throws(() => inspectCampaigns({ manifest, campaigns: [campaign], requestsRoot }), /worker is still live/);
write(path.join(attempt, 'draft.child.json'), { pid: process.pid, startIdentity: 'old-process-identity' });
assert.doesNotThrow(() => inspectCampaigns({ manifest, campaigns: [campaign], requestsRoot }));
mkdirSync(path.join(campaign, 'controller.lock'));
assert.throws(() => inspectCampaigns({ manifest, campaigns: [campaign], requestsRoot }), /Stop and drain/);
pass('live old workers/controllers block regrouping; reused PID identities are not mistaken for live old workers');

write(path.join(fixtureRoot, 'docs/tutorial-localization/source.json'), manifest);
write(path.join(fixtureRoot, 'www/help', page.route, 'index.html'), html);
write(path.join(fixtureRoot, 'docs/tutorial-localization/translations/fr.json'), record);
const prepared = prepareSectionPlan({ root: fixtureRoot, locales: ['fr'], ...opts });
assert.equal(prepared.manifestFile.sha256, sha(readFileSync(path.join(fixtureRoot, 'docs/tutorial-localization/source.json'))));
assert.equal(prepared.sources[0].sha256, page.sourceHash);
assert.equal(prepared.accepted[0].sha256, sha(readFileSync(path.join(fixtureRoot, 'docs/tutorial-localization/translations/fr.json'))));
assert.equal(sectionPlanSummary(prepared).locales[0].missing, fields.length - 1);
const privateOutput = path.join(fixtureRoot, 'private', 'plan.json');
const output = writeSectionPlan(prepared, privateOutput);
assert.equal(statSync(privateOutput).mode & 0o777, 0o600);
assert.equal(statSync(path.dirname(privateOutput)).mode & 0o777, 0o700);
assert.equal(output.sha256, sha(readFileSync(privateOutput)));
assert.throws(() => writeSectionPlan(prepared, privateOutput), /fresh plan/);
assert.throws(() => writeSectionPlan(prepared, path.join(fixtureRoot, 'outside.json').replace('/tmp/scirepl-tutorial-section-', '/tmp/not-a-private-section-')), /private task temporary directory/);
pass('filesystem preparation pins manifest, English and accepted bytes and writes only explicitly requested private evidence');

const moduleFile = new URL('../scripts/tutorial_locale_section_plan.mjs', import.meta.url).href;
const imported = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(moduleFile)})`], { encoding: 'utf8' });
assert.equal(imported.status, 0); assert.equal(imported.stdout, ''); assert.equal(imported.stderr, '');
assert(!existsSync(path.join(fixtureRoot, 'controller-status.json')));
pass('pure import does not write, print, run a worker, or acquire a queue slot');

console.log(`${passes}/${passes} section-plan checks passed; no model requests were made.`);
