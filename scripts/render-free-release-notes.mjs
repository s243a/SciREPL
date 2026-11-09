// Website-only Free 1.5.0 release notes. Never writes into www by default.
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const RELEASE_ROOT = 'https://s243a.github.io/SciREPL/help/releases/v1.5.0/';
const PRODUCT = 'SciREPL Free 1.5.0';
const SOURCE = new URL('../docs/releases/1.5.0-play-notes.txt', import.meta.url);

// [Play tag, app route / language tag, autonym, title, language navigation]
const LOCALES = [
    ['en-US', 'en', 'English', 'Release notes', 'Languages'],
    ['ar', 'ar', 'العربية', 'ملاحظات الإصدار', 'اللغات'],
    ['bn-BD', 'bn', 'বাংলা', 'সংস্করণ নোট', 'ভাষা'],
    ['de-DE', 'de', 'Deutsch', 'Versionshinweise', 'Sprachen'],
    ['es-ES', 'es', 'Español', 'Notas de la versión', 'Idiomas'],
    ['fr-FR', 'fr', 'Français', 'Notes de version', 'Langues'],
    ['hi-IN', 'hi', 'हिन्दी', 'रिलीज़ नोट्स', 'भाषाएँ'],
    ['id', 'id', 'Bahasa Indonesia', 'Catatan rilis', 'Bahasa'],
    ['ja-JP', 'ja', '日本語', 'リリースノート', '言語'],
    ['ko-KR', 'ko', '한국어', '릴리스 노트', '언어'],
    ['pt-BR', 'pt-BR', 'Português (Brasil)', 'Notas da versão', 'Idiomas'],
    ['ru-RU', 'ru', 'Русский', 'Примечания к выпуску', 'Языки'],
    ['zh-CN', 'zh', '简体中文', '发行说明', '语言'],
].map(([play, lang, name, title, languages]) => ({ play, lang, name, title, languages }));

const TOKENS = ['Free', '#!source', 'Prolog', '[object Object]', 'Matplotlib'];
const escapeHtml = value => value.replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]);
const dir = lang => lang === 'ar' ? 'rtl' : 'ltr';
const route = lang => lang === 'en' ? '' : `${lang}/`;
const rtlLiterals = /(#!source|\[object Object\]|%pip install(?: matplotlib)?|\b(?:Free|Prolog|Matplotlib)\b)/g;

function renderBullet(bullet, lang) {
    if (dir(lang) !== 'rtl') return escapeHtml(bullet);
    return bullet.split(rtlLiterals).map((part, index) =>
        index % 2 ? `<bdi dir="ltr">${escapeHtml(part)}</bdi>` : escapeHtml(part)).join('');
}

/** Read the ordered, explicitly tagged Play source without dropping any prose. */
export function parsePlayReleaseNotes(source) {
    if (typeof source !== 'string') throw new TypeError('Play notes must be text');
    const lines = source.replace(/\r\n/g, '\n').split('\n');
    let cursor = 0;
    const skipEmpty = () => { while (lines[cursor] === '') cursor++; };
    const notes = [];
    for (const locale of LOCALES) {
        skipEmpty();
        if (lines[cursor++] !== `<${locale.play}>`) {
            throw new Error(`Expected release notes tag <${locale.play}>`);
        }
        const bullets = lines.slice(cursor, cursor + 4);
        cursor += 4;
        if (bullets.length !== 4 || bullets.some(line =>
            !line.startsWith('• ') || !line.slice(2).trim() || line !== line.trim() ||
            /[<>\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(line))) {
            throw new Error(`${locale.play}: expected four safe, nonempty plain-text bullets`);
        }
        if (lines[cursor++] !== `</${locale.play}>`) {
            throw new Error(`Expected release notes closing tag </${locale.play}>`);
        }
        const body = bullets.join('\n');
        if (body.length > 500 || [...body].length > 500) {
            throw new Error(`${locale.play}: notes exceed 500 characters`);
        }
        for (const token of TOKENS) {
            if (!body.includes(token)) throw new Error(`${locale.play}: missing ${token}`);
        }
        notes.push({ ...locale, bullets: bullets.map(line => line.slice(2)) });
    }
    skipEmpty();
    if (cursor !== lines.length) throw new Error('Unexpected text after release notes');
    return notes;
}

export const RELEASE_NOTE_CSS = `
  :root { color-scheme: light dark; --paper: #fff; --page: #f3f6fb; --ink: #182335; --link: #154483; --border: #bbc8da; }
  @media (prefers-color-scheme: dark) {
    :root { --paper: #182335; --page: #101927; --ink: #f1f5fc; --link: #add0ff; --border: #61718a; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; padding: clamp(1rem, 4vw, 3rem); background: var(--page); color: var(--ink); font: 1rem/1.6 system-ui, sans-serif; overflow-wrap: anywhere; }
  main { max-inline-size: 48rem; margin-inline: auto; padding: clamp(1rem, 4vw, 2.5rem); border: 1px solid var(--border); border-radius: .75rem; background: var(--paper); }
  h1 { margin-block: 0 1rem; line-height: 1.25; font-size: clamp(1.45rem, 5vw, 2.25rem); }
  h1 span { display: block; margin-block-start: .35rem; font-size: .72em; }
  h2 { margin-block: 0 .5rem; font-size: 1.15rem; }
  .notes { padding-inline-start: 1.4rem; }
  .notes li + li { margin-block-start: .6rem; }
  nav { margin-block-start: 1.5rem; padding-block-start: 1rem; border-block-start: 1px solid var(--border); }
  nav ul { display: flex; flex-wrap: wrap; gap: .35rem .75rem; padding: 0; margin: 0; list-style: none; }
  nav a { display: inline-flex; align-items: center; justify-content: center; min-block-size: 2.75rem; min-inline-size: 2.75rem; padding-inline: .3rem; color: var(--link); text-underline-offset: .18em; }
  nav a[aria-current="page"] { font-weight: 700; }
  a:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }
`;

/** Return fixed relative output paths mapped to complete, standalone HTML. */
export function renderReleaseNotes(source) {
    return new Map(parsePlayReleaseNotes(source).map(locale => {
        const { lang, title, languages, bullets } = locale;
        const canonical = RELEASE_ROOT + route(lang);
        const alternates = LOCALES.map(other =>
            `  <link rel="alternate" hreflang="${other.lang}" href="${RELEASE_ROOT}${route(other.lang)}">`).join('\n');
        const navigation = LOCALES.map(other => {
            const href = other.lang === lang ? './' : (lang === 'en' ? './' : '../') + route(other.lang);
            return `        <li><a href="${href}" lang="${other.lang}" dir="${dir(other.lang)}"${other.lang === lang ? ' aria-current="page"' : ''}>${escapeHtml(other.name)}</a></li>`;
        }).join('\n');
        const items = bullets.map(bullet => `      <li>${renderBullet(bullet, lang)}</li>`).join('\n');
        return [`${route(lang)}index.html`, `<!doctype html>
<html lang="${lang}" dir="${dir(lang)}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(`${PRODUCT} · ${title}`)}</title>
  <link rel="canonical" href="${canonical}">
${alternates}
  <link rel="alternate" hreflang="x-default" href="${RELEASE_ROOT}">
  <style>${RELEASE_NOTE_CSS}</style>
</head>
<body>
  <main>
    <h1><bdi dir="ltr">${PRODUCT}</bdi> <span>${escapeHtml(title)}</span></h1>
    <ul class="notes">
${items}
    </ul>
    <nav aria-label="${escapeHtml(languages)}">
      <h2>${escapeHtml(languages)}</h2>
      <ul>
${navigation}
      </ul>
    </nav>
  </main>
</body>
</html>
`];
    }));
}

function writePages(directory, pages) {
    const root = resolve(directory);
    mkdirSync(root, { recursive: true });
    if (!lstatSync(root).isDirectory()) throw new Error('Output must be a real directory');
    // Reject existing symlinks and non-file destinations before replacing any
    // generated page. Locale directory names come only from the allowlist.
    for (const file of pages.keys()) {
        const [first, second] = file.split('/');
        if (second) {
            const localeDir = join(root, first);
            const stat = lstatSync(localeDir, { throwIfNoEntry: false });
            if (stat && !stat.isDirectory()) throw new Error(`Not a real output directory: ${localeDir}`);
        }
        const target = join(root, file);
        const stat = lstatSync(target, { throwIfNoEntry: false });
        if (stat && !stat.isFile()) throw new Error(`Not a regular output file: ${target}`);
    }
    for (const [file, html] of pages) {
        const [first, second] = file.split('/');
        if (second) mkdirSync(join(root, first), { recursive: true });
        writeFileSync(join(root, file), html, 'utf8');
    }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const args = process.argv.slice(2);
    if (args.length !== 2 || args[0] !== '--output' || !args[1].trim() || args[1].startsWith('--')) {
        console.error('Usage: node scripts/render-free-release-notes.mjs --output DIR');
        process.exitCode = 1;
    } else {
        try {
            const pages = renderReleaseNotes(readFileSync(SOURCE, 'utf8'));
            writePages(args[1], pages);
            console.log(`Rendered ${pages.size} Free 1.5.0 release-note pages to ${resolve(args[1])}`);
        } catch (error) {
            console.error(error.message);
            process.exitCode = 1;
        }
    }
}
