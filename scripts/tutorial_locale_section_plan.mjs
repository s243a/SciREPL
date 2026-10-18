// Read-only preparation for coherent, consecutive tutorial translation turns.
// Importing this module never starts work, claims a slot, or writes a file.
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, LOCALES, scan, sha, validateText, validateKeep } from './tutorial_locale_lib.mjs';
import { inspectLocaleRecord } from './tutorial_locale_status.mjs';
import { parseTransport } from './tutorial_translation_transport.mjs';
import { getProcessStartIdentity } from './tutorial_translation_queue.mjs';

const plain = value => value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const canonical = value => JSON.stringify(value);
const read = file => {
  assert(lstatSync(file).isFile() && !lstatSync(file).isSymbolicLink(), 'Planning inputs must be regular files');
  const bytes = readFileSync(file);
  return { file: path.resolve(file), sha256: sha(bytes), bytes };
};
const json = file => ({ ...read(file), value: JSON.parse(readFileSync(file, 'utf8')) });
const countChars = fields => fields.reduce((sum, field) => sum + field.text.length, 0);
const headingText = (html, node) => html.slice(node.innerStart, node.innerEnd).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();

export function requestField(field) {
  return { id: field.id, text: field.text, context: field.tag || 'shared navigation',
    protected: (field.protectedSpans || []).map(span => ({ token: span.token,
      meaning: span.kind === 'ui' || span.kind === 'ui-text' ? `App control: ${span.label}; localized automatically`
        : span.kind === 'html' ? 'Protected formatting or executable example; do not edit' : span.value })) };
}

// H2 is the normal conversational turn boundary. H3 boundaries divide a long
// section before the final fallback of splitting between complete prose fields.
// There is deliberately no small field-count limit.
export function classifySections(page, html, { maxChars = 15000, minChars = 5000 } = {}) {
  assert(Number.isSafeInteger(maxChars) && maxChars >= 500 && maxChars <= 30000, 'Invalid section character budget');
  assert(Number.isSafeInteger(minChars) && minChars >= 0 && minChars <= maxChars / 2, 'Invalid tiny-section threshold');
  assert.equal(sha(html), page.sourceHash, 'Frozen page source changed');
  const nodes = scan(html).tokens.filter(token => token.type === 'tag' && token.node && /^h[23]$/.test(token.tag)).map(token => token.node);
  const h2 = nodes.filter(node => node.tag === 'h2');
  const boundaries = [{ start: 0, heading: 'Page introduction' }, ...h2.map(node => ({ start: node.start, heading: headingText(html, node) }))];
  const parts = [];
  for (let i = 0; i < boundaries.length; i++) {
    const beginning = boundaries[i], end = boundaries[i + 1]?.start ?? html.length;
    const fields = page.fields.filter(field => field.start >= beginning.start && field.start < end);
    if (!fields.length) continue;
    const subheads = nodes.filter(node => node.tag === 'h3' && node.start > beginning.start && node.start < end);
    const cuts = countChars(fields) > maxChars ? [beginning, ...subheads.map(node => ({ start: node.start, heading: headingText(html, node) }))] : [beginning];
    for (let j = 0; j < cuts.length; j++) {
      const until = cuts[j + 1]?.start ?? end;
      const group = fields.filter(field => field.start >= cuts[j].start && field.start < until);
      let current = [];
      const push = () => { if (current.length) parts.push({ heading: cuts[j].heading, sourceStart: current[0].start, sourceEnd: current.at(-1).end, fields: current }); current = []; };
      for (const field of group) {
        assert(field.text.length <= maxChars, 'One prose field exceeds the section budget');
        if (current.length && countChars(current) + field.text.length > maxChars) push();
        current.push(field);
      }
      push();
    }
  }
  // Merge short adjacent headings, not unrelated pieces from different pages.
  const merged = [];
  for (const part of parts) {
    const previous = merged.at(-1);
    if (previous && (countChars(previous.fields) < minChars || countChars(part.fields) < minChars)
        && countChars(previous.fields) + countChars(part.fields) <= maxChars) {
      previous.heading += ' / ' + part.heading;
      previous.sourceEnd = part.sourceEnd; previous.fields.push(...part.fields);
    } else merged.push({ ...part, fields: [...part.fields] });
  }
  assert.deepEqual(merged.flatMap(part => part.fields.map(field => field.id)), page.fields.map(field => field.id), 'Section boundaries lost or duplicated source fields');
  return merged.map((part, index) => ({ ...part, id: `${page.route.replaceAll('/', '.')}.section.${String(index + 1).padStart(2, '0')}`, sourceChars: countChars(part.fields) }));
}

// A successful old draft is review input, not an accepted translation. Failed
// review envelopes are never interpreted as translation or completion evidence.
export function inspectCampaigns({ manifest, campaigns = [], requestsRoot }) {
  const fields = new Map([...manifest.pages.flatMap(page => page.fields), ...manifest.chrome].map(field => [field.id, field]));
  const evidence = [], draftSeeds = [];
  for (const campaign of campaigns.map(value => path.resolve(value)).sort()) {
    assert(!existsSync(path.join(campaign, 'controller.lock')), 'Stop and drain the old campaign before preparing a replacement');
    for (const locale of LOCALES.filter(value => value !== 'en')) {
      const localeDir = path.join(campaign, locale);
      if (!existsSync(localeDir)) continue;
      for (const chunk of readdirSync(localeDir).filter(value => /^\d{2}$/.test(value)).sort()) {
        const dir = path.join(localeDir, chunk), startedFile = path.join(dir, 'started.json');
        if (!existsSync(startedFile)) continue;
        const started = json(startedFile);
        assert.equal(started.value.manifestHash, manifest.manifestHash, 'Old attempt has different source');
        const request = json(path.join(requestsRoot, locale, chunk + '.json'));
        assert.equal(started.value.requestHash, request.sha256, 'Old request bytes changed');
        assert.equal(request.value.locale, locale); assert.equal(request.value.manifestHash, manifest.manifestHash);
        assert(Array.isArray(request.value.fields) && request.value.fields.length, 'Old request has no fields');
        assert.equal(new Set(request.value.fields.map(field => field.id)).size, request.value.fields.length, 'Old request repeats fields');
        for (const field of request.value.fields) assert.equal(field.text, fields.get(field.id)?.text, 'Old request does not match frozen fields');
        const files = readdirSync(dir).filter(name => /^(?:started|completed|accepted|failed|draft\.(?:queued|dispatched|child|status|transport|proposal|reused)|review\.(?:queued|dispatched|child|status|transport|proposal))\.json$/.test(name)).sort().map(name => {
          const input = read(path.join(dir, name)); return { file: input.file, sha256: input.sha256 };
        });
        for (const phase of ['draft', 'review']) {
          const workerFile = path.join(dir, phase + '.child.json');
          if (!existsSync(workerFile)) continue;
          const worker = json(workerFile).value;
          if (!Number.isSafeInteger(worker.pid) || worker.pid <= 0) continue;
          let alive = false;
          try { process.kill(worker.pid, 0); alive = true; } catch (error) { if (error.code !== 'ESRCH') alive = true; }
          if (alive) {
            let sameIdentity = true;
            try { if (worker.startIdentity) sameIdentity = getProcessStartIdentity(worker.pid) === worker.startIdentity; } catch { /* Unknown ownership is a blocker. */ }
            assert(!sameIdentity, 'A prior campaign worker is still live; drain it before regrouping');
          }
        }
        const item = { campaign, locale, chunk, request: { file: request.file, sha256: request.sha256 }, fieldIds: request.value.fields.map(field => field.id), files,
          completed: existsSync(path.join(dir, 'completed.json')), draftDispatched: existsSync(path.join(dir, 'draft.dispatched.json')),
          reviewDispatched: existsSync(path.join(dir, 'review.dispatched.json')), successfulDraft: false };
        const transportFile = path.join(dir, 'draft.transport.json'), proposalFile = path.join(dir, 'draft.proposal.json');
        if (existsSync(transportFile) && existsSync(proposalFile)) {
          const transport = json(transportFile), proposal = json(proposalFile);
          let candidate = null;
          try {
            candidate = parseTransport(transport.value);
            assert.deepEqual(candidate, proposal.value, 'Saved draft differs from the successful transport');
            assert.deepEqual(transport.value.unexpectedFiles || [], [], 'Draft wrote files');
            assert(plain(candidate) && plain(candidate.translations), 'Draft response is not a translation object');
            assert.deepEqual(Object.keys(candidate.translations).sort(), request.value.fields.map(field => field.id).sort(), 'Draft has an incomplete field set');
            assert(Object.values(candidate.translations).every(value => typeof value === 'string' && value.trim()), 'Draft has a non-string or empty value');
            item.successfulDraft = true;
          } catch { candidate = null; }
          if (candidate) for (const field of request.value.fields) {
            const source = { campaign, chunk, transport: { file: transport.file, sha256: transport.sha256 }, proposal: { file: proposal.file, sha256: proposal.sha256 } };
            let draftValid = true;
            try {
              const keep = candidate.keptFields?.[field.id];
              if (keep !== undefined) validateKeep(fields.get(field.id), keep);
              validateText(fields.get(field.id), candidate.translations[field.id], { allowSource: Boolean(keep) });
            } catch { draftValid = false; }
            draftSeeds.push({ locale, id: field.id, text: field.text, translation: candidate.translations[field.id], draftValid, source });
          }
        }
        // Reused draft proposals have no local provider envelope. Their original
        // transport must be included as another campaign; never bless the copy.
        item.reusedDraft = existsSync(path.join(dir, 'draft.reused.json'));
        evidence.push(item);
      }
    }
  }
  return { evidence, draftSeeds };
}

export function buildSectionPlan({ manifest, htmlByRoute, records = {}, draftSeeds = [], campaignEvidence = [],
  locales = LOCALES.filter(value => value !== 'en'), maxChars = 15000, minChars = 5000, pins = {} }) {
  assert.equal(new Set(locales).size, locales.length, 'Duplicate locale');
  assert(locales.every(locale => LOCALES.includes(locale) && locale !== 'en'), 'Invalid target locale');
  const allFields = [...manifest.pages.flatMap(page => page.fields), ...manifest.chrome];
  assert.equal(new Set(allFields.map(field => field.id)).size, allFields.length, 'Manifest has duplicate fields');
  const layout = manifest.pages.map(page => ({ route: page.route, parts: classifySections(page, htmlByRoute[page.route], { maxChars, minChars }) }));
  const shared = { route: '@chrome', parts: [{ id: 'chrome.section.01', heading: 'Shared language navigation and translation notice', sourceStart: null, sourceEnd: null, fields: manifest.chrome, sourceChars: countChars(manifest.chrome) }] };
  const result = [];
  for (const locale of locales) {
    const record = records[locale] || null, inspected = inspectLocaleRecord(manifest, locale, record);
    assert(!inspected.invalid.length && !inspected.unknown.length && !inspected.unreviewed.length, 'Existing accepted translations must be valid and reviewed');
    const values = record?.translations || {}, missing = new Set(inspected.missing);
    const seeds = new Map();
    // Prefer the first successful attempt deterministically and inventory all
    // other attempts, without regenerating any previously successful draft.
    for (const seed of draftSeeds.filter(value => value.locale === locale)) if (missing.has(seed.id) && !seeds.has(seed.id)) seeds.set(seed.id, seed);
    const pages = [];
    for (const page of [...layout, shared]) {
      const sourceFields = page.parts.flatMap(part => part.fields);
      const context = sourceFields.filter(field => field.id in values).map(field => ({ id: field.id, text: field.text, translation: values[field.id], readonly: true }));
      const pageSeeds = sourceFields.filter(field => seeds.has(field.id)).map(field => seeds.get(field.id));
      const sections = [];
      for (const part of page.parts) {
        const selected = part.fields.filter(field => missing.has(field.id) && !seeds.has(field.id));
        if (!selected.length) continue;
        const request = { schema: 1, locale, sourceLocale: 'en', manifestHash: manifest.manifestHash, route: page.route,
          sectionId: part.id, fields: selected.map(requestField) };
        sections.push({ id: part.id, heading: part.heading, sourceStart: part.sourceStart, sourceEnd: part.sourceEnd,
          sourceChars: countChars(selected), fieldIds: selected.map(field => field.id), request, requestHash: sha(canonical(request)) });
      }
      if (sections.length || pageSeeds.length) pages.push({ route: page.route, context, draftSeeds: pageSeeds, sections });
    }
    const plannedIds = pages.flatMap(page => page.sections.flatMap(section => section.fieldIds));
    const seedIds = pages.flatMap(page => page.draftSeeds.map(seed => seed.id));
    assert.equal(new Set([...plannedIds, ...seedIds]).size, plannedIds.length + seedIds.length, 'Missing field selected twice');
    assert.deepEqual([...plannedIds, ...seedIds].sort(), [...missing].sort(), 'Every missing field must be planned or preserved as a successful draft');
    result.push({ locale, acceptedCount: allFields.length - missing.size, missingCount: missing.size,
      plannedCount: plannedIds.length, preservedDraftCount: seedIds.length, pages });
  }
  const plan = { schema: 1, kind: 'tutorial-coherent-section-plan', manifestHash: manifest.manifestHash,
    maximumSectionCharacters: maxChars, tinySectionCharacters: minChars, ...pins, campaignEvidence, locales: result };
  plan.planHash = sha(canonical(plan));
  return plan;
}

export function prepareSectionPlan({ root = ROOT, campaigns = [], requestsRoot = '/tmp/scirepl-tutorial-translation-requests-small-pilot-v3', locales, maxChars, minChars } = {}) {
  const manifestFile = json(path.join(root, 'docs/tutorial-localization/source.json')), manifest = manifestFile.value;
  const { manifestHash, ...unsigned } = manifest;
  assert.equal(sha(canonical(unsigned)), manifestHash, 'Frozen manifest semantic hash changed');
  const htmlByRoute = {}, sources = [], records = {}, accepted = [];
  for (const page of manifest.pages) {
    const source = read(path.join(root, 'www/help', page.route, 'index.html'));
    assert.equal(source.sha256, page.sourceHash, 'English source changed before section planning');
    htmlByRoute[page.route] = source.bytes.toString('utf8'); sources.push({ route: page.route, file: source.file, sha256: source.sha256 });
  }
  for (const locale of locales || LOCALES.filter(value => value !== 'en')) {
    const file = path.join(root, 'docs/tutorial-localization/translations', locale + '.json');
    if (!existsSync(file)) { accepted.push({ locale, file, sha256: null, count: 0 }); continue; }
    const record = json(file); records[locale] = record.value;
    accepted.push({ locale, file: record.file, sha256: record.sha256, count: Object.keys(record.value.translations || {}).length });
  }
  const history = inspectCampaigns({ manifest, campaigns, requestsRoot });
  return buildSectionPlan({ manifest, htmlByRoute, records, draftSeeds: history.draftSeeds, campaignEvidence: history.evidence, locales, maxChars, minChars,
    pins: { manifestFile: { file: manifestFile.file, sha256: manifestFile.sha256 }, sources, accepted } });
}

export function sectionPlanSummary(plan) {
  return { schema: plan.schema, planHash: plan.planHash, manifestHash: plan.manifestHash,
    locales: plan.locales.map(locale => ({ locale: locale.locale, accepted: locale.acceptedCount, missing: locale.missingCount,
      planned: locale.plannedCount, preservedDrafts: locale.preservedDraftCount, pages: locale.pages.length,
      sections: locale.pages.reduce((sum, page) => sum + page.sections.length, 0) })),
    evidenceAttempts: plan.campaignEvidence.length };
}

export function writeSectionPlan(plan, destination) {
  const file = path.resolve(destination), parent = path.dirname(file);
  assert(file.startsWith('/tmp/scirepl-tutorial-section-') && parent !== '/tmp', 'Raw section plans belong in a private task temporary directory');
  assert(!existsSync(file), 'Choose a fresh plan file; never replace evidence');
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true, mode: 0o700 });
  assert(lstatSync(parent).isDirectory() && !lstatSync(parent).isSymbolicLink(), 'Plan parent must be a regular private directory');
  assert.equal(lstatSync(parent).mode & 0o077, 0, 'Plan parent must not expose raw requests to other users');
  writeFileSync(file, JSON.stringify(plan, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return { file, sha256: sha(readFileSync(file)) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), campaigns = [], locales = [];
  let output, requestsRoot, maxChars, minChars;
  for (let i = 0; i < args.length; i++) {
    const option = args[i], value = args[++i];
    assert(value && !value.startsWith('--'), 'Every planner option needs a value');
    if (option === '--campaign') campaigns.push(value);
    else if (option === '--locale') locales.push(value);
    else if (option === '--requests') requestsRoot = value;
    else if (option === '--output') output = value;
    else if (option === '--max-chars') maxChars = Number(value);
    else if (option === '--min-chars') minChars = Number(value);
    else throw new Error('Unknown section planner option');
  }
  const plan = prepareSectionPlan({ campaigns, locales: locales.length ? locales : undefined, requestsRoot, maxChars, minChars });
  console.log(JSON.stringify({ ...sectionPlanSummary(plan), ...(output ? { output: writeSectionPlan(plan, output) } : { mode: 'read-only-preparation' }) }, null, 2));
}
