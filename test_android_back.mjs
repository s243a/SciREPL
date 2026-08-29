// Android hardware-Back routing with a deterministic @capacitor/app mock.
// Run the dev server first: node server.js
import { chromium } from 'playwright';

const PORT = process.env.PORT || 8085;
const URL = `http://localhost:${PORT}/index.html`;
const TIMEOUT = 60_000;
let failures = 0;

const check = (name, passed, detail = '') => {
    if (!passed) failures++;
    console.log(`  [${passed ? 'PASS' : 'FAIL'}] ${name}${detail ? ': ' + String(detail).slice(0, 180) : ''}`);
};

const browser = await chromium.launch({ headless: true });

async function seed(context, { mockAndroid = false } = {}) {
    await context.addInitScript((withMock) => {
        localStorage.setItem('scirepl_privacy_accepted', '1');
        localStorage.setItem('scirepl_onboarding_seen', '1');
        localStorage.setItem('scirepl_auto_download', '1');
        addEventListener('DOMContentLoaded', () => {
            const version = window.KERNEL_CONFIG?.app?.version;
            if (version) localStorage.setItem('scirepl_whats_new_seen_version', version);
        }, { once: true });

        if (!withMock) return;
        const nativeAddEventListener = document.addEventListener;
        window.__documentBackListeners = 0;
        document.addEventListener = function (type, ...args) {
            if (type === 'backbutton') window.__documentBackListeners++;
            return nativeAddEventListener.call(this, type, ...args);
        };
        window.__appPluginMock = {
            listenerNames: [],
            listener: null,
            exitCalls: 0,
            removed: 0,
        };
        window.__webVersionMock = {
            browserUrls: [],
            bridgeCalls: 0,
            bridgeInstalled: false,
            confirmResult: true,
            prompts: [],
        };
        window.confirm = (message) => {
            window.__webVersionMock.prompts.push(String(message));
            return window.__webVersionMock.confirmResult;
        };
        const app = {
            addListener(name, listener) {
                window.__appPluginMock.listenerNames.push(name);
                window.__appPluginMock.listener = listener;
                return Promise.resolve({
                    remove: async () => { window.__appPluginMock.removed++; },
                });
            },
            async exitApp() {
                window.__appPluginMock.exitCalls++;
            },
        };
        window.Capacitor = {
            getPlatform: () => 'android',
            isNativePlatform: () => true,
            isPluginAvailable: (name) => name === 'App'
                || name === 'Browser'
                || (name === 'SciReplBrowserBridge'
                    && window.__webVersionMock.bridgeInstalled),
            Plugins: {
                App: app,
                Browser: {
                    async open({ url }) { window.__webVersionMock.browserUrls.push(url); },
                },
                SciReplBrowserBridge: {
                    async open() { window.__webVersionMock.bridgeCalls++; },
                },
            },
        };
        window.__pressAndroidBack = (event = { canGoBack: false }) => {
            const listener = window.__appPluginMock.listener;
            if (!listener) throw new Error('backButton listener is not installed');
            listener(event);
        };
    }, mockAndroid);
}

async function load(context) {
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
    await page.waitForFunction(() => window.__SCIREPL_APP_READY
        && window.SciReplAndroidBack && window.mathMode && window.onboarding,
    null, { timeout: TIMEOUT });
    return { page, errors };
}

const press = (page, event) => page.evaluate((value) => {
    window.__pressAndroidBack(value);
}, event || { canGoBack: false });

try {
    console.log('\n1. Browser-safe installation');
    const webContext = await browser.newContext();
    await seed(webContext);
    const { page: webPage, errors: webErrors } = await load(webContext);
    check('ordinary web pages do not install a native Back listener',
        await webPage.evaluate(() => window.SciReplAndroidBack.installed === false));
    check('the hosted/browser build hides its redundant Open Web Version action',
        await webPage.evaluate(() => getComputedStyle(
            document.getElementById('btn-open-browser')).display === 'none'));
    check('loading without Capacitor produces no page error', webErrors.length === 0,
        webErrors.join(' | '));
    await webContext.close();

    for (const [label, platform, native] of [
        ['Capacitor web proxy', 'web', false],
        ['native non-Android shell', 'ios', true],
    ]) {
        const guarded = await browser.newContext();
        await seed(guarded);
        await guarded.addInitScript(({ platform, native }) => {
            window.__guardedListenerCalls = 0;
            window.Capacitor = {
                getPlatform: () => platform,
                isNativePlatform: () => native,
                Plugins: {
                    App: {
                        addListener() { window.__guardedListenerCalls++; },
                        async exitApp() {},
                    },
                },
            };
        }, { platform, native });
        const { page: guardedPage, errors: guardedErrors } = await load(guarded);
        check(`${label} does not install Android routing`, await guardedPage.evaluate(() =>
            !window.SciReplAndroidBack.installed && window.__guardedListenerCalls === 0));
        check(`${label} produces no page error`, guardedErrors.length === 0,
            guardedErrors.join(' | '));
        await guarded.close();
    }

    console.log('\n2. Native listener and semantic close paths');
    const context = await browser.newContext({ viewport: { width: 412, height: 915 } });
    await seed(context, { mockAndroid: true });
    const { page, errors } = await load(context);
    await page.waitForFunction(() => window.SciReplAndroidBack.installed
        && window.__appPluginMock.listener);
    const install = await page.evaluate(() => ({
        names: window.__appPluginMock.listenerNames,
        handle: Boolean(window.SciReplAndroidBack.listenerHandle),
    }));
    check('exactly one official backButton listener is installed',
        install.names.join(',') === 'backButton', JSON.stringify(install));
    check('no duplicate document backbutton listener is installed', await page.evaluate(() =>
        window.__documentBackListeners === 0));
    await page.waitForFunction(() => Boolean(window.SciReplAndroidBack.listenerHandle));
    check('the plugin listener handle is retained', await page.evaluate(() =>
        Boolean(window.SciReplAndroidBack.listenerHandle)));
    check('native menu labels and describes the fallback as a separate web version',
        await page.evaluate(() => {
            const button = document.getElementById('btn-open-browser');
            return button?.textContent.includes('Open Web Version')
                && /hosted SciREPL web version/i.test(button.title);
        }));

    await page.click('#menu-btn');
    await page.evaluate(() => { window.__webVersionMock.confirmResult = false; });
    await page.click('#btn-open-browser');
    const declinedWeb = await page.evaluate(() => ({
        browserCalls: window.__webVersionMock.browserUrls.length,
        menuOpen: !document.getElementById('menu-modal').classList.contains('hidden'),
    }));
    check('declining the separate-session warning keeps the menu open and makes no request',
        declinedWeb.browserCalls === 0 && declinedWeb.menuOpen, JSON.stringify(declinedWeb));

    await page.evaluate(() => { window.__webVersionMock.confirmResult = true; });
    await page.click('#btn-open-browser');
    await page.waitForFunction(() => window.__webVersionMock.browserUrls.length === 1);
    const webFallback = await page.evaluate(() => ({
        url: window.__webVersionMock.browserUrls[0],
        prompt: window.__webVersionMock.prompts[0],
        menuClosed: document.getElementById('menu-modal').classList.contains('hidden'),
    }));
    check('the fallback opens the canonical GitHub Pages PWA',
        webFallback.url === 'https://s243a.github.io/SciREPL/', JSON.stringify(webFallback));
    check('the fallback warns about separate data, a second installed app, and first-use network',
        /separate notebooks and settings/i.test(webFallback.prompt)
        && /second SciREPL app/i.test(webFallback.prompt)
        && /first visit requires an internet connection/i.test(webFallback.prompt),
        JSON.stringify(webFallback));
    check('opening the web version closes the menu', webFallback.menuClosed,
        JSON.stringify(webFallback));

    const bridge = await page.evaluate(async () => {
        const beforePrompts = window.__webVersionMock.prompts.length;
        const beforeBrowser = window.__webVersionMock.browserUrls.length;
        window.__webVersionMock.bridgeInstalled = true;
        document.getElementById('menu-modal').classList.remove('hidden');
        document.getElementById('btn-open-browser').click();
        await new Promise(resolve => setTimeout(resolve, 0));
        return {
            calls: window.__webVersionMock.bridgeCalls,
            promptDelta: window.__webVersionMock.prompts.length - beforePrompts,
            browserDelta: window.__webVersionMock.browserUrls.length - beforeBrowser,
        };
    });
    check('an installed Browser Bridge overrides the hosted fallback without a second prompt',
        bridge.calls === 1 && bridge.promptDelta === 0 && bridge.browserDelta === 0,
        JSON.stringify(bridge));
    await page.addScriptTag({ url: `${URL.replace(/index\.html$/, '')}js/android_back.js` });
    check('a duplicate script evaluation does not register twice', await page.evaluate(() =>
        window.__appPluginMock.listenerNames.join(',') === 'backButton'));

    // A specialized dialog must receive a click on its real close control so
    // its focus restoration and lifecycle cleanup run.
    await page.click('#menu-btn');
    await page.click('#btn-appearance');
    await page.evaluate(() => {
        window.__appearanceCloseClicks = 0;
        document.querySelector('#appearance-modal .modal-close').addEventListener('click', () => {
            window.__appearanceCloseClicks++;
        });
    });
    await press(page);
    await page.waitForFunction(() => document.getElementById('appearance-modal')
        .classList.contains('hidden'));
    const appearance = await page.evaluate(() => ({
        clicks: window.__appearanceCloseClicks,
        focus: document.activeElement && document.activeElement.id,
        exits: window.__appPluginMock.exitCalls,
    }));
    check('Back clicks the Appearance dialog’s real close control',
        appearance.clicks === 1, JSON.stringify(appearance));
    check('the dialog’s normal focus restoration runs', appearance.focus === 'menu-btn',
        JSON.stringify(appearance));
    check('closing a dialog does not exit', appearance.exits === 0,
        JSON.stringify(appearance));

    // Same-z-index dialogs paint in DOM order. Only the visually topmost one
    // should close on a press.
    await page.evaluate(() => {
        document.getElementById('help-modal').classList.remove('hidden');
        document.getElementById('menu-modal').classList.remove('hidden');
    });
    await press(page);
    await page.waitForFunction(() => document.getElementById('menu-modal')
        .classList.contains('hidden'));
    check('Back closes only the topmost of two visible modals', await page.evaluate(() =>
        !document.getElementById('help-modal').classList.contains('hidden')
        && document.getElementById('menu-modal').classList.contains('hidden')));
    await press(page);
    await page.waitForFunction(() => document.getElementById('help-modal')
        .classList.contains('hidden'));

    // Privacy uses a Promise whose rejection/cleanup lives on its click handler.
    await page.evaluate(() => {
        localStorage.removeItem('scirepl_privacy_accepted');
        localStorage.removeItem('scirepl_privacy_accepted_revision');
        window.__privacyResult = 'pending';
        window.kernelManager.ensureNetworkConsent()
            .then(() => { window.__privacyResult = 'accepted'; })
            .catch(() => { window.__privacyResult = 'rejected'; });
    });
    await page.waitForSelector('#privacy-modal:not(.hidden)');
    await press(page);
    await page.waitForFunction(() => window.__privacyResult !== 'pending');
    check('Back runs the privacy dialog’s cancellation Promise cleanup',
        await page.evaluate(() => window.__privacyResult === 'rejected'
            && document.getElementById('privacy-modal').classList.contains('hidden')));

    await page.evaluate(() => {
        localStorage.removeItem('scirepl_auto_download');
        const manager = window.kernelManager;
        manager.__realRuntimeCacheCheck = manager._hasCompleteCachedRuntime;
        manager._hasCompleteCachedRuntime = async () => false;
        window.__runtimeConfirmation = 'pending';
        manager._confirmDownload('r')
            .then(() => { window.__runtimeConfirmation = 'download'; })
            .catch(() => { window.__runtimeConfirmation = 'cancelled'; })
            .finally(() => {
                manager._hasCompleteCachedRuntime = manager.__realRuntimeCacheCheck;
                delete manager.__realRuntimeCacheCheck;
            });
    });
    await page.waitForSelector('#runtime-download-modal:not(.hidden)');
    await press(page);
    await page.waitForFunction(() => window.__runtimeConfirmation !== 'pending');
    check('Back rejects a pending runtime confirmation through its real X handler',
        await page.evaluate(() => window.__runtimeConfirmation === 'cancelled'
            && document.getElementById('runtime-download-modal').classList.contains('hidden')));

    // Once a runtime download has started, its confirmation listeners are gone.
    // The global X handler must still hide progress without pretending to abort
    // the in-flight load.
    await page.evaluate(() => {
        const manager = window.kernelManager;
        const original = manager.hideDownloadModal.bind(manager);
        window.__hideDownloadCalls = 0;
        manager.hideDownloadModal = (...args) => {
            window.__hideDownloadCalls++;
            return original(...args);
        };
        document.getElementById('runtime-download-actions').classList.add('hidden');
        document.getElementById('runtime-progress-wrap').classList.remove('hidden');
        document.getElementById('runtime-download-modal').classList.remove('hidden');
    });
    await press(page);
    await page.waitForFunction(() => document.getElementById('runtime-download-modal')
        .classList.contains('hidden'));
    check('Back uses the active runtime progress dialog’s existing X handler',
        await page.evaluate(() => window.__hideDownloadCalls === 1));

    await page.evaluate(() => {
        localStorage.removeItem('scirepl_whats_new_seen_version');
        window.whatsNew.requestOpen({ source: 'help' });
    });
    await page.waitForSelector('#whats-new-modal:not(.hidden)');
    await press(page);
    await page.waitForFunction(() => document.getElementById('whats-new-modal')
        .classList.contains('hidden'));
    check('Back runs What’s New’s normal close lifecycle', await page.evaluate(() =>
        localStorage.getItem('scirepl_whats_new_seen_version')
            === window.KERNEL_CONFIG.app.version));

    await page.evaluate(() => {
        history.pushState({ catalogBackTest: true }, '', '#catalog-back-test');
        document.getElementById('package-catalog-modal').classList.remove('hidden');
        window.packageCatalog._showSourcePanel(true);
    });
    await press(page, { canGoBack: true });
    const sourceBack = await page.evaluate(() => ({
        modalOpen: !document.getElementById('package-catalog-modal').classList.contains('hidden'),
        sourceHidden: document.getElementById('catalog-source-panel').classList.contains('hidden'),
        browseOpen: !document.getElementById('catalog-browse-panel').classList.contains('hidden'),
        hash: location.hash,
    }));
    check('Back unwinds Catalog Source before the catalogue or WebView history',
        sourceBack.modalOpen && sourceBack.sourceHidden && sourceBack.browseOpen
            && sourceBack.hash === '#catalog-back-test', JSON.stringify(sourceBack));

    await page.evaluate(() => window.packageCatalog._showFallbackPanel(true));
    await press(page, { canGoBack: true });
    const fallbackBack = await page.evaluate(() => ({
        modalOpen: !document.getElementById('package-catalog-modal').classList.contains('hidden'),
        fallbackHidden: document.getElementById('catalog-fallback-panel').classList.contains('hidden'),
        browseOpen: !document.getElementById('catalog-browse-panel').classList.contains('hidden'),
        hash: location.hash,
    }));
    check('Back unwinds Fallback Languages before the catalogue or history',
        fallbackBack.modalOpen && fallbackBack.fallbackHidden && fallbackBack.browseOpen
            && fallbackBack.hash === '#catalog-back-test', JSON.stringify(fallbackBack));

    await press(page, { canGoBack: true });
    check('the next Back closes the catalogue before navigating history', await page.evaluate(() =>
        document.getElementById('package-catalog-modal').classList.contains('hidden')
        && location.hash === '#catalog-back-test'));

    console.log('\n3. Tour, search, palette, history and exit');
    await page.evaluate(() => window.onboarding.start());
    await page.waitForSelector('#tour-overlay');
    await page.evaluate(() => {
        const help = document.getElementById('help-modal');
        help.style.zIndex = '9500';
        help.classList.remove('hidden');
    });
    await press(page);
    await page.waitForFunction(() => document.getElementById('help-modal')
        .classList.contains('hidden'));
    check('Back follows actual z-index when a modal outranks the Tour',
        await page.evaluate(() => Boolean(document.getElementById('tour-overlay'))));
    await page.evaluate(() => { document.getElementById('help-modal').style.zIndex = ''; });
    await press(page);
    await page.waitForFunction(() => !document.getElementById('tour-overlay'));
    check('Back finishes the Tour through onboarding.finish()', await page.evaluate(() =>
        localStorage.getItem('scirepl_onboarding_seen') === '1'
        && window.__appPluginMock.exitCalls === 0));

    await page.click('#search-btn');
    await page.waitForFunction(() => !document.getElementById('search-bar')
        .classList.contains('hidden'));
    await press(page);
    await page.waitForFunction(() => document.getElementById('search-bar')
        .classList.contains('hidden'));
    check('Back uses the search bar’s close control', true);

    // Defensive IME ordering: a few WebView/device combinations may deliver
    // the plugin callback before native keyboard dismissal. Simulate that
    // reduced visual viewport while leaving a palette open behind the editor.
    await page.evaluate(() => {
        window.mathMode.setOpen(true);
        document.getElementById('code-input').focus();
        window.__realVisualViewport = window.visualViewport;
        Object.defineProperty(window, 'visualViewport', {
            configurable: true,
            value: {
                width: window.innerWidth,
                height: window.innerHeight - 300,
                offsetTop: 0,
                offsetLeft: 0,
                addEventListener() {},
                removeEventListener() {},
            },
        });
    });
    await page.waitForFunction(() => !document.getElementById('math-palette')
        .classList.contains('hidden'));
    await press(page);
    const ime = await page.evaluate(() => ({
        blurred: document.activeElement !== document.getElementById('code-input'),
        paletteOpen: !document.getElementById('math-palette').classList.contains('hidden'),
        exits: window.__appPluginMock.exitCalls,
    }));
    check('a delivered Back callback dismisses only a still-visible IME',
        ime.blurred && ime.paletteOpen && ime.exits === 0, JSON.stringify(ime));
    await page.evaluate(() => {
        Object.defineProperty(window, 'visualViewport', {
            configurable: true,
            value: window.__realVisualViewport,
        });
        delete window.__realVisualViewport;
    });
    await press(page);
    await page.waitForFunction(() => document.getElementById('math-palette')
        .classList.contains('hidden'));
    check('Back closes the Formula palette without exiting', await page.evaluate(() =>
        window.__appPluginMock.exitCalls === 0));

    await page.evaluate(() => {
        window.__backPopped = false;
        window.addEventListener('popstate', () => { window.__backPopped = true; }, { once: true });
    });
    await press(page, { canGoBack: true });
    await page.waitForFunction(() => window.__backPopped);
    check('when WebView history exists, Back navigates instead of exiting', await page.evaluate(() =>
        location.hash === '' && window.__appPluginMock.exitCalls === 0));

    await page.evaluate(() => {
        const unknown = document.createElement('div');
        unknown.id = 'unknown-blocking-modal';
        unknown.className = 'modal';
        unknown.style.zIndex = '10000';
        unknown.innerHTML = '<div class="modal-content">Unknown blocking state</div>';
        document.body.appendChild(unknown);
    });
    await press(page, { canGoBack: false });
    check('an unknown blocking modal fails closed instead of exiting', await page.evaluate(() =>
        Boolean(document.getElementById('unknown-blocking-modal'))
        && window.__appPluginMock.exitCalls === 0));
    await page.evaluate(() => document.getElementById('unknown-blocking-modal').remove());

    await press(page, { canGoBack: false });
    await page.waitForFunction(() => window.__appPluginMock.exitCalls === 1);
    check('Back exits only when no app UI or history remains', await page.evaluate(() =>
        window.__appPluginMock.exitCalls === 1));
    check('the native routing run produces no page errors', errors.length === 0,
        errors.join(' | '));
    await context.close();
} finally {
    await browser.close();
}

if (failures) {
    console.error(`\n${failures} Android Back check(s) failed.`);
    process.exit(1);
}
console.log('\nAll Android Back checks passed.');
