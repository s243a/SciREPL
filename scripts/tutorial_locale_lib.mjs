import { createHash } from 'node:crypto';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA = path.join(ROOT, 'docs', 'tutorial-localization');
export const ORIGIN = 'https://s243a.github.io';
export const BASE = '/SciREPL/';
export const LOCALES = ['en', 'ar', 'bn', 'de', 'es', 'fr', 'hi', 'id', 'ja', 'ko', 'pt-BR', 'ru', 'zh'];
export const NAMES = { en: 'English', ar: 'العربية', bn: 'বাংলা', de: 'Deutsch', es: 'Español', fr: 'Français', hi: 'हिन्दी', id: 'Bahasa Indonesia', ja: '日本語', ko: '한국어', 'pt-BR': 'Português (Brasil)', ru: 'Русский', zh: '简体中文' };
export const ROUTES = ['tutorials', 'interface/tutorial', 'interface/appearance', 'files-export/tutorial', 'workbooks/tutorial', 'workbooks/import', 'workbooks/graphics', 'workbooks/named-cells', 'pro/ai/tutorial'];
const BLOCKS = new Set(['title', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'figcaption', 'th', 'td', 'dt', 'dd', 'summary', 'button', 'label', 'option']);
const SKIP = new Set(['script', 'style', 'pre', 'code', 'kbd', 'svg', 'math', 'textarea']);
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
export const sha = value => createHash('sha256').update(value).digest('hex');
export const escapeText = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
export const escapeAttr = value => escapeText(value).replaceAll('"', '&quot;').replaceAll("'", '&#39;');
export function decode(value) {
  const names = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', ndash: '–', mdash: '—', hellip: '…', rarr: '→', times: '×', minus: '−' };
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, entity) => entity[0] === '#' ? String.fromCodePoint(entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1))) : (names[entity] ?? all));
}

// Source offsets, not a DOM serializer, preserve executable examples byte for byte.
export function scan(html) {
  const root = { tag: '#root', start: 0, innerStart: 0, end: html.length, innerEnd: html.length, children: [], parent: null };
  const stack = [root];
  const tokens = [];
  const matcher = /<!--[\s\S]*?-->|<![^>]*>|<\/?[a-zA-Z][^>"']*(?:"[^"]*"[^>"']*|'[^']*'[^>"']*)*>/g;
  let last = 0;
  for (const match of html.matchAll(matcher)) {
    if (match.index > last) tokens.push({ type: 'text', start: last, end: match.index, parent: stack.at(-1) });
    const raw = match[0];
    const closing = /^<\//.test(raw);
    const tag = (raw.match(/^<\/?([\w-]+)/) || [])[1]?.toLowerCase();
    const token = { type: 'tag', tag, raw, start: match.index, end: match.index + raw.length, parent: stack.at(-1) };
    tokens.push(token);
    if (tag && closing) {
      const index = stack.findLastIndex(node => node.tag === tag);
      if (index > 0) {
        const node = stack[index]; node.innerEnd = match.index; node.end = token.end;
        stack.splice(index);
      }
    } else if (tag) {
      const node = { ...token, innerStart: token.end, innerEnd: token.end, children: [], parent: stack.at(-1) };
      stack.at(-1).children.push(node);
      token.node = node;
      if (!VOID.has(tag) && !/\/>$/.test(raw)) stack.push(node);
    }
    last = token.end;
  }
  if (last < html.length) tokens.push({ type: 'text', start: last, end: html.length, parent: stack.at(-1) });
  return { root, tokens };
}
export function attributes(raw, offset = 0) {
  return [...raw.matchAll(/\b([\w:-]+)\s*=\s*(["'])([\s\S]*?)\2/g)].map(match => ({ name: match[1].toLowerCase(), value: match[3], start: offset + match.index + match[0].indexOf(match[2]) + 1, end: offset + match.index + match[0].length - 1 }));
}
const ancestors = node => { const out = []; while (node) { out.push(node); node = node.parent; } return out; };
const descendants = node => node.children.flatMap(child => [child, ...descendants(child)]);

export function makeUiGlossary(proRoot) {
  const catalogs = {};
  for (const edition of ['free', 'pro']) {
    const dir = edition === 'free' ? path.join(ROOT, 'www', 'i18n') : proRoot;
    if (!dir || !existsSync(path.join(dir, 'en.json'))) continue;
    catalogs[edition] = Object.fromEntries(LOCALES.map(locale => [locale, JSON.parse(readFileSync(path.join(dir, `${locale}.json`), 'utf8')).strings]));
  }
  const result = {};
  const preferred = /^(?:aiSecurity\.|aiSettings\.|aiPanel\.|completion\.|autocomplete\.|chips\.|localModel\.|aiSuggest\.|menu\.|common\.|appearance\.|files\.|fileIo\.|notebook\.|cell\.|tour\.)/;
  for (const [edition, all] of Object.entries(catalogs)) {
    const entries = Object.entries(all.en || {}).sort(([a], [b]) => Number(preferred.test(b)) - Number(preferred.test(a)) || a.localeCompare(b));
    for (const [key, raw] of entries) {
      if (typeof raw !== 'string' || raw.length > 65 || /[<>{}\n]/.test(raw) || !/[a-z]/i.test(raw)) continue;
      const english = raw.trim().replace(/:$/, '');
      if (result[english]) continue;
      if (LOCALES.some(locale => typeof all[locale]?.[key] !== 'string')) continue;
      result[english] = { edition, key, values: Object.fromEntries(LOCALES.map(locale => [locale, all[locale][key].trim().replace(/:$/, '')])) };
    }
  }
  return result;
}

function protectFragment(raw, ui, attribute = false, route = '', prompt = false) {
  const protectedSpans = [];
  const save = (value, kind = 'literal', extra = {}) => {
    const token = `{{P${String(protectedSpans.length).padStart(3, '0')}}}`;
    protectedSpans.push({ token, value, kind, ...extra }); return token;
  };
  let text = raw;
  if (prompt) {
    // This list is specific to the three reviewed prose prompts, not a general
    // guess at programming syntax. Preserve the exact generator and formulas.
    const literals = [
      'state = (16807 * state) % 2147483647',
      '1 + Math.floor(20 * state / 2147483647)',
      'state = 42', 'u = state / 2147483647',
      'sqrt(-2 * log(u1)) * cos(2 * PI * u2)',
      'sum((x - mean)^2) / 9', 'N(0,1)',
      'window.renderImage(canvas.toDataURL("image/png"))',
    ];
    for (const literal of literals) text = text.replaceAll(literal, () => save(literal, 'literal'));
    text = text.replace(/\b(?:summary_demo|variance_plot|Math\.random|Math\.floor|console\.log|state)\b/g, value => save(value, 'literal'));
  }
  if (!attribute) {
    text = text.replace(/<(code|kbd|pre|script|style|svg|math)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, value => save(value, 'html'));
    text = text.replace(/<strong\b([^>]*)>([^<>]+)<\/strong>/gi, (whole, attrs, contents) => {
      const label = decode(contents).trim();
      // "Open" is a security preset only in the AI lesson. Elsewhere it can
      // be an Android file-picker verb, whose translation is not that preset.
      const control = value => ui[value] && !(value === 'Open' && route !== 'pro/ai/tutorial');
      if (label.includes('→')) {
        const parts = contents.split('→').map(part => {
          const name = decode(part).trim();
          if (!control(name)) return part;
          return part.replace(part.trim(), save(name, 'ui-text', { label: name, glossary: ui[name] }));
        });
        return `<strong${attrs}>${parts.join('→')}</strong>`;
      }
      if (!control(label)) return whole;
      return save(whole, 'ui', { label, glossary: ui[label] });
    });
    text = text.replace(/<!--[\s\S]*?-->|<[^>]+>/g, value => save(value, 'html'));
  }
  text = decode(text);
  text = text.replace(/\\\([\s\S]*?\\\)|\\\[[\s\S]*?\\\]|https?:\/\/[^\s<]+|\b(?:SciREPL(?: Pro)?|sciREPL|JavaScript|Python|Prolog|Markdown|KaTeX|GLM 5\.3 Flash|GPT-6 Luna|Claude Haiku 5\.5|DeepSeek V4 Flash|OpenRouter|Google Play|GitHub|Galaxy S24\+|S24\+|S10\+|Pyodide|webR|Fengari|NumPy|JSON|CSV|API|MCP|UPS|Bash|Lua|TypR|ClojureScript|[23]D|Free|Pro)\b|\.?\b[\w-]+\.(?:srwb|ipynb|csv|zip|json|png|svg|html|js)\b|\b\d+(?:[.,]\d+)*(?:%|\+)?\b|[<>]/g, value => save(value));
  return { text, protectedSpans };
}

export function extractPage(route, html, ui = {}) {
  const { root, tokens } = scan(html);
  const all = descendants(root);
  const prompts = all.filter(node => node.tag === 'pre' && attributes(node.raw).some(attr => attr.name === 'data-translatable-prompt'));
  const promptContainers = new Set(prompts.flatMap(node => [node, ...descendants(node)]));
  const blocks = all.filter(node => BLOCKS.has(node.tag) && !ancestors(node.parent).some(parent => SKIP.has(parent.tag)) && !descendants(node).some(child => BLOCKS.has(child.tag) || promptContainers.has(child)
    || attributes(child.raw).some(attr => ['alt', 'title', 'aria-label', 'placeholder'].includes(attr.name))));
  const spans = blocks.map(node => ({ start: node.innerStart, end: node.innerEnd, kind: 'html-text', tag: node.tag }));
  for (const prompt of prompts) {
    const code = prompt.children.find(node => node.tag === 'code');
    if (!code || code.children.length || prompt.children.length !== 1) throw new Error(`${route}: a translatable prompt must contain only one plain prose code wrapper`);
    spans.push({ start: code.innerStart, end: code.innerEnd, kind: 'prompt-text', tag: 'practice-prompt' });
  }
  for (const token of tokens) {
    if (token.type === 'text' && !promptContainers.has(token.parent) && !ancestors(token.parent).some(node => SKIP.has(node.tag) || /\bclass=["'][^"']*\bbrand\b/.test(node.raw || '')) && !spans.some(span => token.start >= span.start && token.end <= span.end)) spans.push({ start: token.start, end: token.end, kind: 'html-text', tag: token.parent.tag });
    if (token.type === 'tag' && !/^<\//.test(token.raw) && !ancestors(token.parent).some(node => SKIP.has(node.tag))) {
      for (const attr of attributes(token.raw, token.start)) {
        if (['alt', 'title', 'aria-label', 'placeholder'].includes(attr.name) || token.tag === 'meta' && /name=["']description["']/.test(token.raw) && attr.name === 'content') spans.push({ ...attr, kind: 'attribute', tag: token.tag });
      }
    }
  }
  const fields = [];
  for (const span of spans.sort((a, b) => a.start - b.start)) {
    const source = html.slice(span.start, span.end);
    const leading = source.match(/^\s*/)[0], trailing = source.match(/\s*$/)[0];
    const raw = source.slice(leading.length, source.length - trailing.length || undefined);
    const protectedField = protectFragment(raw, ui, span.kind === 'attribute', route, span.kind === 'prompt-text');
    if (!protectedField.text.replace(/\{\{P\d{3}\}\}/g, '').trim() || !/[\p{L}]/u.test(protectedField.text.replace(/\{\{P\d{3}\}\}/g, ''))) continue;
    const id = `${route.replaceAll('/', '.')}.${String(fields.length + 1).padStart(4, '0')}`;
    fields.push({ id, ...span, source, leading, trailing, sourceHash: sha(source), ...protectedField });
  }
  for (let index = 1; index < fields.length; index++) if (fields[index - 1].end > fields[index].start) throw new Error(`Overlapping fields: ${fields[index - 1].id}, ${fields[index].id}`);
  return { route, sourceHash: sha(html), fields };
}

export function validateText(field, translated, { allowSource = false } = {}) {
  if (typeof translated !== 'string' || !translated.trim()) throw new Error(`${field.id}: empty or non-string translation`);
  if (/[<>]/.test(translated)) throw new Error(`${field.id}: translators may not supply HTML`);
  if (/\p{Cc}/u.test(translated.replace(/[\n\r\t]/g, ''))) throw new Error(`${field.id}: control character`);
  if (/[\uFFFD\u202A-\u202E\u2066-\u2069]/u.test(translated)) throw new Error(`${field.id}: replacement or hidden bidi control`);
  const got = translated.match(/\{\{P\d{3}\}\}/g) || [];
  const expected = field.text.match(/\{\{P\d{3}\}\}/g) || [];
  if (JSON.stringify(got) !== JSON.stringify(expected)) throw new Error(`${field.id}: protected tokens missing, changed, duplicated, or reordered`);
  if (/\{\{(?!P\d{3}\}\})/.test(translated)) throw new Error(`${field.id}: unknown placeholder`);
  const withoutTokens = value => value.replace(/\{\{P\d{3}\}\}/g, '');
  if (JSON.stringify(withoutTokens(translated).match(/\p{N}+/gu) || []) !== JSON.stringify(withoutTokens(field.text).match(/\p{N}+/gu) || [])) throw new Error(`${field.id}: unprotected numeric values added or changed`);
  if (!allowSource && translated.trim() === field.text.trim() && /[a-zA-Z]{4}/.test(withoutTokens(field.text))) throw new Error(`${field.id}: substantive prose was not translated; an explicit reviewed keep declaration is required`);
  return true;
}

export function validateKeep(field, reason) {
  if (typeof reason !== 'string' || reason.length < 12) throw new Error(`${field.id}: a reviewed keep needs a substantive reason`);
  // This sole long label is the actual selector title of the explicitly chosen
  // English companion workbook, not untranslated prose. Pin both metadata and
  // source bytes; no other title, field or paragraph receives an exemption.
  const operationalTitle = 'Markov Groups: A Random Walk on Cube Moves';
  const operationalHash = 'd02073d0cfe1eba58a30788da919516205f791dbeaedc199ddccfa5adf47c767';
  if (field.id === 'workbooks.tutorial.0067' && field.kind === 'html-text' && field.tag === 'strong'
      && field.sourceHash === operationalHash && field.text === operationalTitle && typeof field.source === 'string'
      && sha(field.source) === operationalHash && decode(field.source) === operationalTitle
      && Array.isArray(field.protectedSpans) && field.protectedSpans.length === 0) return true;
  const prose = field.text.replace(/\{\{P\d{3}\}\}/g, '').trim();
  const words = prose.match(/[\p{L}\p{N}_-]+/gu) || [];
  if (prose.length > 35 || words.length > 3 || /[.?!]/.test(prose)) throw new Error(`${field.id}: unchanged English sentences/paragraphs cannot be sanctioned as label keeps`);
  return true;
}

export function renderField(field, translated, locale, options = {}) {
  if (locale !== 'en' && options.keepReason !== undefined) validateKeep(field, options.keepReason);
  validateText(field, translated, { allowSource: locale === 'en' || Boolean(options.keepReason) });
  let escaped = field.kind === 'attribute' ? escapeAttr(translated) : escapeText(translated);
  for (const span of field.protectedSpans) {
    let value = span.value;
    if (span.kind === 'ui' && locale !== 'en') value = span.value.replace(/(<strong\b[^>]*>)[\s\S]*?(<\/strong>)/i, (_whole, open, close) => open + escapeText(span.glossary.values[locale]) + close);
    else if (span.kind === 'ui-text') value = escapeText(locale === 'en' ? span.value : span.glossary.values[locale]);
    else if (span.kind !== 'html' && span.kind !== 'ui') value = field.kind === 'attribute' ? escapeAttr(value) : escapeText(value);
    if (field.kind === 'prompt-text' && locale === 'ar' && span.kind === 'literal') value = `<bdi dir="ltr">${value}</bdi>`;
    escaped = escaped.replace(span.token, () => value);
  }
  return field.leading + escaped + field.trailing;
}

export function replaceRanges(source, replacements) {
  let result = source;
  const sorted = replacements.slice().sort((a, b) => b.start - a.start);
  for (let i = 0; i < sorted.length; i++) {
    const edit = sorted[i];
    if (i && edit.end > sorted[i - 1].start) throw new Error('Overlapping render edits');
    result = result.slice(0, edit.start) + edit.value + result.slice(edit.end);
  }
  return result;
}

export function localizedUrl(route, locale) { return `${ORIGIN}${BASE}help/${locale}/${route}/`; }
export function rewriteReference(value, route, locale) {
  if (!value || value.startsWith('#') || /^(?:data:|mailto:|tel:)/i.test(value)) return value;
  const original = new URL(`${BASE}help/${route}/`, ORIGIN);
  let target;
  try { target = new URL(decode(value), original); } catch { return value; }
  if (target.origin !== ORIGIN || !target.pathname.startsWith(BASE)) return value;
  const englishRoute = target.pathname.slice(`${BASE}help/`.length).replace(/(?:index\.html)?\/?$/, '');
  if (ROUTES.includes(englishRoute)) target.pathname = `${BASE}help/${locale}/${englishRoute}/`;
  // Relative references must keep pointing to existing shared originals, not a
  // nonexistent locale asset tree. Root-relative URLs include the Pages base.
  const relative = path.posix.relative(`help/${locale}/${route}`, target.pathname.slice(BASE.length));
  return (relative || './') + (target.pathname.endsWith('/') && relative ? '/' : '') + target.search + target.hash;
}

export const CHROME = {
  language: 'Tutorial language', englishFallback: 'English reference page',
  translationNotice: 'Machine-translated tutorial; native-language review is pending. Code and technical values are unchanged. Screenshots show the original English interface; match the translated control names in this text to your app.',
};

export function decoratePage(html, route, locale, chrome, ui) {
  const replacements = [];
  for (const token of scan(html).tokens) {
    if (token.type !== 'tag' || /^<\//.test(token.raw)) continue;
    for (const attr of attributes(token.raw, token.start)) {
      if (['href', 'src', 'poster', 'action'].includes(attr.name)) replacements.push({ ...attr, value: escapeAttr(rewriteReference(attr.value, route, locale)) });
    }
  }
  html = replaceRanges(html, replacements);
  html = html.replace(/<html\b[^>]*>/i, `<html lang="${locale}" dir="${locale === 'ar' ? 'rtl' : 'ltr'}">`);
  html = html.replace(/<link\b(?=[^>]*\brel=["']canonical["'])[^>]*>/i, `<link rel="canonical" href="${localizedUrl(route, locale)}">`);
  const alternates = LOCALES.map(language => `<link rel="alternate" hreflang="${language}" href="${localizedUrl(route, language)}">`).join('\n  ');
  const sharedCss = path.posix.relative(`help/${locale}/${route}`, 'help/tutorial-locales.css');
  html = html.replace('</head>', `  ${alternates}\n  <link rel="alternate" hreflang="x-default" href="${ORIGIN}${BASE}help/${route}/">\n  <link rel="stylesheet" href="${sharedCss}">\n</head>`);
  const languageLinks = LOCALES.map(language => `<a href="${path.posix.relative(`help/${locale}/${route}`, `help/${language}/${route}`) || '.'}/" lang="${language}" hreflang="${language}"${language === locale ? ' aria-current="page"' : ''}>${NAMES[language]}</a>`).join('\n      ');
  const navigation = `<aside class="tutorial-locale-tools" aria-label="${escapeAttr(chrome.language)}"><details class="tutorial-language-menu"><summary>${escapeText(chrome.language)}: <bdi>${NAMES[locale]}</bdi></summary><nav aria-label="${escapeAttr(chrome.language)}">${languageLinks}</nav></details>${locale === 'en' ? '' : `<p class="tutorial-translation-notice" role="note">${escapeText(chrome.translationNotice)}</p>`}</aside>`;
  html = html.replace(/(<main\b[^>]*>)/i, `$1\n    ${navigation}`);
  // Reference pages have not been translated by this tutorial project. Be
  // explicit about that rather than quietly presenting English as localized.
  const parsed = scan(html);
  const refs = [];
  for (const node of descendants(parsed.root).filter(node => node.tag === 'a')) {
    const href = attributes(node.raw).find(attr => attr.name === 'href')?.value;
    let target;
    try { target = new URL(href, localizedUrl(route, locale)); } catch { continue; }
    if (locale !== 'en' && target.origin === ORIGIN && target.pathname.startsWith(`${BASE}help/`) && !new RegExp(`^${BASE}help/(?:${LOCALES.join('|')})/`).test(target.pathname) && !/\.(?:png|svg|srwb|ipynb|css|js)(?:[?#]|$)/.test(href)) refs.push({ start: node.innerEnd, end: node.innerEnd, value: `<span class="english-reference"> (${escapeText(chrome.englishFallback)})</span>` });
  }
  html = replaceRanges(html, refs);
  return html;
}

export function readManifest() { return JSON.parse(readFileSync(path.join(DATA, 'source.json'), 'utf8')); }
export function localeFile(locale) { return path.join(DATA, 'translations', `${locale}.json`); }
export function readLocale(locale) { return JSON.parse(readFileSync(localeFile(locale), 'utf8')); }
export function allHtmlUnder(directory) { return readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? allHtmlUnder(path.join(directory, entry.name)) : entry.name.endsWith('.html') ? [path.join(directory, entry.name)] : []); }
