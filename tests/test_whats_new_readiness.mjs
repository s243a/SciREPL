// Deterministic startup ordering for the actual What's New implementation.
// No browser, app data, network, device, timers or generated reports involved.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../www/js/whats_new.js', import.meta.url), 'utf8');
const VERSION = '1.5.0';
const SEEN_KEY = 'scirepl_whats_new_seen_version';
let passed = 0, failed = 0;

function fixture({ readyAtConstruction = false, seen = '1.4.0' } = {}) {
    const observers = new Map(), dirty = new Set(), timers = new Map();
    const storage = new Map([[SEEN_KEY, seen]]), writes = [];
    let timerId = 0;
    const document = { readyState: 'loading', listeners: new Map() };
    function eventTarget(target) {
        target.listeners ||= new Map();
        target.addEventListener = (type, listener, options) => {
            const callbacks = target.listeners.get(type) || [];
            callbacks.push({ listener, once: Boolean(options?.once) });
            target.listeners.set(type, callbacks);
        };
        target.emit = type => {
            const callbacks = [...(target.listeners.get(type) || [])];
            target.listeners.set(type, callbacks.filter(item => !item.once));
            for (const { listener } of callbacks) listener({ type, target });
        };
        return target;
    }
    eventTarget(document);
    function element(id, hidden = false, parent = null) {
        const classes = new Set(hidden ? ['hidden'] : []), attributes = new Map();
        const node = eventTarget({ id, disabled: false, controls: [], parent });
        const change = (name, add) => {
            const before = classes.has(name);
            if (add) classes.add(name); else classes.delete(name);
            if (before !== classes.has(name)) {
                for (const observer of observers.get(node) || []) dirty.add(observer);
            }
        };
        node.classList = { contains: name => classes.has(name),
            add: name => change(name, true), remove: name => change(name, false) };
        node.getAttribute = name => attributes.get(name) ?? null;
        node.removeAttribute = name => attributes.delete(name);
        node.querySelector = selector => selector === '.modal-close' ? node.close || null : null;
        node.querySelectorAll = () => node.controls;
        node.contains = child => child === node || node.controls.includes(child);
        node.focus = () => { document.activeElement = node; };
        node.blur = () => { document.activeElement = null; };
        Object.defineProperty(node, 'offsetParent', { get: () =>
            node.classList.contains('hidden') || parent?.classList.contains('hidden') ? null : document.body });
        return node;
    }
    document.body = element('body');
    const headerHelp = element('help-btn');
    const help = element('help-modal', true), modal = element('whats-new-modal', true);
    const privacy = element('privacy-modal', true), runtime = element('runtime-download-modal', true);
    const button = element('btn-show-whats-new', false, help);
    const language = element('whats-new-language', false, modal);
    const done = element('whats-new-done', false, modal);
    const close = element('whats-new-close', false, modal);
    modal.close = close; modal.controls = [close, language, done]; help.controls = [button];
    privacy.controls = [element('privacy-close', false, privacy)];
    runtime.controls = [element('runtime-close', false, runtime)];
    const nodes = new Map([headerHelp, help, modal, privacy, runtime, button, language, done]
        .map(node => [node.id, node]));
    const modals = [help, modal, privacy, runtime];
    document.getElementById = id => nodes.get(id) || null;
    document.querySelectorAll = selector => selector === '.modal' ? modals : [];
    document.contains = node => [...nodes.values()].includes(node) || node === close;
    document.activeElement = headerHelp;
    const window = { __SCIREPL_APP_READY: readyAtConstruction,
        KERNEL_CONFIG: { app: { version: VERSION, releaseChannel: 'release' } } };
    const context = {
        window, document,
        localStorage: { getItem: key => storage.get(key) ?? null,
            setItem(key, value) { writes.push([key, String(value)]); storage.set(key, String(value)); } },
        MutationObserver: class {
            constructor(callback) { this.callback = callback; }
            observe(target, options) {
                if (!options.attributes || !options.attributeFilter?.includes('class')) return;
                const registered = observers.get(target) || new Set();
                registered.add(this); observers.set(target, registered);
            }
        },
        setTimeout(callback) { const id = ++timerId; timers.set(id, callback); return id; },
        clearTimeout(id) { timers.delete(id); },
    };
    vm.runInNewContext(source, context, { filename: 'www/js/whats_new.js' });
    const whatsNew = window.whatsNew;
    // Rendering/catalogues are covered by the browser suite. Keep the real
    // constructor, init, Help listener, request, readiness and arbitration paths.
    whatsNew._render = () => {};
    function settle() {
        for (let count = 0; count < 30; count++) {
            const pendingObservers = [...dirty]; dirty.clear();
            for (const observer of pendingObservers) observer.callback();
            const pendingTimers = [...timers]; timers.clear();
            for (const [, callback] of pendingTimers) callback();
            if (!dirty.size && !timers.size) return;
        }
        throw new Error('readiness fixture failed to settle');
    }
    function ready() { window.__SCIREPL_APP_READY = true; document.emit('scirepl:app-ready'); settle(); }
    function init() { document.readyState = 'interactive'; document.emit('DOMContentLoaded'); settle(); }
    function clickHelp() {
        help.classList.remove('hidden'); settle();
        button.emit('click'); settle();
        assert.ok(help.classList.contains('hidden'), 'the real Help handler closes Help');
    }
    function opened() {
        assert.equal(whatsNew._appReady, true);
        assert.equal(modal.classList.contains('hidden'), false, 'What\'s New actually opens');
        assert.equal(modal.inert, false);
        assert.equal(document.activeElement, language);
        assert.equal(whatsNew._pending, null);
        assert.equal(storage.get(SEEN_KEY), seen, 'opening must not mark the version seen');
        assert.equal(writes.length, 0, 'manual requests must not mutate the seen marker');
    }
    function queued() {
        assert.equal(modal.classList.contains('hidden'), true);
        assert.equal(whatsNew._pending?.manual, true);
        assert.equal(whatsNew._pending?.source, 'help');
        assert.equal(storage.get(SEEN_KEY), seen);
        assert.equal(writes.length, 0);
    }
    return { window, whatsNew, modal, privacy, runtime, storage, writes, done,
        ready, init, clickHelp, settle, opened, queued };
}

function test(name, run) {
    try { run(); passed++; console.log(`PASS ${name}`); }
    catch (error) { failed++; console.error(`FAIL ${name}: ${error.message}`); }
}

test('ready event between construction and init is not lost', () => {
    const f = fixture(); f.ready(); f.init(); f.clickHelp(); f.opened();
});
test('a manual request waits when readiness has not happened, then resumes', () => {
    const f = fixture(); f.init(); f.clickHelp(); f.queued();
    assert.equal(f.whatsNew._appReady, false);
    f.ready(); f.opened();
});
test('readiness before construction and an already-seen version allow manual reopening', () => {
    const f = fixture({ readyAtConstruction: true, seen: VERSION });
    f.init(); f.clickHelp(); f.opened();
});
for (const blocker of ['privacy', 'runtime']) {
    test(`early readiness does not bypass the ${blocker} consent blocker`, () => {
        const f = fixture(); f.ready(); f.init();
        f[blocker].classList.remove('hidden'); f.settle();
        f.clickHelp(); f.queued();
        assert.equal(f.whatsNew._blocked(), true);
        f[blocker].classList.add('hidden'); f.settle(); f.opened();
    });
}
test('only normal dismissal records the current version', () => {
    const f = fixture({ readyAtConstruction: true });
    f.init(); f.clickHelp(); f.opened(); f.done.emit('click'); f.settle();
    assert.equal(f.storage.get(SEEN_KEY), VERSION);
    assert.equal(f.writes.length, 1);
    assert.equal(f.modal.classList.contains('hidden'), true);
});
console.log(`What's New readiness: ${passed} passed, ${failed} failed.`);
// Throw on import too: the browser runner assigns process.exitCode from its
// own results, and must never mask a failed deterministic readiness gate.
if (failed) throw new Error(`What's New readiness failed: ${failed} regression group(s)`);
