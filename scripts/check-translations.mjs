/**
 * check-translations.mjs — reviewer punch list for translated catalogues.
 *
 *   node scripts/check-translations.mjs          # all locales
 *   node scripts/check-translations.mjs de ja    # just these
 *   node scripts/check-translations.mjs --strict # exit 1 on any finding
 *
 * This is a *reviewer aid*, not a gate. The completeness score already answers
 * "is every key filled in?" — and a machine-translated catalogue scores 100%
 * while still having dropped a sentence, translated a file extension, or
 * mangled a placeholder. Those are the failures a percentage cannot see, and
 * they are what a human reviewer should spend their time on.
 *
 * So the defaults are deliberately advisory: it prints where to look and exits
 * 0. Only --strict fails, for use once a locale is meant to be clean.
 *
 * The one thing it is careful about is not crying wolf. Sentence counting knows
 * about the danda (।) and the ideographic full stop (。); without them Bengali
 * and Hindi looked like they had dropped 44 sentences each when they had
 * dropped six, which is exactly the kind of false alarm that gets a tool
 * ignored.
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const I18N = path.join(ROOT, 'www', 'i18n');
const BASE = 'en';

/** Identifiers, not prose: translating these breaks what users type or search. */
const IDENTIFIERS = [
    '.srwb', '.ipynb', '.csv', '.zip', '.tar.gz', '.py',
    'SciREPL', 'Pyodide', 'webR', 'SWI-Prolog', 'Scittle', 'Fengari',
    'Python', 'Prolog', 'JavaScript', 'Bash', 'Lua', 'TypR', 'ClojureScript',
    'LaTeX', 'DOCX', 'HTML', 'Markdown', 'PyPI', 'SharedVFS',
];

/** Inline markup the renderer keeps; anything else is stripped at runtime. */
const ALLOWED_TAGS = new Set(['code', 'strong', 'em', 'b', 'i', 'br', 'a', 'span']);

/** Sentence terminators across the scripts we ship. */
const TERMINATORS = /[.!?。！？।॥؟…]+/g;

const read = (f) => JSON.parse(readFileSync(path.join(I18N, f), 'utf8'));
const stripTags = (s) => s.replace(/<[^>]+>/g, '');
const countSentences = (s) =>
    stripTags(s).split(TERMINATORS).filter((x) => x.trim()).length;
const placeholders = (s) => (s.match(/\{(\w+)\}/g) || []).sort().join(',');

const base = read(`${BASE}.json`).strings || {};

const args = process.argv.slice(2);
const strict = args.includes('--strict');
const wanted = args.filter((a) => !a.startsWith('--'));

const codes = readdirSync(I18N)
    .filter((f) => f.endsWith('.json') && f !== 'manifest.json' && !f.slice(0, -5).includes('.'))
    .map((f) => f.slice(0, -5))
    .filter((c) => c !== BASE)
    .filter((c) => !wanted.length || wanted.includes(c))
    .sort();

let total = 0;

for (const code of codes) {
    const cat = read(`${code}.json`);
    const s = cat.strings || {};
    const literal = new Set(s.__literal || []);
    const findings = [];

    for (const [key, eng] of Object.entries(base)) {
        if (key.startsWith('__') || literal.has(key)) continue;
        const tr = s[key];
        if (typeof tr !== 'string' || !tr.trim() || tr === eng) continue;

        if (placeholders(eng) !== placeholders(tr)) {
            findings.push([key, 'placeholders', `${placeholders(eng) || '—'} -> ${placeholders(tr) || '—'}`]);
        }

        const badTags = [...tr.matchAll(/<\/?([a-zA-Z0-9]+)/g)]
            .map((m) => m[1].toLowerCase())
            .filter((t) => !ALLOWED_TAGS.has(t));
        if (badTags.length) {
            findings.push([key, 'markup', `stripped at runtime: <${[...new Set(badTags)].join('>, <')}>`]);
        }

        const lost = IDENTIFIERS.filter((id) => eng.includes(id) && !tr.includes(id));
        if (lost.length) findings.push([key, 'identifier', `missing: ${lost.join(', ')}`]);

        const se = countSentences(eng);
        const st = countSentences(tr);
        if (se >= 2 && st < se) {
            findings.push([key, 'content', `${se} sentences in English, ${st} here — check for dropped detail`]);
        }
    }

    total += findings.length;
    const status = (cat.__meta || {}).status || 'draft';
    if (!findings.length) {
        console.log(`\n${code} (${status}): clean`);
        continue;
    }
    console.log(`\n${code} (${status}): ${findings.length} to review`);
    const byKind = {};
    for (const [, kind] of findings) byKind[kind] = (byKind[kind] || 0) + 1;
    console.log('  ' + Object.entries(byKind).map(([k, n]) => `${k}=${n}`).join('  '));
    for (const [key, kind, detail] of findings.slice(0, 12)) {
        console.log(`    [${kind}] ${key}\n        ${detail}`);
    }
    if (findings.length > 12) console.log(`    … and ${findings.length - 12} more`);
}

console.log(`\n${total} item(s) across ${codes.length} locale(s).`);
console.log(total
    ? 'These are pointers for a human reviewer, not proof of a defect.'
    : 'Nothing flagged.');

if (strict && total) process.exit(1);
