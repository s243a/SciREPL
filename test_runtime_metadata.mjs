/**
 * Playwright regression: Languages exposes the pinned/tested runtime, the
 * user's effective selection, and the exact source that succeeded this page
 * session without conflating those three facts.
 */
import { chromium } from 'playwright';

const BASE = process.env.SCIREPL_TEST_BASE || 'http://localhost:8085';

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

const browser = await chromium.launch({ headless: true });
try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.setViewportSize({ width: 360, height: 740 });
    await page.route('https://data.jsdelivr.com/v1/package/npm/webr', route => route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ tags: { latest: '0.6.0' }, versions: ['0.6.0', '0.5.4'] }),
    }));
    await page.route('https://data.jsdelivr.com/v1/package/npm/swipl-wasm', route => route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ versions: ['8.0.5', '3.9.1', '3.8.2', '3.10.0-beta.1'] }),
    }));
    await page.addInitScript(() => {
        localStorage.setItem('scirepl_onboarding_seen', '1');
        addEventListener('DOMContentLoaded', () => localStorage.setItem(
            'scirepl_whats_new_seen_version', window.KERNEL_CONFIG.app.version), { once: true });
        localStorage.setItem('scirepl_privacy_accepted', '1');
        localStorage.setItem('scirepl_privacy_accepted_revision',
            '2026-08-runtime-metadata-v1');
        localStorage.removeItem('scirepl_webr_version');
        localStorage.removeItem('scirepl_r_source');
        localStorage.removeItem('scirepl_swipl_version');
        localStorage.removeItem('scirepl_prolog_source');
    });
    await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('#run-btn:not([disabled])', { timeout: 10000 });

    const licenceHref = await page.getAttribute(
        '#help-modal a[href="open-source-licenses.html"]', 'href');
    assert(licenceHref === 'open-source-licenses.html',
        'Help must link to the generated offline licence page');
    const licencePage = await context.newPage();
    await licencePage.goto(`${BASE}/open-source-licenses.html`, {
        waitUntil: 'domcontentloaded', timeout: 30000,
    });
    const licenceText = await licencePage.textContent('body');
    assert(licenceText.includes('Inventory scope') && licenceText.includes('24 components')
        && await licencePage.$$eval('article.component', items => items.length) === 24,
        'generated licence page should state its scope and contain all manifest components');
    assert(licenceText.includes('SWI-Prolog 9.3.8'),
        'generated licence page should disclose the underlying SWI-Prolog version');
    assert(licenceText.includes('webR JavaScript and support code')
        && licenceText.includes('webR binary distribution / R runtime'),
        'generated licence page should distinguish MIT webR support from GPL R');
    assert(licenceText.includes('Sean Connelly') && licenceText.includes('Native Promise Only'),
        'offline licence page should embed Plotly\'s referenced third-party sidecar');
    await licencePage.close();

    await page.click('#menu-btn');
    await page.click('#btn-languages');
    await page.waitForSelector('#languages-modal:not(.hidden)');
    assert(await page.$eval('#languages-modal .modal-content', element =>
        element.scrollWidth <= element.clientWidth + 1),
    'runtime controls should not create horizontal overflow on a narrow phone viewport');

    const r = '[data-runtime-status="r"]';
    const prolog = '[data-runtime-status="prolog"]';
    assert((await page.textContent(`${r} [data-runtime-tested]`)).includes('v0.5.4'),
        'R tested version should be the generated pinned tag');
    assert((await page.textContent(`${prolog} [data-runtime-tested]`)).includes('3/8/2'),
        'Prolog tested selector should be the generated exact package path');
    await page.waitForFunction(() => document.querySelector(
        '[data-runtime-status="r"] [data-runtime-latest]')?.textContent.includes('v0.6.0'));
    assert((await page.textContent(`${r} [data-runtime-latest]`)).includes('v0.6.0'),
        'R latest should come from package metadata without loading the runtime');
    assert((await page.textContent(`${prolog} [data-runtime-latest]`)).includes('3/9/1'),
        'Prolog latest must be the highest stable compatible 3.x, not global 8.x');
    assert(await page.evaluate(() => !window.kernelManager._instances.r
        && !window.kernelManager._instances.prolog),
        'metadata lookup must not download or initialize either runtime');
    assert((await page.textContent(`${r} [data-runtime-loaded-version]`)).includes('Not loaded')
        && (await page.textContent(`${r} [data-runtime-loaded-source]`)).includes('Not loaded'),
        'fresh session must not claim a runtime version or source was loaded');

    const failedInitState = await page.evaluate(async () => {
        const language = '__runtime_init_failure__';
        const source = 'https://example.invalid/runtime-loader.js';
        window.KERNEL_CONFIG.languages[language] = {
            timeoutMs: 1000,
            sources: [{ type: 'cdn', url: source }],
        };
        class FailingRuntime {
            isReady() { return false; }
            async init() {
                await window.kernelManager.loadKernelSource(
                    language, source, async () => ({ loaderResolved: true }));
                throw new Error('runtime initialization failed after loader resolved');
            }
        }
        window.kernelManager.register(language, FailingRuntime);
        let loadedEvents = 0;
        const onLoaded = event => {
            if (event.detail?.language === language) loadedEvents++;
        };
        window.addEventListener('scirepl:runtime-source-loaded', onLoaded);
        let rejected = false;
        try { await window.kernelManager.ensureReady(language); }
        catch (_) { rejected = true; }
        window.removeEventListener('scirepl:runtime-source-loaded', onLoaded);
        return {
            rejected,
            loadedEvents,
            loaded: window.kernelManager.getRuntimeSessionSource(language),
            pending: window.kernelManager._pendingRuntimeSources[language] || null,
        };
    });
    assert(failedInitState.rejected && failedInitState.loadedEvents === 0
        && failedInitState.loaded === null && failedInitState.pending === null,
    `a resolved loader followed by failed runtime init must not be reported as Loaded: ${JSON.stringify(failedInitState)}`);

    const rVersion = `${r} .kernel-version-input`;
    const rSource = `${r} .kernel-source-input`;
    await page.click(`${r} [data-runtime-source-details] > summary`);
    assert((await page.textContent(`${r} [data-runtime-source-details]`)).includes('executable code'),
        'advanced source override must warn that custom runtimes can access notebook data');
    await page.fill(rSource, 'local');
    await page.dispatchEvent(rSource, 'change');
    assert(await page.inputValue(rSource) === ''
        && await page.evaluate(() => localStorage.getItem('scirepl_r_source')) === null,
        'R must reject local when the generated Free profile has no local R source');
    await page.click(`${r} [data-runtime-use-latest]`);
    const latestSelection = await page.evaluate(() => ({
        version: localStorage.getItem('scirepl_webr_version'),
        source: localStorage.getItem('scirepl_r_source'),
    }));
    assert(latestSelection.version === 'v0.6.0' && latestSelection.source === null,
        'Use latest must store an exact version override and clear the source override');
    assert((await page.textContent(`${r} [data-runtime-reset-message]`)).includes('Reload'),
        'Use latest must request a reload');
    await page.click(`${r} [data-runtime-use-tested]`);

    await page.fill(rVersion, '0.6.0');
    await page.dispatchEvent(rVersion, 'change');
    assert(await page.inputValue(rVersion) === 'v0.6.0', 'R version should normalize to an exact tag');
    await page.fill(rSource, 'https://example.invalid/custom-webr.mjs');
    await page.dispatchEvent(rSource, 'change');
    assert((await page.textContent(`${r} [data-runtime-selected]`)).includes('https://example.invalid/custom-webr.mjs'),
        'custom source must take precedence in the selected status');

    await page.evaluate(() => {
        window.kernelManager._recordRuntimeSource(
            'r', 'https://example.invalid/source-that-succeeded.mjs');
        window.kernelManager.recordRuntimeLoadedVersion('r', '0.6.0');
    });
    assert((await page.textContent(`${r} [data-runtime-loaded-version]`)).includes('0.6.0'),
        'runtime-reported loaded version should update an open modal');
    assert((await page.textContent(`${r} [data-runtime-loaded-source]`)).includes('source-that-succeeded.mjs'),
        'successful session source should remain distinct from loaded version');
    assert((await page.textContent(`${r} [data-runtime-latest]`)).includes('v0.6.0'),
        'discovered latest must remain visible independently after custom selection and a different loaded source');

    await page.click(`${r} [data-runtime-use-tested]`);
    const cleared = await page.evaluate(() => ({
        version: localStorage.getItem('scirepl_webr_version'),
        source: localStorage.getItem('scirepl_r_source'),
    }));
    assert(cleared.version === null && cleared.source === null,
        'Use tested version must clear both version and source overrides');
    assert((await page.textContent(`${r} [data-runtime-selected]`)).includes('v0.5.4'),
        'reset should select the generated tested tag');
    assert((await page.textContent(`${r} [data-runtime-latest]`)).includes('v0.6.0'),
        'selecting tested must not erase or relabel the independently discovered latest version');
    assert((await page.textContent(`${r} [data-runtime-reset-message]`)).includes('Reload'),
        'reset must tell the user a reload is required');

    await page.fill(rVersion, 'https://example.invalid/not-a-version');
    await page.dispatchEvent(rVersion, 'change');
    assert(await page.inputValue(rVersion) === '', 'a custom URL must be rejected from the version field');
    assert((await page.$eval(rVersion, el => el.validationMessage)).length > 0,
        'invalid version should produce a visible validation message');

    await page.fill(rVersion, 'latest');
    await page.dispatchEvent(rVersion, 'change');
    assert((await page.textContent(`${r} [data-runtime-selected]`)).includes('rolling/unverified'),
        'latest must be clearly labelled rolling/unverified');

    const prologVersion = `${prolog} .kernel-version-input`;
    await page.fill(prologVersion, '3.8.2');
    await page.dispatchEvent(prologVersion, 'change');
    assert(await page.inputValue(prologVersion) === '3/8/2',
        'Prolog dotted package version should normalize to the exact selector path');
    await page.fill(prologVersion, 'latest');
    await page.dispatchEvent(prologVersion, 'change');
    assert(await page.inputValue(prologVersion) === '3/8/2',
        'Prolog global latest must be rejected rather than resolving incompatible 8.x');
    await page.fill(prologVersion, '8.0.5');
    await page.dispatchEvent(prologVersion, 'change');
    assert(await page.inputValue(prologVersion) === '3/8/2',
        'Prolog version field must reject an exact incompatible 8.x package');
    const prologSource = `${prolog} .kernel-source-input`;
    await page.click(`${prolog} [data-runtime-source-details] > summary`);
    await page.fill(prologSource, 'local');
    await page.dispatchEvent(prologSource, 'change');
    assert(await page.evaluate(() => localStorage.getItem('scirepl_prolog_source')) === 'local',
        'bundled Prolog may select its declared local source');
    await page.click(`${prolog} [data-runtime-use-tested]`);

    // Legacy boolean consent predates version-metadata lookups and must not
    // silently authorise this newly disclosed network request. The explicit
    // Check latest action opens the revised policy and records its revision.
    const privateContext = await browser.newContext();
    const privatePage = await privateContext.newPage();
    let metadataRequests = 0;
    await privatePage.route('https://data.jsdelivr.com/v1/package/npm/webr', route => {
        metadataRequests++;
        return route.fulfill({
            contentType: 'application/json',
            body: JSON.stringify({ tags: { latest: '0.6.0' } }),
        });
    });
    await privatePage.addInitScript(() => {
        localStorage.setItem('scirepl_onboarding_seen', '1');
        addEventListener('DOMContentLoaded', () => localStorage.setItem(
            'scirepl_whats_new_seen_version', window.KERNEL_CONFIG.app.version), { once: true });
        localStorage.setItem('scirepl_privacy_accepted', '1');
        localStorage.removeItem('scirepl_privacy_accepted_revision');
    });
    await privatePage.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await privatePage.waitForSelector('#run-btn:not([disabled])', { timeout: 10000 });
    await privatePage.click('#menu-btn');
    await privatePage.click('#btn-languages');
    await privatePage.waitForTimeout(200);
    assert(metadataRequests === 0,
        'legacy boolean consent must not authorise automatic version-metadata requests');
    assert((await privatePage.textContent(`${r} [data-runtime-latest]`)).includes('not checked'),
        'without consent, latest status should remain not checked');
    await privatePage.click(`${r} [data-runtime-check-latest]`);
    await privatePage.waitForSelector('#privacy-modal:not(.hidden)');
    assert(metadataRequests === 0, 'metadata request must wait for consent acceptance');
    await privatePage.click('#privacy-modal .modal-close');
    await privatePage.waitForFunction(() =>
        document.querySelector('#privacy-modal')?.classList.contains('hidden'));
    assert(metadataRequests === 0
        && await privatePage.evaluate(() =>
            localStorage.getItem('scirepl_privacy_accepted_revision')) === null,
    'dismissing the revised policy must preserve legacy consent without sending metadata');
    await privatePage.click(`${r} [data-runtime-check-latest]`);
    await privatePage.waitForSelector('#privacy-modal:not(.hidden)');
    await privatePage.click('#privacy-accept-btn');
    await privatePage.waitForFunction(() => document.querySelector(
        '[data-runtime-status="r"] [data-runtime-latest]')?.textContent.includes('v0.6.0'));
    assert(metadataRequests === 1, 'explicit consented check should make one metadata request');
    assert(await privatePage.evaluate(() =>
        localStorage.getItem('scirepl_privacy_accepted_revision'))
        === '2026-08-runtime-metadata-v1',
    'accepting the revised policy must persist its exact revision');
    await privateContext.close();

    const failureContext = await browser.newContext();
    const failurePage = await failureContext.newPage();
    await failurePage.route('https://data.jsdelivr.com/v1/package/npm/*', route => route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: '{}',
    }));
    await failurePage.addInitScript(() => {
        localStorage.setItem('scirepl_onboarding_seen', '1');
        addEventListener('DOMContentLoaded', () => localStorage.setItem(
            'scirepl_whats_new_seen_version', window.KERNEL_CONFIG.app.version), { once: true });
        localStorage.setItem('scirepl_privacy_accepted', '1');
        localStorage.setItem('scirepl_privacy_accepted_revision',
            '2026-08-runtime-metadata-v1');
    });
    await failurePage.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await failurePage.waitForSelector('#run-btn:not([disabled])', { timeout: 10000 });
    await failurePage.click('#menu-btn');
    await failurePage.click('#btn-languages');
    await failurePage.waitForFunction(() => document.querySelector(
        '[data-runtime-status="r"] [data-runtime-latest]')?.textContent.includes('unavailable'));
    await failureContext.close();

    const electronContext = await browser.newContext();
    const electronPage = await electronContext.newPage();
    await electronPage.route('https://data.jsdelivr.com/v1/package/npm/*', route => route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: '{}',
    }));
    await electronPage.addInitScript(() => {
        Object.defineProperty(window, 'sciREPLPlatform', {
            configurable: false,
            writable: false,
            value: Object.freeze({ platform: 'electron' }),
        });
        localStorage.setItem('scirepl_onboarding_seen', '1');
        addEventListener('DOMContentLoaded', () => localStorage.setItem(
            'scirepl_whats_new_seen_version', window.KERNEL_CONFIG.app.version), { once: true });
        localStorage.setItem('scirepl_privacy_accepted', '1');
        localStorage.setItem('scirepl_privacy_accepted_revision',
            '2026-08-runtime-metadata-v1');
    });
    await electronPage.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await electronPage.waitForSelector('#run-btn:not([disabled])', { timeout: 10000 });
    await electronPage.click('#menu-btn');
    await electronPage.click('#btn-languages');
    const electronSourcePolicy = await electronPage.evaluate(() => {
        const row = document.querySelector('[data-runtime-status="r"]');
        const note = row?.querySelector('[data-runtime-source-policy-notice]');
        return {
            visible: !!note && getComputedStyle(note).display !== 'none' && note.open,
            text: note?.textContent || '',
            editableInputs: row?.querySelectorAll('.kernel-source-input').length || 0,
        };
    });
    assert(electronSourcePolicy.visible
        && electronSourcePolicy.text.includes('disabled by the Electron host policy')
        && electronSourcePolicy.editableInputs === 0,
    `Electron must explain its fixed runtime-source policy without an editable URL: ${JSON.stringify(electronSourcePolicy)}`);
    await electronContext.close();

    // The generated runtime controls are substantially wider than a language
    // checkbox. Prove they wrap coherently on the narrowest supported layout,
    // including RTL and adversarially long custom/loaded source URLs.
    const mobileContext = await browser.newContext({ viewport: { width: 320, height: 640 } });
    const mobilePage = await mobileContext.newPage();
    const longSource = 'https://example.invalid/runtime/builds/very-long-segment-that-must-wrap/runtime-module.mjs?revision=1234567890';
    await mobilePage.route('https://data.jsdelivr.com/v1/package/npm/*', route => route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: '{}',
    }));
    await mobilePage.addInitScript((source) => {
        localStorage.setItem('scirepl_onboarding_seen', '1');
        addEventListener('DOMContentLoaded', () => localStorage.setItem(
            'scirepl_whats_new_seen_version', window.KERNEL_CONFIG.app.version), { once: true });
        localStorage.setItem('scirepl_privacy_accepted', '1');
        localStorage.setItem('scirepl_privacy_accepted_revision',
            '2026-08-runtime-metadata-v1');
        localStorage.setItem('scirepl_r_source', source);
    }, longSource);
    await mobilePage.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await mobilePage.waitForSelector('#run-btn:not([disabled])', { timeout: 10000 });
    await mobilePage.evaluate(async () => window.i18n.activate('ar'));
    await mobilePage.click('#menu-btn');
    await mobilePage.click('#btn-languages');
    await mobilePage.evaluate((source) => {
        window.kernelManager._recordRuntimeSource('r', source);
        window.kernelManager.recordRuntimeLoadedVersion('r', '0.6.0');
        document.querySelector('[data-runtime-status="r"] [data-runtime-source-details]').open = true;
    }, longSource);
    const mobileLayout = await mobilePage.evaluate(() => {
        const modal = document.querySelector('#languages-modal .modal-content');
        const row = document.querySelector('[data-runtime-status="r"]').closest('.settings-item');
        const label = row.querySelector('.language-toggle-label');
        const wrap = row.querySelector('.kernel-version-wrap');
        const input = wrap.querySelector('.kernel-source-input');
        const contained = (node) => {
            const rect = node.getBoundingClientRect();
            return rect.left >= 0 && rect.right <= innerWidth
                && rect.left >= modal.getBoundingClientRect().left
                && rect.right <= modal.getBoundingClientRect().right;
        };
        return {
            dir: document.documentElement.dir,
            viewportWidth: innerWidth,
            pageScrollWidth: document.documentElement.scrollWidth,
            modalContained: contained(modal),
            labelContained: contained(label),
            labelWidth: label.getBoundingClientRect().width,
            wrapContained: contained(wrap),
            wrapClientWidth: wrap.clientWidth,
            wrapScrollWidth: wrap.scrollWidth,
            sourceContained: contained(input),
            logicalMargin: getComputedStyle(wrap).marginInlineStart,
            buttonsContained: [...wrap.querySelectorAll('button')]
                .filter(button => getComputedStyle(button).display !== 'none')
                .every(contained),
        };
    });
    assert(mobileLayout.dir === 'rtl', 'mobile runtime-control check must actually run in RTL');
    assert(mobileLayout.pageScrollWidth <= mobileLayout.viewportWidth,
        `Languages controls widened the 320px page: ${JSON.stringify(mobileLayout)}`);
    assert(mobileLayout.modalContained && mobileLayout.labelContained
        && mobileLayout.wrapContained && mobileLayout.sourceContained
        && mobileLayout.buttonsContained,
    `Languages controls escaped the narrow modal: ${JSON.stringify(mobileLayout)}`);
    assert(mobileLayout.labelWidth >= 140,
        `runtime controls squeezed the language label: ${JSON.stringify(mobileLayout)}`);
    assert(mobileLayout.wrapScrollWidth <= mobileLayout.wrapClientWidth + 1,
        `long runtime source did not wrap: ${JSON.stringify(mobileLayout)}`);
    assert(mobileLayout.logicalMargin === '0px',
        `runtime controls retained a physical/directional offset: ${JSON.stringify(mobileLayout)}`);
    await mobileContext.close();

    console.log('runtime metadata UI: all assertions passed');
} finally {
    await browser.close();
}
