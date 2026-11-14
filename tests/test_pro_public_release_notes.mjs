import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, readdirSync, mkdirSync, symlinkSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseProHighlights, renderProReleaseNotes, PRO_NOTE_LOCALES, proNotePath, proNoteUrl } from '../scripts/render-pro-release-notes.mjs';

const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const source = read('docs/releases/pro-1.5.0-highlights.json');
const english = read('www/pro/releases/v1.5.0.html');
const data = parseProHighlights(source);
const pages = renderProReleaseNotes(source, english);
assert.equal(pages.size, 13);
assert.deepEqual([...pages.keys()], PRO_NOTE_LOCALES.map(proNotePath));
assert.deepEqual(renderProReleaseNotes(source, pages.get('v1.5.0.html')), pages, 'English navigation regeneration is idempotent');
for (const lang of PRO_NOTE_LOCALES) {
    const html = pages.get(proNotePath(lang));
    assert.equal(read('www/pro/releases/' + proNotePath(lang)), html, `${lang}: committed output is fresh`);
    assert.ok(html.includes(`href="${proNoteUrl(lang)}"`), `${lang}: canonical route retained`);
    assert.equal((html.match(/<a\b[^>]*aria-current="page"/g) || []).length, 1, `${lang}: one current navigation entry`);
    const canonical = proNoteUrl(lang);
    const nav = /<nav class="release-note-languages"[\s\S]*?<\/nav>/.exec(html)?.[0];
    assert.ok(nav);
    assert.deepEqual([...nav.matchAll(/href="([^"]+)" lang="([^"]+)"/g)].map(([, href, locale]) =>
        [new URL(href, canonical).href.replace(/\/index\.html$/, '/'), locale]),
    PRO_NOTE_LOCALES.map(locale => [proNoteUrl(locale), locale]), `${lang}: 13 safe language links resolve at the GitHub Pages subpath`);
    if (lang === 'en') {
        assert.ok(html.includes('Exact-candidate native CI, signed CLOSED-testing upgrades on both test phones'), 'full English validation caveats remain intact');
        continue;
    }
    assert.ok(html.startsWith(`<!doctype html>\n<html lang="${lang}" dir="${lang === 'ar' ? 'rtl' : 'ltr'}">`));
    assert.ok(html.includes('name="scirepl-translation-status" content="draft"'));
    assert.ok(html.includes(data.locales[lang].notice.replaceAll('&', '&amp;').replaceAll("'", '&#39;')), `${lang}: draft/full-English notice is not dropped`);
    assert.notEqual(data.locales[lang].notice, data.locales.en.notice);
    assert.equal((/<ul class="notes">([\s\S]*?)<\/ul>/.exec(html)[1].match(/<li>/g) || []).length, 4);
    assert.ok(html.includes('href="../../v1.5.0.html"'), `${lang}: complete English fallback remains accessible`);
    assert.ok(html.includes(`href="../../../../help/${lang}/tutorials/"`), `${lang}: locale-aware tutorials`);
    assert.doesNotMatch(html, /<(?:script|iframe|object|embed|img|form|svg)\b|<[a-z][^>]*\son[a-z]+\s*=|@import|url\s*\(/i);
    if (lang === 'ar') for (const token of ['Bash', 'Prolog']) assert.ok(html.includes(`<bdi dir="ltr">${token}</bdi>`));
}
for (const mutate of [
    value => delete value.locales.ar,
    value => { value.locales['../es'] = value.locales.es; },
    value => { value.version = '2.0.0'; },
    value => { value.locales.es.status = 'reviewed'; },
    value => { value.locales.es.bullets.push('unexpected'); },
    value => { value.locales.es.title = '<script>'; },
    value => { value.locales.ar.notice += '\u202e'; },
    value => { value.locales.ru.bullets[2] = 'Lost identifiers'; },
]) {
    const changed = JSON.parse(source); mutate(changed);
    assert.throws(() => renderProReleaseNotes(changed, english), 'invalid source is rejected before output');
}
const escaped = JSON.parse(source); escaped.locales.es.title = 'A & "B"';
assert.ok(renderProReleaseNotes(escaped, english).get('v1.5.0/es/index.html').includes('A &amp; &quot;B&quot;'));
const scratch = mkdtempSync(join(tmpdir(), 'scirepl-pro-notes-'));
try {
    const script = fileURLToPath(new URL('../scripts/render-pro-release-notes.mjs', import.meta.url));
    const cli = (...args) => spawnSync(process.execPath, [script, ...args], { cwd: scratch, encoding: 'utf8' });
    assert.equal(cli().status, 1);
    assert.equal(cli('--output').status, 1);
    assert.deepEqual(readdirSync(scratch), [], 'no default or invalid-argument writes');
    assert.equal(cli('--check').status, 0);
    const output = join(scratch, 'output');
    const generated = cli('--output', output);
    assert.equal(generated.status, 0, generated.stderr);
    for (const [file, html] of pages) assert.equal(readFileSync(join(output, file), 'utf8'), html);
    const blocked = join(scratch, 'blocked'); mkdirSync(blocked);
    symlinkSync(output, join(blocked, 'v1.5.0'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal(cli('--output', blocked).status, 1, 'a nested output symlink cannot redirect writes');
    assert.deepEqual(readdirSync(blocked), ['v1.5.0'], 'no partial output before symlink rejection');
} finally { rmSync(scratch, { recursive: true, force: true }); }
console.log('Public Pro notes: English source plus 12 draft summaries, fresh rendering, fallback routes and safe explicit-output CLI passed.');
