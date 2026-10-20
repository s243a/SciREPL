// Deterministic public-tutorial localization checks. No model or network calls.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT, DATA, BASE, ORIGIN, LOCALES, ROUTES, CHROME, readManifest, readLocale, sha, scan, attributes, decode, extractPage, validateText, validateKeep, renderField, replaceRanges, decoratePage, rewriteReference, localizedUrl } from '../scripts/tutorial_locale_lib.mjs';
import { inspectLocaleRecord } from '../scripts/tutorial_locale_status.mjs';
import { verifyEditorialInventory, restoreOperationalNames, editorialReceipt } from '../scripts/tutorial_locale_editorial.mjs';

let checks = 0;
const verify = (name, fn) => { fn(); checks++; console.log(`PASS ${name}`); };
const manifest = readManifest();
const inventory = verifyEditorialInventory(manifest);
verify('controller editorial inventory and English receipt stay separate from machine approval', () => {
  assert.equal(inventory.occurrences.length, 18);
  const receipt = JSON.parse(readFileSync(path.join(DATA, 'editorial', 'en.json'), 'utf8'));
  assert.deepEqual(receipt, editorialReceipt(manifest, 'en', []));
  assert.equal(receipt.modelApproval, false);
  assert.equal(receipt.nativeLanguageApproval, false);
});
verify('manifest protects the exact English source and covers all nine routes', () => {
  assert.deepEqual(manifest.pages.map(page => page.route), ROUTES);
  assert.deepEqual(manifest.locales, LOCALES);
  const { manifestHash, ...payload } = manifest; assert.equal(manifestHash, sha(JSON.stringify(payload)));
});
verify('incomplete locale inventories fail closed before rendering', () => {
  const status = inspectLocaleRecord(manifest, 'fr', { locale: 'fr', manifestHash: manifest.manifestHash, translations: {}, receipts: [] });
  assert.equal(status.complete, false); assert.equal(status.translated, 0); assert.equal(status.missing.length, status.fields);
  const withUnknown = inspectLocaleRecord(manifest, 'fr', { locale: 'fr', manifestHash: manifest.manifestHash, translations: { unexpected: 'Texte' }, receipts: [] });
  assert.deepEqual(withUnknown.unknown, ['unexpected']);
  const wrongSource = inspectLocaleRecord(manifest, 'fr', { locale: 'de', manifestHash: 'stale', translations: {}, receipts: [] });
  assert.equal(wrongSource.invalid[0].id, '(record)');
});
const codeSpans = html => {
  const parsed = scan(html), roots = [];
  const walk = node => { for (const child of node.children) { if (child.tag === 'pre' && /\bdata-translatable-prompt=/.test(child.raw)) continue; if (['code', 'kbd'].includes(child.tag) || child.tag === 'pre' && !child.children.length) roots.push(html.slice(child.innerStart, child.innerEnd)); else walk(child); } };
  walk(parsed.root); return roots;
};
const mathSpans = html => html.match(/\\\([\s\S]*?\\\)|\\\[[\s\S]*?\\\]/g) || [];
const unit = extractPage('pro/ai/tutorial', String.raw`<p>Use <strong>Open</strong> and <code>x = 12 &lt; 15</code>; \(T_{d,j}\) costs $0.25.</p>`);
const field = unit.fields[0];
verify('protected English roundtrip leaves code, formula and literal numbers intact', () => {
  assert.equal(renderField(field, field.text, 'en'), field.source);
  assert.ok(field.protectedSpans.some(span => span.value.includes('T_{d,j}')));
  assert.ok(field.protectedSpans.some(span => span.value === '0.25'));
});
verify('missing, duplicate, reordered and unknown placeholders fail closed', () => {
  const tokens = field.text.match(/\{\{P\d{3}\}\}/g);
  assert.throws(() => validateText(field, field.text.replace(tokens[0], '')));
  assert.throws(() => validateText(field, field.text + tokens[0]));
  assert.throws(() => validateText(field, field.text.replace(tokens[0], 'TEMP').replace(tokens[1], tokens[0]).replace('TEMP', tokens[1])));
  assert.throws(() => validateText(field, field.text + '{{P999}}'));
});
verify('worker HTML and script injection cannot enter generated pages', () => {
  assert.throws(() => validateText(field, field.text + '<img onerror=alert(1)>'));
  assert.throws(() => validateText(field, field.text + '\u0000'));
  assert.throws(() => validateText(field, ''));
  for (const hidden of ['\uFFFD', '\u202A', '\u202E', '\u2066', '\u2069']) assert.throws(() => validateText(field, field.text + hidden));
  assert.throws(() => validateText(field, field.text + ' 99'));
  assert.throws(() => validateText(field, field.text + ' ٩٩'));
  assert.throws(() => validateText(field, field.text));
  assert.doesNotThrow(() => validateText(field, field.text, { allowSource: true }));
});
verify('reviewed keeps cover short labels only, never copied English paragraphs', () => {
  const menu = { id: 'label.menu', text: 'Menu', protectedSpans: [] };
  const source = { id: 'label.source', text: 'Source', protectedSpans: [] };
  const sentence = { id: 'paragraph', text: 'Before sending, review the request and do not share private code.', protectedSpans: [] };
  const reason = 'This short label is identical in the target language.';
  assert.doesNotThrow(() => validateKeep(menu, reason));
  assert.doesNotThrow(() => validateKeep(source, reason));
  assert.throws(() => validateKeep(sentence, reason));
  assert.throws(() => renderField(sentence, sentence.text, 'fr', { keepReason: reason }));
  assert.throws(() => validateKeep(menu, 'short'));
  assert.throws(() => validateKeep({ ...menu, text: 'This is already a sentence.' }, reason));
});
const operationalTitle = manifest.pages.flatMap(page => page.fields).find(item => item.id === 'workbooks.tutorial.0067');
const operationalReason = 'This is the exact operational title of the selected English workbook.';
verify('only the exact immutable operational title permits a reviewed long-label keep', () => {
  assert.doesNotThrow(() => validateKeep(operationalTitle, operationalReason));
  assert.equal(renderField(operationalTitle, operationalTitle.text, 'de', { keepReason: operationalReason }), operationalTitle.source);
});
for (const [name, mutation] of Object.entries({
  'different field id': { id: 'workbooks.tutorial.0068' },
  'paragraph tag': { tag: 'p' },
  'attribute field kind': { kind: 'attribute' },
  'forged declared hash': { sourceHash: 'stale' },
  'changed source with copied declared hash': { source: operationalTitle.source + ' Changed' },
  'different protected text': { text: operationalTitle.text + ' Changed' },
  'unapproved source whitespace': { source: ' ' + operationalTitle.source },
  'injected span metadata': { protectedSpans: [{ token: '{{P000}}', value: '<script>' }] },
  'title id but full English paragraph': { source: 'Before sending, review the request and do not share private code.', text: 'Before sending, review the request and do not share private code.' }
})) verify(`long-label keep rejects ${name}`, () => assert.throws(() => validateKeep({ ...operationalTitle, ...mutation }, operationalReason)));
verify('the operational title still requires a substantive keep reason', () => {
  for (const reason of [undefined, '', 'short']) assert.throws(() => validateKeep(operationalTitle, reason));
});
verify('ordinary English paragraphs still cannot be kept', () => assert.throws(() => validateKeep({ id: 'arbitrary.prose', text: 'Before sending, review the request and do not share private code.', protectedSpans: [] }, operationalReason)));
verify('other actual-sounding long titles get no keep exemption', () => assert.throws(() => validateKeep({ ...operationalTitle, id: 'workbooks.other.0001', text: 'Simpson Paradox When Every Group Disagrees With The Total' }, operationalReason)));
verify('short reviewed Menu and Source labels retain their existing keep behavior', () => {
  for (const text of ['Menu', 'Source']) assert.doesNotThrow(() => validateKeep({ id: 'short.label', text, protectedSpans: [] }, operationalReason));
});
verify('an unreviewed unchanged operational title still fails text validation', () => assert.throws(() => validateText(operationalTitle, operationalTitle.text)));
verify('external links, fragments and data URLs are unchanged', () => {
  for (const value of ['#tables', 'https://example.org/a?x=1#b', 'mailto:help@example.org', 'data:image/png;base64,AA==']) assert.equal(rewriteReference(value, 'pro/ai/tutorial', 'ar'), value);
});
verify('inter-tutorial links localize but shared images and reference pages do not', () => {
  const original = `${ORIGIN}${BASE}help/fr/pro/ai/tutorial/`;
  assert.equal(new URL(rewriteReference('../../../interface/appearance/#pro-editor', 'pro/ai/tutorial', 'fr'), original).href, `${ORIGIN}${BASE}help/fr/interface/appearance/#pro-editor`);
  assert.equal(new URL(rewriteReference('assets/completion-general.png', 'pro/ai/tutorial', 'fr'), original).href, `${ORIGIN}${BASE}help/pro/ai/tutorial/assets/completion-general.png`);
  assert.equal(new URL(rewriteReference('../', 'pro/ai/tutorial', 'fr'), original).href, `${ORIGIN}${BASE}help/pro/ai/`);
});
verify('Free and Pro are protected edition names; lowercase free remains ordinary prose', () => {
  const item = extractPage('tutorials', '<p>Free workflows use free tools. Pro only.</p>').fields[0];
  assert.deepEqual(item.protectedSpans.map(span => span.value), ['Free', 'Pro']);
  assert.ok(item.text.includes('free tools'));
  const translated = renderField(item, 'Flux de travail {{P000}} utilisant des outils gratuits. {{P001}} uniquement.', 'fr');
  assert.ok(translated.includes('Free'));
  assert.ok(translated.includes('Pro'));
  assert.ok(translated.includes('outils gratuits'));
});
verify('only three explicitly marked AI prose prompts are translatable, with formulas protected', () => {
  const prompts = manifest.pages.flatMap(page => page.fields).filter(item => item.kind === 'prompt-text');
  assert.equal(prompts.length, 3);
  assert.ok(prompts[0].protectedSpans.some(span => span.value === 'summary_demo'));
  assert.ok(prompts[0].protectedSpans.some(span => span.value === 'state = (16807 * state) % 2147483647'));
  assert.ok(prompts[2].protectedSpans.some(span => span.value === 'sqrt(-2 * log(u1)) * cos(2 * PI * u2)'));
  assert.ok(prompts[2].protectedSpans.some(span => span.value === 'window.renderImage(canvas.toDataURL("image/png"))'));
  for (const item of prompts) assert.ok(item.text.includes('{{P'));
  const arabicPrompt = renderField(prompts[0], 'مثال: ' + prompts[0].text, 'ar');
  assert.ok(arabicPrompt.includes('<bdi dir="ltr">state = (16807 * state) % 2147483647</bdi>'));
});

for (const page of manifest.pages) {
  const original = readFileSync(path.join(ROOT, 'www', 'help', page.route, 'index.html'), 'utf8');
  verify(`${page.route}: extraction offsets are current and fields do not overlap`, () => {
    assert.equal(sha(original), page.sourceHash);
    for (let index = 0; index < page.fields.length; index++) {
      const item = page.fields[index];
      assert.equal(original.slice(item.start, item.end), item.source);
      assert.equal(sha(item.source), item.sourceHash);
      if (index) assert.ok(page.fields[index - 1].end <= item.start);
      validateText(item, item.text, { allowSource: true });
    }
  });
  const localizedEnglish = readFileSync(path.join(ROOT, 'www', 'help', 'en', page.route, 'index.html'), 'utf8');
  verify(`${page.route}: code and TeX are byte-identical, without duplicating assets`, () => {
    assert.deepEqual(codeSpans(localizedEnglish), codeSpans(original));
    assert.deepEqual(mathSpans(localizedEnglish), mathSpans(original));
    assert.equal(existsSync(path.join(ROOT, 'www', 'help', 'en', page.route, 'assets')), false);
    assert.ok(localizedEnglish.includes('lang="en" dir="ltr"'));
  });
  verify(`${page.route}: every generated English local reference resolves`, () => {
    for (const token of scan(localizedEnglish).tokens.filter(token => token.type === 'tag')) for (const attr of attributes(token.raw).filter(attr => ['href', 'src'].includes(attr.name))) {
      const target = new URL(attr.value, localizedUrl(page.route, 'en'));
      if (target.origin !== ORIGIN || !target.pathname.startsWith(BASE) || /\b(?:alternate|canonical)\b/.test(token.raw)) continue;
      let relative = target.pathname.slice(BASE.length); if (relative.endsWith('/')) relative += 'index.html';
      // Other locale versions intentionally appear in the picker before their
      // reviewed translations are applied; the all-locale gate below checks them.
      if (LOCALES.filter(locale => locale !== 'en').some(locale => relative.startsWith(`help/${locale}/`))) continue;
      assert.ok(existsSync(path.join(ROOT, 'www', decodeURIComponent(relative))), `${page.route}: ${attr.value}`);
      if (target.hash && relative.endsWith('.html')) assert.ok(readFileSync(path.join(ROOT, 'www', relative), 'utf8').includes(`id="${decodeURIComponent(target.hash.slice(1))}"`), `${attr.value}: missing anchor`);
    }
  });
  verify(`${page.route}: Arabic renderer adds RTL, localized links and an honest caveat`, () => {
    const synthetic = replaceRanges(original, page.fields.map(item => ({ start: item.start, end: item.end, value: renderField(item, 'مثال: ' + item.text, 'ar') })));
    const rendered = decoratePage(synthetic, page.route, 'ar', CHROME);
    assert.ok(rendered.includes('lang="ar" dir="rtl"'));
    assert.ok(rendered.includes('Machine-translated tutorial; native-language review is pending'));
    assert.ok(rendered.includes('original English interface'));
    assert.deepEqual(codeSpans(rendered), codeSpans(original));
    assert.ok(rendered.includes('hreflang="pt-BR"'));
    assert.ok(rendered.includes(`href="${localizedUrl(page.route, 'ar')}"`));
  });
}

const args = process.argv.slice(2), requestedLocales = [];
for (let index = 0; index < args.length; index++) {
  if (args[index] === '--locale') { const locale = args[++index]; assert.ok(LOCALES.includes(locale), 'Unknown tutorial test locale'); requestedLocales.push(locale); }
  else assert.equal(args[index], '--all', 'Unknown tutorial test option');
}
const full = args.includes('--all');
if (full || requestedLocales.length) {
  for (const locale of (full ? LOCALES : requestedLocales).filter(locale => locale !== 'en')) {
    const record = readLocale(locale);
    const fields = [...manifest.pages.flatMap(page => page.fields), ...manifest.chrome];
    verify(`${locale}: all fields have accepted independent review receipts`, () => {
      assert.equal(inspectLocaleRecord(manifest, locale, record).complete, true);
      assert.equal(record.manifestHash, manifest.manifestHash);
      assert.deepEqual(Object.keys(record.translations).sort(), fields.map(item => item.id).sort());
      const reviewed = new Set(record.receipts.filter(receipt => receipt.review.status === 'accepted' && receipt.review.reviewer && receipt.review.draftModel).flatMap(receipt => receipt.fields));
      const kept = Object.assign({}, ...record.receipts.map(receipt => receipt.review.keptFields || {}));
      for (const item of fields) { if (kept[item.id]) validateKeep(item, kept[item.id]); validateText(item, record.translations[item.id], { allowSource: Boolean(kept[item.id]) }); assert.ok(reviewed.has(item.id), item.id); }
    });
    verify(`${locale}: operational rendering has its own deterministic, non-model receipt`, () => {
      const kept = Object.assign({}, ...record.receipts.map(receipt => receipt.review.keptFields || {}));
      const corrections = manifest.pages.flatMap(page => page.fields).flatMap(item =>
        restoreOperationalNames(item, record.translations[item.id], locale, manifest, { keepReason: kept[item.id], inventory }).corrections);
      const receipt = JSON.parse(readFileSync(path.join(DATA, 'editorial', `${locale}.json`), 'utf8'));
      assert.deepEqual(receipt, editorialReceipt(manifest, locale, corrections));
      assert.equal(receipt.modelApproval, false); assert.equal(receipt.nativeLanguageApproval, false);
      assert.equal(receipt.nativeLanguageReview, 'pending');
      assert.ok(receipt.corrections.every(item => item.protectedTokensPreserved));
    });
    for (const page of manifest.pages) verify(`${locale}/${page.route}: complete generated route preserves executable examples`, () => {
      const html = readFileSync(path.join(ROOT, 'www', 'help', locale, page.route, 'index.html'), 'utf8');
      const english = readFileSync(path.join(ROOT, 'www', 'help', page.route, 'index.html'), 'utf8');
      assert.ok(html.includes(`lang="${locale}" dir="${locale === 'ar' ? 'rtl' : 'ltr'}"`));
      assert.deepEqual(codeSpans(html), codeSpans(english));
      assert.deepEqual(mathSpans(html), mathSpans(english));
      assert.ok(html.includes('tutorial-translation-notice'));
      assert.equal((html.match(/rel="canonical"/g) || []).length, 1);
      assert.equal((html.match(/hreflang=/g) || []).length, 27); // 14 alternates + 13 picker links.
      const prose = html.replace(/<[^>]*>/g, '');
      for (const row of inventory.occurrences.filter(row => page.fields.some(item => item.id === row.fieldId))) {
        assert.ok(prose.includes(row.identifier.replace(/'/g, '&#39;')) || prose.includes(row.identifier), `${locale}/${page.route}: operational name ${row.identifier} is missing`);
      }
    });
    // Incremental --locale checks may precede rendering the other picker
    // editions. The final --all gate requires every destination, with no
    // exception for language navigation, alternates or canonical links.
    if (full) for (const page of manifest.pages) verify(`${locale}/${page.route}: every generated local reference and fragment resolves`, () => {
      const html = readFileSync(path.join(ROOT, 'www', 'help', locale, page.route, 'index.html'), 'utf8');
      for (const token of scan(html).tokens.filter(token => token.type === 'tag')) for (const attr of attributes(token.raw).filter(attr => ['href', 'src', 'poster', 'action'].includes(attr.name))) {
        const target = new URL(decode(attr.value), localizedUrl(page.route, locale));
        if (target.origin !== ORIGIN || !target.pathname.startsWith(BASE)) continue;
        let relative = decodeURIComponent(target.pathname.slice(BASE.length));
        if (relative.endsWith('/')) relative += 'index.html';
        const file = path.join(ROOT, 'www', relative);
        assert.ok(existsSync(file), `${locale}/${page.route}: ${attr.value}: missing local target`);
        if (target.hash && relative.endsWith('.html')) {
          const ids = scan(readFileSync(file, 'utf8')).tokens.filter(token => token.type === 'tag')
            .flatMap(token => attributes(token.raw).filter(attr => attr.name === 'id').map(attr => decode(attr.value)));
          assert.ok(ids.includes(decodeURIComponent(target.hash.slice(1))), `${locale}/${page.route}: ${attr.value}: missing anchor`);
        }
      }
    });
  }
}
console.log(`Tutorial localization: ${checks} checks passed${full ? '; all 13 locales complete' : requestedLocales.length ? '; selected locale gate only, not full publication approval' : '; English architecture only, translations pending'}.`);
