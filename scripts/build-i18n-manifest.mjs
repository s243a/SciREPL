/**
 * build-i18n-manifest.mjs — precompute the locale index.
 *
 * i18n.js needs to know, before the user opens the language picker, which
 * locales exist, how complete each one is, and whether it has been reviewed.
 * It used to work that out by fetching every catalogue at startup — fine at two
 * locales, twenty HTTP requests on every launch at twenty.
 *
 * This computes the same information once, at build time, so the running app
 * fetches one small manifest plus the single catalogue it actually uses.
 *
 *   node scripts/build-i18n-manifest.mjs
 *
 * Run it after adding or editing a catalogue. CI checks it is current.
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const I18N_DIR = path.join(ROOT, 'www', 'i18n');
const MANIFEST = path.join(I18N_DIR, 'manifest.json');
const BASE = 'en';

/** Same scoring rule as i18n.js: a value identical to English is untranslated. */
function score(baseStrings, strings) {
    const literal = new Set(strings.__literal || []);
    const keys = Object.keys(baseStrings).filter((k) => !k.startsWith('__') && !literal.has(k));
    if (!keys.length) return 1;
    let done = 0;
    for (const k of keys) {
        const v = strings[k];
        if (typeof v === 'string' && v.trim() && v !== baseStrings[k]) done++;
    }
    return done / keys.length;
}

function read(code) {
    return JSON.parse(readFileSync(path.join(I18N_DIR, `${code}.json`), 'utf8'));
}

const codes = readdirSync(I18N_DIR)
    .filter((f) => f.endsWith('.json') && f !== 'manifest.json')
    .map((f) => f.replace(/\.json$/, ''))
    // Domain catalogues (privacy.*) are indexed separately below.
    .filter((c) => !c.includes('.'));

const base = read(BASE);

/**
 * Sense vocabulary. A short mnemonic names a word sense once ("Cell-Notebook"),
 * and strings point at it, rather than every string re-explaining that "cell"
 * is not the biological kind. A locale then commits to one term per sense in
 * its __glossary, which is what makes terminology consistency reviewable.
 *
 * Only the reference integrity is enforced: a typo'd sense id is a bug and
 * fails the build. Whether a translation actually *uses* its declared term is
 * deliberately NOT checked — inflection, agglutination and scripts without word
 * boundaries make substring matching produce confident nonsense. The glossary
 * is a decision record for the reviewer, not a lint rule.
 */
const SENSES = base.__senses || {};
const senseErrors = [];
for (const [key, ids] of Object.entries(base.__senseOf || {})) {
    if (!(base.strings || {})[key]) senseErrors.push(`__senseOf: no such string "${key}"`);
    for (const id of ids) {
        if (!SENSES[id]) senseErrors.push(`__senseOf["${key}"]: unknown sense "${id}"`);
    }
}
if (senseErrors.length) {
    console.error('[i18n] sense vocabulary errors:');
    for (const e of senseErrors) console.error(`       ${e}`);
    process.exit(1);
}

/** Which senses a locale has committed to a term for. */
function glossaryCoverage(cat) {
    const g = cat.__glossary || {};
    const ids = Object.keys(SENSES);
    const unknown = Object.keys(g).filter((k) => !SENSES[k]);
    return {
        defined: ids.filter((id) => typeof g[id] === 'string' && g[id].trim()).length,
        total: ids.length,
        unknown,
    };
}

const locales = [];

for (const code of codes.sort()) {
    const cat = read(code);
    const meta = cat.__meta || {};
    const completeness = code === BASE ? 1 : score(base.strings || {}, cat.strings || {});

    // A domain catalogue may be reviewed on a different schedule from the UI —
    // privacy text in particular is legal copy and is gated separately.
    const domains = {};
    for (const f of readdirSync(I18N_DIR)) {
        const m = f.match(/^([a-z]+)\.([\w-]+)\.json$/);
        if (m && m[2] === code) {
            const d = JSON.parse(readFileSync(path.join(I18N_DIR, f), 'utf8'));
            domains[m[1]] = { status: (d.__meta || {}).status || 'draft' };
        }
    }

    const glossary = code === BASE ? null : glossaryCoverage(cat);
    if (glossary && glossary.unknown.length) {
        console.error(`[i18n] ${code}: __glossary has unknown sense id(s): ${glossary.unknown.join(', ')}`);
        process.exit(1);
    }

    locales.push({
        code,
        endonym: meta.endonym || code,
        dir: meta.dir || 'ltr',
        status: meta.status || 'draft',
        completeness: Math.round(completeness * 1000) / 1000,
        ...(glossary ? { glossary: { defined: glossary.defined, total: glossary.total } } : {}),
        ...(Object.keys(domains).length ? { domains } : {}),
    });
}

const manifest = {
    generatedBy: 'scripts/build-i18n-manifest.mjs',
    base: BASE,
    senses: Object.keys(SENSES).sort(),
    locales,
};

const serialised = JSON.stringify(manifest, null, 2) + '\n';

if (process.argv.includes('--check')) {
    let current = '';
    try { current = readFileSync(MANIFEST, 'utf8'); } catch { /* missing */ }
    if (current !== serialised) {
        console.error('[i18n] manifest.json is out of date.\n' +
            '       Run: node scripts/build-i18n-manifest.mjs');
        process.exit(1);
    }
    console.log('[i18n] manifest.json is up to date.');
    process.exit(0);
}

writeFileSync(MANIFEST, serialised);
console.log(`[i18n] wrote manifest.json for ${locales.length} locale(s):`);
for (const l of locales) {
    console.log(`  ${l.code.padEnd(6)} ${String(Math.round(l.completeness * 100) + '%').padStart(4)}  ${l.status}` +
        (l.glossary ? `  glossary: ${l.glossary.defined}/${l.glossary.total}` : '') +
        (l.domains ? `  domains: ${Object.entries(l.domains).map(([k, v]) => `${k}=${v.status}`).join(', ')}` : ''));
}
