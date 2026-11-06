// Free 1.5.0 release summaries and copy/paste-ready Play notes. No network,
// model requests, signing, account access, browser or publication required.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = relative => readFileSync(path.join(ROOT, relative), 'utf8');
const LOCALES = ['en', 'ar', 'bn', 'de', 'es', 'fr', 'hi', 'id', 'ja', 'ko', 'pt-BR', 'ru', 'zh'];
const PLAY_LOCALES = ['en-US', 'ar', 'bn-BD', 'de-DE', 'es-ES', 'fr-FR', 'hi-IN', 'id', 'ja-JP', 'ko-KR', 'pt-BR', 'ru-RU', 'zh-CN'];
const KEYS = ['whatsNew.highlightLocalizedTutorials', 'whatsNew.highlightSourceOnlyCells',
    'whatsNew.highlightPrologBindings', 'whatsNew.highlightKeyboardTrust'];
const FROZEN = {
    '1.1.0': ['whatsNew.highlightLanguages', 'whatsNew.highlightOffline', 'whatsNew.highlightDesktop'],
    '1.2.0': ['whatsNew.highlightLicenses', 'whatsNew.highlightWhatsNew', 'whatsNew.highlightShortcuts', 'whatsNew.highlightRuntimeMetadata'],
    '1.3.0': ['whatsNew.highlightCatalogSources', 'whatsNew.highlightShortcuts'],
    '1.3.1': ['whatsNew.highlightCatalogBrowse', 'whatsNew.highlightFormulaContexts', 'whatsNew.highlightPipPackages', 'whatsNew.highlightLanguageAndHeader', 'whatsNew.highlightAndroidAndWindows'],
    '1.3.2': ['whatsNew.highlightWorkbookClosing', 'whatsNew.highlightAndroidCloudImport', 'whatsNew.highlightAccessibility'],
    '1.4.0': ['whatsNew.highlightStatusBar', 'whatsNew.highlightShortLandscapeComposer', 'whatsNew.highlightHelpExamples', 'whatsNew.highlightPipConsent'],
    '1.5.0': KEYS,
};
let checks = 0;
const check = (passed, message) => { assert.ok(passed, message); checks++; };
const equal = (actual, expected, message) => { assert.deepEqual(actual, expected, message); checks++; };

const sandbox = { window: {} };
vm.runInNewContext(read('www/js/release_highlights.js'), sandbox);
const highlights = sandbox.window.SCIREPL_RELEASE_HIGHLIGHTS;
for (const [version, expected] of Object.entries(FROZEN)) {
    equal(Array.from(highlights[version] || []), expected, `${version}: published highlight keys stay frozen`);
}
check(!highlights['1.5.0'].includes('whatsNew.highlightHelpExamples'),
    'Copy/Insert shipped in 1.4.0, not as a new 1.5.0 feature');

equal(readdirSync(path.join(ROOT, 'www/i18n')).filter(file => file.endsWith('.json')
    && file !== 'manifest.json' && !file.startsWith('privacy.')).sort(),
LOCALES.map(locale => `${locale}.json`).sort(), 'cover every shipped UI locale');
const base = JSON.parse(read('www/i18n/en.json'));
for (const locale of LOCALES) {
    const catalogue = JSON.parse(read(`www/i18n/${locale}.json`));
    equal(catalogue.__meta.locale, locale, `${locale}: catalogue owns its locale`);
    check(['draft', 'reviewed'].includes(catalogue.__meta.status), `${locale}: explicit approval status is retained`);
    for (const key of KEYS) {
        const value = catalogue.strings[key];
        check(typeof value === 'string' && value.trim() && !/[<>]/.test(value), `${locale}/${key}: plain complete prose`);
        check(!/\{\w+\}/.test(value), `${locale}/${key}: no unexpected interpolation placeholders`);
        if (locale !== 'en') check(value !== base.strings[key], `${locale}/${key}: not an English fallback`);
    }
    check(catalogue.strings[KEYS[0]].includes('Free') && catalogue.strings[KEYS[0]].includes('Pro'),
        `${locale}: product identifiers remain literal`);
    check(catalogue.strings[KEYS[1]].includes('#!source'), `${locale}: source-only marker remains literal`);
    check(catalogue.strings[KEYS[2]].includes('Prolog') && catalogue.strings[KEYS[2]].includes('[object Object]'),
        `${locale}: Prolog and the fixed display example remain literal`);
}

function validatePlayNotes(text) {
    // Git may check these copy/paste notes out with Windows CRLF endings.
    // Normalize only paired CRLF; locale, content and length gates stay strict.
    text = text.replace(/\r\n/g, '\n');
    const pattern = /<([A-Za-z0-9-]+)>\n([\s\S]*?)\n<\/\1>/g;
    const blocks = [...text.matchAll(pattern)];
    assert.deepEqual(blocks.map(match => match[1]), PLAY_LOCALES, 'exact supported Play locale tags, once each');
    assert.equal(text.replace(pattern, '').trim(), '', 'no untagged draft instructions can be pasted as notes');
    for (const [, locale, body] of blocks) {
        assert.ok(body.length <= 500 && [...body].length <= 500, `${locale}: Play notes fit 500 characters`);
        const lines = body.split('\n');
        assert.equal(lines.length, 4, `${locale}: four focused release bullets`);
        assert.ok(lines.every(line => line.startsWith('• ')), `${locale}: plain bullet text`);
        for (const token of ['Free', '#!source']) {
            assert.ok(body.includes(token), `${locale}: preserve ${token}`);
        }
        for (const token of ['Prolog', '[object Object]', 'Matplotlib']) {
            assert.ok(lines[2].includes(token), `${locale}: output-fixes bullet preserves ${token}`);
        }
    }
    return blocks;
}

const playNotes = read('docs/releases/1.5.0-play-notes.txt').replace(/\r\n/g, '\n');
const blocks = validatePlayNotes(playNotes);
checks++;
equal(validatePlayNotes(playNotes.replace(/\n/g, '\r\n')), blocks,
    'Windows CRLF notes retain the exact LF locale blocks and prose');
equal(validatePlayNotes(playNotes.replace(/\n/, '\r\n')), blocks,
    'mixed LF/CRLF notes retain the exact locale blocks and prose');
for (const [name, invalid] of [
    ['missing locale', playNotes.replace(/<ar>\n[\s\S]*?\n<\/ar>\n/, '')],
    ['duplicate locale', playNotes + '\n' + blocks[0][0]],
    ['too long', playNotes.replace(blocks[0][2], 'x'.repeat(501))],
    ['untagged prose', 'Upload instructions\n' + playNotes],
    ['lost marker', playNotes.replace('#!source', '#source')],
    ['lost plotting fix', playNotes.replace('Matplotlib', 'plotting')],
    ['wrong locale', playNotes.replace('<ar>', '<tr>').replace('</ar>', '</tr>')],
    ['mismatched closing tag', playNotes.replace('</ar>', '</tr>')],
    ['bare CR delimiter', playNotes.replace('<en-US>\n', '<en-US>\r')],
]) {
    for (const [ending, candidate] of [['LF', invalid], ['CRLF', invalid.replace(/\n/g, '\r\n')]]) {
        assert.throws(() => validatePlayNotes(candidate), undefined, `${name} (${ending})`);
        checks++;
    }
}
const githubNotes = read('docs/releases/1.5.0-github-notes.txt');
check(githubNotes.includes('already shipped in Free 1.4.0'),
    'full notes do not reannounce existing Help Copy/Insert as new');
check(githubNotes.includes('compound terms and dictionaries') && githubNotes.includes('first Matplotlib plot appears inline'),
    'full notes describe both output fixes');
console.log(`Free release notes: ${checks} checks passed; ${blocks.length} Play locales, longest ${Math.max(...blocks.map(match => match[2].length))}/500 characters.`);
