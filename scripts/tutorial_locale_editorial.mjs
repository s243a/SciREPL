// Controller-owned rendering of operational identifiers, deliberately separate
// from model proposals/approvals and native-language review. Never edits source,
// translation records, requests, or the live translation controller.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT, DATA, sha, decode, escapeText, renderField, validateText, validateKeep } from './tutorial_locale_lib.mjs';

const FILE = path.join(DATA, 'operational-names.json');
export function readEditorialInventory() { return JSON.parse(readFileSync(FILE, 'utf8')); }
const tokens = value => value.match(/\{\{P\d{3}\}\}/g) || [];
const CONTROL_CORRECTIONS = {
  'fr/tutorials.0044': {
    key: 'aiSecurity.levelOpen', en: 'Open', localized: 'Ouvert',
    before: "le préréglage d'agent Open", after: "le préréglage d'agent Ouvert",
    unexpected: /\bOpen\b/, sourceFragment: 'the Open agent preset'
  },
  'fr/interface.appearance.0075': {
    key: 'chips.ownRow', en: 'Own row', localized: 'Ligne dédiée', token: '{{P002}}',
    before: 'Les valeurs par défaut sont Propre rangée en portrait',
    after: 'Les valeurs par défaut sont Ligne dédiée en portrait',
    unexpected: /Propre rangée/, sourceFragment: 'The defaults are Own row in portrait'
  },
  'bn/tutorials.0044': {
    key: 'aiSecurity.levelOpen', en: 'Open', localized: 'উন্মুক্ত',
    before: 'ওপেন এজেন্ট প্রিসেট', after: 'উন্মুক্ত এজেন্ট প্রিসেট',
    unexpected: /ওপেন এজেন্ট প্রিসেট/, sourceFragment: 'the Open agent preset',
    glossaryField: 'pro.ai.tutorial.0082'
  },
  'hi/tutorials.0044': {
    key: 'aiSecurity.levelOpen', en: 'Open', localized: 'खुला',
    before: 'ओपन एजेंट प्रीसेट', after: 'खुला एजेंट प्रीसेट',
    unexpected: /ओपन एजेंट प्रीसेट/, sourceFragment: 'the Open agent preset',
    glossaryField: 'pro.ai.tutorial.0082'
  },
  'ja/tutorials.0044': {
    key: 'aiSecurity.levelOpen', en: 'Open', localized: 'オープン',
    before: 'Openエージェントプリセット', after: 'オープンエージェントプリセット',
    unexpected: /\bOpen\b/, sourceFragment: 'the Open agent preset',
    glossaryField: 'pro.ai.tutorial.0082', glossaryToken: '{{P000}}'
  },
  'ko/tutorials.0044': {
    key: 'aiSecurity.levelOpen', en: 'Open', localized: '열림',
    before: 'Open 에이전트 프리셋', after: '열림 에이전트 프리셋',
    unexpected: /\bOpen\b/, sourceFragment: 'the Open agent preset',
    glossaryField: 'pro.ai.tutorial.0082', glossaryToken: '{{P000}}'
  },
  'de/tutorials.0044': {
    key: 'aiSecurity.levelOpen', en: 'Open', localized: 'Offen',
    before: 'die Open-Agent-Voreinstellung', after: 'die Agent-Voreinstellung „Offen“',
    unexpected: /\bOpen\b/, sourceFragment: 'the Open agent preset',
    glossaryField: 'pro.ai.tutorial.0082', glossaryToken: '{{P000}}'
  },
  'es/tutorials.0044': {
    key: 'aiSecurity.levelOpen', en: 'Open', localized: 'Abierto',
    before: 'el ajuste predeterminado de agente Open', after: 'el ajuste predeterminado de agente Abierto',
    unexpected: /\bOpen\b/, sourceFragment: 'the Open agent preset',
    glossaryField: 'pro.ai.tutorial.0082', glossaryToken: '{{P000}}'
  },
  'id/tutorials.0044': {
    key: 'aiSecurity.levelOpen', en: 'Open', localized: 'Terbuka',
    before: 'prasetel agen Open', after: 'prasetel agen Terbuka',
    unexpected: /\bOpen\b/, sourceFragment: 'the Open agent preset',
    glossaryField: 'pro.ai.tutorial.0082', glossaryToken: '{{P000}}'
  },
  'pt-BR/tutorials.0044': {
    key: 'aiSecurity.levelOpen', en: 'Open', localized: 'Aberto',
    before: 'predefinição de agente Open', after: 'predefinição de agente Aberto',
    unexpected: /\bOpen\b/, sourceFragment: 'the Open agent preset',
    glossaryField: 'pro.ai.tutorial.0082', glossaryToken: '{{P000}}'
  },
  'de/files-export.tutorial.0076': {
    key: 'menu.importFileEGSrwb',
    en: '📂 Import File (e.g. .srwb, .ipynb, .csv, .py, .zip)',
    localized: '📂 Datei importieren (z. B. .srwb, .ipynb, .csv, .py, .zip)',
    before: '→ Import File', after: '→ Datei importieren',
    unexpected: /\bImport File\b/, sourceFragment: 'Menu → Import File',
    glossaryField: 'workbooks.import.0037', glossaryToken: '{{P000}}'
  }
};

export function verifyEditorialInventory(manifest, inventory = readEditorialInventory()) {
  assert.equal(inventory.manifestHash, manifest.manifestHash, 'Operational-name inventory has a different source manifest');
  assert.equal(inventory.occurrences.length, 18, 'Only the explicitly approved operational occurrences may render');
  const fields = new Map(manifest.pages.flatMap(page => page.fields).map(field => [field.id, field]));
  const approvedNames = new Set(['CSV Basics', 'CSV Basics: Seedling Heights', 'Markov Groups', 'Markov Groups: A Random Walk on Cube Moves', "Simpson's Paradox", "Simpson's Paradox: When Every Group Disagrees with the Total", 'Workbook Graphics', 'Named Cell Interop', 'English']);
  for (const asset of inventory.localCompanions) {
    assert.ok(asset.source.startsWith('www/help/') && !asset.source.includes('..'), 'Companion provenance must be scoped to public help assets');
    const bytes = readFileSync(path.join(ROOT, asset.source));
    assert.equal(sha(bytes), asset.sha256, 'English companion bytes changed; review the operational inventory');
    assert.equal(JSON.parse(bytes).notebook.name, asset.notebookName, 'English companion title does not match');
  }
  const endonym = JSON.parse(readFileSync(path.join(ROOT, inventory.englishLanguageOption.localeSource), 'utf8')).locales.find(locale => locale.code === 'en')?.endonym;
  assert.equal(endonym, 'English', 'The app English language option has changed');
  for (const row of inventory.occurrences) {
    const field = fields.get(row.fieldId);
    assert.ok(field, 'Unknown operational field');
    assert.equal(field.sourceHash, row.sourceHash, 'Operational source field changed');
    assert.ok(approvedNames.has(row.identifier), 'Unapproved operational identifier');
    if (row.wholeLabel) {
      assert.equal(row.fieldId, 'workbooks.tutorial.0067', 'Whole-field override is permitted only for the one verified title label');
      assert.equal(field.tag, 'strong');
      assert.equal(field.text, row.sourceText); assert.equal(decode(field.source).trim(), row.identifier);
    } else {
      const spans = new Map(field.protectedSpans.map(span => [span.token, span]));
      assert.match(spans.get(row.openToken)?.value || '', /^<strong(?:\s[^>]*)?>$/i, 'Operational span must start at its original strong token');
      assert.match(spans.get(row.closeToken)?.value || '', /^<\/strong\s*>$/i, 'Operational span must end at its original strong token');
      assert.equal(field.text.split(row.openToken).length, 2); assert.equal(field.text.split(row.closeToken).length, 2);
      const inner = field.text.slice(field.text.indexOf(row.openToken) + row.openToken.length, field.text.indexOf(row.closeToken));
      assert.equal(inner, row.innerTemplate, 'Operational source inner template changed');
      const literal = inner.replace(/\{\{P\d{3}\}\}/g, token => spans.get(token)?.value || token);
      assert.equal(decode(literal).trim(), row.identifier, 'Inner template does not name the verified identifier');
    }
  }
  assert.equal(inventory.controlCorrections.length, 11, 'Only the eleven explicitly approved control fragments may be corrected');
  assert.equal(new Set(inventory.controlCorrections.map(row => row.locale + '/' + row.fieldId)).size, 11, 'Duplicate locale/field control correction');
  for (const row of inventory.controlCorrections) {
    const approved = CONTROL_CORRECTIONS[row.locale + '/' + row.fieldId];
    assert.ok(approved, 'Unapproved control correction');
    assert.equal(row.controlKey, approved.key); assert.equal(row.glossaryField, approved.glossaryField);
    assert.equal(row.glossaryToken, approved.glossaryToken);
    assert.equal(row.controlToken, approved.token); assert.equal(row.sourceFragment, approved.sourceFragment);
    assert.equal(fields.get(row.fieldId)?.sourceHash, row.sourceHash);
    assert.ok(fields.get(row.fieldId)?.source.includes(row.sourceFragment));
    assert.equal(row.before, approved.before, 'Only the approved exact locale/field fragment may be corrected');
  }
  return inventory;
}

export function restoreOperationalNames(field, translated, locale, manifest, { keepReason, inventory = readEditorialInventory() } = {}) {
  if (keepReason !== undefined) validateKeep(field, keepReason);
  validateText(field, translated, { allowSource: locale === 'en' || Boolean(keepReason) });
  const expected = manifest.pages.flatMap(page => page.fields).find(candidate => candidate.id === field.id);
  assert.ok(expected); assert.equal(field.sourceHash, expected.sourceHash); assert.equal(sha(field.source), field.sourceHash); assert.equal(field.text, expected.text);
  if (locale === 'en') return { text: translated, wholeLiteral: null, corrections: [] };
  let text = translated, wholeLiteral = null;
  const corrections = [];
  for (const row of inventory.occurrences.filter(row => row.fieldId === field.id)) {
    assert.equal(row.sourceHash, field.sourceHash);
    const before = text;
    if (row.wholeLabel) {
      assert.equal(row.fieldId, 'workbooks.tutorial.0067'); assert.equal(field.tag, 'strong');
      assert.equal(field.text, row.sourceText); assert.equal(decode(field.source).trim(), row.identifier);
      wholeLiteral = row.identifier;
    } else {
      const spans = new Map(field.protectedSpans.map(span => [span.token, span]));
      assert.match(spans.get(row.openToken)?.value || '', /^<strong(?:\s[^>]*)?>$/i);
      assert.match(spans.get(row.closeToken)?.value || '', /^<\/strong\s*>$/i);
      const sourceStart = field.text.indexOf(row.openToken) + row.openToken.length, sourceEnd = field.text.indexOf(row.closeToken);
      assert.equal(field.text.slice(sourceStart, sourceEnd), row.innerTemplate, 'Operational source template changed');
      const start = text.indexOf(row.openToken) + row.openToken.length, end = text.indexOf(row.closeToken);
      assert.ok(start >= row.openToken.length && end >= start, 'Operational boundaries missing');
      assert.deepEqual(tokens(text.slice(start, end)), tokens(row.innerTemplate), 'Nested protected placeholder order changed');
      text = text.slice(0, start) + row.innerTemplate + text.slice(end);
    }
    assert.deepEqual(tokens(text), tokens(translated), 'Operational restoration changed protected tokens');
    corrections.push({ fieldId: field.id, kind: row.wholeLabel ? 'verified whole-label identifier' : 'verified label span', identifier: row.identifier, sourceHash: field.sourceHash, changed: row.wholeLabel ? translated !== row.identifier : text !== before, beforeHash: sha(before), afterHash: sha(row.wholeLabel ? row.identifier : text), protectedTokensPreserved: true, directionalIsolation: locale === 'ar' ? 'LTR English identifier' : null });
  }
  for (const row of inventory.controlCorrections.filter(row => row.fieldId === field.id && row.locale === locale)) {
    const approved = CONTROL_CORRECTIONS[row.locale + '/' + row.fieldId]; assert.ok(approved);
    assert.equal(row.before, approved.before); assert.equal(row.controlKey, approved.key);
    assert.equal(row.sourceHash, field.sourceHash); assert.equal(row.sourceFragment, approved.sourceFragment);
    assert.ok(field.source.includes(row.sourceFragment));
    assert.equal(row.glossaryField, approved.glossaryField); assert.equal(row.glossaryToken, approved.glossaryToken);
    const glossary = (row.controlToken
      ? field.protectedSpans.find(span => span.token === row.controlToken)
      : manifest.pages.flatMap(page => page.fields).filter(candidate => !row.glossaryField || candidate.id === row.glossaryField).flatMap(candidate => candidate.protectedSpans).find(span => span.glossary?.key === row.controlKey && (!row.glossaryToken || span.token === row.glossaryToken)))?.glossary;
    assert.equal(glossary?.key, approved.key); assert.equal(glossary?.values.en, approved.en); assert.equal(glossary?.values[locale], approved.localized);
    if (text.includes(row.before)) {
      assert.equal(text.split(row.before).length, 2, 'Approved control fragment occurs more than once');
      const before = text; text = text.replace(row.before, approved.after);
      corrections.push({ fieldId: field.id, kind: 'frozen app control label', controlKey: row.controlKey, identifier: glossary.values[locale], sourceHash: field.sourceHash, changed: true, beforeHash: sha(before), afterHash: sha(text), protectedTokensPreserved: true });
    } else assert.ok(!approved.unexpected.test(text), 'An unapproved control fragment needs controller editorial review');
  }
  // Never allow restoring a name to turn an untranslated English paragraph
  // into an accepted field. The one whole-label identifier is not prose.
  if (!wholeLiteral) validateText(field, text, { allowSource: locale === 'en' || Boolean(keepReason) });
  return { text, wholeLiteral, corrections };
}

// Trusted renderer markup, never worker-authored HTML. Only the approved
// operational strong interiors are direction-isolated in Arabic. Code/TeX and
// every existing protected token remain unchanged in the proposal and record.
export function renderEditorialField(field, restored, locale, { keepReason, inventory = readEditorialInventory() } = {}) {
  if (restored.wholeLiteral !== null) {
    const row = inventory.occurrences.find(row => row.fieldId === field.id && row.wholeLabel);
    assert.ok(row && field.id === 'workbooks.tutorial.0067' && field.tag === 'strong');
    assert.equal(restored.wholeLiteral, row.identifier); assert.equal(field.text, row.sourceText);
    return field.leading + `<bdi lang="en" dir="ltr">${escapeText(restored.wholeLiteral)}</bdi>` + field.trailing;
  }
  if (locale !== 'ar') return renderField(field, restored.text, locale, { keepReason });
  const renderable = structuredClone(field);
  for (const row of inventory.occurrences.filter(row => row.fieldId === field.id && !row.wholeLabel)) {
    assert.equal(field.sourceHash, row.sourceHash);
    const opening = renderable.protectedSpans.find(span => span.token === row.openToken);
    const closing = renderable.protectedSpans.find(span => span.token === row.closeToken);
    assert.equal(opening?.kind, 'html'); assert.equal(closing?.kind, 'html');
    assert.match(opening?.value || '', /^<strong(?:\s[^>]*)?>$/i);
    assert.match(closing?.value || '', /^<\/strong\s*>$/i);
    const start = restored.text.indexOf(row.openToken) + row.openToken.length;
    const end = restored.text.indexOf(row.closeToken);
    assert.equal(restored.text.slice(start, end), row.innerTemplate);
    opening.value += '<bdi lang="en" dir="ltr">'; closing.value = '</bdi>' + closing.value;
  }
  return renderField(renderable, restored.text, locale, { keepReason });
}

export function editorialReceipt(manifest, locale, corrections) {
  return { schema: 1, kind: 'controller-authored operational-name rendering', manifestHash: manifest.manifestHash, inventoryHash: sha(readFileSync(FILE)), locale, modelApproval: false, nativeLanguageApproval: false, nativeLanguageReview: locale === 'en' ? 'not applicable: source language' : 'pending', scope: 'Only the explicitly inventoried operational labels; model prose records remain unchanged.', corrections };
}
