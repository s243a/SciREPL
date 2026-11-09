// Public Pro highlights only; full English notes remain the release-status source.
// No model requests and no writes unless --output is explicitly supplied.
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RELEASE_NOTE_CSS } from './render-free-release-notes.mjs';

export const PRO_RELEASE_VERSION = '1.5.0';
export const PRO_RELEASE_ROOT = 'https://s243a.github.io/SciREPL/pro/releases/';
export const PRO_NOTE_LOCALES = Object.freeze(['en', 'ar', 'bn', 'de', 'es', 'fr', 'hi', 'id', 'ja', 'ko', 'pt-BR', 'ru', 'zh']);
const SOURCE = new URL('../docs/releases/pro-1.5.0-highlights.json', import.meta.url);
const ENGLISH = new URL('../www/pro/releases/v1.5.0.html', import.meta.url);
const NAV_START = '<!-- BEGIN PRO RELEASE NOTE LANGUAGES -->';
const NAV_END = '<!-- END PRO RELEASE NOTE LANGUAGES -->';
const escapeHtml = text => text.replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]);
const direction = locale => locale === 'ar' ? 'rtl' : 'ltr';
export const proNotePath = locale => locale === 'en'
    ? `v${PRO_RELEASE_VERSION}.html` : `v${PRO_RELEASE_VERSION}/${locale}/index.html`;
export const proNoteUrl = locale => PRO_RELEASE_ROOT + (locale === 'en'
    ? proNotePath(locale) : `v${PRO_RELEASE_VERSION}/${locale}/`);

function plain(value, label) {
    if (typeof value !== 'string' || !value.trim() || value !== value.trim()
        || /[<>\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value)) {
        throw new Error(`${label}: expected nonempty plain text`);
    }
}

export function parseProHighlights(source) {
    const data = typeof source === 'string' ? JSON.parse(source) : source;
    if (!data || data.schemaVersion !== 1 || data.version !== PRO_RELEASE_VERSION
        || !data.locales || Object.keys(data.locales).join('|') !== PRO_NOTE_LOCALES.join('|')) {
        throw new Error('Expected the exact Pro release version and ordered locale allowlist');
    }
    for (const lang of PRO_NOTE_LOCALES) {
        const locale = data.locales[lang];
        if (!locale || locale.status !== (lang === 'en' ? 'source' : 'draft')) {
            throw new Error(`${lang}: target translations must remain draft`);
        }
        for (const key of ['name', 'title', 'notice', 'fullNotes', 'languages', 'tutorials']) plain(locale[key], `${lang}.${key}`);
        if (!Array.isArray(locale.bullets) || locale.bullets.length !== 4) throw new Error(`${lang}: expected four highlights`);
        locale.bullets.forEach((bullet, index) => plain(bullet, `${lang}.bullets[${index}]`));
        if (!locale.bullets[2].includes('Bash') || !locale.bullets[2].includes('Prolog')) {
            throw new Error(`${lang}: preserve the Bash and Prolog identifiers`);
        }
    }
    return data;
}

function navigation(data, current, english = false) {
    const locale = data.locales[current];
    return `<nav class="release-note-languages" aria-label="${escapeHtml(locale.languages)}" style="margin-block:2rem;padding:1rem;border:1px solid currentColor;border-radius:.5rem">
      <h2>${escapeHtml(locale.languages)}</h2>
      <ul style="display:flex;flex-wrap:wrap;gap:.5rem 1rem;list-style:none;padding:0">
${PRO_NOTE_LOCALES.map(lang => {
        const file = proNotePath(lang);
        const href = english ? file : (lang === 'en' ? `../../v${PRO_RELEASE_VERSION}.html` : `../${lang}/`);
        return `        <li><a href="${href}" lang="${lang}" dir="${direction(lang)}"${lang === current ? ' aria-current="page"' : ''} style="display:inline-flex;align-items:center;min-height:44px">${escapeHtml(data.locales[lang].name)}</a></li>`;
    }).join('\n')}
      </ul>
    </nav>`;
}

function bulletHtml(text, lang) {
    if (lang !== 'ar') return escapeHtml(text);
    return text.split(/(Bash|Prolog)/g).map((part, index) => index % 2
        ? `<bdi dir="ltr">${escapeHtml(part)}</bdi>` : escapeHtml(part)).join('');
}

export function renderProReleaseNotes(source, englishSource) {
    const data = parseProHighlights(source);
    if (typeof englishSource !== 'string' || !englishSource.includes('<html lang="en">')
        || !englishSource.includes(`href="${proNoteUrl('en')}"`) || !englishSource.includes('</main>')) {
        throw new Error('Full English source must retain its exact public canonical URL and main landmark');
    }
    const starts = englishSource.split(NAV_START).length - 1;
    const ends = englishSource.split(NAV_END).length - 1;
    if (starts !== ends || starts > 1) throw new Error('Malformed generated language navigation markers');
    let english = englishSource;
    if (starts) {
        const first = english.indexOf(NAV_START), last = english.indexOf(NAV_END) + NAV_END.length;
        english = english.slice(0, first) + english.slice(last);
    }
    // Whitespace is normalized only next to our own block. Full English prose,
    // status and validation limitations are otherwise preserved verbatim.
    english = english.replace(/\s*<\/main>/, `\n    ${NAV_START}\n    ${navigation(data, 'en', true)}\n    ${NAV_END}\n    </main>`);
    const pages = new Map([[proNotePath('en'), english]]);
    for (const lang of PRO_NOTE_LOCALES.slice(1)) {
        const locale = data.locales[lang];
        const canonical = proNoteUrl(lang);
        const fullNotes = `../../v${PRO_RELEASE_VERSION}.html`;
        pages.set(proNotePath(lang), `<!doctype html>
<html lang="${lang}" dir="${direction(lang)}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="scirepl-translation-status" content="draft">
  <title>SciREPL Pro ${PRO_RELEASE_VERSION} · ${escapeHtml(locale.title)}</title>
  <link rel="canonical" href="${canonical}">
${PRO_NOTE_LOCALES.map(other => `  <link rel="alternate" hreflang="${other}" href="${proNoteUrl(other)}">`).join('\n')}
  <link rel="alternate" hreflang="x-default" href="${proNoteUrl('en')}">
  <style>${RELEASE_NOTE_CSS}</style>
</head>
<body>
  <main>
    <h1><bdi dir="ltr">SciREPL Pro ${PRO_RELEASE_VERSION}</bdi> <span>${escapeHtml(locale.title)}</span></h1>
    <p role="note">${escapeHtml(locale.notice)}</p>
    <ul class="notes">
${locale.bullets.map(bullet => `      <li>${bulletHtml(bullet, lang)}</li>`).join('\n')}
    </ul>
    <p><a href="${fullNotes}">${escapeHtml(locale.fullNotes)}</a></p>
    <p><a href="../../../../help/${lang}/tutorials/">${escapeHtml(locale.tutorials)}</a></p>
    ${navigation(data, lang)}
  </main>
</body>
</html>
`);
    }
    return pages;
}

function writePages(directory, pages) {
    const root = resolve(directory);
    mkdirSync(root, { recursive: true });
    if (!lstatSync(root).isDirectory()) throw new Error('Output must be a real directory');
    // Validate every existing component before any output is replaced.
    for (const relative of pages.keys()) {
        const parts = relative.split('/');
        for (let index = 0; index < parts.length; index++) {
            const path = join(root, ...parts.slice(0, index + 1));
            const stat = lstatSync(path, { throwIfNoEntry: false });
            if (stat && (index === parts.length - 1 ? !stat.isFile() : !stat.isDirectory())) {
                throw new Error(`Output must not traverse a symlink or non-regular path: ${path}`);
            }
        }
    }
    for (const [relative, html] of pages) {
        const target = join(root, relative);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, html, 'utf8');
    }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const args = process.argv.slice(2);
    try {
        const pages = renderProReleaseNotes(readFileSync(SOURCE, 'utf8'), readFileSync(ENGLISH, 'utf8'));
        if (args.length === 1 && args[0] === '--check') {
            const root = fileURLToPath(new URL('../www/pro/releases/', import.meta.url));
            for (const [file, html] of pages) {
                if (readFileSync(join(root, file), 'utf8') !== html) throw new Error(`Stale generated Pro notes: ${file}`);
            }
            console.log(`Pro highlights: ${pages.size} locale routes are fresh (12 draft translations).`);
        } else if (args.length === 2 && args[0] === '--output' && args[1].trim() && !args[1].startsWith('--')) {
            writePages(args[1], pages);
            console.log(`Rendered ${pages.size} Pro note routes to ${resolve(args[1])}`);
        } else {
            throw new Error('Usage: node scripts/render-pro-release-notes.mjs --check | --output DIR');
        }
    } catch (error) { console.error(error.message); process.exitCode = 1; }
}
