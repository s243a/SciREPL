import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { ROOT, DATA, LOCALES, CHROME, readManifest, readLocale, sha, escapeText, validateText, validateKeep, renderField, replaceRanges, decoratePage } from './tutorial_locale_lib.mjs';
import { inspectLocaleRecord } from './tutorial_locale_status.mjs';
import { verifyEditorialInventory, restoreOperationalNames, renderEditorialField, editorialReceipt } from './tutorial_locale_editorial.mjs';

// Link text for the Windows supplement, matching each locale's
// help/<locale>/interface/appearance-windows/ page.
const WINDOWS_APPEARANCE_LINK = {
  en: ['On Windows?', "See what's different"],
  ar: ['هل تستخدم Windows؟', 'اطّلع على ما يختلف'],
  bn: ['Windows ব্যবহার করছেন?', 'কী আলাদা দেখুন'],
  de: ['Unter Windows?', 'Sehen Sie, was dort anders ist'],
  es: ['¿Usa Windows?', 'Vea qué cambia'],
  fr: ['Sous Windows ?', 'Voyez ce qui change'],
  hi: ['Windows इस्तेमाल करते हैं?', 'देखें क्या अलग है'],
  id: ['Memakai Windows?', 'Lihat apa yang berbeda'],
  ja: ['Windows をお使いですか？', '異なる点を見る'],
  ko: ['Windows를 사용하시나요?', '달라지는 점 보기'],
  'pt-BR': ['Usa Windows?', 'Veja o que muda'],
  ru: ['Пользуетесь Windows?', 'Узнайте, что там отличается'],
  zh: ['使用 Windows？', '查看有何不同'],
};

const requested = process.argv.filter(value => LOCALES.includes(value));
const locales = requested.length ? requested : LOCALES;
const check = process.argv.includes('--check');
const manifest = readManifest();
const inventory = verifyEditorialInventory(manifest);
const staged = [];
const receipts = [];
let count = 0;
for (const locale of locales) {
  const record = locale === 'en' ? null : readLocale(locale);
  if (record && record.manifestHash !== manifest.manifestHash) throw new Error(`${locale}: stale translation record`);
  if (locale !== 'en') {
    const status = inspectLocaleRecord(manifest, locale, record);
    if (!status.complete) throw new Error(`${locale}: locale preflight incomplete (${status.missing.length} missing, ${status.invalid.length} invalid, ${status.unreviewed.length} unreviewed, ${status.unknown.length} unknown fields); no locale files were written`);
  }
  const kept = Object.assign({}, ...(record?.receipts || []).map(receipt => receipt.review.keptFields || {}));
  const chrome = Object.fromEntries(manifest.chrome.map(field => {
    const value = locale === 'en' ? field.text : record.translations[field.id];
    if (locale !== 'en' && kept[field.id] !== undefined) validateKeep(field, kept[field.id]);
    validateText(field, value, { allowSource: locale === 'en' || Boolean(kept[field.id]) });
    return [field.id.slice(7), value];
  }));
  if (Object.values(chrome).some(value => !value)) throw new Error(`${locale}: navigation translation incomplete`);
  const corrections = [];
  for (const page of manifest.pages) {
    const source = readFileSync(path.join(ROOT, 'www', 'help', page.route, 'index.html'), 'utf8');
    if (sha(source) !== page.sourceHash) throw new Error(`${page.route}: source changed; extraction and translation must be repeated`);
    const replacements = page.fields.map(field => {
      const proposal = locale === 'en' ? field.text : record.translations[field.id];
      const restored = restoreOperationalNames(field, proposal, locale, manifest, { keepReason: kept[field.id], inventory });
      corrections.push(...restored.corrections);
      const value = renderEditorialField(field, restored, locale, { keepReason: kept[field.id], inventory });
      return { start: field.start, end: field.end, value };
    });
    let rendered = decoratePage(replaceRanges(source, replacements), page.route, locale, chrome);
    if (page.route === 'tutorials') {
      // Edition selection is presentation, not translated prose. Keep the
      // accepted source and locale records intact, and retain the full shared
      // index unless the app explicitly requests its Free-only view.
      const proSection = '<section aria-labelledby="ai-tutorials">';
      const proChip = '<li class="chip chip-pro">';
      if (!rendered.includes(proSection) || !rendered.includes(proChip)) throw new Error(`${locale}: tutorial edition markers no longer match the index`);
      rendered = rendered.replace(proSection, '<section aria-labelledby="ai-tutorials" data-tutorial-editions="pro">')
        .replace(proChip, '<li class="chip chip-pro" data-tutorial-editions="pro">');
    }
    if (page.route === 'interface/appearance') {
      // Navigation to the hand-authored Windows supplement
      // (help/<locale>/interface/appearance-windows/), which sits outside the
      // frozen ROUTES inventory. Like the edition markers above, this is
      // controller-authored output, not reviewed tutorial fields: the accepted
      // source, its hashes and the locale records stay unchanged. The legacy
      // un-prefixed English page is that frozen source, so it has no link.
      const [question, linkText] = WINDOWS_APPEARANCE_LINK[locale] || [];
      const lessonNav = '\n      <nav class="lesson-nav"';
      if (!question || rendered.split(lessonNav).length !== 2) throw new Error(`${locale}: Windows Appearance link has no label or no unique insertion point`);
      rendered = rendered.replace(lessonNav, `\n      <p class="callout" id="windows-differences"><strong>${escapeText(question)}</strong> <a href="../appearance-windows/">${escapeText(linkText)}</a></p>${lessonNav}`);
    }
    if (page.route !== 'pro/ai/tutorial') {
      const editionScript = path.posix.relative(`help/${locale}/${page.route}`, 'help/tutorial-edition.js');
      // Not deferred: the script sets the CSS selector before body parsing, so
      // the Pro-only section cannot flash before DOMContentLoaded removes it.
      // Shared lessons retain this explicit view in navigation back to the
      // index, while the Pro walkthrough and the default URLs are unchanged.
      rendered = rendered.replace('</head>', `  <script src="${editionScript}"></script>\n</head>`);
    }
    const output = path.join(ROOT, 'www', 'help', locale, page.route, 'index.html');
    staged.push({ output, rendered, locale, route: page.route });
    count++;
  }
  receipts.push({ output: path.join(DATA, 'editorial', `${locale}.json`), rendered: JSON.stringify(editorialReceipt(manifest, locale, corrections), null, 2) + '\n', locale });
}
// Preflight every requested page/locale before writing any output. A missing
// late page or chrome field must not publish the earlier pages accidentally.
for (const page of staged) {
  if (check) { if (!existsSync(page.output) || readFileSync(page.output, 'utf8') !== page.rendered) throw new Error(`${page.locale}/${page.route}: generated page is stale`); }
  else { mkdirSync(path.dirname(page.output), { recursive: true }); writeFileSync(page.output, page.rendered); }
}
for (const receipt of receipts) {
  if (check) { if (!existsSync(receipt.output) || readFileSync(receipt.output, 'utf8') !== receipt.rendered) throw new Error(`${receipt.locale}: operational rendering receipt is missing or stale`); }
  else { mkdirSync(path.dirname(receipt.output), { recursive: true }); writeFileSync(receipt.output, receipt.rendered); }
}
console.log(`${check ? 'Verified' : 'Rendered'} ${count} tutorial pages (${locales.length} locales); shared assets were not copied.`);
