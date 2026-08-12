/**
 * whats_new.js — one release summary, shared by PWA, Android and Electron.
 *
 * The release version and URL come from generated KERNEL_CONFIG metadata,
 * whose source is package.json. This keeps the prompt marker, visible version
 * and GitHub link on the same version the build system packages.
 *
 * Automatic display is intentionally conservative:
 *   - a fresh install sees it only after completing the first-run tour;
 *   - an existing install sees it once after each version upgrade;
 *   - privacy/runtime dialogs and the tour always take precedence;
 *   - Help can reopen it at any time.
 */

(function () {
    'use strict';

    const SEEN_VERSION_KEY = 'scirepl_whats_new_seen_version';
    const ONBOARDING_KEY = 'scirepl_onboarding_seen';
    const BLOCKING_MODALS = ['privacy-modal', 'runtime-download-modal'];

    function visibleModal(modal) {
        return Boolean(modal && !modal.classList.contains('hidden'));
    }

    function focusable(root) {
        return [...root.querySelectorAll(
            'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
            .filter((node) => !node.disabled && node.offsetParent !== null);
    }

    class WhatsNew {
        constructor() {
            const app = (window.KERNEL_CONFIG && window.KERNEL_CONFIG.app) || {};
            this.version = String(app.version || '');
            this.releaseChannel = app.releaseChannel === 'release'
                ? 'release' : 'development';
            this.releaseUrl = app.releasesUrl || app.releaseUrl
                || 'https://github.com/s243a/SciREPL/releases';
            this.modal = null;
            this._pending = null;
            this._autoTimer = null;
            // If this was absent at script load, Skip/Escape must not turn into
            // an upgrade prompt simply because onboarding then marks itself seen.
            this._onboardingAtBoot = localStorage.getItem(ONBOARDING_KEY);
            this._appReady = Boolean(window.__SCIREPL_APP_READY);
        }

        init() {
            this.modal = document.getElementById('whats-new-modal');
            if (!this.modal) return;

            const close = this.modal.querySelector('.modal-close');
            if (close) close.addEventListener('click', () => this.close());
            const done = document.getElementById('whats-new-done');
            if (done) done.addEventListener('click', () => this.close());
            this.modal.addEventListener('click', (event) => {
                if (event.target === this.modal) this.close();
            });
            this.modal.addEventListener('keydown', (event) => {
                if (this.modal.classList.contains('hidden')) return;
                if (event.key === 'Escape') {
                    event.preventDefault();
                    this.close();
                } else if (event.key === 'Tab') {
                    this._trapFocus(event);
                }
            });

            const help = document.getElementById('btn-show-whats-new');
            if (help) help.addEventListener('click', () => {
                const helpModal = document.getElementById('help-modal');
                if (helpModal) helpModal.classList.add('hidden');
                this.requestOpen({ source: 'help' });
            });

            const language = document.getElementById('whats-new-language');
            if (language) language.addEventListener('change', async () => {
                if (!window.i18n) return;
                const value = language.value;
                const sequence = (this._languageSequence || 0) + 1;
                this._languageSequence = sequence;
                window.i18n.setPreference(value);
                await window.i18n.activate(value === 'auto'
                    ? window.i18n.resolve() : value);
                if (sequence !== this._languageSequence || !this.modal
                    || !this.modal.isConnected || this.modal.classList.contains('hidden')) return;
                this._populateLanguages();
                const fresh = document.getElementById('whats-new-language');
                if (fresh) fresh.focus();
            });

            document.addEventListener('i18n:changed', () => this._render());

            // Class changes cover privacy/runtime and ordinary modals. Child-list
            // changes cover the tour overlay, which is constructed dynamically.
            this._modalObserver = new MutationObserver(() => this._arbitrate());
            document.querySelectorAll('.modal').forEach((modal) => {
                this._modalObserver.observe(modal, {
                    attributes: true,
                    attributeFilter: ['class'],
                });
            });
            this._tourObserver = new MutationObserver(() => this._arbitrate());
            this._tourObserver.observe(document.body, { childList: true });

            document.addEventListener('scirepl:app-ready', () => {
                this._appReady = true;
                if (this._pending) this._scheduleAttempt(120);
            }, { once: true });

            this._render();
            // Only an install that had already completed/grandfathered onboarding
            // when this release loaded is eligible for the upgrade prompt here.
            if (this._onboardingAtBoot) this.requestAuto('upgrade');
        }

        /** Request the once-per-version upgrade prompt. */
        requestAuto(source = 'upgrade') {
            if (!this.version || this._seenCurrent()) return false;
            // A genuinely fresh boot is released only by explicit grandfathering
            // or by the tour's completed path (which calls requestOpen instead).
            if (!this._onboardingAtBoot && source !== 'grandfathered') return false;
            if (visibleModal(this.modal)) return true;
            this._pending = { manual: false, source };
            // Let startup modal/tour decisions settle before interrupting.
            this._scheduleAttempt(700);
            return true;
        }

        /**
         * Open from Help or after normal first-run tour completion.
         * Help bypasses the seen marker; tour completion does not, preventing a
         * second copy if the user already opened the page during that session.
         */
        requestOpen({ source = 'manual' } = {}) {
            const manual = source === 'manual' || source === 'help';
            if (!manual && this._seenCurrent()) return false;
            if (visibleModal(this.modal)) return true;
            this._pending = { manual, source };
            this._attemptOpen();
            return true;
        }

        /** Mark this version handled without opening it (first-run Skip/Escape). */
        suppressCurrent() {
            if (this.version) localStorage.setItem(SEEN_VERSION_KEY, this.version);
            this._pending = null;
            this._activeRequest = null;
        }

        _scheduleAttempt(delay) {
            clearTimeout(this._autoTimer);
            this._autoTimer = setTimeout(() => this._attemptOpen(), delay);
        }

        _seenCurrent() {
            return Boolean(this.version
                && localStorage.getItem(SEEN_VERSION_KEY) === this.version);
        }

        _blocked() {
            if (BLOCKING_MODALS.some((id) => visibleModal(document.getElementById(id)))) {
                return true;
            }
            const tour = document.getElementById('tour-overlay');
            if (tour && tour.style.display !== 'none'
                && tour.getAttribute('aria-hidden') !== 'true') return true;
            return [...document.querySelectorAll('.modal')].some((modal) =>
                modal !== this.modal && visibleModal(modal));
        }

        _arbitrate() {
            if (!this.modal) return;
            if (!this.modal.classList.contains('hidden') && this._blocked()) {
                // A consent/runtime dialog appeared after us. Yield without
                // marking the release seen, then resume when the blocker leaves.
                this._pending = this._activeRequest
                    || this._pending || { manual: false, source: 'resume' };
                this._activeRequest = null;
                this.modal.classList.add('hidden');
                this._open = false;
                const blocker = BLOCKING_MODALS
                    .map((id) => document.getElementById(id))
                    .find((modal) => visibleModal(modal));
                const target = blocker && focusable(blocker)[0];
                if (target) target.focus();
                else if (this.modal.contains(document.activeElement)
                    && document.activeElement.blur) document.activeElement.blur();
                return;
            }
            if (this._pending && !this._blocked()) {
                clearTimeout(this._retryTimer);
                this._retryTimer = setTimeout(() => this._attemptOpen(), 120);
            }
        }

        _attemptOpen() {
            clearTimeout(this._autoTimer);
            this._autoTimer = null;
            if (!this.modal || !this._pending || !this._appReady) return;
            if (!this._pending.manual && this._seenCurrent()) {
                this._pending = null;
                return;
            }
            if (this._blocked()) return;

            const request = this._pending;
            this._pending = null;
            this._activeRequest = request;
            if (!this._returnFocusTo) this._returnFocusTo = document.activeElement;
            this._render();
            this.modal.classList.remove('hidden');
            // The global modal observer clears inert on a microtask. Focus must
            // move now, so mirror the Appearance dialog's synchronous clear.
            this.modal.inert = false;
            this.modal.removeAttribute('aria-hidden');
            this._open = true;
            const language = document.getElementById('whats-new-language');
            const first = language || focusable(this.modal)[0];
            if (first) first.focus();
        }

        close() {
            if (!this.modal || this.modal.classList.contains('hidden')) return;
            this.modal.classList.add('hidden');
            this._open = false;
            this._pending = null;
            this._activeRequest = null;
            this._languageSequence = (this._languageSequence || 0) + 1;
            if (this.version) localStorage.setItem(SEEN_VERSION_KEY, this.version);

            const back = this._returnFocusTo;
            this._returnFocusTo = null;
            if (back && document.contains(back) && back.offsetParent !== null && back.focus) {
                back.focus();
            } else {
                const help = document.getElementById('help-btn');
                if (help) help.focus();
            }
        }

        _trapFocus(event) {
            const nodes = focusable(this.modal);
            if (!nodes.length) return;
            const first = nodes[0];
            const last = nodes[nodes.length - 1];
            const active = document.activeElement;
            if (event.shiftKey && (active === first || !this.modal.contains(active))) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && active === last) {
                event.preventDefault();
                first.focus();
            }
        }

        _render() {
            if (!this.modal) return;
            if (window.i18n) window.i18n.applyToDom(this.modal);
            const version = document.getElementById('whats-new-version');
            if (version) {
                window.setI18nText(version, this._isUnreleasedBuild()
                    ? 'whatsNew.unreleasedVersion' : 'whatsNew.version', {
                    version: this.version || '—',
                });
            }
            const release = document.getElementById('whats-new-release-link');
            if (release) release.href = this.releaseUrl;
            const helpVersion = document.getElementById('help-app-version');
            if (helpVersion) {
                window.setI18nHtml(helpVersion, 'help.scireplVersion', {
                    version: this.version || '—',
                });
            }
            this._renderHighlights();
            this._populateLanguages();
        }

        _renderHighlights() {
            const list = document.getElementById('whats-new-highlights');
            if (!list) return;
            const releases = window.SCIREPL_RELEASE_HIGHLIGHTS || {};
            // A development build may intentionally retain the last published
            // version while accumulating the next release. Its frozen history
            // must not hide the live, explicitly-unreleased list.
            const keys = this._isUnreleasedBuild()
                ? (releases.unreleased || [])
                : (releases[this.version] || []);
            list.replaceChildren();
            for (const key of keys) {
                const item = document.createElement('li');
                window.setI18nText(item, key);
                list.appendChild(item);
            }
            list.hidden = keys.length === 0;
        }

        _isUnreleasedBuild() {
            return this.releaseChannel !== 'release';
        }

        _populateLanguages() {
            const select = document.getElementById('whats-new-language');
            const i18n = window.i18n;
            if (!select || !i18n) return;
            const focused = document.activeElement === select;
            const detected = i18n.detected();
            const detectedName = i18n.localeInfo(detected).endonym;
            select.innerHTML = '';

            const auto = document.createElement('option');
            auto.value = 'auto';
            auto.textContent = window.t('appearance.languageDetectValue', {
                language: detectedName,
            });
            select.appendChild(auto);
            for (const locale of i18n.available()) {
                const option = document.createElement('option');
                option.value = locale.code;
                const percent = Math.round(locale.completeness * 100);
                if (locale.draft) {
                    option.textContent = window.t('appearance.languageDraft', {
                        language: locale.endonym,
                        percent,
                    });
                } else if (locale.partial) {
                    option.textContent = window.t('appearance.languagePartial', {
                        language: locale.endonym,
                        percent,
                    });
                } else {
                    option.textContent = locale.endonym;
                }
                select.appendChild(option);
            }
            select.value = i18n.getPreference();
            if (focused) select.focus();
        }
    }

    const whatsNew = new WhatsNew();
    window.whatsNew = whatsNew;

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => whatsNew.init(), { once: true });
    } else {
        whatsNew.init();
    }
})();
