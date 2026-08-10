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

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const WWW = path.join(ROOT, 'www');

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

const sources = [];
for (const dir of [path.join(WWW, 'js'), WWW]) {
    for (const f of readdirSync(dir)) {
        if (f.endsWith('.js') || f.endsWith('.html')) sources.push(path.join(dir, f));
    }
}

const referenced = new Map();   // key -> first file that asks for it
for (const file of sources) {
    const text = readFileSync(file, 'utf8');
    const rel = path.relative(ROOT, file);
    const add = (k) => { if (KEYISH.test(k) && !referenced.has(k)) referenced.set(k, rel); };

    // t('key') / window.t('key'), but not inside a comment line.
    for (const line of text.split('\n')) {
        if (/^\s*(\*|\/\/)/.test(line)) continue;
        // window.t(...) is the usual call form, so a rule that simply forbids a
        // preceding dot misses every real call — which is how the first version
        // of this check passed while the key it was written for was absent.
        for (const m of line.matchAll(
            /(?:\bwindow\.t|(?:^|[^\w.])t)\(\s*['"]([\w.]+)['"]/g)) add(m[1]);
    }
    for (const m of text.matchAll(
        /data-i18n(?:-html|-title|-placeholder|-aria-label)?="([\w.]+)"/g)) add(m[1]);
}

const missing = [...referenced].filter(([k]) => !known.has(k));
const unused = [...known].filter((k) => !referenced.has(k) && !k.startsWith('__'));

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

console.log(`[i18n] all ${referenced.size} referenced key(s) exist in the base catalogue.`);
