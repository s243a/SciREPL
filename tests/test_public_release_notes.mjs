// Static Free release-note rendering and explicit-output CLI contract.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePlayReleaseNotes, RELEASE_ROOT, renderReleaseNotes } from '../scripts/render-free-release-notes.mjs';

const source = readFileSync(new URL('../docs/releases/1.5.0-play-notes.txt', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const expected = [
    ['en', 'en-US', 'English'], ['ar', 'ar', 'العربية'], ['bn', 'bn-BD', 'বাংলা'],
    ['de', 'de-DE', 'Deutsch'], ['es', 'es-ES', 'Español'], ['fr', 'fr-FR', 'Français'],
    ['hi', 'hi-IN', 'हिन्दी'], ['id', 'id', 'Bahasa Indonesia'], ['ja', 'ja-JP', '日本語'],
    ['ko', 'ko-KR', '한국어'], ['pt-BR', 'pt-BR', 'Português (Brasil)'], ['ru', 'ru-RU', 'Русский'],
    ['zh', 'zh-CN', '简体中文'],
];
const prefix = locale => locale === 'en' ? '' : `${locale}/`;
const destination = locale => RELEASE_ROOT + prefix(locale);
const decodeHtml = text => text.replace(/&(amp|lt|gt|quot|#39);/g, (_, name) => ({
    amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'",
})[name]);

assert.equal(RELEASE_ROOT, 'https://s243a.github.io/SciREPL/help/releases/v1.5.0/');
const parsed = parsePlayReleaseNotes(source);
assert.deepEqual(parsed.map(({ lang, play, name }) => [lang, play, name]), expected);
assert.deepEqual(parsePlayReleaseNotes(source.replace(/\n/g, '\r\n')), parsed, 'CRLF checkout keeps the same prose');
const pages = renderReleaseNotes(source);
assert.deepEqual([...pages.keys()], expected.map(([lang]) => prefix(lang) + 'index.html'));
assert.deepEqual(renderReleaseNotes(source), pages, 'pure rendering is deterministic');

for (const [lang, play] of expected) {
    const page = pages.get(prefix(lang) + 'index.html');
    const canonical = destination(lang);
    assert.ok(page.startsWith(`<!doctype html>\n<html lang="${lang}" dir="${lang === 'ar' ? 'rtl' : 'ltr'}">`), `${lang}: language and direction`);
    const heading = /<h1><bdi dir="ltr">SciREPL Free 1\.5\.0<\/bdi>\s+<span>([^<]+)<\/span><\/h1>/.exec(page)?.[1];
    assert.ok(heading?.trim(), `${lang}: localized heading`);
    assert.ok(page.includes(`<title>SciREPL Free 1.5.0 · ${heading}</title>`), `${lang}: localized title`);
    if (lang !== 'en') assert.notEqual(heading, 'Release notes', `${lang}: no English heading fallback`);
    assert.ok(page.includes('<meta name="viewport" content="width=device-width, initial-scale=1">'));
    assert.deepEqual([...page.matchAll(/<link rel="canonical" href="([^"]+)">/g)].map(m => m[1]), [canonical]);
    assert.deepEqual([...page.matchAll(/<link rel="alternate" hreflang="([^"]+)" href="([^"]+)">/g)].map(m => m.slice(1)),
        [...expected.map(([other]) => [other, destination(other)]), ['x-default', RELEASE_ROOT]], `${lang}: 13 alternates and x-default`);
    const notes = /<ul class="notes">([\s\S]*?)<\/ul>/.exec(page)?.[1];
    const sourceBlock = new RegExp(`<${play}>\\n([\\s\\S]*?)\\n</${play}>`).exec(source)?.[1];
    assert.ok(notes && sourceBlock, `${lang}: source and HTML notes are both present`);
    assert.deepEqual([...notes.matchAll(/<li>([^<]*)<\/li>/g)].map(m => `• ${decodeHtml(m[1])}`),
        sourceBlock.split('\n'), `${lang}: all four complete Play bullets, in order`);
    const nav = /<nav aria-label="([^"]+)">([\s\S]*?)<\/nav>/.exec(page);
    assert.ok(nav && nav[1].trim(), `${lang}: localized navigation label`);
    if (lang !== 'en') assert.notEqual(nav[1], 'Languages', `${lang}: no English navigation fallback`);
    assert.deepEqual([...nav[2].matchAll(/<a href="([^"]+)" lang="([^"]+)" dir="(ltr|rtl)"( aria-current="page")?>([^<]+)<\/a>/g)].map(m =>
        [new URL(m[1], canonical).href, m[2], m[3], Boolean(m[4]), decodeHtml(m[5])]),
        expected.map(([other, , name]) => [destination(other), other, other === 'ar' ? 'rtl' : 'ltr', other === lang, name]), `${lang}: autonyms and relative language routes`);
    assert.doesNotMatch(page, /<(?:script|iframe|object|embed|img|form|svg)\b|<[a-z][^>]*\son[a-z]+\s*=|@import|url\s*\(/i, `${lang}: no active markup or external assets`);
}

const encoded = renderReleaseNotes(source.replace('Open online tutorials', 'Open & "read" online tutorials'));
assert.match(encoded.get('index.html'), /Open &amp; &quot;read&quot; online tutorials/);
const encodedEntity = renderReleaseNotes(source.replace('Open online tutorials', 'Open &lt;script&gt; online tutorials'));
assert.match(encodedEntity.get('index.html'), /Open &amp;lt;script&amp;gt; online tutorials/, 'entity-looking prose remains inert text');

for (const [label, invalid] of [
    ['missing locale', source.replace(/<ar>\n[\s\S]*?\n<\/ar>\n/, '')],
    ['duplicate locale', source + '\n' + source.split('\n\n')[0]],
    ['bad close', source.replace('</ar>', '</en-US>')],
    ['path-like locale', source.replace('<ar>', '<../ar>')],
    ['untagged text', 'Unexpected instructions\n' + source],
    ['extra bullet', source.replace('</en-US>', '• Unexpected\n</en-US>')],
    ['missing bullet', source.replace(/• Translated keyboard trust warnings\.\n/, '')],
    ['empty bullet', source.replace('• Translated keyboard trust warnings.', '• ')],
    ['over 500 characters', source.replace('Open online tutorials', 'x'.repeat(501))],
    ['over 500 UTF-16 units', source.replace('Open online tutorials', '😀'.repeat(251))],
    ['active markup', source.replace('Open online tutorials', '<img src=x onerror=alert(1)>')],
    ['bare CR', source.replace('<en-US>\n', '<en-US>\r')],
    ['bidi override', source.replace('Open online tutorials', 'Open\u202e online tutorials')],
    ['lost Matplotlib literal', source.replace('Matplotlib', 'plotting library')],
    ['lost Prolog literal', source.replace('Prolog', 'logic language')],
    ['lost object literal', source.replace('[object Object]', 'stray values')],
    ['lost source marker', source.replace('#!source', '#source')],
]) assert.throws(() => renderReleaseNotes(invalid), undefined, label);

const scratch = mkdtempSync(join(tmpdir(), 'scirepl-public-release-notes-'));
try {
    const script = fileURLToPath(new URL('../scripts/render-free-release-notes.mjs', import.meta.url));
    const cli = (...args) => spawnSync(process.execPath, [script, ...args], { cwd: scratch, encoding: 'utf8' });
    assert.equal(cli().status, 1, 'output argument is required');
    assert.equal(cli('--output').status, 1, 'output directory value is required');
    assert.equal(cli('--output', 'preview', '--other').status, 1, 'extra options are rejected');
    assert.deepEqual(readdirSync(scratch), [], 'invalid CLI writes no output');
    const output = join(scratch, 'preview', 'v1.5.0');
    const run = cli('--output', output);
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(readdirSync(scratch), ['preview'], 'pages go only beneath the supplied output root');
    assert.deepEqual(readdirSync(output).sort(), ['index.html', ...expected.slice(1).map(([lang]) => lang)].sort());
    for (const [file, page] of pages) assert.equal(readFileSync(join(output, file), 'utf8'), page);
    assert.equal(cli('--output', output).status, 0, 'explicit regeneration is supported');
    const blocked = join(scratch, 'blocked');
    mkdirSync(blocked);
    symlinkSync(output, join(blocked, 'ar'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal(cli('--output', blocked).status, 1, 'locale symlink cannot redirect page writes');
    assert.deepEqual(readdirSync(blocked), ['ar'], 'blocked generation replaces no pages');
} finally {
    rmSync(scratch, { recursive: true, force: true });
}
console.log('Public Free release notes: 13 static locale pages, exact bullets, safe routes, and explicit-output CLI passed.');
