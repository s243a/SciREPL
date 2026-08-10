/**
 * check-i18n-html-ids.mjs — stop localization from deleting scripted elements.
 *
 *   node scripts/check-i18n-html-ids.mjs
 *
 * Translating an element replaces its contents: `data-i18n` assigns
 * textContent, `data-i18n-html` assigns sanitised innerHTML. Either way, any
 * element nested inside is destroyed and rebuilt from the catalogue — without
 * its id, and without whatever listeners were attached to it.
 *
 * That is not hypothetical. The Privacy Policy link lived inside a
 * `data-i18n-html` paragraph; the first locale application replaced the
 * paragraph, the link lost its id, and the bootstrap code then called
 * addEventListener on null. The exception stopped startup before notebook
 * restoration ran, so the user's cells silently failed to come back. The
 * symptom (lost work on reload) was several steps away from the cause
 * (a translated string containing markup), which is exactly the kind of link
 * a person will not make twice in a row.
 *
 * So: an element that gets translated must not contain anything the code
 * addresses by id. Put `data-i18n` on the inner element instead — translate the
 * link's own text, and the link itself survives.
 */

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const WWW = path.join(ROOT, 'www');

/** Elements carrying a translation directive, with their inner markup. */
const TRANSLATED = /<([a-zA-Z0-9]+)((?:[^>"']|"[^"]*"|'[^']*')*?\bdata-i18n(?:-html)?\s*=\s*"([^"]+)"(?:[^>"']|"[^"]*"|'[^']*')*)>/g;

function findEnd(html, from, tag) {
    // Walk nested same-tag pairs so a <p> inside a <p> cannot end it early.
    const re = new RegExp(`<${tag}\\b|</${tag}>`, 'gi');
    re.lastIndex = from;
    let depth = 1, m;
    while ((m = re.exec(html))) {
        if (m[0][1] === '/') { depth--; if (!depth) return m.index; }
        else depth++;
    }
    return -1;
}

const problems = [];

for (const file of readdirSync(WWW).filter((f) => f.endsWith('.html'))) {
    const html = readFileSync(path.join(WWW, file), 'utf8');
    let m;
    TRANSLATED.lastIndex = 0;
    while ((m = TRANSLATED.exec(html))) {
        const [full, tag, , key] = m;
        const start = m.index + full.length;
        const end = findEnd(html, start, tag);
        if (end < 0) continue;
        const inner = html.slice(start, end);

        for (const idMatch of inner.matchAll(/<([a-zA-Z0-9]+)[^>]*\bid="([\w-]+)"/g)) {
            problems.push({
                file,
                key,
                outer: tag,
                inner: idMatch[1],
                id: idMatch[2],
            });
        }
    }
}

if (problems.length) {
    console.error('[i18n] translated elements contain id-bearing markup, which is '
        + 'destroyed the first time a locale is applied:\n');
    for (const p of problems) {
        console.error(`  ${p.file}: <${p.outer} data-i18n="${p.key}"> contains `
            + `<${p.inner} id="${p.id}">`);
        console.error(`      Move the translation onto the inner element:`);
        console.error(`      <${p.inner} id="${p.id}" data-i18n="${p.key}">…</${p.inner}>\n`);
    }
    console.error(`${problems.length} problem(s). See scripts/check-i18n-html-ids.mjs.`);
    process.exit(1);
}

console.log('[i18n] no translated element contains id-bearing markup.');
