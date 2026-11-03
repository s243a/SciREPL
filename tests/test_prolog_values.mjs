// Source-loaded renderer regressions: no browser, network or WASM startup.
// The doubles mirror swipl-wasm 3/8/2's exported custom-prototype wrappers;
// plain dictionaries with the same property names are deliberately not wrappers.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

class TestVar { constructor(v) { this.$t = 'v'; this.v = v; } }
class TestString { constructor(v) { this.$t = 's'; this.v = v; } }
class TestRational { constructor(n, d) { this.$t = 'r'; this.n = n; this.d = d; } }
class TestCompound {
    constructor(functor, args) { this.$t = 't'; this.functor = functor; this[functor] = args; }
}
class TestList { constructor(v, t) { this.$t = 'l'; this.v = v; this.t = t; } }
class TestBlob { constructor() { this.$t = 'b'; } }

const source = readFileSync(new URL('../www/js/kernels/prolog.js', import.meta.url), 'utf8');
let Kernel;
vm.runInNewContext(source, {
    window: { kernelManager: { register(name, constructor) {
        assert.equal(name, 'prolog');
        Kernel = constructor;
    } } },
}, { filename: 'www/js/kernels/prolog.js' });
assert.equal(typeof Kernel, 'function', 'the actual source registers its kernel');

function kernel() {
    const instance = new Kernel();
    instance._swipl = { prolog: {
        Var: TestVar, String: TestString, Rational: TestRational,
        Compound: TestCompound, List: TestList, Blob: TestBlob,
    } };
    return instance;
}
const compound = (functor, ...args) => new TestCompound(functor, args);

test('actual Compound shape renders its functor and arguments recursively', () => {
    const k = kernel();
    assert.equal(k._formatValue(compound('foo', 'bar')), 'foo(bar)');
    assert.equal(k._formatValue(compound('outer', compound('foo', 'bar'), ['a', 'b'])),
        'outer(foo(bar), [a, b])');
    assert.equal(k._formatValue(compound('two words', 'Upper')), "'two words'('Upper')");
    // These legitimate functor names overlap the wrapper's own metadata keys.
    assert.equal(k._formatValue(compound('functor', 'bar')), 'functor(bar)');
    assert.equal(k._formatValue(compound('args', 'bar')), 'args(bar)');
    assert.equal(k._formatValue(compound('$t', 'bar')), "'$t'(bar)");
});

test('atoms and SWI string wrappers remain distinct and escape Prolog syntax', () => {
    const k = kernel();
    for (const [value, expected] of [
        ['ordinary_atom2', 'ordinary_atom2'], ['Upper', "'Upper'"], ['', "''"],
        ['two words', "'two words'"], ["can't", "'can\\'t'"],
        ['a\\b', "'a\\\\b'"], ['line\nnext\tend', "'line\\nnext\\tend'"],
        [new TestString('hello'), '"hello"'],
        [new TestString('say "hi"\\\n'), '"say \\"hi\\"\\\\\\n"'],
    ]) assert.equal(k._formatValue(value), expected);
});

test('proper/improper lists, BigInt and rational wrappers render exactly', () => {
    const k = kernel();
    assert.equal(k._formatValue([]), '[]');
    assert.equal(k._formatValue([compound('foo', 'bar'), new TestString('hello'), 9n]),
        '[foo(bar), "hello", 9]');
    assert.equal(k._formatValue(new TestList(['a', compound('foo', 'bar')], new TestVar(7))),
        '[a, foo(bar) | _]');
    assert.equal(k._formatValue(new TestRational(1, 3)), '1r3');
    assert.equal(k._formatValue(new TestRational(9007199254740993n, 7n)), '9007199254740993r7');
    assert.equal(k._formatValue(123456789012345678901234567890n), '123456789012345678901234567890');
    assert.equal(k._formatValue([0, -2, 1.25, true, false, null, undefined]),
        '[0, -2, 1.25, true, false, null, null]');
});

test('tagged, anonymous and empty dictionaries render recursively', () => {
    const k = kernel();
    assert.equal(k._formatValue({ $tag: 'person', name: 'alice' }), 'person{name:alice}');
    assert.equal(k._formatValue({}), '_{}');
    assert.equal(k._formatValue({ $tag: 'empty' }), 'empty{}');
    // A variable-tag dict comes from the runtime with $tag omitted, not a Var
    // in $tag; the real-runtime PWA query also covers that conversion.
    assert.equal(k._formatValue({ $tag: new TestVar(1) }), '_{}');
    assert.equal(k._formatValue({ $tag: 'tag', a: 1, b: compound('foo', 'bar') }),
        'tag{a:1, b:foo(bar)}');
    assert.equal(k._formatValue({ $tag: 'two words', 'odd key': new TestString('hello') }),
        "'two words'{'odd key':\"hello\"}");
});

test('ordinary dictionary keys cannot impersonate SWI wrappers or compounds', () => {
    const k = kernel();
    assert.equal(k._formatValue({ $tag: 'schema', functor: 'foo', args: ['bar'], $t: 'v' }),
        "schema{functor:foo, args:[bar], '$t':v}");
    for (const tag of ['v', 'b', 's', 'r', 'l', 't']) {
        const value = { $t: tag, v: 1 };
        assert.equal(k._formatValue(value), `_{'$t':${tag}, v:1}`);
        assert.equal(k._formatBindings({ X: value }), `X = _{'$t':${tag}, v:1}`);
    }
    assert.equal(k._formatValue({ functor: 'foo', args: ['bar'] }),
        '_{functor:foo, args:[bar]}');
});

test('numeric-looking atom keys stay quoted while canonical integer keys remain numeric', () => {
    const k = kernel();
    assert.equal(k._formatValue({ '007': 'v', '-0': 'w' }), "_{'007':v, '-0':w}");
    assert.equal(k._formatValue({ '0': 'zero', '-1': 'negative', '1': 'one' }),
        '_{0:zero, 1:one, -1:negative}');
});

test('non-dictionary JavaScript values stay opaque and accessors are never invoked', () => {
    const k = kernel();
    class CustomValue { constructor() { this.value = 'not_a_dict'; } }
    for (const value of [new Date(0), new Map([['key', 'value']]), new CustomValue()]) {
        assert.equal(k._formatValue(value), '<opaque>');
        assert.equal(k._formatBindings({ X: value }), 'X = <opaque>');
    }
    // Plain data objects from other realms and null-prototype dictionaries
    // are still dictionaries; neither depends on constructor-name heuristics.
    assert.equal(k._formatValue(Object.assign(Object.create(null), { name: 'alice' })),
        '_{name:alice}');
    assert.equal(k._formatValue(vm.runInNewContext('({ name: "alice" })')),
        '_{name:alice}');
    let getterCalls = 0;
    for (const key of ['value', '$tag', '$t']) {
        const value = Object.defineProperty({}, key, {
            enumerable: true,
            get() { getterCalls++; return 'must_not_run'; },
        });
        assert.equal(k._formatValue(value), '<opaque>');
        assert.equal(k._formatBindings({ X: value }), 'X = <opaque>');
        assert.equal(getterCalls, 0, `rendering must not invoke the ${key} getter`);
    }
});

test('only top-level variables/opaque wrappers and existing metadata stay hidden', () => {
    const k = kernel();
    assert.equal(k._formatBindings({ success: true, done: false, error: false,
        message: 'metadata', $internal: 1, _Internal: 2, U: new TestVar(1), S: new TestBlob() }), null);
    assert.equal(k._formatBindings({ N: 42, X: compound('foo', 'bar'),
        D: { $tag: 'person', name: 'alice' } }), 'N = 42, X = foo(bar), D = person{name:alice}');
    assert.equal(k._formatBindings({ X: compound('pair', new TestVar(1), new TestBlob()) }),
        'X = pair(_, <opaque>)');
});

test('active-path cycles are bounded without treating shared values as cycles', () => {
    const k = kernel();
    const list = []; list.push(list);
    const dict = {}; dict.self = dict;
    const term = compound('loop'); term.loop.push(term);
    for (const value of [list, dict, term]) {
        assert.match(k._formatValue(value), /<cycle>/);
    }
    const shared = compound('foo', 'bar');
    assert.equal(k._formatValue(compound('pair', shared, shared)), 'pair(foo(bar), foo(bar))');
    assert.equal(k._formatValue([shared, shared]), '[foo(bar), foo(bar)]');
});

test('deep and wide JavaScript values stop at the renderer resource guards', () => {
    const k = kernel();
    let deep = 'leaf';
    for (let i = 0; i < 150; i++) deep = [deep];
    assert.match(k._formatValue(deep), /<truncated>/);
    assert.match(k._formatValue(Array.from({ length: 10020 }, (_, i) => i)), /<truncated>/);
});
