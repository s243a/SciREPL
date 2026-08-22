// Playwright test: What's New lifecycle and optional header shortcuts.
// Run the dev server first: node server.js
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const PORT = process.env.PORT || 8085;
const APP_URL = `http://localhost:${PORT}/index.html`;
const PACKAGE = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const PACKAGE_VERSION = PACKAGE.version;
const RELEASE_CHANNEL = PACKAGE.releaseChannel;

let failures = 0;
const check = (name, passed, detail = '') => {
    if (!passed) failures++;
    console.log(`  [${passed ? 'PASS' : 'FAIL'}] ${name}${detail ? ': ' + String(detail).slice(0, 180) : ''}`);
};

const browser = await chromium.launch({ headless: true });

async function load(context) {
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForFunction(() => window.__SCIREPL_APP_READY
        && window.whatsNew && window.onboarding && window.appearance,
    null, { timeout: 30_000 });
    return { page, errors };
}

async function existingContext({ markCurrent = false } = {}) {
    const context = await browser.newContext();
    await context.addInitScript((mark) => {
        localStorage.setItem('scirepl_privacy_accepted', '1');
        localStorage.setItem('scirepl_onboarding_seen', '1');
        if (mark) {
            addEventListener('DOMContentLoaded', () => {
                const version = window.KERNEL_CONFIG?.app?.version;
                if (version) localStorage.setItem('scirepl_whats_new_seen_version', version);
            }, { once: true });
        }
    }, markCurrent);
    return context;
}

try {
    console.log('\n1. Version source and upgrade lifecycle');
    const upgrade = await existingContext();
    const { page, errors } = await load(upgrade);
    await page.waitForSelector('#whats-new-modal:not(.hidden)', { timeout: 10_000 });

    const release = await page.evaluate(() => ({
        generated: window.KERNEL_CONFIG.app.version,
        channel: window.KERNEL_CONFIG.app.releaseChannel,
        visible: document.getElementById('whats-new-version').textContent,
        highlights: document.querySelectorAll('#whats-new-highlights li').length,
        expectedHighlights: (window.KERNEL_CONFIG.app.releaseChannel === 'release'
            ? window.SCIREPL_RELEASE_HIGHLIGHTS[window.KERNEL_CONFIG.app.version]
            : window.SCIREPL_RELEASE_HIGHLIGHTS.unreleased).length,
        frozen110: Array.from(window.SCIREPL_RELEASE_HIGHLIGHTS['1.1.0'] || []),
        href: document.getElementById('whats-new-release-link').href,
        focusInside: document.getElementById('whats-new-modal').contains(document.activeElement),
        languageBeforeTitle: Boolean(document.getElementById('whats-new-language')
            .compareDocumentPosition(document.getElementById('whats-new-title'))
            & Node.DOCUMENT_POSITION_FOLLOWING),
    }));
    check('package.json is the generated browser version source',
        release.generated === PACKAGE_VERSION, JSON.stringify(release));
    check('package.json is the explicit browser release-channel source',
        release.channel === RELEASE_CHANNEL, JSON.stringify(release));
    check('the modal renders that version', release.visible.includes(PACKAGE_VERSION), release.visible);
    check('the label honestly follows the declared development/release channel',
        release.visible.includes(PACKAGE_VERSION)
        && (RELEASE_CHANNEL === 'development'
            ? /unreleased/i.test(release.visible)
            : !/unreleased/i.test(release.visible)), release.visible);
    check('the current build renders the real table for its declared channel',
        release.highlights === release.expectedHighlights
        && release.highlights > 0 && release.highlights <= 5,
        JSON.stringify(release));
    check('the published 1.1.0 highlights remain frozen history',
        JSON.stringify(release.frozen110) === JSON.stringify([
            'whatsNew.highlightLanguages',
            'whatsNew.highlightOffline',
            'whatsNew.highlightDesktop',
        ]), JSON.stringify(release.frozen110));
    check('the release link remains valid before a tag exists', /\/releases\/?$/.test(release.href), release.href);
    check('focus moves into the modal', release.focusInside);
    check('the display-language picker is above the release title', release.languageBeforeTitle);

    await page.selectOption('#whats-new-language', 'es');
    await page.waitForFunction(() => document.documentElement.lang === 'es');
    check('the top picker changes the display language in place', await page.evaluate(() =>
        document.getElementById('whats-new-title').textContent === window.t('whatsNew.title')
        && document.getElementById('whats-new-title').textContent !== 'What’s new in SciREPL'
        && document.activeElement.id === 'whats-new-language'));
    await page.selectOption('#whats-new-language', 'en');
    await page.waitForFunction(() => document.documentElement.lang === 'en');

    await page.click('#whats-new-done');
    check('closing records the exact version', await page.evaluate((version) =>
        localStorage.getItem('scirepl_whats_new_seen_version') === version, PACKAGE_VERSION));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__SCIREPL_APP_READY, null, { timeout: 30_000 });
    await page.waitForTimeout(1000);
    check('the same version does not open twice', await page.evaluate(() =>
        document.getElementById('whats-new-modal').classList.contains('hidden')));

    await page.click('#help-btn');
    check('Help explains how to restore both default header shortcuts', await page.evaluate(() => {
        const note = document.querySelector('[data-i18n="help.headerShortcuts"]');
        return note && note.textContent === window.t('help.headerShortcuts')
            && note.textContent.includes('🧭') && note.textContent.includes('∑');
    }));
    await page.click('#btn-show-whats-new');
    check('Help can reopen it after the one-time prompt', await page.evaluate(() =>
        !document.getElementById('whats-new-modal').classList.contains('hidden')));
    await page.click('#whats-new-done');
    check('the lifecycle produces no page errors', errors.length === 0, errors.join(' | '));
    await upgrade.close();

    console.log('\n2. Privacy/runtime modal arbitration');
    const blocked = await existingContext();
    await blocked.addInitScript(() => {
        addEventListener('DOMContentLoaded', () => {
            document.getElementById('privacy-modal')?.classList.remove('hidden');
        }, { once: true });
    });
    const { page: blockedPage, errors: blockedErrors } = await load(blocked);
    await blockedPage.waitForTimeout(1000);
    check('privacy outranks the automatic update', await blockedPage.evaluate(() =>
        document.getElementById('whats-new-modal').classList.contains('hidden')));
    await blockedPage.evaluate(() => document.getElementById('privacy-modal').classList.add('hidden'));
    await blockedPage.waitForSelector('#whats-new-modal:not(.hidden)', { timeout: 5_000 });
    check('the update resumes once privacy closes', true);

    await blockedPage.evaluate(() => document.getElementById('runtime-download-modal')
        .classList.remove('hidden'));
    await blockedPage.waitForFunction(() => document.getElementById('whats-new-modal')
        .classList.contains('hidden'));
    check('a runtime dialog suspends an already-open update', await blockedPage.evaluate(() =>
        document.getElementById('runtime-download-modal').contains(document.activeElement)));
    await blockedPage.evaluate(() => document.getElementById('runtime-download-modal')
        .classList.add('hidden'));
    await blockedPage.waitForSelector('#whats-new-modal:not(.hidden)', { timeout: 5_000 });
    check('the same modal resumes rather than duplicating', await blockedPage.evaluate(() =>
        document.querySelectorAll('#whats-new-modal').length === 1));
    check('arbitration produces no page errors', blockedErrors.length === 0, blockedErrors.join(' | '));
    await blocked.close();

    console.log('\n3. First-run completion and Skip');
    const first = await browser.newContext();
    await first.addInitScript(() => localStorage.setItem('scirepl_privacy_accepted', '1'));
    const { page: firstPage, errors: firstErrors } = await load(first);
    await firstPage.waitForSelector('#tour-overlay', { timeout: 10_000 });
    check('the Tour shortcut option starts checked', await firstPage.isChecked('#tour-show-shortcut'));
    await firstPage.uncheck('#tour-show-shortcut');
    check('the first tour panel can hide the Tour shortcut', await firstPage.evaluate(() =>
        document.getElementById('tour-shortcut-btn').classList.contains('header-shortcut-hidden')));
    await firstPage.evaluate(() => {
        const tour = window.onboarding;
        while (tour.el && tour.index < tour.steps.length - 1) tour.go(1);
        if (tour.el) tour.go(1);
    });
    await firstPage.waitForSelector('#whats-new-modal:not(.hidden)', { timeout: 5_000 });
    check('normal first-run completion continues into What’s New', true);
    check('first-run completion produces no page errors', firstErrors.length === 0,
        firstErrors.join(' | '));
    await first.close();

    const skipped = await browser.newContext();
    await skipped.addInitScript(() => localStorage.setItem('scirepl_privacy_accepted', '1'));
    const { page: skipPage } = await load(skipped);
    await skipPage.waitForSelector('#tour-overlay', { timeout: 10_000 });
    await skipPage.click('#tour-skip');
    check('Skip suppresses What’s New for this version', await skipPage.evaluate((version) =>
        localStorage.getItem('scirepl_whats_new_seen_version') === version, PACKAGE_VERSION));
    await skipPage.reload({ waitUntil: 'domcontentloaded' });
    await skipPage.waitForFunction(() => window.__SCIREPL_APP_READY, null, { timeout: 30_000 });
    await skipPage.waitForTimeout(1000);
    check('Skip does not turn into a prompt on the next launch', await skipPage.evaluate(() =>
        document.getElementById('whats-new-modal').classList.contains('hidden')));
    await skipped.close();

    console.log('\n4. Optional header shortcuts');
    const prefs = await existingContext({ markCurrent: true });
    const { page: prefsPage, errors: prefsErrors } = await load(prefs);
    // Desktop width, so "auto" has room and behaves like "always".
    check('Tour and Browse are visible and Formula is hidden by default (formula is opt-in)', await prefsPage.evaluate(() =>
        !document.getElementById('tour-shortcut-btn').classList.contains('header-shortcut-hidden')
        && !document.getElementById('browse-shortcut-btn').classList.contains('header-shortcut-hidden')
        && document.getElementById('math-mode-btn').classList.contains('header-shortcut-hidden')));
    check('the stored modes are the three-state defaults', await prefsPage.evaluate(() =>
        window.appearance.getShortcutMode('browse') === 'auto'
        && window.appearance.getShortcutMode('tour') === 'auto'
        && window.appearance.getShortcutMode('formula') === 'never'));
    await prefsPage.click('#menu-btn');
    await prefsPage.click('#btn-appearance');
    check('Appearance lists one row per shortcut, in priority order',
        await prefsPage.evaluate(() =>
            [...document.querySelectorAll('#appearance-shortcut-list .appearance-shortcut-row')].length === 3));
    check('each row offers all three states',
        await prefsPage.evaluate(() =>
            [...document.querySelectorAll('#appearance-shortcut-mode-browse option')].map(o => o.value).join(',')
            === 'always,auto,never'));
    check('the selects reflect the stored modes',
        await prefsPage.inputValue('#appearance-shortcut-mode-browse') === 'auto'
        && await prefsPage.inputValue('#appearance-shortcut-mode-formula') === 'never');

    await prefsPage.selectOption('#appearance-shortcut-mode-browse', 'never');
    check('choosing Never hides Browse and takes it out of the tab order',
        await prefsPage.evaluate(() => {
            const button = document.getElementById('browse-shortcut-btn');
            return button.classList.contains('header-shortcut-hidden') && button.tabIndex === -1;
        }));
    await prefsPage.selectOption('#appearance-shortcut-mode-browse', 'auto');
    check('choosing When there is room restores it at this width', await prefsPage.evaluate(() =>
        !document.getElementById('browse-shortcut-btn').classList.contains('header-shortcut-hidden')));

    check('priority starts at the registry default', await prefsPage.evaluate(() =>
        window.appearance.getShortcutPriority().join('>') === 'browse>formula>tour'));
    await prefsPage.click('#appearance-shortcut-list .appearance-shortcut-row:nth-child(3) .appearance-shortcut-move:first-of-type');
    check('the priority controls reorder the list', await prefsPage.evaluate(() =>
        window.appearance.getShortcutPriority().join('>') === 'browse>tour>formula'));
    await prefsPage.evaluate(() => window.appearance.setShortcutPriority(['browse', 'formula', 'tour']));

    await prefsPage.selectOption('#appearance-shortcut-mode-tour', 'never');
    await prefsPage.selectOption('#appearance-shortcut-mode-formula', 'always');
    check('the Appearance controls apply both choices immediately', await prefsPage.evaluate(() =>
        document.getElementById('tour-shortcut-btn').classList.contains('header-shortcut-hidden')
        && !document.getElementById('math-mode-btn').classList.contains('header-shortcut-hidden')));
    // Close deterministically: focus now sits in a <select>, which swallows
    // Escape before the modal sees it.
    await prefsPage.evaluate(() => document.getElementById('appearance-modal').classList.add('hidden'));
    await prefsPage.evaluate(() => window.appearance.setShortcutMode('formula', 'always'));
    await prefsPage.click('#math-mode-btn');
    await prefsPage.evaluate(() => window.appearance.setShortcutMode('formula', 'never'));
    check('hiding Formula also closes its open palette', await prefsPage.evaluate(() => {
        const button = document.getElementById('math-mode-btn');
        return button.classList.contains('header-shortcut-hidden')
            && !button.classList.contains('active')
            && document.getElementById('math-palette').classList.contains('hidden');
    }));
    check('Tour remains independently hidden', await prefsPage.evaluate(() =>
        document.getElementById('tour-shortcut-btn').classList.contains('header-shortcut-hidden')));
    await prefsPage.reload({ waitUntil: 'domcontentloaded' });
    await prefsPage.waitForFunction(() => window.__SCIREPL_APP_READY, null, { timeout: 30_000 });
    check('shortcut choices persist', await prefsPage.evaluate(() =>
        document.getElementById('tour-shortcut-btn').classList.contains('header-shortcut-hidden')
        && document.getElementById('math-mode-btn').classList.contains('header-shortcut-hidden')));
    await prefsPage.evaluate(() => window.appearance.reset());
    check('Reset restores the defaults (tour and browse auto, formula never)', await prefsPage.evaluate(() =>
        window.appearance.getShortcutMode('browse') === 'auto'
        && window.appearance.getShortcutMode('tour') === 'auto'
        && window.appearance.getShortcutMode('formula') === 'never'
        && !document.getElementById('browse-shortcut-btn').classList.contains('header-shortcut-hidden')));
    check('shortcut controls produce no page errors', prefsErrors.length === 0, prefsErrors.join(' | '));
    await prefs.close();

    // Opening the catalogue starts a remote source load, which asynchronously
    // raises the download-consent modal over the header. That modal would
    // intercept any later click, and it arrives too late to dismiss inline, so
    // this check owns a context that is closed the moment it is done.
    const browseCtx = await existingContext({ markCurrent: true });
    const { page: browsePage } = await load(browseCtx);
    await browsePage.click('#browse-shortcut-btn');
    check('the Browse shortcut opens the package catalogue without the menu hop',
        await browsePage.evaluate(() =>
            !document.getElementById('package-catalog-modal').classList.contains('hidden')));
    await browseCtx.close();

    const compact = await browser.newContext({ viewport: { width: 320, height: 640 } });
    await compact.addInitScript(() => {
        localStorage.setItem('scirepl_privacy_accepted', '1');
        localStorage.setItem('scirepl_onboarding_seen', '1');
        addEventListener('DOMContentLoaded', () => {
            const version = window.KERNEL_CONFIG?.app?.version;
            if (version) localStorage.setItem('scirepl_whats_new_seen_version', version);
        }, { once: true });
    });
    const { page: compactPage } = await load(compact);
    const compactHeader = await compactPage.evaluate(() => {
        const buttons = [...document.querySelectorAll('.header-right > *')]
            .filter((node) => getComputedStyle(node).display !== 'none');
        return {
            tourVisible: getComputedStyle(document.getElementById('tour-shortcut-btn')).display !== 'none',
            browseVisible: getComputedStyle(document.getElementById('browse-shortcut-btn')).display !== 'none',
            formulaVisible: getComputedStyle(document.getElementById('math-mode-btn')).display !== 'none',
            withinViewport: buttons.every((node) => {
                const rect = node.getBoundingClientRect();
                return rect.left >= 0 && rect.right <= innerWidth;
            }),
            scrollWidth: document.documentElement.scrollWidth,
            innerWidth,
        };
    });
    // At 320px the header has room for the mandatory buttons and the status
    // badge and nothing else — one optional button already wraps it. So the
    // "auto" default correctly yields NO optional shortcuts here, and the
    // header still occupies a single row. That is the whole point of the third
    // state: the same settings give a different answer on a wider screen,
    // which test_header_shortcuts.mjs pins across widths.
    check('at 320px the auto shortcuts stand down and the header stays one row',
        !compactHeader.tourVisible && !compactHeader.browseVisible && !compactHeader.formulaVisible
        && compactHeader.withinViewport && compactHeader.scrollWidth <= compactHeader.innerWidth,
        JSON.stringify(compactHeader));
    await compact.close();
} finally {
    await browser.close();
}

console.log(`\n${failures ? `FAILED: ${failures}` : 'All What\'s New tests passed.'}`);
process.exitCode = failures ? 1 : 0;
