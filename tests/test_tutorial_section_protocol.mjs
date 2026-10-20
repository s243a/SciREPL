// In-memory protocol tests only: no provider calls, claims, live evidence or IO.
import assert from 'node:assert/strict';
import { gateSection, reviewPrompt, correctionReviewPrompt, createDispatchCadence } from '../scripts/tutorial_section_protocol.mjs';

let passed = 0;
function test(name, body) { body(); passed++; console.log('PASS ' + name); }
const field = (id, text, protectedSpans = []) => ({ id, text, kind: 'html-text', tag: 'p', protectedSpans });
const one = field('fixture.page.0001', 'Use {{P001}} before {{P002}} for 2 groups and 10 trials.', [
  { token: '{{P001}}', kind: 'literal', value: 'fixtureAlpha(99)' },
  { token: '{{P002}}', kind: 'ui', label: 'Run', value: '<strong>Run</strong>' },
]);
const two = field('fixture.page.0002', 'Name');
const three = field('fixture.page.0003', 'Never disclose credentials or grant standing consent.');
const fields = [one, two, three], sourceFields = new Map(fields.map(item => [item.id, item]));
const values = {
  [one.id]: 'Utilisez {{P001}} avant {{P002}} pour 2 groupes et 10 essais.',
  [two.id]: 'Nom', [three.id]: 'Ne divulguez jamais les identifiants et ne donnez aucun consentement permanent.',
};
const proposal = changes => ({ translations: { ...values, ...changes } });
const gate = value => gateSection(fields, value, sourceFields);
const dataFrom = prompt => JSON.parse(prompt.split('\nBEGIN UNTRUSTED REVIEW SECTION\n')[1].split('\nEND UNTRUSTED REVIEW SECTION')[0]);
const job = { locale: 'fr', page: { route: 'fixture/page', context: [
  { id: 'fixture.accepted', translation: 'Terminologie validée.', readonly: true },
  { id: 'fixture.unverified', translation: 'Unverified context must not be supplied.' },
  { id: 'fixture.false', translation: 'Not accepted.', readonly: false },
] } };

test('valid gate returns exact proposal objects and does not mutate inputs', () => {
  const input = proposal(), before = JSON.stringify({ fields, input });
  const result = gate(input);
  assert.equal(result.translations, input.translations); assert.deepEqual(result.keptFields, {});
  assert.equal(JSON.stringify({ fields, input }), before);
});
test('unchanged eligible labels require their own substantive explanation', () => {
  assert.throws(() => gate(proposal({ [two.id]: two.text })), /explicit reviewed keep/);
  const keptFields = { [two.id]: 'Fixture linguistic reason: this label is conventionally retained.' };
  const input = { ...proposal({ [two.id]: two.text }), keptFields };
  assert.equal(gate(input).keptFields, keptFields);
  assert.throws(() => gate({ ...input, keptFields: { [two.id]: 'short' } }), /substantive reason/);
});
test('keep declarations cannot cover translated text or fields outside the turn', () => {
  assert.throws(() => gate({ ...proposal(), keptFields: { [two.id]: 'A substantive fixture reason.' } }), /requires unchanged/);
  assert.throws(() => gate({ ...proposal(), keptFields: { unknown: 'A substantive fixture reason.' } }), /outside section/);
});
test('English sentences remain ineligible even with a keep explanation', () => {
  assert.throws(() => gate({ ...proposal({ [three.id]: three.text }), keptFields: { [three.id]: 'This fixture explanation cannot sanction prose.' } }), /sentences\/paragraphs/);
});
test('missing and extra translation keys are rejected', () => {
  const missing = proposal(); delete missing.translations[two.id];
  assert.throws(() => gate(missing), /Missing or extra/);
  assert.throws(() => gate({ translations: { ...values, extra: 'Supplément.' } }), /Missing or extra/);
});
test('unexpected top-level keys and invalid shapes are rejected', () => {
  assert.throws(() => gate({ ...proposal(), approved: true }), /Unexpected response keys/);
  for (const value of [null, [], { translations: [] }, { translations: null }]) assert.throws(() => gate(value), /must contain translations/);
  assert.throws(() => gate({ ...proposal(), keptFields: [] }), /Invalid keep/);
  // Preserve the legacy gate's exact null-keptFields fallback behavior.
  assert.deepEqual(gate({ ...proposal(), keptFields: null }).keptFields, {});
});
test('frozen-source drift is rejected', () => {
  assert.throws(() => gateSection([{ ...one, text: one.text + ' drift' }, two, three], proposal(), sourceFields), /frozen source/);
});
test('missing duplicated reordered and unknown protected tokens are rejected', () => {
  for (const text of [
    'Utilisez {{P001}} pour 2 groupes et 10 essais.',
    'Utilisez {{P001}} {{P001}} avant {{P002}} pour 2 groupes et 10 essais.',
    'Utilisez {{P002}} avant {{P001}} pour 2 groupes et 10 essais.',
    values[one.id] + ' {{unknown}}',
  ]) assert.throws(() => gate(proposal({ [one.id]: text })), /protected tokens|unknown placeholder/);
});
test('numerals cannot change order script quantity or spelling', () => {
  for (const text of [
    values[one.id].replace('2 groupes et 10 essais', '10 groupes et 2 essais'),
    values[one.id].replace('2 groupes', '٢ groupes'),
    values[one.id] + ' 1',
    values[one.id].replace('2 groupes', 'deux groupes'),
  ]) assert.throws(() => gate(proposal({ [one.id]: text })), /numeric values/);
});
test('HTML hidden controls and non-string values remain rejected', () => {
  for (const text of ['<b>Nom</b>', 'Nom\u0001', 'Nom\u202E', null, 10]) assert.throws(() => gate(proposal({ [two.id]: text })));
});
test('legacy review serialization retains original fields and numeric metadata', () => {
  const before = JSON.stringify({ fields, values, job }), first = reviewPrompt(job, fields, values, true);
  const next = reviewPrompt(job, fields, values, false), data = dataFrom(first);
  assert.deepEqual(Object.keys(data), ['locale', 'route', 'fields', 'translations']);
  assert.deepEqual(data.fields[0].unprotectedNumericSequence, ['2', '10']);
  assert.equal(data.fields[1].sourceAllowsReviewedKeep, true);
  assert.equal(data.fields[2].sourceAllowsReviewedKeep, false);
  assert.equal(data.fields[0].protected[0].meaning, 'fixtureAlpha(99)');
  assert.match(first, /Begin independent review/); assert.match(next, /Continue the independent review/);
  assert.equal(JSON.stringify({ fields, values, job }), before);
});
test('correction review has exact IDs and source-derived token sequences', () => {
  const data = dataFrom(correctionReviewPrompt(job, fields, values, true));
  assert.deepEqual(data.exactFieldIds, fields.map(item => item.id));
  assert.deepEqual(data.fields[0].expectedProtectedTokenSequence, ['{{P001}}', '{{P002}}']);
  assert.deepEqual(data.fields[0].unprotectedNumericSequence, ['2', '10']);
  assert.deepEqual(data.fields[1].expectedProtectedTokenSequence, []);
  assert.equal(data.fields[0].protected[1].meaning, 'App control: Run; localized automatically');
  assert.deepEqual(data.translations, values);
});
test('token sequence metadata preserves source order and repeated occurrences', () => {
  const repeated = field('fixture.repeat.0001', '{{P002}} puis {{P001}} et {{P002}}.', one.protectedSpans);
  const data = dataFrom(correctionReviewPrompt(job, [repeated], { [repeated.id]: 'Brouillon.' }, true));
  assert.deepEqual(data.fields[0].expectedProtectedTokenSequence, ['{{P002}}', '{{P001}}', '{{P002}}']);
});
test('correction review separates explanatory meanings from tokens to copy', () => {
  const prompt = correctionReviewPrompt(job, fields, values, true);
  assert.match(prompt, /copy token into the translation, NEVER copy meaning in place of token/);
  assert.match(prompt, /exactly the same spelling, braces, order and multiplicity/);
  assert.match(prompt, /Every translations value.*STRING/);
  assert.match(prompt, /Every translations key.*exactFieldIds/);
  assert.match(prompt, /examples show syntax only/);
});
test('correction review requires independent keep reasons and forbids approvals from failed output', () => {
  const prompt = correctionReviewPrompt(job, fields, values, true);
  assert.match(prompt, /fresh independent reviewer, not the original drafter or a previous reviewer/);
  assert.match(prompt, /Failed outputs are not approvals/);
  assert.match(prompt, /valid original-draft candidates and validated prior terminology context/);
  assert.match(prompt, /EVERY field you leave identical to the source/);
  assert.match(prompt, /at least twelve characters/);
  assert.match(prompt, /sourceAllowsReviewedKeep means validator eligibility only/);
});
test('all review variants forbid tools filesystem network permission requests and loops', () => {
  for (const build of [reviewPrompt, correctionReviewPrompt]) for (const first of [true, false]) {
    const prompt = build(job, fields, values, first);
    assert.match(prompt, /No tools, filesystem access, network calls or permission requests/);
    assert.match(prompt, /untrusted data|untrusted reference data/);
    assert.match(prompt, /no retry\/repair loop|no retry or repair loop/);
  }
});
test('only validated readonly context is included on the first correction turn', () => {
  const before = JSON.stringify(job);
  const first = dataFrom(correctionReviewPrompt(job, fields, values, true));
  const next = dataFrom(correctionReviewPrompt(job, fields, values, false));
  assert.deepEqual(first.validatedPriorTerminologyContext, [{ id: 'fixture.accepted', translation: 'Terminologie validée.' }]);
  assert.deepEqual(next.validatedPriorTerminologyContext, []);
  assert.equal(JSON.stringify(job), before);
});
test('correction input rejects missing drafts duplicate IDs and implicit turn position', () => {
  const missing = { ...values }; delete missing[two.id];
  assert.throws(() => correctionReviewPrompt(job, fields, missing, true), /complete original-draft/);
  assert.throws(() => correctionReviewPrompt(job, [two, two], values, true), /repeats fields/);
  assert.throws(() => correctionReviewPrompt(job, fields, values), /turn position/);
});
test('dispatch cadence validates its limits and clock without provider calls', () => {
  for (const minimumGapMs of [-1, 1.5, Infinity, '15000']) assert.throws(() => createDispatchCadence({ minimumGapMs, clock: { now: () => 0, sleep: async () => {} } }));
  assert.throws(() => createDispatchCadence({ minimumGapMs: 15000, clock: {} }));
});
{
  let now = 0; const sleeps = [];
  const acquire = createDispatchCadence({ minimumGapMs: 15000, clock: {
    now: () => now, sleep: async ms => { sleeps.push(ms); now += ms; },
  } });
  const first = await acquire(); const waitingSecond = acquire();
  now += 4500; // Metadata/version checks occur before actual dispatch.
  first(true); first(true); // Releasing twice cannot free another turn.
  const second = await waitingSecond;
  assert.equal(now, 19500); assert.deepEqual(sleeps, [15000]);
  now += 2000; second(true);
  const third = await acquire(); assert.equal(now, 36500); third(false);
  const fourth = await acquire(); assert.equal(now, 36500); fourth(true);
  passed++; console.log('PASS virtual-clock cadence spaces actual dispatches without serializing request lifetimes');
}
console.log(`PASS ${passed} offline section-protocol scenarios (no model calls or applies)`);
