import assert from 'node:assert/strict';
import { readManifest, readLocale } from '../scripts/tutorial_locale_lib.mjs';
import { readEditorialInventory, verifyEditorialInventory, restoreOperationalNames, renderEditorialField, editorialReceipt } from '../scripts/tutorial_locale_editorial.mjs';

const manifest = readManifest(), inventory = readEditorialInventory();
const fields = new Map(manifest.pages.flatMap(page => page.fields).map(field => [field.id, field]));
const tokenList = text => text.match(/\{\{P\d{3}\}\}/g) || [];
let checks = 0;
const verify = (name, fn) => { fn(); checks++; console.log('PASS ' + name); };
verify('exact 18-occurrence inventory matches frozen source and verified English companion names', () => assert.equal(verifyEditorialInventory(manifest, inventory).occurrences.length, 18));
verify('changed source templates, opening tags and field hashes are rejected', () => {
  const changed = structuredClone(inventory); changed.occurrences[0].innerTemplate += ' changed'; assert.throws(() => verifyEditorialInventory(manifest, changed));
  const stale = structuredClone(inventory); stale.occurrences[0].sourceHash = 'stale'; assert.throws(() => verifyEditorialInventory(manifest, stale));
  const field = structuredClone(fields.get('files-export.tutorial.0029'));
  field.protectedSpans.find(span => span.token === '{{P001}}').value = '<em>';
  assert.throws(() => restoreOperationalNames(field, 'Exemple : ' + field.text, 'fr', manifest, { inventory }));
});
verify('CSV name spans restore their exact inner templates without changing protected tokens', () => {
  const field = fields.get('files-export.tutorial.0029');
  const translated = 'Exemple : ' + field.text.replace('{{P005}} Basics', '{{P005}} notions').replace('{{P006}} Basics: Seedling Heights', '{{P006}} notions : hauteur des semis');
  const result = restoreOperationalNames(field, translated, 'fr', manifest, { inventory });
  assert.ok(result.text.includes('{{P001}}{{P005}} Basics{{P002}}'));
  assert.ok(result.text.includes('{{P003}}{{P006}} Basics: Seedling Heights{{P004}}'));
  assert.deepEqual(tokenList(result.text), tokenList(translated)); assert.equal(result.wholeLiteral, null);
});
verify('missing or duplicated protected boundaries cannot be restored', () => {
  const field = fields.get('files-export.tutorial.0029');
  assert.throws(() => restoreOperationalNames(field, ('Exemple : ' + field.text).replace('{{P001}}', ''), 'fr', manifest, { inventory }));
  assert.throws(() => restoreOperationalNames(field, 'Exemple : ' + field.text + '{{P005}}', 'fr', manifest, { inventory }));
});
verify('only the pinned strong title can be a whole operational label', () => {
  const field = fields.get('workbooks.tutorial.0067');
  const result = restoreOperationalNames(field, 'Groupes de Markov : une marche aléatoire sur les mouvements du cube', 'fr', manifest, { inventory });
  assert.equal(result.wholeLiteral, 'Markov Groups: A Random Walk on Cube Moves');
  assert.throws(() => restoreOperationalNames({ ...field, tag: 'p' }, 'Une traduction', 'fr', manifest, { inventory }));
});
verify('an uninventoried English paragraph gets no passthrough exemption', () => {
  const field = fields.get('tutorials.0001');
  assert.throws(() => restoreOperationalNames(field, field.text, 'fr', manifest, { inventory }));
  assert.throws(() => restoreOperationalNames(field, field.text, 'fr', manifest, { inventory, keepReason: 'Controller must not sanction copied English paragraphs.' }));
  const translated = 'Exemple : ' + field.text;
  assert.deepEqual(restoreOperationalNames(field, translated, 'fr', manifest, { inventory }), { text: translated, wholeLiteral: null, corrections: [] });
  const operational = fields.get('workbooks.graphics.0045');
  assert.throws(() => restoreOperationalNames(operational, operational.text.replace('Workbook Graphics', 'Images du classeur'), 'fr', manifest, { inventory }), /substantive prose was not translated/);
});
verify('the exact French Open preset fragment uses the frozen app label only', () => {
  const field = fields.get('tutorials.0044');
  const translated = "Commencez sans coût d'{{P000}}, configurez le préréglage d'agent Open, puis continuez.";
  const result = restoreOperationalNames(field, translated, 'fr', manifest, { inventory });
  assert.ok(result.text.includes("le préréglage d'agent Ouvert"));
  assert.deepEqual(tokenList(result.text), tokenList(translated));
  assert.throws(() => restoreOperationalNames(field, "Exemple d'{{P000}} avec un autre mode Open.", 'fr', manifest, { inventory }));
});
verify('the exact French Own row default uses the same frozen label as its strong control', () => {
  const field = fields.get('interface.appearance.0075');
  const translated = 'Exemple : ' + field.text.replace('The defaults are Own row in portrait', 'Les valeurs par défaut sont Propre rangée en portrait');
  const restored = restoreOperationalNames(field, translated, 'fr', manifest, { inventory });
  assert.ok(restored.text.includes('Les valeurs par défaut sont Ligne dédiée en portrait'));
  assert.deepEqual(tokenList(restored.text), tokenList(translated));
  const rendered = renderEditorialField(field, restored, 'fr', { inventory });
  assert.ok(rendered.includes('<strong>Ligne dédiée</strong>'));
  assert.throws(() => restoreOperationalNames(field, 'Exemple : ' + field.text + ' Propre rangée', 'fr', manifest, { inventory }));
  const changed = structuredClone(inventory); changed.controlCorrections[1].fieldId = 'tutorials.0001';
  assert.throws(() => verifyEditorialInventory(manifest, changed));
  const wrongKey = structuredClone(inventory); wrongKey.controlCorrections[1].controlKey = 'aiSecurity.levelOpen';
  assert.throws(() => verifyEditorialInventory(manifest, wrongKey));
});
verify('the exact Bengali Open preset uses its own frozen app label, not a generic replacement', () => {
  const field = fields.get('tutorials.0044');
  const translated = 'উদাহরণ : ' + field.text.replace('the Open agent preset', 'ওপেন এজেন্ট প্রিসেট');
  const restored = restoreOperationalNames(field, translated, 'bn', manifest, { inventory });
  assert.ok(restored.text.includes('উন্মুক্ত এজেন্ট প্রিসেট'));
  assert.deepEqual(tokenList(restored.text), tokenList(translated));
  assert.equal(restored.corrections[0].identifier, 'উন্মুক্ত');
  const outside = 'উদাহরণ : ' + fields.get('tutorials.0001').text + ' ওপেন এজেন্ট প্রিসেট';
  assert.equal(restoreOperationalNames(fields.get('tutorials.0001'), outside, 'bn', manifest, { inventory }).text, outside);
  const wrongLocale = structuredClone(inventory); wrongLocale.controlCorrections[2].locale = 'hi';
  assert.throws(() => verifyEditorialInventory(manifest, wrongLocale));
  const wrongGlossary = structuredClone(inventory); wrongGlossary.controlCorrections[2].glossaryField = 'pro.ai.tutorial.0001';
  assert.throws(() => verifyEditorialInventory(manifest, wrongGlossary));
});
verify('the exact Hindi Open preset uses the frozen Hindi label in this field only', () => {
  const field = fields.get('tutorials.0044');
  const translated = 'उदाहरण : ' + field.text.replace('the Open agent preset', 'ओपन एजेंट प्रीसेट');
  const restored = restoreOperationalNames(field, translated, 'hi', manifest, { inventory });
  assert.ok(restored.text.includes('खुला एजेंट प्रीसेट'));
  assert.deepEqual(tokenList(restored.text), tokenList(translated));
  assert.equal(restored.corrections[0].identifier, 'खुला');
  const outside = 'उदाहरण : ' + fields.get('tutorials.0001').text + ' ओपन एजेंट प्रीसेट';
  assert.equal(restoreOperationalNames(fields.get('tutorials.0001'), outside, 'hi', manifest, { inventory }).text, outside);
  const wrongLocale = structuredClone(inventory); wrongLocale.controlCorrections[3].locale = 'ja';
  assert.throws(() => verifyEditorialInventory(manifest, wrongLocale));
  const wrongFragment = structuredClone(inventory); wrongFragment.controlCorrections[3].before = 'ओपन';
  assert.throws(() => verifyEditorialInventory(manifest, wrongFragment));
});
const addedOpenCorrections = [
  { locale: 'ja', before: 'Openエージェントプリセット', after: 'オープンエージェントプリセット', label: 'オープン' },
  { locale: 'ko', before: 'Open 에이전트 프리셋', after: '열림 에이전트 프리셋', label: '열림' },
  { locale: 'de', before: 'die Open-Agent-Voreinstellung', after: 'die Agent-Voreinstellung „Offen“', label: 'Offen' },
  { locale: 'es', before: 'el ajuste predeterminado de agente Open', after: 'el ajuste predeterminado de agente Abierto', label: 'Abierto' },
  { locale: 'id', before: 'prasetel agen Open', after: 'prasetel agen Terbuka', label: 'Terbuka' },
  { locale: 'pt-BR', before: 'predefinição de agente Open', after: 'predefinição de agente Aberto', label: 'Aberto' }
];
for (const { locale, before, after, label } of addedOpenCorrections) {
  verify(`the accepted ${locale} Open fragment alone uses its pinned P000 app label without mutating the record`, () => {
    const field = fields.get('tutorials.0044'), record = readLocale(locale);
    const recordBefore = JSON.stringify(record), translated = record.translations[field.id];
    assert.equal(record.manifestHash, manifest.manifestHash);
    assert.equal(translated.split(before).length, 2, 'Accepted prose no longer has the explicitly reviewed fragment');
    const glossary = fields.get('pro.ai.tutorial.0082').protectedSpans.find(span => span.token === '{{P000}}').glossary;
    assert.equal(glossary.key, 'aiSecurity.levelOpen'); assert.equal(glossary.values[locale], label);
    const restored = restoreOperationalNames(field, translated, locale, manifest, { inventory });
    assert.equal(restored.text, translated.replace(before, after));
    assert.deepEqual(tokenList(restored.text), tokenList(translated));
    assert.equal(restored.corrections.length, 1); assert.equal(restored.corrections[0].identifier, label);
    assert.equal(JSON.stringify(record), recordBefore, 'Model translations and their receipts must stay unchanged');
    const html = renderEditorialField(field, restored, locale, { inventory });
    assert.ok(html.includes(after)); assert.ok(!html.includes(before));
    assert.equal(restoreOperationalNames(field, restored.text, locale, manifest, { inventory }).corrections.length, 0);
    assert.throws(() => restoreOperationalNames(field, translated + ' ' + before, locale, manifest, { inventory }), /more than once/);
    assert.throws(() => restoreOperationalNames(field, translated.replace(before, 'Unreviewed Open label'), locale, manifest, { inventory }), /editorial review/);
    const otherField = fields.get('tutorials.0001'), outside = 'Exemple : ' + otherField.text + ' ' + before;
    assert.equal(restoreOperationalNames(otherField, outside, locale, manifest, { inventory }).text, outside);
    assert.equal(restoreOperationalNames(field, translated, 'ar', manifest, { inventory }).text, translated);
    const drifted = structuredClone(manifest);
    drifted.pages.flatMap(page => page.fields).find(item => item.id === 'pro.ai.tutorial.0082').protectedSpans.find(span => span.token === '{{P000}}').glossary.values[locale] = 'Changed';
    assert.throws(() => restoreOperationalNames(field, translated, locale, drifted, { inventory }));
    const rowIndex = inventory.controlCorrections.findIndex(row => row.locale === locale && row.fieldId === field.id);
    for (const [key, value] of [['glossaryToken', '{{P001}}'], ['glossaryField', 'pro.ai.tutorial.0001'], ['sourceHash', 'stale'], ['before', 'Open']]) {
      const changed = structuredClone(inventory); changed.controlCorrections[rowIndex][key] = value;
      assert.throws(() => verifyEditorialInventory(manifest, changed));
      assert.throws(() => restoreOperationalNames(field, translated, locale, manifest, { inventory: changed }));
    }
  });
}
verify('the accepted German CSV menu path alone uses the pinned Import File app label', () => {
  const field = fields.get('files-export.tutorial.0076'), record = readLocale('de');
  const recordBefore = JSON.stringify(record), translated = record.translations[field.id];
  const before = '→ Import File', after = '→ Datei importieren';
  assert.equal(translated.split(before).length, 2);
  const glossary = fields.get('workbooks.import.0037').protectedSpans.find(span => span.token === '{{P000}}').glossary;
  assert.equal(glossary.key, 'menu.importFileEGSrwb');
  assert.equal(glossary.values.en, '📂 Import File (e.g. .srwb, .ipynb, .csv, .py, .zip)');
  assert.equal(glossary.values.de, '📂 Datei importieren (z. B. .srwb, .ipynb, .csv, .py, .zip)');
  const restored = restoreOperationalNames(field, translated, 'de', manifest, { inventory });
  assert.equal(restored.text, translated.replace(before, after));
  assert.deepEqual(tokenList(restored.text), tokenList(translated));
  assert.equal(restored.corrections.length, 1); assert.equal(restored.corrections[0].controlKey, 'menu.importFileEGSrwb');
  assert.equal(JSON.stringify(record), recordBefore);
  const html = renderEditorialField(field, restored, 'de', { inventory });
  assert.ok(html.includes('<strong>Menü → Datei importieren</strong>'));
  assert.ok(html.includes('<code>seedling-heights.csv</code>'));
  assert.ok(html.includes('<code>/shared/data/seedling-heights.csv</code>'));
  assert.throws(() => restoreOperationalNames(field, translated + ' ' + before, 'de', manifest, { inventory }), /more than once/);
  assert.throws(() => restoreOperationalNames(field, translated.replace(before, 'Import File'), 'de', manifest, { inventory }), /editorial review/);
  const outsideField = fields.get('tutorials.0001'), outside = 'Beispiel : ' + outsideField.text + ' ' + before;
  assert.equal(restoreOperationalNames(outsideField, outside, 'de', manifest, { inventory }).text, outside);
  assert.equal(restoreOperationalNames(field, translated, 'fr', manifest, { inventory }).text, translated);
  const drifted = structuredClone(manifest);
  drifted.pages.flatMap(page => page.fields).find(item => item.id === 'workbooks.import.0037').protectedSpans.find(span => span.token === '{{P000}}').glossary.values.de += ' geändert';
  assert.throws(() => restoreOperationalNames(field, translated, 'de', drifted, { inventory }));
});
verify('Arabic wraps only inventoried strong interiors in trusted LTR English bdi markup', () => {
  const field = fields.get('files-export.tutorial.0029');
  const beforeSpans = structuredClone(field.protectedSpans);
  const translated = 'مثال : ' + field.text.replace('{{P005}} Basics', '{{P005}} أساسيات').replace('{{P006}} Basics: Seedling Heights', '{{P006}} أساسيات : ارتفاع الشتلات');
  const restored = restoreOperationalNames(field, translated, 'ar', manifest, { inventory });
  const html = renderEditorialField(field, restored, 'ar', { inventory });
  assert.ok(html.includes('<strong><bdi lang="en" dir="ltr">CSV Basics</bdi></strong>'));
  assert.ok(html.includes('<strong><bdi lang="en" dir="ltr">CSV Basics: Seedling Heights</bdi></strong>'));
  assert.equal((html.match(/<bdi lang="en" dir="ltr">/g) || []).length, 2);
  assert.deepEqual(field.protectedSpans, beforeSpans); assert.deepEqual(tokenList(restored.text), tokenList(translated));
  assert.ok(restored.corrections.every(row => row.directionalIsolation === 'LTR English identifier'));
  const altered = structuredClone(restored); altered.text = altered.text.replace('{{P005}} Basics', '{{P005}} shifted');
  assert.throws(() => renderEditorialField(field, altered, 'ar', { inventory }));
  const ordinary = fields.get('tutorials.0001');
  const ordinaryText = 'مثال : ' + ordinary.text;
  assert.ok(!renderEditorialField(ordinary, restoreOperationalNames(ordinary, ordinaryText, 'ar', manifest, { inventory }), 'ar', { inventory }).includes('<bdi lang="en"'));
});
verify('editorial receipts are explicitly not model/native approval', () => {
  const result = editorialReceipt(manifest, 'fr', []);
  assert.equal(result.modelApproval, false); assert.equal(result.nativeLanguageApproval, false); assert.equal(result.nativeLanguageReview, 'pending');
});
console.log(`Operational rendering: ${checks} deterministic checks passed; no model calls or record changes.`);
