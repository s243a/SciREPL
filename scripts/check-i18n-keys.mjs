/**
 * check-i18n-keys.mjs — every key the code asks for must exist.
 *
 *   node scripts/check-i18n-keys.mjs
 *
 * t('some.key') returns the key itself when the catalogue has no entry, so a
 * missing key renders as literal "appearance.cssQuarantined" on screen. Nothing
 * throws, no test fails unless one happens to assert that exact string, and the
 * completeness score is unaffected — it measures the catalogue against itself,
 * not against what the app actually asks for.
 *
 * That is how appearance.cssQuarantined shipped: the code called for it, the
 * catalogue never had it, and it survived only because the call site carried a
 * hardcoded English fallback. Translators never saw it, so it would have stayed
 * English in all thirteen languages.
 *
 * The reverse direction is only reported, never enforced: an unused key is
 * usually a string that is about to be used, or one referenced from markup this
 * script does not parse.
 */

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const WWW = path.join(ROOT, 'www');
const require = createRequire(import.meta.url);

const base = JSON.parse(readFileSync(path.join(WWW, 'i18n', 'en.json'), 'utf8'));
const known = new Set(Object.keys(base.strings || {}));

// Domain catalogues (privacy.en.json) hold their own keys — the policy strings
// live there now, not in the general catalogue — so include them or every
// privacy.* reference reads as missing.
for (const f of readdirSync(path.join(WWW, 'i18n'))) {
    const m = f.match(/^([a-z]+)\.en\.json$/);
    if (!m) continue;
    const dom = JSON.parse(readFileSync(path.join(WWW, 'i18n', f), 'utf8'));
    for (const k of Object.keys(dom.strings || {})) known.add(k);
}

/** A key looks like a dotted identifier; anything else is a false positive. */
const KEYISH = /^[a-z][\w]*(?:\.[\w]+)+$/i;

// Electron owns a small native menu/dialog surface. Its trusted English map is
// deliberately duplicated as an in-process recovery fallback, but en.json is
// still the authoritative translator-facing catalogue. Keep the two exactly in
// sync: a missing entry would make every non-English native menu silently fall
// back to English, while wording drift would make the host and renderer disagree.
const { ENGLISH: nativeEnglish } = require('../desktop/electron/native-i18n.js');
for (const [key, value] of Object.entries(nativeEnglish)) {
    if (base.strings?.[key] !== value) {
        console.error(`[i18n] Electron native fallback mismatch for ${key}\n`
            + `  en.json: ${JSON.stringify(base.strings?.[key])}\n`
            + `  native:  ${JSON.stringify(value)}`);
        process.exit(1);
    }
}

const sources = [];
const SKIP_DIRS = new Set([
    'i18n', 'vendor', 'workbooks', 'out', 'node_modules', 'test', 'coverage',
]);
function collectSources(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            // Translation catalogues, notebook payloads, generated packages and
            // tests are data/consumers rather than production call sites.
            if (!SKIP_DIRS.has(entry.name)) collectSources(full);
        } else if (entry.name.endsWith('.js') || entry.name.endsWith('.html')) {
            sources.push(full);
        }
    }
}
collectSources(WWW);
collectSources(path.join(ROOT, 'desktop', 'electron'));

const knownNamespaces = new Set([...known, ...Object.keys(nativeEnglish)]
    .map((key) => key.split('.')[0]));

function addMatches(text, regex, group, add) {
    for (const match of text.matchAll(regex)) add(match[group]);
}

function decodeJsString(body) {
    return body.replace(/\\(?:u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2})|([nrtbfv0\\'" ]))/g,
        (_match, unicode, hex, simple) => {
            if (unicode) return String.fromCodePoint(Number.parseInt(unicode, 16));
            if (hex) return String.fromCodePoint(Number.parseInt(hex, 16));
            return ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', 0: '\0' })[simple]
                ?? simple;
        });
}

function scanLiteralFallbacks(text, add) {
    const code = text
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
    const body = String.raw`((?:\\.|(?!\3)[^\\\r\n])*)`;

    // _t(key, fallback), _emptyMessage(key, fallback)
    const firstKey = new RegExp(
        String.raw`\b(?:this\s*\.\s*)?(?:_t|_emptyMessage)\s*\(\s*(['"])([\w.]+)\1\s*,\s*(['"])${body}\3`,
        'g');
    for (const match of code.matchAll(firstKey)) {
        if (/^\s*\+/.test(code.slice(match.index + match[0].length))) continue;
        add(match[2], decodeJsString(match[4]));
    }

    // _setText(element, key, fallback), and the equivalent persistent helpers.
    const secondKey = new RegExp(
        String.raw`\b(?:_setText|_setTitle|_setTranslatedText|_setTranslatedHtml|_setButtonLabel)\s*\(\s*[^,]+,\s*(['"])([\w.]+)\1\s*,\s*(['"])${body}\3`,
        'g');
    for (const match of code.matchAll(secondKey)) {
        if (/^\s*\+/.test(code.slice(match.index + match[0].length))) continue;
        add(match[2], decodeJsString(match[4]));
    }
}

/**
 * Find literal translation keys across all helper styles used by the renderer.
 * This is intentionally a small source scanner, not a JavaScript parser. The
 * synthetic assertions below guard the supported forms so adding a wrapper
 * cannot quietly make the completeness gate weaker.
 */
function scanJsKeys(text, add) {
    // Ignore documentation examples and commented-out code. Only whole-line
    // `//` comments are removed so URL literals such as https://... survive.
    const code = text
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');

    // Direct translators and helpers whose key is the first argument.
    addMatches(code,
        /\b(?:(?:window|this)\s*\.\s*)?(?:t|_t|setStatus|_emptyMessage)\s*\(\s*(['"])([\w.]+)\1/g,
        2, add);

    // Persistent text/HTML helpers whose key is the second argument.
    addMatches(code,
        /\b(?:setI18nText|setI18nHtml|setUiText|_setText|_setTitle|_setTranslatedText|_setTranslatedHtml|_setButtonLabel)\s*\(\s*[^,]+,\s*(['"])([\w.]+)\1/g,
        2, add);

    // Attribute helpers take (element, attribute, key, vars).
    addMatches(code,
        /\b(?:setI18nAttr|setUiAttr)\s*\(\s*[^,]+,\s*[^,]+,\s*(['"])([\w.]+)\1/g,
        2, add);

    // Declarative descriptors (displayNameKey, titleKey, errorKey, and so on)
    // feed a translator later through a variable rather than a literal call.
    addMatches(code, /\b[\w]*Key\s*:\s*(['"])([\w.]+)\1/g, 2, add);
    addMatches(code, /\b(?:const|let|var)\s+[\w]*Key\s*=\s*(['"])([\w.]+)\1/g, 2, add);

    // Conditional keys such as t(show ? 'typr.on' : 'typr.off') cannot be
    // recognized from the first argument alone. Once a namespace is known,
    // every key-shaped literal in that namespace is a catalogue reference.
    const fileLikeSuffixes = new Set([
        'html', 'js', 'json', 'wasm', 'pl', 'py', 'r', 'zip', 'tar', 'gz',
        'srwb', 'ipynb', 'tex', 'css',
    ]);
    addMatches(code, /(['"])([A-Za-z][\w]*(?:\.[\w]+)+)\1/g, 2, (key) => {
        const parts = key.split('.');
        if (!knownNamespaces.has(parts[0])) return;
        // Existing catalogue keys such as export.html are valid; an unknown
        // privacy.html in href assignment is a filename, not a new key.
        if (!known.has(key) && fileLikeSuffixes.has(parts.at(-1).toLowerCase())) return;
        add(key);
    });
}

function assertScannerCoverage() {
    const found = new Set();
    scanJsKeys(`
        window.t('fixture.direct');
        this._t(\n  "fixture.multiline", 'fallback');
        setStatus('fixture.status');
        window.setI18nText(node, 'fixture.text');
        this._setTranslatedHtml(node, 'fixture.html', 'fallback');
        window.setI18nAttr(node, 'title', 'fixture.attr');
        setUiAttr(node, 'aria-label', 'fixture.uiAttr');
        const row = { displayNameKey: 'fixture.descriptor' };
        const errorKey = 'fixture.assignment';
        window.t(flag ? 'tour.next' : 'tour.back');
        /** Documentation example only: t('appearance.scalePercent') */
        link.href = 'privacy.html';
    `, (key) => found.add(key));
    const expected = [
        'fixture.direct', 'fixture.multiline', 'fixture.status', 'fixture.text',
        'fixture.html', 'fixture.attr', 'fixture.uiAttr', 'fixture.descriptor',
        'fixture.assignment', 'tour.next', 'tour.back',
    ];
    const missed = expected.filter((key) => !found.has(key));
    if (missed.length) throw new Error(`i18n key scanner regression: missed ${missed.join(', ')}`);
    const falsePositives = ['appearance.scalePercent', 'privacy.html'].filter((key) => found.has(key));
    if (falsePositives.length) {
        throw new Error(`i18n key scanner regression: false positive ${falsePositives.join(', ')}`);
    }
}
assertScannerCoverage();

const referenced = new Map();   // key -> first file that asks for it
const literalFallbacks = new Map(); // key -> { value, file }
for (const file of sources) {
    const text = readFileSync(file, 'utf8');
    const rel = path.relative(ROOT, file);
    const add = (k) => { if (KEYISH.test(k) && !referenced.has(k)) referenced.set(k, rel); };
    scanJsKeys(text, add);
    scanLiteralFallbacks(text, (key, value) => {
        if (!literalFallbacks.has(key)) literalFallbacks.set(key, { value, file: rel });
    });
    for (const m of text.matchAll(
        /data-i18n(?:-html|-title|-placeholder|-aria-label)?\s*=\s*["']([\w.]+)["']/g)) add(m[1]);
}

const missing = [...referenced].filter(([k]) => !known.has(k));
const unused = [...known].filter((k) => !referenced.has(k) && !k.startsWith('__'));
const fallbackMismatches = [...literalFallbacks]
    .filter(([key, { value }]) => base.strings?.[key] !== undefined && base.strings[key] !== value);

if (unused.length) {
    console.log(`[i18n] ${unused.length} catalogue key(s) not referenced by code or markup `
        + `(informational): ${unused.slice(0, 8).join(', ')}${unused.length > 8 ? ' …' : ''}`);
}

if (missing.length) {
    console.error('\n[i18n] the code asks for keys the catalogue does not have. These render '
        + 'as the raw key, or silently fall back to hardcoded English:\n');
    for (const [k, where] of missing) console.error(`  ${k}\n      referenced in ${where}`);
    console.error(`\nAdd them to www/i18n/en.json and re-run npm run i18n:manifest.`);
    process.exit(1);
}

if (fallbackMismatches.length) {
    console.error('\n[i18n] literal English fallbacks disagree with en.json:\n');
    for (const [key, { value, file }] of fallbackMismatches) {
        console.error(`  ${key}\n      en.json:  ${JSON.stringify(base.strings[key])}`
            + `\n      fallback: ${JSON.stringify(value)} (${file})`);
    }
    process.exit(1);
}

console.log(`[i18n] all ${referenced.size} referenced key(s) exist in the base catalogue; `
    + `${literalFallbacks.size} literal fallback(s) match it.`);
