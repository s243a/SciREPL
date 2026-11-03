// Free tutorial entry points. External navigation uses inert local fixtures;
// neither providers nor language runtimes are contacted by this suite.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BASE = process.env.SCIREPL_TEST_BASE || `http://localhost:${process.env.PORT || 8085}/`;
const ORIGIN = new URL(BASE).origin;
const LOCALES = ['en', 'ar', 'bn', 'de', 'es', 'fr', 'hi', 'id', 'ja', 'ko', 'pt-BR', 'ru', 'zh'];
const LINKS = [
    { id: 'help-tutorial-index', key: 'help.tutorialIndex', guide: 'index',
      modal: 'help-modal', path: 'tutorials/', query: '?edition=free' },
    { id: 'workbook-import-tutorial', key: 'vfs.workbookImportTutorial', guide: 'import',
      modal: 'prolog-settings-modal', path: 'workbooks/import/', query: '?edition=free' },
];
const href = (link, locale = 'en') => `https://s243a.github.io/SciREPL/help/${locale}/${link.path}${link.query}`;
const read = name => readFileSync(path.join(ROOT, name), 'utf8');
const catalogues = new Map(LOCALES.map(locale => [locale, JSON.parse(read(`www/i18n/${locale}.json`)).strings]));
let checks = 0;
function check(condition, message) { assert(condition, message); checks++; }
function equal(actual, expected, message) { assert.deepEqual(actual, expected, message); checks++; }

const source = read('www/index.html');
const helperSource = read('www/js/tutorial_links.js');
equal(readdirSync(path.join(ROOT, 'www/i18n')).filter(name => name.endsWith('.json')
    && name !== 'manifest.json' && !name.startsWith('privacy.')).sort(),
LOCALES.map(locale => `${locale}.json`).sort(), 'test every bundled display locale');
equal((source.match(/<a\b[^>]*data-tutorial-guide=/g) || []).length, 2,
    'Free offers exactly the two applicable tutorial entry points');
for (const link of LINKS) {
    equal((source.match(new RegExp(`\\bid="${link.id}"`, 'g')) || []).length, 1,
        `${link.id}: the ID is unique across all element types`);
    const anchors = source.match(new RegExp(`<a\\b[^>]*id="${link.id}"[^>]*>`, 'g')) || [];
    equal(anchors.length, 1, `${link.id}: one native anchor`);
    for (const [attribute, value] of Object.entries({ href: href(link), target: '_blank',
        rel: 'noopener noreferrer', 'data-i18n': link.key, 'data-tutorial-guide': link.guide })) {
        check(anchors[0].includes(`${attribute}="${value}"`), `${link.id}: ${attribute}`);
    }
    check(!/onclick=/.test(anchors[0]), `${link.id}: navigation has no action handler`);
    for (const [locale, catalogue] of catalogues) {
        const value = catalogue[link.key];
        check(typeof value === 'string' && value.trim() && !/[<>]/.test(value),
            `${locale}: ${link.key} is a plain translated label`);
        check(existsSync(path.join(ROOT, `www/help/${locale}/${link.path}index.html`)),
            `${locale}: ${link.guide} resolves to a rendered local guide`);
    }
}
const helpActionOrder = ['id="help-tutorial-index"', 'id="btn-show-tour"',
    'id="btn-show-whats-new"', 'data-i18n="help.landscapeKeyboards"'].map(token => source.indexOf(token));
check(helpActionOrder.every((position, index) => position > source.indexOf('id="help-modal"')
    && (index === 0 || position > helpActionOrder[index - 1])),
    'Help starts with the tutorial index, Tour and What\'s New before keyboard guidance');
check(!source.includes('tour-ai-tutorial') && !helperSource.includes('pro/ai/tutorial/'),
    'Free does not acquire Pro-only AI or completion tutorial routes');
check(read('www/sw.js').includes("'./js/tutorial_links.js'"),
    'locale routing helper is included in the cached app shell');
check(source.indexOf('src="js/tutorial_links.js"') > source.indexOf('src="js/i18n.js"')
    && source.indexOf('src="js/tutorial_links.js"') < source.indexOf('src="js/onboarding.js"'),
    'helper loads after i18n and before onboarding');

const helperContext = vm.createContext({ window: { i18n: { current: 'en' } }, document: {
    readyState: 'complete', addEventListener() {}, querySelectorAll() { return []; },
} });
vm.runInContext(helperSource, helperContext);
const helper = helperContext.window.scireplTutorials;
for (const locale of LOCALES) {
    for (const link of LINKS) equal(helper.url(link.guide, locale), href(link, locale), `${locale}: allowlisted route`);
}
for (const locale of [undefined, null, '', 'xx', 'pt-br', '../fr', 'en/../../',
    'https://evil.invalid', 'javascript:alert(1)', 'en#x', 'ar?edition=pro']) {
    for (const link of LINKS) equal(helper.url(link.guide, locale), href(link),
        `${String(locale)}: unknown or malicious locale falls back to English`);
}
for (const guide of ['ai', 'completion', '__proto__', 'constructor', '../', 'https://evil.invalid', '', null]) {
    assert.throws(() => helper.url(guide, 'fr'), /Unknown tutorial guide/);
    checks++;
}
if (process.argv.includes('--static-only')) {
    console.log(`Tutorial entry links: ${checks} static checks passed.`);
    process.exit(0);
}

const { chromium } = await import('playwright');
const browser = await chromium.launch({ headless: true });
try {
    // This placement gate deliberately runs before the older scrolled-link
    // checks. Every profile has a fresh Help scrollport, and neither focus nor
    // locator.click()/scrollIntoViewIfNeeded() can rescue a buried tutorial.
    const freshProfiles = LOCALES.flatMap(locale => [
        { locale, viewport: { width: 320, height: 844 }, scale: 1 },
        { locale, viewport: { width: 844, height: 390 }, scale: 1 },
    ]);
    const longestLabels = [...catalogues].sort((a, b) =>
        b[1]['help.tutorialIndex'].length - a[1]['help.tutorialIndex'].length)
        .slice(0, 2).map(([locale]) => locale);
    for (const locale of new Set([...longestLabels, 'ar'])) {
        freshProfiles.push({ locale, viewport: { width: 844, height: 390 }, scale: 1.5 });
    }
    for (const { locale, viewport, scale } of freshProfiles) {
        const label = `fresh Help/${locale}/${viewport.width}x${viewport.height}/scale${scale}`;
        const context = await browser.newContext({ viewport, hasTouch: true, isMobile: true, serviceWorkers: 'block' });
        const requests = [], errors = [], dialogs = [];
        const expectedURL = href(LINKS[0], locale);
        await context.route('**/*', route => {
            const request = route.request(), url = new URL(request.url());
            if (url.origin === ORIGIN && !url.pathname.startsWith('/proxy')) return route.continue();
            requests.push({ url: url.href, method: request.method(), type: request.resourceType() });
            if (url.href === expectedURL && request.isNavigationRequest() && request.method() === 'GET') {
                return route.fulfill({ contentType: 'text/html', body: '<title>Tutorial fixture</title>' });
            }
            return route.abort('blockedbyclient');
        });
        await context.addInitScript(() => {
            localStorage.setItem('scirepl_privacy_accepted', '1');
            localStorage.setItem('scirepl_privacy_accepted_revision', '2026-08-catalog-sources-v1');
            localStorage.setItem('scirepl_auto_download', '1');
            localStorage.setItem('scirepl_auto_execute', '0');
            localStorage.setItem('scirepl_onboarding_seen', '1');
            localStorage.setItem('scirepl_i18n_show_drafts', '1');
            addEventListener('DOMContentLoaded', () => localStorage.setItem(
                'scirepl_whats_new_seen_version', window.KERNEL_CONFIG.app.version), { once: true });
        });
        try {
            const page = await context.newPage();
            page.on('pageerror', error => errors.push(error.message));
            page.on('dialog', dialog => { dialogs.push(dialog.type()); dialog.dismiss().catch(() => {}); });
            await page.goto(new URL('index.html', BASE).href, { waitUntil: 'domcontentloaded' });
            await page.waitForFunction(() => window.__SCIREPL_APP_READY && window.i18n
                && window.appearance && window.fileIO && window.scireplTutorials);
            await page.evaluate(async ({ locale, scale }) => {
                window.i18n.setPreference(locale);
                await window.i18n.activate(locale);
                window.appearance.setButtonScale(scale);
                window.__tutorialLinkEffects = [];
                for (const [owner, methods] of [
                    [window, ['importCells']], [window.kernelManager, ['execute']],
                    [window.fileIO, ['importSrwb', 'importIpynb', 'handleFileUpload']],
                ]) for (const method of methods) {
                    if (typeof owner?.[method] !== 'function') continue;
                    owner[method] = () => {
                        window.__tutorialLinkEffects.push(method);
                        return Promise.resolve([]);
                    };
                }
                document.getElementById('code-input').value = 'fresh_help_draft_to_keep';
            }, { locale, scale });
            await page.click('#help-btn');
            await page.locator('#help-modal').waitFor({ state: 'visible' });
            await page.locator('#help-modal .modal-content').evaluate(element =>
                Promise.all(element.getAnimations().map(animation => animation.finished.catch(() => {}))));
            const geometry = await page.evaluate(() => {
                const modal = document.getElementById('help-modal');
                const content = modal.querySelector('.modal-content');
                const link = document.getElementById('help-tutorial-index');
                const r = link.getBoundingClientRect(), c = content.getBoundingClientRect();
                const clip = { left: Math.max(0, c.left + content.clientLeft),
                    right: Math.min(innerWidth, c.left + content.clientLeft + content.clientWidth),
                    top: Math.max(0, c.top + content.clientTop),
                    bottom: Math.min(innerHeight, c.top + content.clientTop + content.clientHeight) };
                const x = r.left + r.width / 2, y = r.top + r.height / 2;
                const hit = document.elementFromPoint(x, y);
                return { x, y, width: r.width, height: r.height, scrollTop: content.scrollTop,
                    fullyVisible: r.left >= clip.left - 1 && r.right <= clip.right + 1
                        && r.top >= clip.top - 1 && r.bottom <= clip.bottom + 1,
                    fits: link.scrollWidth <= link.clientWidth + 1,
                    hit: Boolean(hit && (hit === link || link.contains(hit))),
                    text: link.textContent, href: link.href, count: document.querySelectorAll('#help-tutorial-index').length,
                    scale: window.appearance.getButtonScale() };
            });
            equal(geometry.scrollTop, 0, `${label}: real Help opens at the top before any scroll or focus`);
            equal(geometry.count, 1, `${label}: one tutorial-index control`);
            equal(geometry.scale, scale, `${label}: real Appearance button scale is applied`);
            equal(geometry.text, catalogues.get(locale)['help.tutorialIndex'], `${label}: existing localized label`);
            equal(geometry.href, expectedURL, `${label}: selected-language Free-only index`);
            check(geometry.fullyVisible && geometry.fits && geometry.width >= 43.5
                && geometry.height >= 43.5 && geometry.hit, `${label}: first-viewport 44px link is fully readable and hit-testable`);
            equal(requests, [], `${label}: displaying Help makes no external request`);
            const state = () => page.evaluate(() => ({
                draft: document.getElementById('code-input').value,
                cells: window._cells.map(cell => ({ id: cell.id, code: cell.code, language: cell.language, type: cell.type })),
                preferences: Object.fromEntries(Object.keys(localStorage).filter(key => key.startsWith('scirepl_')
                    && !['scirepl_session_v1', 'scirepl_session_v2', 'scirepl_draft_input'].includes(key))
                    .sort().map(key => [key, localStorage.getItem(key)])),
                effects: window.__tutorialLinkEffects,
            }));
            const before = await state(), appURL = page.url();
            const popupPromise = page.waitForEvent('popup');
            await page.touchscreen.tap(geometry.x, geometry.y);
            const popup = await popupPromise;
            await popup.waitForLoadState('domcontentloaded');
            equal(popup.url(), expectedURL, `${label}: raw touch opens the index without automatic scrolling`);
            check(await popup.evaluate(() => window.opener === null), `${label}: new guide has no opener`);
            equal(page.url(), appURL, `${label}: app stays open`);
            equal(await state(), before, `${label}: navigation preserves draft, cells, consent and preferences`);
            equal(requests, [{ url: expectedURL, method: 'GET', type: 'document' }], `${label}: only explicit guide navigation is requested`);
            equal(await page.evaluate(() => window.__tutorialLinkEffects), [], `${label}: no import or code execution`);
            equal(dialogs, [], `${label}: no permission or consent prompt`);
            equal(errors, [], `${label}: no app errors`);
            await popup.close();
        } finally { await context.close(); }
    }
    for (const native of [false, true]) {
        const mode = native ? 'mocked Android' : 'browser';
        const context = await browser.newContext({ viewport: { width: 320, height: 844 }, serviceWorkers: 'block' });
        const requests = [], errors = [], dialogs = [];
        const guideURLs = new Set(LOCALES.flatMap(locale => LINKS.map(link => href(link, locale))));
        await context.route('**/*', route => {
            const request = route.request();
            const url = new URL(request.url());
            if (url.origin === ORIGIN && !url.pathname.startsWith('/proxy')) return route.continue();
            requests.push({ url: url.href, method: request.method(), type: request.resourceType() });
            if (guideURLs.has(url.href) && request.isNavigationRequest() && request.method() === 'GET') {
                return route.fulfill({ contentType: 'text/html', body: '<title>Tutorial fixture</title>' });
            }
            return route.abort('blockedbyclient');
        });
        await context.addInitScript(isNative => {
            if (isNative) window.Capacitor = {
                getPlatform: () => 'android', isNativePlatform: () => true, Plugins: {},
            };
            localStorage.setItem('scirepl_privacy_accepted', '1');
            localStorage.setItem('scirepl_privacy_accepted_revision', '2026-08-catalog-sources-v1');
            localStorage.setItem('scirepl_auto_download', '1');
            localStorage.setItem('scirepl_auto_execute', '0');
            localStorage.setItem('scirepl_onboarding_seen', '1');
            localStorage.setItem('scirepl_i18n_show_drafts', '1');
            addEventListener('DOMContentLoaded', () => localStorage.setItem(
                'scirepl_whats_new_seen_version', window.KERNEL_CONFIG.app.version), { once: true });
        }, native);
        const page = await context.newPage();
        page.on('pageerror', error => errors.push(error.message));
        page.on('dialog', dialog => { dialogs.push(dialog.type()); dialog.dismiss().catch(() => {}); });
        await page.goto(new URL('index.html', BASE).href, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => window.__SCIREPL_APP_READY && window.i18n
            && window.fileIO && window.onboarding && window.scireplTutorials);
        await page.evaluate(() => {
            window.__tutorialLinkEffects = [];
            for (const [owner, methods] of [
                [window, ['importCells']], [window.kernelManager, ['execute']],
                [window.fileIO, ['importSrwb', 'importIpynb', 'handleFileUpload']],
            ]) for (const method of methods) {
                if (typeof owner?.[method] !== 'function') continue;
                owner[method] = () => {
                    window.__tutorialLinkEffects.push(method);
                    return Promise.resolve([]);
                };
            }
            document.getElementById('code-input').value = 'draft_to_keep';
            document.getElementById('shared-upload-path').value = '/shared/keep/';
        });

        async function openModal(link) {
            await page.evaluate(modal => {
                document.querySelectorAll('.modal').forEach(el => el.classList.add('hidden'));
                document.getElementById(modal).classList.remove('hidden');
            }, link.modal);
        }
        async function state() {
            return page.evaluate(() => ({
                draft: document.getElementById('code-input').value,
                destination: document.getElementById('shared-upload-path').value,
                cells: window._cells.map(cell => ({ id: cell.id, code: cell.code, language: cell.language, type: cell.type })),
                preferences: Object.fromEntries(Object.keys(localStorage).filter(key => key.startsWith('scirepl_')
                    && !['scirepl_session_v1', 'scirepl_session_v2', 'scirepl_draft_input'].includes(key))
                    .sort().map(key => [key, localStorage.getItem(key)])),
                effects: window.__tutorialLinkEffects,
            }));
        }

        for (const locale of LOCALES) {
            await page.evaluate(code => window.i18n.activate(code), locale);
            equal(await page.evaluate(() => document.documentElement.dir), locale === 'ar' ? 'rtl' : 'ltr',
                `${mode}/${locale}: correct layout direction`);
            for (const link of LINKS) {
                await openModal(link);
                const element = page.locator(`#${link.id}`);
                await element.scrollIntoViewIfNeeded();
                equal(await element.innerText(), catalogues.get(locale)[link.key], `${mode}/${locale}: translated label`);
                equal(await element.getAttribute('href'), href(link, locale), `${mode}/${locale}: selected-language guide`);
                const geometry = await element.evaluate(el => {
                    const r = el.getBoundingClientRect();
                    return { x: r.x, right: r.right, width: r.width, height: r.height,
                        fits: el.scrollWidth <= el.clientWidth + 1 };
                });
                check(geometry.height >= 43.5 && geometry.width >= 43.5 && geometry.x >= -1
                    && geometry.right <= 321 && geometry.fits, `${mode}/${locale}: 44px target fits a narrow viewport`);
                await element.focus();
                check(await element.evaluate(el => document.activeElement === el), `${mode}/${locale}: keyboard focus`);
            }
        }
        equal(requests, [], `${mode}: startup and locale changes make no external requests`);
        for (const link of LINKS) {
            await openModal(link);
            const before = await state();
            const mainURL = page.url();
            const beforeCount = requests.length;
            const expectedURL = href(link, 'zh');
            const popupPromise = page.waitForEvent('popup');
            await page.locator(`#${link.id}`).press('Enter');
            const popup = await popupPromise;
            await popup.waitForLoadState('domcontentloaded');
            equal(popup.url(), expectedURL, `${mode}: Enter opens the selected-language guide`);
            check(await popup.evaluate(() => window.opener === null), `${mode}: external guide has no opener`);
            equal(page.url(), mainURL, `${mode}: app remains open`);
            equal(await state(), before, `${mode}: navigation preserves cells, drafts, consent and all preferences`);
            equal(requests.slice(beforeCount), [{ url: expectedURL, method: 'GET', type: 'document' }],
                `${mode}: only the explicit guide navigation is requested`);
            await popup.close();
        }
        await context.setOffline(true);
        await page.evaluate(() => { window.i18n.current = 'javascript:alert(1)'; window.scireplTutorials.update(); });
        for (const link of LINKS) equal(await page.locator(`#${link.id}`).getAttribute('href'), href(link),
            `${mode}: loaded helper can update safely while offline`);
        equal(await page.evaluate(() => window.__tutorialLinkEffects), [], `${mode}: no import or execution actions`);
        equal(dialogs, [], `${mode}: reading links asks for no consent or permission changes`);
        equal(errors, [], `${mode}: no app errors`);
        await context.close();
    }
} finally { await browser.close(); }
console.log(`Tutorial entry links: ${checks} checks passed; no live external requests or code execution.`);
