// Operator-selected finite recovery. Loading/status is read-only; verification
// claims each selected chunk once immediately before its next provider phase.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, lstatSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { ROOT, LOCALES, readManifest, readLocale, localeFile, sha } from './tutorial_locale_lib.mjs';
import { parseTransport } from './tutorial_translation_transport.mjs';

const context = new WeakMap();
const originalInventoryHash = '0a68ca2cac1bcd7caa77d3bd7804aa098eabe18ab03734b3878b37bcd5aa27d4';
function bytes(file) {
  const stat = lstatSync(file);
  assert(stat.isFile() && !stat.isSymbolicLink(), 'Recovery evidence must be a regular file');
  return readFileSync(file);
}
function pinned(file, expected) {
  assert(/^[a-f0-9]{64}$/.test(expected), 'Missing recovery evidence hash');
  const data = bytes(file);
  assert.equal(sha(data), expected, 'Recovery evidence changed');
  return data;
}
function assertSource(manifest, sourceFileHash) {
  pinned(path.join(ROOT, 'docs/tutorial-localization/source.json'), sourceFileHash);
  assert.equal(readManifest().manifestHash, manifest.manifestHash, 'Recovery source manifest changed');
  for (const page of manifest.pages) pinned(path.join(ROOT, 'www/help', page.route, 'index.html'), page.sourceHash);
}
function assertUnaccepted(entry, request) {
  if (!existsSync(localeFile(entry.locale))) return;
  const current = readLocale(entry.locale);
  for (const field of request.fields) assert(!(field.id in current.translations), 'Recovery would replace an already accepted field');
}
function evidence(entry) {
  assert(Array.isArray(entry.evidence), 'Missing audited phase evidence');
  for (const origin of entry.evidence) {
    const root = path.resolve(origin.campaign);
    assert(!existsSync(path.join(root, 'controller.lock')), 'A prior campaign still owns its controller lock');
    for (const row of origin.files) {
      assert(typeof row.file === 'string' && (path.isAbsolute(row.file) || path.basename(row.file) === row.file), 'Invalid relative evidence file');
      const file = path.isAbsolute(row.file) ? path.resolve(row.file) : path.join(root, entry.locale, entry.chunk, row.file);
      assert(file.startsWith(root + path.sep), 'Evidence outside its original campaign');
      pinned(file, row.sha256);
    }
  }
}
function reusableDraft(entry) {
  const source = entry.draftSource;
  assert(source && source.locale === entry.locale && source.chunk === entry.chunk, 'Draft belongs to another chunk');
  const dir = path.join(source.campaign, entry.locale, entry.chunk);
  const transport = JSON.parse(pinned(path.join(dir, 'draft.transport.json'), source.transportSha256));
  assert.equal(transport.unexpectedFiles?.length, 0, 'Original draft worker wrote files');
  assert(!transport.cliTimeoutWarning, 'Original draft reported a timeout');
  const draft = parseTransport(transport);
  const proposal = JSON.parse(pinned(path.join(dir, 'draft.proposal.json'), source.proposalSha256));
  assert.deepEqual(draft, proposal, 'Saved draft differs from successful final transport');
  assert.equal(sha(JSON.stringify(draft)), source.canonicalDraftHash, 'Draft content changed');
  return draft;
}

export function loadRecoveryPlan(planFile, { manifest, requestsRoot, campaign, claimsRoot } = {}) {
  assert(manifest && requestsRoot && campaign, 'Recovery requires frozen source, requests and a new campaign');
  const planBytes = bytes(planFile), planHash = sha(planBytes), plan = JSON.parse(planBytes);
  assert.equal(plan.schema, 1);
  assert.equal(plan.kind, 'finite-translation-completion');
  assert.equal(plan.manifestHash, manifest.manifestHash);
  assert.equal(path.resolve(plan.requestsRoot), path.resolve(requestsRoot));
  assert(Array.isArray(plan.campaigns) && plan.campaigns.length && Array.isArray(plan.jobs) && plan.jobs.length);
  assert(!plan.campaigns.some(origin => path.resolve(origin) === path.resolve(campaign)), 'Recovery needs a new campaign');
  for (const origin of plan.campaigns) assert(!existsSync(path.join(origin, 'controller.lock')), 'A prior campaign still owns a controller');
  assertSource(manifest, plan.sourceFileHash);
  // This recovery completes the original 552-request authorization, not a new
  // source inventory or an expanded model campaign.
  const inventory = LOCALES.filter(locale => locale !== 'en').flatMap(locale => readdirSync(path.join(requestsRoot, locale))
    .filter(name => /^\d{2}\.json$/.test(name)).sort().map(name => ({ locale, name, hash: sha(bytes(path.join(requestsRoot, locale, name))) })));
  assert.equal(inventory.length, 552);
  assert.equal(sha(JSON.stringify(inventory)), originalInventoryHash, 'Original sanitized request inventory changed');
  const selected = new Map(); let drafts = 0;
  for (const entry of plan.jobs) {
    assert(LOCALES.includes(entry.locale) && entry.locale !== 'en' && /^\d{2}$/.test(entry.chunk));
    const key = entry.locale + '/' + entry.chunk;
    assert(!selected.has(key), 'Duplicate recovery chunk');
    assert(['fresh-draft-and-review', 'review-existing-draft'].includes(entry.action));
    const count = entry.action === 'review-existing-draft' ? 0 : 1;
    assert.deepEqual(entry.maximumNewCalls, { draft: count, freshReview: 1, repair: 0 });
    const requestFile = path.join(requestsRoot, entry.locale, entry.chunk + '.json');
    assert.equal(path.resolve(entry.request.path), path.resolve(requestFile));
    const request = JSON.parse(pinned(requestFile, entry.request.sha256));
    assert.equal(request.locale, entry.locale); assert.equal(request.manifestHash, manifest.manifestHash);
    evidence(entry); assertUnaccepted(entry, request);
    if (!count) reusableDraft(entry);
    else assert(!entry.draftSource, 'Never regenerate a successfully preserved draft');
    drafts += count;
    context.set(entry, { manifest, planFile, planHash, sourceFileHash: plan.sourceFileHash, requestFile,
      campaign: path.resolve(campaign), claimsRoot: claimsRoot || path.join(tmpdir(), 'scirepl-tutorial-recovery-claims', sha(ROOT)) });
    selected.set(key, entry);
  }
  assert.deepEqual(plan.maximumNewCalls, { draft: drafts, freshReview: selected.size, total: drafts + selected.size, repair: 0 });
  return selected;
}

export function recheckRecoveryJob(entry, job) {
  const config = context.get(entry);
  assert(config, 'Recovery entry was not verified from its plan');
  pinned(config.planFile, config.planHash);
  assertSource(config.manifest, config.sourceFileHash);
  assert.equal(job.locale, entry.locale); assert.equal(job.chunk, entry.chunk);
  assert.equal(job.requestHash, entry.request.sha256);
  const request = JSON.parse(pinned(config.requestFile, entry.request.sha256));
  assert.deepEqual(job.request, request);
  evidence(entry); assertUnaccepted(entry, request);
  const draft = entry.action === 'review-existing-draft' ? reusableDraft(entry) : null;
  return { draft, provenance: { planHash: config.planHash, action: entry.action, reason: entry.reason,
    ...(entry.draftSource ? { originalDraft: entry.draftSource } : {}) },
  requestCounts: { draft: draft ? 0 : 1, freshReview: 1, repair: 0 } };
}

export function verifyRecoveryJob(entry, job) {
  const checked = recheckRecoveryJob(entry, job), config = context.get(entry);
  const claimDir = path.join(config.claimsRoot, config.planHash);
  mkdirSync(claimDir, { recursive: true, mode: 0o700 });
  // An exclusive permanent claim makes this recovery generation at-most-once,
  // even if an operator accidentally starts the same plan in another job.
  writeFileSync(path.join(claimDir, entry.locale + '-' + entry.chunk + '.json'), JSON.stringify({
    schema: 1, planHash: config.planHash, campaign: config.campaign, locale: entry.locale,
    chunk: entry.chunk, action: entry.action, nonce: randomUUID(), at: new Date().toISOString(),
  }) + '\n', { flag: 'wx', mode: 0o600 });
  return checked;
}
