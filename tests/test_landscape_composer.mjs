// Playwright regression: short-landscape composer collapse.
//
// Run the dev server first (PORT=8085 by default), then:
//   node tests/test_landscape_composer.mjs
//
// Ported from SciREPL Pro's test of the same feature (sections 1-3, 7-9),
// adapted to Free's header and footer.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const PORT = process.env.PORT || 8085;
const APP_URL = `http://localhost:${PORT}/index.html`;
const TIMEOUT = 120_000;
let checks = 0;

function check(message, condition, detail = '') {
    assert.ok(condition, `${message}${detail ? `: ${detail}` : ''}`);
    checks += 1;
    console.log(`  PASS ${message}${detail ? `: ${String(detail).slice(0, 240)}` : ''}`);
}

async function settle(page) {
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(
        () => requestAnimationFrame(resolve))));
}

async function state(page) {
    return page.evaluate(() => {
        const toggle = document.getElementById('composer-toggle');
        const restore = document.getElementById('composer-restore-btn');
        const content = document.getElementById('composer-content');
        const bar = document.getElementById('input-bar');
        const body = document.getElementById('app-body');
        const input = document.getElementById('code-input');
        const activeScroller = [...document.querySelectorAll('#repl, .repl-container')]
            .find(el => el.offsetParent !== null);
        const visible = element => {
            if (!element || element.hidden) return false;
            const style = getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            return style.display !== 'none' && style.visibility !== 'hidden'
                && rect.width > 0 && rect.height > 0;
        };
        const box = element => {
            const rect = element.getBoundingClientRect();
            return {
                left: Math.round(rect.left * 10) / 10,
                right: Math.round(rect.right * 10) / 10,
                top: Math.round(rect.top * 10) / 10,
                bottom: Math.round(rect.bottom * 10) / 10,
                width: Math.round(rect.width * 10) / 10,
                height: Math.round(rect.height * 10) / 10,
            };
        };
        return {
            eligible: !!window.landscapeComposer?.isEligible?.(),
            toggleVisible: visible(toggle),
            restoreVisible: visible(restore),
            // The controlled wrapper intentionally uses display:contents so it
            // does not alter the historical flex geometry; its own rectangle
            // is therefore empty even when its children are fully visible.
            contentVisible: !!content && !content.hidden && visible(input),
            expanded: toggle?.getAttribute('aria-expanded'),
            label: toggle?.getAttribute('aria-label'),
            title: toggle?.getAttribute('title'),
            expectedExpand: window.t?.('composer.expand'),
            expectedCollapse: window.t?.('composer.collapse'),
            toggleBox: toggle ? box(toggle) : null,
            restoreBox: restore ? box(restore) : null,
            contentBox: input ? box(input) : null,
            barBox: bar ? box(bar) : null,
            bodyBox: body ? box(body) : null,
            inputValue: input?.value,
            selectionStart: input?.selectionStart,
            selectionEnd: input?.selectionEnd,
            activeId: document.activeElement?.id || '',
            paletteOpen: !document.getElementById('math-palette')?.classList.contains('hidden'),
            footerOverlay: parseFloat(activeScroller
                ? getComputedStyle(activeScroller).getPropertyValue('--footer-overlay-local') : '0') || 0,
            viewportLift: parseFloat(getComputedStyle(body)
                .getPropertyValue('--sci-vv-lift')) || 0,
        };
    });
}

async function swipe(page, deltaY) {
    await page.evaluate((dy) => {
        const target = document.getElementById('composer-toggle');
        const rect = target.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        const event = (type, clientY, buttons) => new PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            pointerId: 7,
            pointerType: 'touch',
            isPrimary: true,
            buttons,
            clientX: x,
            clientY,
        });
        target.dispatchEvent(event('pointerdown', y, 1));
        target.dispatchEvent(event('pointermove', y + dy, 1));
        target.dispatchEvent(event('pointerup', y + dy, 0));
    }, deltaY);
    await settle(page);
}

async function swipeUpFromBottom(page, deltaY = -72, options = {}) {
    await page.evaluate(({ dy, opts }) => {
        const target = [...document.querySelectorAll('#repl, .repl-container')]
            .find(el => el.offsetParent !== null);
        if (opts.atEnd !== false) target.scrollTop = target.scrollHeight;
        const viewport = window.visualViewport;
        const bottom = viewport ? viewport.offsetTop + viewport.height : innerHeight;
        const x = innerWidth * (opts.xRatio ?? 0.5);
        const y = bottom - 12;
        const event = (type, clientY, buttons) => new PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            pointerId: 19,
            pointerType: 'mouse',
            isPrimary: true,
            buttons,
            clientX: x,
            clientY,
        });
        target.dispatchEvent(event('pointerdown', y, 1));
        target.dispatchEvent(event('pointerup', y + dy, 0));
    }, { dy: deltaY, opts: options });
    await settle(page);
}

async function realTouchSwipeUpFromBottom(page, deltaY = -72) {
    const point = await page.evaluate(() => {
        const target = [...document.querySelectorAll('#repl, .repl-container')]
            .find(el => el.offsetParent !== null);
        target.scrollTop = target.scrollHeight;
        const viewport = window.visualViewport;
        const bottom = viewport ? viewport.offsetTop + viewport.height : innerHeight;
        window.__composerTouchPointerCancels = 0;
        document.addEventListener('pointercancel', () => {
            window.__composerTouchPointerCancels += 1;
        }, { once: true, capture: true });
        return { x: innerWidth * 0.5, y: bottom - 12 };
    });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x: point.x, y: point.y, id: 31 }],
    });
    await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x: point.x, y: point.y + deltaY, id: 31 }],
    });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await cdp.detach();
    await settle(page);
}

function installPrelude() {
    localStorage.setItem('scirepl_privacy_accepted', '1');
    localStorage.setItem('scirepl_privacy_accepted_revision', '2026-09-network-guard-v1');
    localStorage.setItem('scirepl_onboarding_seen', '1');
    localStorage.setItem('scirepl_auto_download', '1');
    addEventListener('DOMContentLoaded', () => {
        const version = window.KERNEL_CONFIG?.app?.version;
        if (version) localStorage.setItem('scirepl_whats_new_seen_version', version);
    }, { once: true });
}

const browser = await chromium.launch({ headless: true });
try {
    // Deliberately not a mobile/coarse-pointer context: eligibility is based on
    // usable landscape height, so desktop and native window resizing behave the
    // same and a stylus/mouse-connected phone is not accidentally excluded.
    const context = await browser.newContext({ viewport: { width: 844, height: 390 } });
    await context.addInitScript(installPrelude);
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
    await page.waitForFunction(() => window.__SCIREPL_APP_READY === true
        && window.landscapeComposer && window.appearance && window.mathMode,
    null, { timeout: TIMEOUT });
    await page.waitForFunction(async () => {
        if (!window.i18n) return false;
        await window.i18n.init();
        return window.t('composer.collapse') !== 'composer.collapse';
    }, null, { timeout: TIMEOUT });
    await settle(page);

    console.log('1. Short landscape starts expanded and remains usable');
    let before = await state(page);
    check('844x390 is eligible without a coarse-pointer requirement',
        before.eligible && before.toggleVisible, JSON.stringify(before));
    check('the composer starts expanded whenever eligibility begins',
        before.contentVisible && before.expanded === 'true', JSON.stringify(before));
    check('the expanded toggle has synchronized accessible text',
        before.label === before.expectedCollapse && before.title === before.expectedCollapse,
        `${before.label} / ${before.expectedCollapse}`);
    const rawKeyLabels = await page.evaluate(() => {
        const realT = window.t;
        window.t = key => key;   // catalogue not loaded yet
        try {
            window.landscapeComposer._refreshLabel();
            return {
                toggle: document.getElementById('composer-toggle').getAttribute('aria-label'),
                restore: document.getElementById('composer-restore-btn').getAttribute('title'),
            };
        } finally {
            window.t = realT;
            window.landscapeComposer._refreshLabel();
        }
    });
    check('an unloaded catalogue falls back to English rather than raw keys',
        rawKeyLabels.toggle === 'Hide new-cell panel'
        && rawKeyLabels.restore === 'Show new-cell panel', JSON.stringify(rawKeyLabels));
    check('the toggle is a complete on-screen touch target',
        before.toggleBox.height >= 44 && before.toggleBox.left >= 0
        && before.toggleBox.right <= 844 && before.toggleBox.top >= 0
        && before.toggleBox.bottom <= 390, JSON.stringify(before.toggleBox));
    check('the footer participates in layout rather than covering the notebook',
        before.bodyBox.bottom <= before.barBox.top + 1,
        `${before.bodyBox.bottom} <= ${before.barBox.top}`);
    // Free-specific: the wrapper must not disturb the historical single row
    // (controls, code field, Run) that composer_fit.js measures.
    const row = await page.evaluate(() => {
        const ids = ['composer-toggle', 'input-controls', 'code-input', 'run-btn'];
        const boxes = ids.map(id => document.getElementById(id).getBoundingClientRect());
        const rowBox = document.querySelector('#input-bar .input-row').getBoundingClientRect();
        const hit = id => {
            const el = document.getElementById(id);
            const r = el.getBoundingClientRect();
            const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
            return at === el || el.contains(at);
        };
        return {
            ordered: boxes.every((b, i) => i === 0 || b.left >= boxes[i - 1].right - 1),
            inside: boxes.every(b => b.left >= rowBox.left - 1 && b.right <= rowBox.right + 1),
            hittable: ['composer-toggle', 'code-input'].every(hit),
            parent: document.getElementById('code-input').parentElement.id,
        };
    });
    check('the toggle, controls, code field and Run share one unclipped row',
        row.ordered && row.inside && row.hittable && row.parent === 'composer-content',
        JSON.stringify(row));

    // First prove the ordinary pointer/tap path, independently of the focus
    // rescue below.
    await page.click('#composer-toggle');
    await settle(page);
    let collapsed = await state(page);
    check('tap collapses the new-cell panel and moves Show into the header',
        !collapsed.contentVisible && collapsed.expanded === 'false'
        && !collapsed.toggleVisible && collapsed.restoreVisible,
        JSON.stringify(collapsed));
    check('the collapsed footer leaves layout completely',
        collapsed.barBox.height === 0 && collapsed.bodyBox.bottom >= 389
        && collapsed.footerOverlay === 0 && collapsed.viewportLift === 0,
        JSON.stringify(collapsed));
    await page.click('#composer-restore-btn');
    await settle(page);
    check('tap reopens the panel',
        (await state(page)).contentVisible && (await state(page)).expanded === 'true');

    await page.evaluate(() => {
        const input = document.getElementById('code-input');
        input.value = 'first line\nsecond line\nthird line';
        input.setSelectionRange(11, 22);
        input.focus();
    });
    const expandedBodyHeight = before.bodyBox.height;
    await page.evaluate(() => window.landscapeComposer.setCollapsed(true));
    await settle(page);
    collapsed = await state(page);
    check('the public controller collapses the new-cell panel',
        !collapsed.contentVisible && collapsed.expanded === 'false', JSON.stringify(collapsed));
    check('collapse moves focus to the remaining control',
        collapsed.activeId === 'composer-restore-btn', collapsed.activeId);
    check('collapsed control announces its inverse action',
        await page.evaluate(() => {
            const restore = document.getElementById('composer-restore-btn');
            return restore.getAttribute('aria-label') === window.t('composer.expand')
                && restore.getAttribute('title') === window.t('composer.expand')
                && restore.getAttribute('aria-controls') === 'composer-content';
        }));
    check('collapse yields notebook height',
        collapsed.bodyBox.height > expandedBodyHeight, `${collapsed.bodyBox.height} > ${expandedBodyHeight}`);
    check('collapse preserves the draft and selection',
        collapsed.inputValue === 'first line\nsecond line\nthird line'
        && collapsed.selectionStart === 11 && collapsed.selectionEnd === 22,
        JSON.stringify(collapsed));

    await page.click('#composer-restore-btn');
    await settle(page);
    let opened = await state(page);
    check('the panel reopens after focus-safe collapse',
        opened.contentVisible && opened.expanded === 'true', JSON.stringify(opened));
    check('reopening keeps focus on the footer control instead of summoning the keyboard',
        opened.activeId === 'composer-toggle', opened.activeId);

    console.log('2. Directional gestures are deliberate and reversible');
    await swipe(page, 72);
    collapsed = await state(page);
    check('downward swipe collapses', !collapsed.contentVisible && collapsed.expanded === 'false');
    await page.evaluate(() => {
        document.getElementById('composer-toggle').dispatchEvent(new PointerEvent('click', {
            bubbles: true,
            cancelable: true,
            detail: 1,
            pointerId: -1,
            pointerType: 'touch',
        }));
    });
    check('the swipe compatibility click cannot undo the gesture',
        (await state(page)).expanded === 'false');
    await page.press('#composer-restore-btn', 'Enter');
    opened = await state(page);
    check('keyboard activation is not swallowed by the swipe compatibility click',
        opened.contentVisible && opened.expanded === 'true');
    await swipe(page, 72);
    collapsed = await state(page);
    check('a new pointer gesture still works immediately after keyboard activation',
        !collapsed.contentVisible && collapsed.expanded === 'false');
    await page.click('#composer-restore-btn');
    check('a genuine corrective tap is not swallowed after a swipe',
        (await state(page)).expanded === 'true');
    await swipe(page, 72);
    await realTouchSwipeUpFromBottom(page);
    opened = await state(page);
    check('a real upward touch stream expands despite Chrome pointer cancellation',
        opened.contentVisible && opened.expanded === 'true'
        && await page.evaluate(() => window.__composerTouchPointerCancels > 0),
        JSON.stringify(opened));
    await swipe(page, 72);
    await swipeUpFromBottom(page, -12);
    check('short bottom-edge movement is not mistaken for a swipe',
        (await state(page)).expanded === 'false');
    await swipeUpFromBottom(page, -72, { xRatio: 0.05 });
    check('the side navigation zone is not claimed as a composer gesture',
        (await state(page)).expanded === 'false');
    await page.evaluate(() => {
        const target = [...document.querySelectorAll('#repl, .repl-container')]
            .find(el => el.offsetParent !== null);
        const spacer = document.createElement('div');
        spacer.id = 'composer-gesture-scroll-fixture';
        spacer.style.height = '1200px';
        target.appendChild(spacer);
        target.scrollTop = 0;
    });
    await swipeUpFromBottom(page, -72, { atEnd: false });
    check('an ordinary mid-notebook upward scroll does not reveal the composer',
        (await state(page)).expanded === 'false');
    await page.evaluate(() => document.getElementById('composer-gesture-scroll-fixture')?.remove());
    await page.click('#composer-restore-btn');

    // An open palette must not remain as a tall, orphaned footer after the
    // editor it belongs to is collapsed. Free hides the Formula header button
    // by default, and a hidden button closes its palette, so show it first.
    await page.evaluate(() => window.appearance.setShortcutMode('formula', 'always'));
    await settle(page);
    await page.click('#math-mode-btn');
    await settle(page);
    check('the Formula palette opens in short landscape', (await state(page)).paletteOpen);
    await page.evaluate(() => window.landscapeComposer.setCollapsed(true));
    await settle(page);
    collapsed = await state(page);
    check('collapsing also closes an open Formula palette', !collapsed.paletteOpen);
    await page.click('#composer-restore-btn');
    await settle(page);
    await page.click('#math-mode-btn');
    await settle(page);
    await settle(page);
    const palette = await page.evaluate(() => {
        const pal = document.getElementById('math-palette');
        const bar = document.getElementById('input-bar');
        const input = document.getElementById('code-input');
        const r = pal.getBoundingClientRect();
        return {
            open: !pal.classList.contains('hidden'),
            spaceCollapsed: pal.classList.contains('space-collapsed'),
            palBottom: r.bottom,
            inputTop: input.getBoundingClientRect().top,
            barBottom: bar.getBoundingClientRect().bottom,
            composerMax: bar.style.getPropertyValue('--sci-composer-max'),
        };
    });
    check('a reopened composer is budgeted again by the Formula palette',
        palette.open && palette.composerMax !== ''
        && (palette.spaceCollapsed || palette.palBottom <= palette.inputTop + 1)
        && palette.barBottom <= 391, JSON.stringify(palette));
    await page.evaluate(() => {
        window.mathMode.setOpen(false);
        window.appearance.setShortcutMode('formula', 'never');
    });

    console.log('3. Eligibility changes fail toward a visible composer');
    await page.evaluate(() => window.landscapeComposer.setCollapsed(true));
    await page.focus('#composer-restore-btn');
    await page.setViewportSize({ width: 390, height: 844 });
    await settle(page);
    let portrait = await state(page);
    check('portrait hides the landscape handle and forces content visible',
        !portrait.toggleVisible && !portrait.restoreVisible && portrait.contentVisible,
        JSON.stringify(portrait));
    check('rotation hands focus from the hidden handle back to the restored editor',
        portrait.activeId === 'code-input', portrait.activeId);

    await page.setViewportSize({ width: 844, height: 390 });
    await settle(page);
    let reentered = await state(page);
    check('re-entering short landscape starts expanded rather than restoring hidden state',
        reentered.toggleVisible && reentered.contentVisible && reentered.expanded === 'true',
        JSON.stringify(reentered));

    await page.click('#composer-toggle');
    await page.setViewportSize({ width: 1024, height: 600 });
    await settle(page);
    const tablet = await state(page);
    check('roomy landscape does not offer or retain collapse',
        !tablet.toggleVisible && tablet.contentVisible, JSON.stringify(tablet));

    await page.setViewportSize({ width: 844, height: 390 });
    await settle(page);
    reentered = await state(page);
    check('returning from roomy landscape again starts expanded',
        reentered.toggleVisible && reentered.contentVisible && reentered.expanded === 'true');

    await page.click('#composer-toggle');
    await page.reload({ waitUntil: 'domcontentloaded', timeout: TIMEOUT });
    await page.waitForFunction(() => window.__SCIREPL_APP_READY === true
        && window.landscapeComposer && window.appearance, null, { timeout: TIMEOUT });
    await settle(page);
    const reloaded = await state(page);
    check('collapsed state is session-only and a reload starts expanded',
        reloaded.toggleVisible && reloaded.contentVisible && reloaded.expanded === 'true',
        JSON.stringify(reloaded));

    console.log('7. Narrow landscape restores from the title group without selector collisions');
    const addedId = await page.evaluate(() => {
        const added = window.notebookManager.createNotebook({ name: 'Layout workbook' });
        window.notebookManager.renderSelector();
        return added && added.id;
    });
    for (const width of [360, 390, 411, 430]) {
        await page.setViewportSize({ width, height: 240 });
        await settle(page);
        await page.evaluate(() => window.landscapeComposer.setCollapsed(true));
        await settle(page);
        await settle(page);
        const narrow = await page.evaluate(() => {
            const selector = document.getElementById('notebook-selector-container');
            const selectorControls = [...selector.querySelectorAll('select, button')];
            const visibleControls = [document.getElementById('composer-restore-btn'),
                ...selectorControls, ...document.querySelectorAll('.header-right button')]
                .filter(el => el.offsetParent !== null);
            const misHits = visibleControls.map(el => {
                const box = el.getBoundingClientRect();
                const hit = document.elementFromPoint(
                    box.left + box.width / 2, box.top + box.height / 2);
                return (hit === el || el.contains(hit)) ? null : (el.id || el.className);
            }).filter(Boolean);
            const header = document.getElementById('app-header').getBoundingClientRect();
            return {
                selectorControls: selectorControls.length,
                misHits,
                restoreInTitle: !!document.getElementById('composer-restore-btn').closest('h1'),
                restoreVisible: document.getElementById('composer-restore-btn').offsetParent !== null,
                titleVisible: document.querySelector('#app-header .app-title-text').offsetParent !== null,
                headerHeight: header.height,
                pageOverflow: document.documentElement.scrollWidth > innerWidth,
            };
        });
        check(`${width}px collapsed header keeps every visible control hittable`,
            narrow.selectorControls === 4 && narrow.misHits.length === 0
            && narrow.restoreInTitle && narrow.restoreVisible && !narrow.titleVisible
            && !narrow.pageOverflow,
            JSON.stringify(narrow));
        await page.click('#composer-restore-btn');
        await settle(page);
        check(`${width}px restore brings the title back`,
            await page.evaluate(() => document.querySelector('#app-header .app-title-text')
                .offsetParent !== null && !window.landscapeComposer.collapsed));
    }
    await page.setViewportSize({ width: 844, height: 390 });
    await settle(page);

    console.log('8. RTL keeps the header restore control clear of the physical navigation inset');
    await page.evaluate(() => window.i18n.activate('ar'));
    await page.waitForFunction(() => document.documentElement.dir === 'rtl');
    const rtl = await page.evaluate(async () => {
        document.documentElement.style.setProperty('--safe-area-inset-right', '48px');
        // Model Android's physical navigation strip as a DOM overlay so
        // centre-point hit tests catch the overlap the real bar causes.
        const nav = document.createElement('div');
        nav.id = 'test-android-landscape-navigation';
        Object.assign(nav.style, {
            position: 'fixed', right: '0', top: '0', bottom: '0', width: '48px',
            zIndex: '99999', pointerEvents: 'auto', background: 'black',
        });
        document.body.appendChild(nav);
        const toggle = document.getElementById('composer-toggle');
        const toggleLabel = toggle.getAttribute('aria-label');
        window.landscapeComposer.setCollapsed(true);
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const restore = document.getElementById('composer-restore-btn');
        const box = restore.getBoundingClientRect();
        const at = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
        return {
            dir: document.documentElement.dir,
            toggleLabel,
            restoreLabel: restore.getAttribute('aria-label'),
            restoreTitle: restore.getAttribute('title'),
            expectedCollapse: window.t('composer.collapse'),
            expectedExpand: window.t('composer.expand'),
            left: box.left,
            right: box.right,
            safeBoundary: innerWidth - 48,
            hit: at === restore || restore.contains(at),
        };
    });
    check('Arabic activates the real right-to-left layout', rtl.dir === 'rtl', rtl.dir);
    check('both composer controls carry the Arabic labels',
        rtl.toggleLabel === rtl.expectedCollapse && rtl.restoreLabel === rtl.expectedExpand
        && rtl.restoreTitle === rtl.expectedExpand && rtl.expectedExpand !== 'Show new-cell panel',
        JSON.stringify(rtl));
    check('the RTL restore control sits wholly before the physical navigation strip and is hittable',
        rtl.right <= rtl.safeBoundary + 1 && rtl.left >= 0 && rtl.hit, JSON.stringify(rtl));
    await page.click('#composer-restore-btn');
    check('the RTL restore control reopens the panel',
        (await state(page)).contentVisible);

    await page.evaluate(async (id) => {
        document.getElementById('test-android-landscape-navigation')?.remove();
        document.documentElement.style.removeProperty('--safe-area-inset-right');
        if (id) window.notebookManager.removeNotebook(id);
        window.notebookManager.renderSelector();
        await window.i18n.activate('en');
    }, addedId);
    await settle(page);

    const destroyed = await page.evaluate(() => {
        window.landscapeComposer.destroy();
        return {
            accepted: window.landscapeComposer.setCollapsed(true),
            contentHidden: document.getElementById('composer-content').hidden,
            toggleHidden: document.getElementById('composer-toggle').hidden,
            restoreHidden: document.getElementById('composer-restore-btn').hidden,
        };
    });
    check('destroy leaves the editor visible and rejects later state changes',
        destroyed.accepted === false && !destroyed.contentHidden
        && destroyed.toggleHidden && destroyed.restoreHidden,
        JSON.stringify(destroyed));

    check('the focused interactions produced no page errors', pageErrors.length === 0,
        pageErrors.join(' | '));
    await context.close();

    console.log('9. Existing-cell keyboards automatically reclaim landscape space');
    // A soft keyboard is only inferred on a device that can have one.
    const imeContext = await browser.newContext({
        viewport: { width: 844, height: 390 }, hasTouch: true,
    });
    await imeContext.addInitScript(installPrelude);
    // Install the mutable viewport BEFORE production scripts initialize so the
    // test exercises their real startup baseline and listener attachment.
    await imeContext.addInitScript(() => {
        const viewport = new EventTarget();
        viewport.width = innerWidth;
        viewport.height = innerHeight;
        viewport.offsetTop = 0;
        viewport.scale = 1;
        window.__imeViewport = viewport;
        Object.defineProperty(window, 'visualViewport', {
            configurable: true,
            value: viewport,
        });
    });
    const imePage = await imeContext.newPage();
    const imeErrors = [];
    imePage.on('pageerror', error => imeErrors.push(error.message));
    await imePage.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
    await imePage.waitForFunction(() => window.__SCIREPL_APP_READY === true
        && window.landscapeComposer && window.mathMode, null, { timeout: TIMEOUT });
    // Use a real Markdown cell so this exercises app.js's dynamically-created
    // .cell-editor rather than a test-only stand-in.
    if (!await imePage.evaluate(() => document.getElementById('cell-type-toggle')
        .classList.contains('markdown-active'))) {
        await imePage.click('#cell-type-toggle');
    }
    await imePage.fill('#code-input', 'existing-cell keyboard fixture');
    await imePage.click('#run-btn');
    const renderedImeCard = imePage.locator('.card-input').filter({
        hasText: 'existing-cell keyboard fixture',
    }).last();
    const imeCellId = await renderedImeCard.getAttribute('data-cell-id');
    const imeCard = imePage.locator(`.card-input[data-cell-id="${imeCellId}"]`);
    await imeCard.locator('.cell-edit-btn').click();
    const cellEditor = imeCard.locator('.cell-editor');
    await cellEditor.fill('edited fixture value');
    await cellEditor.evaluate(editor => {
        editor.setSelectionRange(7, 14);
        editor.focus();
        document.getElementById('code-input').value = 'preserved new-cell draft';
    });
    await settle(imePage);
    check('cell-editor focus without a viewport shrink does not imitate a soft keyboard',
        await imePage.evaluate(() => !window.landscapeComposer.collapsed));

    await imePage.evaluate(() => {
        window.__imeViewport.height = innerHeight - 60;
        window.__imeViewport.dispatchEvent(new Event('resize'));
    });
    await settle(imePage);
    check('a small visual-viewport change is not mistaken for a soft keyboard',
        await imePage.evaluate(() => !window.landscapeComposer.collapsed));
    await imePage.evaluate(() => {
        window.__imeViewport.height = innerHeight;
        window.__imeViewport.dispatchEvent(new Event('resize'));
    });

    // Android may resize both layout and visual viewports instead of overlaying
    // the keyboard. The baseline learned before editing must still detect it.
    await imePage.setViewportSize({ width: 844, height: 300 });
    await imePage.evaluate(() => {
        window.__imeViewport.width = innerWidth;
        window.__imeViewport.height = innerHeight;
        window.__imeViewport.dispatchEvent(new Event('resize'));
    });
    await imePage.waitForFunction(() => window.landscapeComposer.collapsed);
    check('layout-resize keyboard mode is detected from the pre-keyboard baseline',
        await imePage.evaluate(() => document.activeElement
            === document.querySelector('.card-input.editing .cell-editor')));
    await imePage.setViewportSize({ width: 844, height: 390 });
    await imePage.evaluate(() => {
        window.__imeViewport.width = innerWidth;
        window.__imeViewport.height = innerHeight;
        window.__imeViewport.dispatchEvent(new Event('resize'));
    });
    await imePage.waitForFunction(() => !window.landscapeComposer.collapsed);

    await imePage.evaluate(() => {
        window.__imeViewport.height = innerHeight - 170;
        window.__imeViewport.dispatchEvent(new Event('resize'));
    });
    await imePage.waitForFunction(() => window.landscapeComposer.collapsed
        && window.landscapeComposer._imeAutoCollapsed);
    await settle(imePage);
    await settle(imePage);
    const imeCollapsed = await imePage.evaluate(() => ({
        editorHasFocus: document.activeElement
            === document.querySelector('.card-input.editing .cell-editor'),
        value: document.activeElement?.value,
        start: document.activeElement?.selectionStart,
        end: document.activeElement?.selectionEnd,
        barHeight: document.getElementById('input-bar').getBoundingClientRect().height,
        restoreVisible: document.getElementById('composer-restore-btn').offsetParent !== null,
        titleVisible: document.querySelector('#app-header .app-title-text').offsetParent !== null,
        footerOverlay: parseFloat(getComputedStyle(
            [...document.querySelectorAll('#repl, .repl-container')]
                .find(element => element.offsetParent !== null))
            .getPropertyValue('--footer-overlay-local')) || 0,
        viewportLift: parseFloat(getComputedStyle(document.getElementById('app-body'))
            .getPropertyValue('--sci-vv-lift')) || 0,
    }));
    check('soft-keyboard shrink hides the whole new-cell footer without stealing edit focus',
        imeCollapsed.editorHasFocus
        && imeCollapsed.value === 'edited fixture value'
        && imeCollapsed.start === 7 && imeCollapsed.end === 14
        && imeCollapsed.barHeight === 0
        && imeCollapsed.footerOverlay === 0 && imeCollapsed.viewportLift === 0,
        JSON.stringify(imeCollapsed));
    // Free deliberately differs from Pro here: a lone restore control would
    // blur the editor and dismiss the keyboard mid-edit, so the title stays.
    check('the keyboard collapse keeps the title and offers no restore control',
        !imeCollapsed.restoreVisible && imeCollapsed.titleVisible, JSON.stringify(imeCollapsed));

    await imePage.evaluate(() => {
        window.__imeViewport.height = innerHeight;
        window.__imeViewport.dispatchEvent(new Event('resize'));
    });
    await imePage.waitForFunction(() => !window.landscapeComposer.collapsed);
    await settle(imePage);
    const imeRestored = await imePage.evaluate(() => ({
        activeClass: document.activeElement?.className || '',
        value: document.activeElement?.value,
        start: document.activeElement?.selectionStart,
        end: document.activeElement?.selectionEnd,
        draft: document.getElementById('code-input').value,
        barHeight: document.getElementById('input-bar').getBoundingClientRect().height,
        restoreVisible: document.getElementById('composer-restore-btn').offsetParent !== null,
        titleVisible: document.querySelector('#app-header .app-title-text').offsetParent !== null,
        toggleVisible: document.getElementById('composer-toggle').offsetParent !== null,
    }));
    // Free keeps the composer visible during an existing-cell edit, so once
    // the keyboard closes the auto-collapsed footer simply returns.
    check('closing the keyboard preserves edit focus and both drafts and returns the footer',
        imeRestored.activeClass === 'cell-editor'
        && imeRestored.value === 'edited fixture value'
        && imeRestored.start === 7 && imeRestored.end === 14
        && imeRestored.draft === 'preserved new-cell draft'
        && imeRestored.barHeight > 0,
        JSON.stringify(imeRestored));
    check('after the keyboard closes the title and footer toggle are back, restore still hidden',
        imeRestored.titleVisible && imeRestored.toggleVisible && !imeRestored.restoreVisible,
        JSON.stringify(imeRestored));

    await imePage.evaluate(() => {
        window.__imeViewport.height = innerHeight - 170;
        window.__imeViewport.dispatchEvent(new Event('resize'));
    });
    await imePage.waitForFunction(() => window.landscapeComposer._imeAutoCollapsed);
    check('short landscape keeps the footer hidden while the edit keyboard is up',
        await imePage.evaluate(() => document.getElementById('input-bar')
            .getBoundingClientRect().height === 0));
    await imeCard.locator('.cell-cancel-btn').click();
    await settle(imePage);
    check('ending cell edit does not flash the composer over a keyboard still dismissing',
        await imePage.evaluate(() => window.landscapeComposer.collapsed
            && window.landscapeComposer._imeAutoCollapsed));
    await imePage.evaluate(() => {
        window.__imeViewport.height = innerHeight;
        window.__imeViewport.dispatchEvent(new Event('resize'));
    });
    await imePage.waitForFunction(() => !window.landscapeComposer.collapsed);
    check('the composer returns after the post-edit viewport actually recovers',
        await imePage.evaluate(() => document.getElementById('input-bar')
            .getBoundingClientRect().height > 0));

    await imePage.focus('#code-input');
    await imePage.evaluate(() => {
        window.__imeViewport.height = innerHeight - 170;
        window.__imeViewport.dispatchEvent(new Event('resize'));
    });
    await settle(imePage);
    check('the new-cell textarea never hides the composer that owns it',
        await imePage.evaluate(() => !window.landscapeComposer.collapsed));
    await imePage.evaluate(() => {
        window.__imeViewport.height = innerHeight;
        window.__imeViewport.dispatchEvent(new Event('resize'));
        window.landscapeComposer.setCollapsed(true);
    });
    await settle(imePage);
    check('a manually hidden composer stays hidden across a viewport change',
        await imePage.evaluate(() => window.landscapeComposer.collapsed
            && !window.landscapeComposer._imeAutoCollapsed));
    check('a manual collapse still swaps the title for the restore control',
        await imePage.evaluate(() => document.getElementById('composer-restore-btn')
            .offsetParent !== null
            && document.querySelector('#app-header .app-title-text').offsetParent === null));
    await imePage.click('#composer-restore-btn');

    await imeCard.locator('.cell-delete-btn').click({ force: true });
    await imePage.evaluate(() => {
        window.landscapeComposer._queueImeSync();
        window.landscapeComposer.destroy();
        window.__imeViewport.height = innerHeight - 170;
        window.__imeViewport.dispatchEvent(new Event('resize'));
    });
    await settle(imePage);
    check('destroy cancels pending keyboard work and detaches viewport listeners',
        await imePage.evaluate(() => !window.landscapeComposer.collapsed
            && document.getElementById('input-bar').offsetParent !== null));
    check('keyboard-focused interactions produced no page errors', imeErrors.length === 0,
        imeErrors.join(' | '));
    await imeContext.close();

    console.log('10. A short window is not a keyboard, and an auto-collapse never outlives its edit');
    // Shared helpers: open a page, create a Markdown cell and enter its editor.
    async function openEditing(contextOptions) {
        const ctx = await browser.newContext({ viewport: { width: 844, height: 390 }, ...contextOptions });
        await ctx.addInitScript(installPrelude);
        const pg = await ctx.newPage();
        const errors = [];
        pg.on('pageerror', error => errors.push(error.message));
        await pg.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
        await pg.waitForFunction(() => window.__SCIREPL_APP_READY === true
            && window.landscapeComposer && window.mathMode, null, { timeout: TIMEOUT });
        if (!await pg.evaluate(() => document.getElementById('cell-type-toggle')
            .classList.contains('markdown-active'))) {
            await pg.click('#cell-type-toggle');
        }
        await pg.fill('#code-input', 'resize fixture');
        await pg.click('#run-btn');
        const id = await pg.locator('.card-input').filter({ hasText: 'resize fixture' })
            .last().getAttribute('data-cell-id');
        const card = pg.locator(`.card-input[data-cell-id="${id}"]`);
        await card.locator('.cell-edit-btn').click();
        await card.locator('.cell-editor').focus();
        await settle(pg);
        return { ctx, pg, card, errors };
    }
    const recoverable = pg => pg.evaluate(() => {
        const visible = el => !!el && !el.hidden && el.offsetParent !== null;
        return {
            collapsed: window.landscapeComposer.collapsed,
            composerVisible: visible(document.getElementById('code-input')),
            restoreVisible: visible(document.getElementById('composer-restore-btn')),
            toggleVisible: visible(document.getElementById('composer-toggle')),
        };
    });

    // Sol's scenario: a desktop window (no touch) shrunk mid-edit, then Cancel.
    let run = await openEditing({});
    await run.pg.setViewportSize({ width: 844, height: 280 });
    await settle(run.pg);
    await settle(run.pg);
    let st = await recoverable(run.pg);
    check('desktop: shrinking the window mid-edit is not mistaken for a keyboard',
        !st.collapsed && st.composerVisible, JSON.stringify(st));
    await run.card.locator('.cell-cancel-btn').click();
    await run.pg.waitForTimeout(600);
    st = await recoverable(run.pg);
    check('desktop: after Cancel the composer (or a restore control) is reachable',
        st.composerVisible || st.restoreVisible, JSON.stringify(st));
    check('desktop resize scenario produced no page errors', run.errors.length === 0,
        run.errors.join(' | '));
    await run.ctx.close();

    // The same scenario on a touch device looks like a resize-mode keyboard
    // while the editor is focused, so it may collapse; Cancel must undo it.
    run = await openEditing({ hasTouch: true });
    await run.pg.setViewportSize({ width: 844, height: 280 });
    await run.pg.waitForFunction(() => window.landscapeComposer._imeAutoCollapsed);
    await run.card.locator('.cell-cancel-btn').click();
    await run.pg.waitForFunction(() => !window.landscapeComposer.collapsed, null, { timeout: 3000 });
    st = await recoverable(run.pg);
    check('touch: Cancel ends the auto-collapse even though the window stays short',
        !st.collapsed && st.composerVisible && st.toggleVisible, JSON.stringify(st));
    // The short window is now the baseline: editing again is not a keyboard.
    await run.card.locator('.cell-edit-btn').click();
    await run.card.locator('.cell-editor').focus();
    await settle(run.pg);
    await settle(run.pg);
    check('touch: the baseline is re-learned after a real window resize',
        !(await recoverable(run.pg)).collapsed);
    await run.ctx.close();

    // Blur without Cancel: the keyboard-sized viewport persists, focus leaves.
    run = await openEditing({ hasTouch: true });
    await run.pg.setViewportSize({ width: 844, height: 280 });
    await run.pg.waitForFunction(() => window.landscapeComposer._imeAutoCollapsed);
    await run.pg.evaluate(() => document.querySelector('.card-input.editing .cell-editor').blur());
    await run.pg.waitForFunction(() => !window.landscapeComposer.collapsed, null, { timeout: 3000 });
    st = await recoverable(run.pg);
    check('touch: blurring the editor without Cancel restores the composer',
        !st.collapsed && st.composerVisible, JSON.stringify(st));
    check('every collapsed, eligible state left a way back', !st.collapsed || st.restoreVisible);
    check('touch scenarios produced no page errors', run.errors.length === 0, run.errors.join(' | '));
    await run.ctx.close();
} finally {
    await browser.close();
}

console.log(`\nPASS: ${checks} landscape composer checks`);
