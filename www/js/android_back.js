/**
 * android_back.js — Android system-Back routing for the Capacitor shell.
 *
 * This remains a plain browser script because the web, PWA, Android and
 * desktop builds share index.html.  It installs a listener only when the
 * official Capacitor App plugin is present on native Android; ordinary web
 * pages keep their normal browser history and keyboard behaviour.
 *
 * The native system normally gives the IME first refusal on Back, so we do not
 * listen for DOM key events or call a Keyboard plugin.  A defensive path blurs
 * only the focused editor when a callback nevertheless arrives with clear
 * visual-viewport evidence that the keyboard is still open.
 */
(function () {
    'use strict';

    // A script accidentally included twice must not replace the public helper
    // or register a second native callback (one press would otherwise dismiss
    // two layers). Registration starts synchronously below, before addListener's
    // Promise settles, so this also covers two evaluations in the same tick.
    if (window.SciReplAndroidBack
        && window.SciReplAndroidBack.registrationStarted) return;

    function shown(element) {
        if (!element || !element.isConnected) return false;
        if (element.classList.contains('hidden')
            || element.classList.contains('space-collapsed')) return false;
        if (element.getAttribute('aria-hidden') === 'true') return false;
        const style = getComputedStyle(element);
        if (style.display === 'none' || style.visibility === 'hidden'
            || Number(style.opacity) === 0) return false;
        const box = element.getBoundingClientRect();
        return box.width > 0 && box.height > 0;
    }

    /** Highest numeric stacking layer on the element's ancestor chain. */
    function stackingLayer(element) {
        let layer = 0;
        for (let node = element; node instanceof Element; node = node.parentElement) {
            const value = Number.parseInt(getComputedStyle(node).zIndex, 10);
            if (Number.isFinite(value)) layer = Math.max(layer, value);
        }
        return layer;
    }

    /** Later equal-layer elements paint above earlier DOM siblings. */
    function topmostSurface() {
        const candidates = [];
        const add = (kind, element) => {
            if (shown(element)) candidates.push({
                kind,
                element,
                layer: stackingLayer(element),
            });
        };
        document.querySelectorAll('.modal').forEach((modal) => add('modal', modal));
        add('tour', document.getElementById('tour-overlay'));
        add('search', document.getElementById('search-bar'));
        add('palette', document.getElementById('math-palette'));
        candidates.sort((a, b) => {
            if (a.layer !== b.layer) return a.layer - b.layer;
            if (a.element === b.element) return 0;
            return a.element.compareDocumentPosition(b.element)
                & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
        });
        return candidates[candidates.length - 1] || null;
    }

    function focusedEditable() {
        const element = document.activeElement;
        if (!element || element.disabled || element.readOnly) return null;
        if (element instanceof HTMLTextAreaElement) return element;
        if (element instanceof HTMLInputElement) {
            const nonText = new Set([
                'button', 'checkbox', 'color', 'file', 'hidden', 'image',
                'radio', 'range', 'reset', 'submit',
            ]);
            return nonText.has((element.type || 'text').toLowerCase()) ? null : element;
        }
        return element.isContentEditable ? element : null;
    }

    /**
     * Android normally gives the IME first refusal before @capacitor/app emits
     * backButton. Keep a defensive path for WebView/device combinations that
     * deliver the callback first: a materially shrunken visual viewport plus
     * an editable focus is strong evidence that the keyboard is still open.
     * Blur only that field; do not also close app UI or exit on the same press.
     */
    function dismissImeIfVisible() {
        const editable = focusedEditable();
        const viewport = window.visualViewport;
        if (!editable || !viewport) return false;
        if (window.innerHeight - viewport.height < 80) return false;
        editable.blur();
        return true;
    }

    /**
     * Close one visible app surface, in the same order as the CSS layers.
     * Every surface is dismissed through its semantic close path.  In
     * particular, never add `.hidden` to a modal here: runtime/privacy dialogs
     * attach cancellation and Promise cleanup to their real close control.
     */
    function dismissTopmostUi() {
        const surface = topmostSurface();
        if (!surface) return null;

        if (surface.kind === 'tour') {
            if (window.onboarding && typeof window.onboarding.finish === 'function') {
                window.onboarding.finish();
                return 'tour';
            }
            return 'blocked-tour';
        }

        if (surface.kind === 'search') {
            const close = document.getElementById('search-close-btn');
            if (close) {
                close.click();
                return 'search';
            }
            return 'blocked-search';
        }

        if (surface.kind === 'modal') {
            // Package Catalogue contains two drill-in screens inside its one
            // modal. Android Back must unwind that inner navigation before the
            // next press closes the whole catalogue.
            if (surface.element.id === 'package-catalog-modal') {
                for (const [panelId, backId, result] of [
                    ['catalog-source-panel', 'catalog-source-back', 'catalog-source'],
                    ['catalog-fallback-panel', 'catalog-fallback-back', 'catalog-fallback'],
                ]) {
                    if (!shown(document.getElementById(panelId))) continue;
                    const back = document.getElementById(backId);
                    if (back) {
                        back.click();
                        return result;
                    }
                    return 'blocked-catalog-panel';
                }
            }
            const close = surface.element.querySelector('.modal-close');
            if (close) {
                close.click();
                return 'modal';
            }
            // A blocking surface with no known semantic close path must fail
            // closed. Exiting here would strand or silently abandon its state.
            return 'blocked-modal';
        }

        if (surface.kind === 'palette') {
            if (window.mathMode && typeof window.mathMode.setOpen === 'function') {
                window.mathMode.setOpen(false);
                return 'palette';
            }
            return 'blocked-palette';
        }

        // The notebook sidebar is a persistent tablet/desktop layout mode, not
        // a temporary drawer, so it is intentionally not treated as dismissible.
        return 'blocked-surface';
    }

    const api = {
        installed: false,
        registrationStarted: false,
        listenerHandle: null,
        dismissTopmostUi,
        dismissImeIfVisible,
        async handleBack(event, appPlugin) {
            if (dismissImeIfVisible()) return;
            if (dismissTopmostUi()) return;
            if (event && event.canGoBack) {
                window.history.back();
                return;
            }
            await appPlugin.exitApp();
        },
    };
    window.SciReplAndroidBack = api;

    const capacitor = window.Capacitor;
    const appPlugin = capacitor && capacitor.Plugins && capacitor.Plugins.App;
    const platform = capacitor && typeof capacitor.getPlatform === 'function'
        ? capacitor.getPlatform() : null;
    const native = capacitor && typeof capacitor.isNativePlatform === 'function'
        ? capacitor.isNativePlatform() : platform === 'android';
    if (!appPlugin || typeof appPlugin.addListener !== 'function'
        || !native || platform !== 'android') return;

    api.registrationStarted = true;
    api.installed = true;
    Promise.resolve(appPlugin.addListener('backButton', (event) => {
        api.handleBack(event, appPlugin).catch((error) => {
            console.error('Android Back handling failed:', error);
        });
    })).then((handle) => {
        api.listenerHandle = handle || null;
    }).catch((error) => {
        api.installed = false;
        api.registrationStarted = false;
        console.error('Could not install Android Back handler:', error);
    });
})();
