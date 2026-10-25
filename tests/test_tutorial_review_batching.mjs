// Pure planning tests: no provider requests, work claims, or campaign mutations.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { packReviewSections } from '../scripts/tutorial_review_batching.mjs';

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log('PASS ' + name); };
const field = (id, text = 'x', extra = {}) => ({ id, text, ...extra });
const sections = (...lengths) => lengths.map((length, index) => [field('f' + index, 'x'.repeat(length))]);
const bytes = (fields, { firstBatch }) => fields.reduce((n, value) => n + value.text.length, firstBatch ? 2 : 1);
const options = (value, extra = {}) => ({ sections: value, measurePromptBytes: bytes, maxPromptBytes: 10, ...extra });
const fails = (fn, code) => assert.throws(fn, error => error.code === code);

check('packs adjacent coherent sections greedily under an inclusive cap', () => {
  const input = sections(4, 4, 4, 4);
  const result = packReviewSections(options(input));
  assert.deepEqual(result.batches.map(batch => batch.map(value => value.id)), [['f0', 'f1'], ['f2', 'f3']]);
  assert.deepEqual(result.stats, {
    beforeCount: 4, afterCount: 2, savedCalls: 2, fieldCount: 4, maxPromptBytes: 10,
    beforePromptBytes: 21, afterPromptBytes: 19,
    beforePromptBytesBySection: [6, 5, 5, 5], afterPromptBytesByBatch: [10, 9],
  });
});

check('preserves complete field identity, ordering and original arrays', () => {
  const a = field('a', 'xxx', { protected: [{ token: '__TOKEN__' }] });
  const b = field('b', 'xx'), c = field('c', 'x');
  const first = Object.freeze([a, b]), second = Object.freeze([c]);
  const input = Object.freeze([first, second]);
  const result = packReviewSections(options(input));
  assert.deepEqual(result.batches.flat(), [a, b, c]);
  assert.strictEqual(result.batches[0][0], a);
  assert.strictEqual(input[0], first);
  assert.equal(a.protected[0].token, '__TOKEN__');
  assert.equal(result.stats.fieldCount, 3);
});

check('uses first-turn overhead for a packed prefix and continuation overhead later', () => {
  const result = packReviewSections(options(sections(3, 3, 3), {
    maxPromptBytes: 13,
    measurePromptBytes: (values, { firstBatch }) => values.length * 3 + (firstBatch ? 7 : 1),
  }));
  assert.deepEqual(result.batches.map(batch => batch.length), [2, 1]);
  assert.deepEqual(result.stats.afterPromptBytesByBatch, [13, 4]);
});

check('a shorter first-turn context can safely absorb a later section', () => {
  const result = packReviewSections(options(sections(1, 1), {
    maxPromptBytes: 2,
    measurePromptBytes: (values, { firstBatch }) => values.length + (firstBatch ? 0 : 10),
  }));
  assert.equal(result.batches.length, 1);
  assert.deepEqual(result.stats.afterPromptBytesByBatch, [2]);
});

check('enforces the response estimate cap independently of prompt size', () => {
  const result = packReviewSections(options(sections(1, 1, 1, 1), {
    estimateResponseBytes: values => values.length * 5, maxResponseBytes: 10,
  }));
  assert.deepEqual(result.batches.map(batch => batch.length), [2, 2]);
  assert.deepEqual(result.stats.afterResponseBytesByBatch, [10, 10]);
  assert.equal(result.stats.beforeResponseBytes, 20);
  assert.equal(result.stats.afterResponseBytes, 20);
});

check('rejects an indivisible oversized source section instead of splitting it', () => {
  const input = [[field('one', 'xxxx'), field('two', 'xxxxx')]];
  assert.throws(() => packReviewSections(options(input)), error => {
    assert.equal(error.code, 'REVIEW_SECTION_OVERSIZE');
    assert.equal(error.dimension, 'prompt');
    assert.equal(error.sectionIndex, 0);
    assert.equal(error.measuredBytes, 11);
    assert.equal(error.maximumBytes, 10);
    return true;
  });
});

check('rejects oversized response estimates with safe numeric details', () => {
  assert.throws(() => packReviewSections(options(sections(1), {
    estimateResponseBytes: () => 11, maxResponseBytes: 10,
  })), error => error.code === 'REVIEW_SECTION_OVERSIZE' && error.dimension === 'response');
});

check('empty input yields no batches or measurements', () => {
  const result = packReviewSections(options([], { measurePromptBytes: () => { throw new Error('must not run'); } }));
  assert.deepEqual(result.batches, []);
  assert.equal(result.stats.beforeCount, 0);
  assert.equal(result.stats.savedCalls, 0);
  assert.equal(result.stats.afterPromptBytes, 0);
});

check('rejects duplicate IDs and empty or malformed sections', () => {
  fails(() => packReviewSections(options([[field('same')], [field('same')]])), 'DUPLICATE_REVIEW_BATCH_FIELD');
  for (const input of [[[]], [null], [[null]], [[{ id: 'a' }]], [[field(' ')]]]) {
    assert.throws(() => packReviewSections(options(input)), error => /^INVALID_REVIEW_BATCH_/.test(error.code));
  }
});

check('rejects explicit cross-locale or cross-page metadata', () => {
  for (const key of ['locale', 'route', 'pageRoute']) {
    fails(() => packReviewSections(options([[field('a', 'x', { [key]: 'one' })],
      [field('b', 'x', { [key]: 'two' })]])), 'MIXED_REVIEW_BATCH_SCOPE');
  }
  fails(() => packReviewSections(options([[field('tutorial.0001')], [field('ai.0002')]])), 'MIXED_REVIEW_BATCH_SCOPE');
  fails(() => packReviewSections(options([[field('a', 'x', { route: 'one', pageRoute: 'two' })]])), 'MIXED_REVIEW_BATCH_SCOPE');
});

check('accepts consistent scope and preserves optional field metadata', () => {
  const input = [[field('tutorial.0001', 'x', { locale: 'fr', route: 'tutorial' })],
    [field('tutorial.0002', 'x', { locale: 'fr', pageRoute: 'tutorial' })]];
  const result = packReviewSections(options(input));
  assert.equal(result.batches.length, 1);
  assert.equal(result.batches[0][1].locale, 'fr');
});

check('rejects invalid and unsafe byte limits or callback values', () => {
  for (const cap of [0, -1, NaN, Infinity, 1.5, '10', Number.MAX_SAFE_INTEGER + 1]) {
    fails(() => packReviewSections(options(sections(1), { maxPromptBytes: cap })), 'INVALID_REVIEW_BATCH_SIZE');
  }
  for (const measurement of [-1, NaN, Infinity, 0.5, 'private prompt', Promise.resolve(1)]) {
    fails(() => packReviewSections(options(sections(1), { measurePromptBytes: () => measurement })), 'INVALID_REVIEW_BATCH_SIZE');
  }
  fails(() => packReviewSections(options(sections(1), {
    maxPromptBytes: Number.MAX_SAFE_INTEGER,
    measurePromptBytes: () => Number.MAX_SAFE_INTEGER,
    sections: sections(1, 1),
  })), 'INVALID_REVIEW_BATCH_SIZE');
});

check('rejects mismatched response options and unknown options', () => {
  for (const extra of [{ estimateResponseBytes: () => 1 }, { maxResponseBytes: 10 },
    { estimateResponseBytes: 1, maxResponseBytes: 10 }, { undocumented: true }]) {
    fails(() => packReviewSections(options(sections(1), extra)), 'INVALID_REVIEW_BATCH_OPTIONS');
  }
});

check('sanitizes callback exceptions and invalid results without leaking data', () => {
  const secret = 'private prompt, response, credential or conversation identifier';
  for (const extra of [
    { measurePromptBytes: () => { throw new Error(secret); } },
    { estimateResponseBytes: () => { throw new Error(secret); }, maxResponseBytes: 10 },
    { measurePromptBytes: () => secret },
  ]) {
    assert.throws(() => packReviewSections(options(sections(1), extra)), error => {
      assert(!String(error.stack).includes(secret));
      assert(!JSON.stringify(error).includes(secret));
      assert.equal(error.cause, undefined);
      return true;
    });
  }
});

check('rejected async callbacks cannot escape through unhandled rejections', () => {
  const moduleURL = new URL('../scripts/tutorial_review_batching.mjs', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--unhandled-rejections=strict', '--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { packReviewSections } from ${JSON.stringify(moduleURL)};
    const reject = async () => { throw new Error('PRIVATE_MEASUREMENT_SENTINEL'); };
    const input = {sections: [[{id: 'a', text: 'x'}]], measurePromptBytes: reject};
    assert.throws(() => packReviewSections(input), error => error.code === 'INVALID_REVIEW_BATCH_SIZE');
    assert.throws(() => packReviewSections({...input, measurePromptBytes: () => 1,
      estimateResponseBytes: reject, maxResponseBytes: 10}), error => error.code === 'INVALID_REVIEW_BATCH_SIZE');
    await new Promise(resolve => setImmediate(resolve));
  `], { encoding: 'utf8', timeout: 5000 });
  assert.equal(child.status, 0, 'Asynchronous callback rejection must remain contained');
  assert.equal(child.stdout, '');
  assert.equal(child.stderr, '');
});

check('exposes frozen callback arrays and context but leaves input untouched', () => {
  const input = sections(1, 1);
  const result = packReviewSections(options(input, { measurePromptBytes: (values, context) => {
    assert(Object.isFrozen(values)); assert(Object.isFrozen(context));
    return values.length;
  } }));
  assert.equal(input.length, 2);
  assert.equal(result.batches.length, 1);
});

check('counts fully serialized Unicode bytes rather than source character counts', () => {
  const input = [[field('a', '漢')], [field('b', '字')]];
  const measure = values => Buffer.byteLength(JSON.stringify(values));
  const result = packReviewSections(options(input, { maxPromptBytes: measure(input.flat()) - 1, measurePromptBytes: measure }));
  assert.equal(result.batches.length, 2);
});

check('is deterministic across varied section sizes and never loses fields', () => {
  for (let seed = 0; seed < 75; seed++) {
    const input = sections(...Array.from({ length: 1 + seed % 11 }, (_, index) => 1 + (seed * 7 + index * 3) % 8));
    const a = packReviewSections(options(input));
    const b = packReviewSections(options(input));
    assert.deepEqual(a, b);
    assert.deepEqual(a.batches.flat().map(value => value.id), input.flat().map(value => value.id));
    assert(a.stats.afterPromptBytesByBatch.every(value => value <= 10));
    assert(a.batches.length <= input.length);
  }
});

console.log(`Review batching tests passed: ${passed}`);
