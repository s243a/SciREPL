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
                    if (menu) menu.classList.add('hidden');
                    this.open();
                });
            }

            const closeBtn = this.modal.querySelector('.modal-close');
            if (closeBtn) closeBtn.addEventListener('click', () => this.close());
            this.modal.addEventListener('click', (e) => {
                if (e.target === this.modal) this.close();
            });

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

        open() {
            this.refresh();
            this.modal.classList.remove('hidden');
        }

        close() {
            this.modal.classList.add('hidden');
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
        }

        _refreshButtonScale() {
            const scale = window.appearance.getButtonScale();
            $('appearance-btn-scale').value = String(scale);
            $('appearance-btn-scale-value').textContent = `${Math.round(scale * 100)}%`;
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
                    err.textContent = result.error;
                    return;
                }
                err.textContent = '';
                this.refresh();
            });

            $('appearance-theme-revert').addEventListener('click', () => {
                $('appearance-theme-json').value = window.appearance.exportCurrentTheme();
                $('appearance-theme-error').textContent = '';
            });

            $('appearance-css-apply').addEventListener('click', () => {
                window.appearance.setCustomCss($('appearance-custom-css-input').value);
            });
        }

        _refreshTheme() {
            $('appearance-theme').value = window.appearance.getTheme();
            $('appearance-custom-css-input').value = window.appearance.getCustomCss();
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
