/**
 * appearance_ui.js — the Appearance dialog.
 *
 * Kept apart from appearance.js so the settings model has no DOM dependency:
 * the model can be exercised directly in tests, and the dialog is only wiring.
 * Every control writes through the model, which is what persists and applies.
 */

(function () {
    'use strict';

    const $ = (id) => document.getElementById(id);

    class AppearanceUI {
        constructor() {
            this.modal = null;
        }

        init() {
            this.modal = $('appearance-modal');
            if (!this.modal || !window.appearance) return;

            const openBtn = $('btn-appearance');
            if (openBtn) {
                openBtn.addEventListener('click', () => {
                    const menu = $('menu-modal');
                    // Capture where focus should go back to BEFORE hiding the
                    // menu: the menu button is what stays visible, and the
                    // Appearance entry that was clicked is about to become inert.
                    const opener = document.getElementById('menu-btn') || openBtn;
                    if (menu) menu.classList.add('hidden');
                    this.open(opener);
                });
            }

            const closeBtn = this.modal.querySelector('.modal-close');
            if (closeBtn) closeBtn.addEventListener('click', () => this.close());
            this.modal.addEventListener('click', (e) => {
                if (e.target === this.modal) this.close();
            });

            // Keyboard: Escape closes, Tab is trapped inside the dialog. Without
            // this a keyboard user tabs straight out of the modal onto the app
            // behind it, which the backdrop is meant to be blocking.
            this._onKey = (e) => {
                if (this.modal.classList.contains('hidden')) return;
                if (e.key === 'Escape') { e.preventDefault(); this.close(); }
                else if (e.key === 'Tab') this._trapFocus(e);
            };
            this.modal.addEventListener('keydown', this._onKey);

            this._wireLayout();
            this._wireButtons();
            this._wireTheme();
            this._wireLanguage();

            $('appearance-reset').addEventListener('click', () => {
                window.appearance.reset();
                this.refresh();
            });

            // Re-label the dialog when the language changes underneath it.
            document.addEventListener('i18n:changed', () => {
                if (window.i18n) window.i18n.applyToDom(this.modal);
                this.refresh();
            });
        }

        open(opener) {
            this.refresh();
            this._returnFocusTo = opener
                || (document.activeElement && !document.activeElement.closest('.modal.hidden')
                    ? document.activeElement : document.getElementById('menu-btn'));
            this.modal.classList.remove('hidden');
            // Clear inert synchronously: the global observer that toggles it runs
            // on a microtask, after the focus() below would have failed against a
            // still-inert subtree.
            this.modal.inert = false;
            this.modal.removeAttribute('aria-hidden');
            // Move focus into the dialog so keyboard and screen-reader users are
            // actually in it, not still on the menu behind the backdrop.
            const first = this.modal.querySelector(
                '.modal-close, button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
            if (first) first.focus();
        }

        close() {
            this.modal.classList.add('hidden');
            // Hand focus back to whatever opened the dialog, if it is still
            // visible; otherwise to the menu button.
            const back = this._returnFocusTo;
            this._returnFocusTo = null;
            const visible = (el) => {
                if (!el || !document.contains(el)) return false;
                const cs = getComputedStyle(el);
                if (cs.visibility === 'hidden' || cs.display === 'none') return false;
                if (el.closest && el.closest('.modal.hidden')) return false;
                return el.getBoundingClientRect().width > 0;
            };
            if (visible(back) && back.focus) back.focus();
            else {
                const menu = document.getElementById('menu-btn');
                if (menu) menu.focus();
            }
        }

        /** Keep Tab inside the dialog, cycling at both ends. */
        _trapFocus(e) {
            const focusable = [...this.modal.querySelectorAll(
                'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
                .filter((n) => !n.disabled && n.offsetParent !== null);
            if (!focusable.length) return;
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            const active = document.activeElement;
            if (e.shiftKey && (active === first || !this.modal.contains(active))) {
                e.preventDefault(); last.focus();
            } else if (!e.shiftKey && active === last) {
                e.preventDefault(); first.focus();
            }
        }

        /* ----------------------------- layout ---------------------------- */

        _wireLayout() {
            const slider = $('appearance-top-margin');
            const auto = $('appearance-top-margin-auto');

            slider.addEventListener('input', () => {
                // Moving the slider is an explicit choice, so it leaves auto.
                auto.checked = false;
                window.appearance.setTopMargin(Number(slider.value));
                this._refreshTopMargin();
            });

            auto.addEventListener('change', () => {
                if (auto.checked) {
                    window.appearance.setTopMargin(null);
                } else {
                    // Leaving auto keeps whatever auto currently resolves to, so
                    // the layout does not jump at the moment of switching.
                    window.appearance.setTopMargin(this._resolvedTopMargin());
                }
                this._refreshTopMargin();
            });
        }

        /** What the header is actually using right now, in px. */
        _resolvedTopMargin() {
            const header = $('app-header');
            if (!header) return 0;
            const padTop = parseFloat(getComputedStyle(header).paddingTop) || 0;
            // The header's own 10px padding is not part of the setting.
            return Math.max(0, Math.round(padTop - 10));
        }

        _refreshTopMargin() {
            const stored = window.appearance.getTopMargin();
            const slider = $('appearance-top-margin');
            const auto = $('appearance-top-margin-auto');
            const value = $('appearance-top-margin-value');

            auto.checked = stored === null;
            slider.disabled = stored === null;

            const effective = stored === null ? this._resolvedTopMargin() : stored;
            slider.value = String(Math.min(96, effective));
            value.textContent = stored === null
                ? window.t('appearance.topMarginAutoValue', { pixels: effective })
                : `${stored} px`;
        }

        /* ----------------------------- buttons --------------------------- */

        _wireButtons() {
            const slider = $('appearance-btn-scale');
            slider.addEventListener('input', () => {
                window.appearance.setButtonScale(Number(slider.value));
                this._refreshButtonScale();
            });

            const tour = $('appearance-show-tour-shortcut');
            const browse = $('appearance-show-browse-shortcut');
            const formula = $('appearance-show-formula-shortcut');
            if (tour) {
                tour.addEventListener('change', () => {
                    window.appearance.setShowTourShortcut(tour.checked);
                });
            }
            if (browse) {
                browse.addEventListener('change', () => {
                    window.appearance.setShowBrowseShortcut(browse.checked);
                });
            }
            if (formula) {
                formula.addEventListener('change', () => {
                    window.appearance.setShowFormulaShortcut(formula.checked);
                });
            }
        }

        _refreshButtonScale() {
            const scale = window.appearance.getButtonScale();
            $('appearance-btn-scale').value = String(scale);
            $('appearance-btn-scale-value').textContent = `${Math.round(scale * 100)}%`;
            const tour = $('appearance-show-tour-shortcut');
            const browse = $('appearance-show-browse-shortcut');
            const formula = $('appearance-show-formula-shortcut');
            if (tour) tour.checked = window.appearance.getShowTourShortcut();
            if (browse) browse.checked = window.appearance.getShowBrowseShortcut();
            if (formula) formula.checked = window.appearance.getShowFormulaShortcut();
        }

        /* ------------------------------ theme ---------------------------- */

        _wireTheme() {
            const select = $('appearance-theme');
            const editor = $('appearance-theme-editor');

            select.addEventListener('change', () => {
                if (select.value === 'custom' && !window.appearance.getCustomTheme()) {
                    // Choosing Custom with nothing defined yet opens the editor
                    // seeded from the current theme, rather than applying blank.
                    editor.classList.remove('hidden');
                    $('appearance-theme-json').value = window.appearance.exportCurrentTheme();
                    return;
                }
                window.appearance.setTheme(select.value);
                this.refresh();
            });

            $('appearance-customise').addEventListener('click', () => {
                const hidden = editor.classList.toggle('hidden');
                if (!hidden && !$('appearance-theme-json').value.trim()) {
                    $('appearance-theme-json').value = window.appearance.exportCurrentTheme();
                }
            });

            $('appearance-theme-apply').addEventListener('click', () => {
                const err = $('appearance-theme-error');
                const result = window.appearance.saveCustomTheme($('appearance-theme-json').value);
                if (!result.ok) {
                    if (result.errorKey) {
                        window.setI18nText(err, result.errorKey, result.errorVars);
                    } else {
                        err.textContent = result.error;
                    }
                    return;
                }
                err.removeAttribute('data-i18n');
                err.removeAttribute('data-i18n-vars');
                err.textContent = '';
                this.refresh();
            });

            $('appearance-theme-revert').addEventListener('click', () => {
                $('appearance-theme-json').value = window.appearance.exportCurrentTheme();
                const err = $('appearance-theme-error');
                err.removeAttribute('data-i18n');
                err.removeAttribute('data-i18n-vars');
                err.textContent = '';
            });

            $('appearance-css-apply').addEventListener('click', () => {
                const value = $('appearance-custom-css-input').value;
                window.appearance.setCustomCss(value);
                // If the app rolled it back, it now lives in quarantine and the
                // box should show it (so the user can fix the offending line);
                // if it applied cleanly, any earlier quarantine is stale.
                const quarantined = window.appearance.getQuarantinedCss();
                if (quarantined && quarantined === value) {
                    this._showCssError();
                } else {
                    window.appearance.clearQuarantinedCss();
                    this._clearCssError();
                }
            });
        }

        _refreshTheme() {
            $('appearance-theme').value = window.appearance.getTheme();
            // The rolled-back CSS, if any, is what the user needs to see and fix.
            const quarantined = window.appearance.getQuarantinedCss();
            $('appearance-custom-css-input').value =
                quarantined || window.appearance.getCustomCss();
            if (quarantined) this._showCssError(); else this._clearCssError();
        }

        _showCssError() {
            const el = $('appearance-css-error');
            if (!el) return;
            window.setI18nText(el, 'appearance.cssRolledBack');
            el.hidden = false;
            // Open the Advanced section so the message is not buried.
            const details = el.closest('details');
            if (details) details.open = true;
        }

        _clearCssError() {
            const el = $('appearance-css-error');
            if (el) {
                el.removeAttribute('data-i18n');
                el.removeAttribute('data-i18n-vars');
                el.textContent = '';
                el.hidden = true;
            }
        }

        /* ---------------------------- language --------------------------- */

        _wireLanguage() {
            const drafts = $('appearance-show-drafts');
            if (drafts) {
                drafts.addEventListener('change', async () => {
                    window.i18n.setShowDrafts(drafts.checked);
                    // Turning it off while a draft is active would leave the user
                    // in a locale the picker no longer lists, so re-resolve.
                    const pref = window.i18n.getPreference();
                    await window.i18n.activate(
                        pref === 'auto' ? window.i18n.resolve() : window.i18n.resolve(pref));
                    this._refreshLanguage();
                });
            }
            $('appearance-language').addEventListener('change', async (e) => {
                const code = e.target.value;
                window.i18n.setPreference(code);
                await window.i18n.activate(code === 'auto' ? window.i18n.resolve() : code);
            });
        }

        _refreshLanguage() {
            const select = $('appearance-language');
            if (!window.i18n) return;

            const detected = window.i18n.detected();
            const detectedName = window.i18n.localeInfo(detected).endonym;

            select.innerHTML = '';
            const autoOpt = document.createElement('option');
            autoOpt.value = 'auto';
            autoOpt.textContent = window.t('appearance.languageDetectValue', { language: detectedName });
            select.appendChild(autoOpt);

            for (const locale of window.i18n.available()) {
                const opt = document.createElement('option');
                opt.value = locale.code;
                // Partial locales say so, so choosing one is an informed decision
                // rather than a surprise half-English interface.
                const pct = Math.round(locale.completeness * 100);
                // An unreviewed translation says so in the picker. Someone who
                // opted in to see drafts still needs to know which ones they are.
                if (locale.draft) {
                    opt.textContent = window.t('appearance.languageDraft',
                        { language: locale.endonym, percent: pct });
                } else if (locale.partial) {
                    opt.textContent = window.t('appearance.languagePartial',
                        { language: locale.endonym, percent: pct });
                } else {
                    opt.textContent = locale.endonym;
                }
                select.appendChild(opt);
            }

            const drafts = $('appearance-show-drafts');
            if (drafts) drafts.checked = window.i18n.showDrafts();

            select.value = window.i18n.getPreference();
        }

        /* ----------------------------- refresh --------------------------- */

        refresh() {
            this._refreshTopMargin();
            this._refreshButtonScale();
            this._refreshTheme();
            this._refreshLanguage();
        }
    }

    const ui = new AppearanceUI();
    window.appearanceUI = ui;

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => ui.init(), { once: true });
    } else {
        ui.init();
    }
})();
