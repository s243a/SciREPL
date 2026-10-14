// App entry points to the shared online tutorials. No live external requests.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { chromium } from 'playwright';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BASE = `http://localhost:${process.env.PORT || 8085}`;
const LOCALES = ['en', 'ar', 'bn', 'de', 'es', 'fr', 'hi', 'id', 'ja', 'ko', 'pt-BR', 'ru', 'zh'];
const LINKS = [
    { id: 'help-tutorial-index', key: 'help.tutorialIndex', modal: 'help-modal',
      url: 'https://s243a.github.io/SciREPL/help/tutorials/' },
    { id: 'workbook-import-tutorial', key: 'vfs.workbookImportTutorial', modal: 'prolog-settings-modal',
      url: 'https://s243a.github.io/SciREPL/help/workbooks/import/' },
];
let checks = 0;
function check(condition, message) { assert(condition, message); checks++; }

const source = readFileSync(path.join(ROOT, 'www/index.html'), 'utf8');
for (const link of LINKS) {
    const anchor = source.match(new RegExp(`<a\\b[^>]*id="${link.id}"[^>]*>[\\s\\S]*?<\\/a>`))?.[0];
    check(Boolean(anchor), `${link.id}: real anchor exists`);
    check(anchor.includes(`href="${link.url}"`) && anchor.includes(`data-i18n="${link.key}"`),
        `${link.id}: fixed public URL and translated label`);
    check(anchor.includes('target="_blank"') && anchor.includes('rel="noopener noreferrer"')
        && !/onclick=/.test(anchor), `${link.id}: isolated external navigation without an action handler`);
}
for (const locale of LOCALES) {
    const catalogue = JSON.parse(readFileSync(path.join(ROOT, `www/i18n/${locale}.json`), 'utf8'));
    for (const { key } of LINKS) {
        const value = catalogue.strings[key];
        check(typeof value === 'string' && value.trim() && !/[<>]/.test(value), `${locale}: ${key} is plain label text`);
    }
}
check(!source.includes('tour-ai-tutorial'), 'Free does not acquire the Pro-only AI walkthrough');

const browser = await chromium.launch({ headless: true });
try {
    const context = await browser.newContext({ viewport: { width: 320, height: 844 }, serviceWorkers: 'block' });
    const visits = [], errors = [];
    await context.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.origin === BASE || ['data:', 'blob:'].includes(url.protocol)) return route.continue();
        if (LINKS.some(link => link.url === url.href)) {
            visits.push(url.href);
            return route.fulfill({ contentType: 'text/html', body: '<title>Offline tutorial navigation fixture</title>' });
        }
        return route.abort('blockedbyclient');
    });
    await context.addInitScript(() => {
        localStorage.setItem('scirepl_privacy_accepted', '1');
        localStorage.setItem('scirepl_privacy_accepted_revision', '2026-08-catalog-sources-v1');
        localStorage.setItem('scirepl_auto_download', '1');
        localStorage.setItem('scirepl_onboarding_seen', '1');
        localStorage.setItem('scirepl_i18n_show_drafts', '1');
        addEventListener('DOMContentLoaded', () => localStorage.setItem(
            'scirepl_whats_new_seen_version', window.KERNEL_CONFIG.app.version), { once: true });
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${BASE}/index.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.i18n && window.fileIO && window.onboarding);
    await page.evaluate(() => { document.getElementById('code-input').value = 'draft_to_keep'; });

    for (const locale of LOCALES) {
        await page.evaluate(code => window.i18n.activate(code), locale);
        const expected = JSON.parse(readFileSync(path.join(ROOT, `www/i18n/${locale}.json`), 'utf8')).strings;
        for (const link of LINKS) {
            await page.evaluate(modal => {
                document.querySelectorAll('.modal').forEach(el => el.classList.add('hidden'));
                document.getElementById(modal).classList.remove('hidden');
            }, link.modal);
            const element = page.locator(`#${link.id}`);
            await element.scrollIntoViewIfNeeded();
            check(await element.innerText() === expected[link.key], `${locale}: ${link.id} follows language switches`);
            const box = await element.boundingBox();
            check(box && box.height >= 44 && box.width >= 44 && box.x >= -1 && box.x + box.width <= 321,
                `${locale}: ${link.id} is tap-sized and fits a narrow viewport`);
            await element.focus();
            check(await element.evaluate(el => document.activeElement === el), `${locale}: ${link.id} is keyboard-focusable`);
        }
    }
    for (const link of LINKS) {
        await page.evaluate(modal => {
            document.querySelectorAll('.modal').forEach(el => el.classList.add('hidden'));
            document.getElementById(modal).classList.remove('hidden');
        }, link.modal);
        const snapshot = await page.evaluate(() => ({
            draft: document.getElementById('code-input').value,
            cells: window._cells.map(cell => ({ id: cell.id, code: cell.code })),
        }));
        const popupPromise = context.waitForEvent('page');
        await page.locator(`#${link.id}`).press('Enter');
        const popup = await popupPromise;
        await popup.waitForLoadState('domcontentloaded');
        check(popup.url() === link.url && await popup.evaluate(() => window.opener === null),
            `${link.id}: Enter opens the guide without an opener`);
        assert.deepEqual(await page.evaluate(() => ({
            draft: document.getElementById('code-input').value,
            cells: window._cells.map(cell => ({ id: cell.id, code: cell.code })),
        })), snapshot, `${link.id}: source and draft unchanged`);
        checks++;
        await popup.close();
    }
    check(visits.length === LINKS.length, 'Only explicit tutorial activation opens the fixture destinations');
    assert.deepEqual(errors, [], 'No app page errors during locale changes or navigation'); checks++;
    await context.close();
} finally { await browser.close(); }
console.log(`Tutorial entry links: ${checks} checks passed; no live external requests or code execution.`);
