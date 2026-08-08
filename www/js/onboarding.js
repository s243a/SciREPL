/**
 * onboarding.js — first-run tour.
 *
 * Points at the controls a new user cannot be expected to find: the menu, help,
 * how to edit a cell, and how to set the programming language for a new cell and
 * for one being edited. It opens with the display-language picker, so someone
 * whose language was detected wrongly can fix it before reading anything else.
 *
 * Two design constraints worth stating.
 *
 * "Language" means two different things in this app — the display language
 * (locale) and the programming language (kernel). The tour never uses the bare
 * word: it says "display language" and "programming language" throughout, and
 * the string ids reflect that. Conflating them is the obvious way to make a
 * tour that is meant to orient a newcomer do the opposite.
 *
 * The cell controls only exist once a cell does. Rather than fabricate notebook
 * state or run a kernel to manufacture one — which on first launch could
 * trigger a runtime download — those steps spotlight the real control when a
 * cell is present and fall back to a small inline illustration when it is not.
 * The tour never modifies the user's notebook.
 */

(function () {
    'use strict';

    const SEEN_KEY = 'scirepl_onboarding_seen';

    /**
     * A step targets a live element by selector. `optional` steps are skipped
     * when the target is absent; `mock` supplies an illustration to show
     * instead, so the explanation still happens.
     */
    const STEPS = [
        {
            id: 'language',
            titleKey: 'tour.language.title',
            bodyKey: 'tour.language.body',
            // Rendered inline rather than pointing at a control, because this is
            // the one step the user should be able to act on immediately.
            control: 'language',
        },
        {
            id: 'menu',
            target: '#menu-btn',
            titleKey: 'tour.menu.title',
            bodyKey: 'tour.menu.body',
        },
        {
            id: 'help',
            target: '#help-btn',
            titleKey: 'tour.help.title',
            bodyKey: 'tour.help.body',
        },
        {
            id: 'newCellLanguage',
            target: '#lang-selector',
            titleKey: 'tour.newCellLanguage.title',
            bodyKey: 'tour.newCellLanguage.body',
        },
        {
            id: 'editCell',
            target: '.cell-edit-btn',
            titleKey: 'tour.editCell.title',
            bodyKey: 'tour.editCell.body',
            optional: true,
            mock: '<span class="tour-mock-btn">✎</span>',
        },
        {
            id: 'editCellLanguage',
            target: '.cell-lang-switch',
            titleKey: 'tour.editCellLanguage.title',
            bodyKey: 'tour.editCellLanguage.body',
            optional: true,
            mock: '<span class="tour-mock-select">Py ▾</span>'
                + '<span class="tour-mock-btn">All→</span>',
        },
    ];

    class Onboarding {
        constructor() {
            this.index = 0;
            this.steps = [];
            this.el = null;
        }

        hasSeen() {
            return localStorage.getItem(SEEN_KEY) === '1';
        }

        markSeen() {
            localStorage.setItem(SEEN_KEY, '1');
        }

        /** Steps whose target exists, plus optional ones shown as illustrations. */
        _resolveSteps() {
            return STEPS.filter((s) => {
                if (!s.target) return true;                 // inline steps always show
                if (document.querySelector(s.target)) return true;
                return Boolean(s.mock);                     // absent but illustratable
            });
        }

        start() {
            this.steps = this._resolveSteps();
            this.index = 0;
            this._build();
            this._render();
        }

        /* ------------------------------ chrome ----------------------------- */

        _build() {
            if (this.el) this.el.remove();
            const el = document.createElement('div');
            el.id = 'tour-overlay';
            el.innerHTML = `
                <div id="tour-spotlight"></div>
                <div id="tour-card" role="dialog" aria-modal="true" aria-labelledby="tour-title">
                    <h3 id="tour-title"></h3>
                    <div id="tour-body"></div>
                    <div id="tour-control"></div>
                    <div id="tour-footer">
                        <span id="tour-progress"></span>
                        <div id="tour-actions">
                            <button id="tour-skip" class="tour-btn-quiet"></button>
                            <button id="tour-back" class="tour-btn-quiet"></button>
                            <button id="tour-next" class="tour-btn"></button>
                        </div>
                    </div>
                </div>`;
            document.body.appendChild(el);
            this.el = el;

            el.querySelector('#tour-skip').addEventListener('click', () => this.finish());
            el.querySelector('#tour-back').addEventListener('click', () => this.go(-1));
            el.querySelector('#tour-next').addEventListener('click', () => this.go(1));
            // Clicking the dimmed area moves on; Escape leaves.
            el.addEventListener('click', (e) => { if (e.target === el) this.go(1); });
            this._onKey = (e) => {
                if (e.key === 'Escape') this.finish();
                else if (e.key === 'ArrowRight' || e.key === 'Enter') this.go(1);
                else if (e.key === 'ArrowLeft') this.go(-1);
            };
            document.addEventListener('keydown', this._onKey);
            this._onResize = () => this._position();
            window.addEventListener('resize', this._onResize);
        }

        go(delta) {
            const next = this.index + delta;
            if (next < 0) return;
            if (next >= this.steps.length) return this.finish();
            this.index = next;
            this._render();
        }

        _render() {
            const step = this.steps[this.index];
            const t = window.t || ((k) => k);

            this.el.querySelector('#tour-title').textContent = t(step.titleKey);
            this.el.querySelector('#tour-body').textContent = t(step.bodyKey);
            this.el.querySelector('#tour-progress').textContent =
                t('tour.progress', { current: this.index + 1, total: this.steps.length });
            this.el.querySelector('#tour-skip').textContent = t('tour.skip');
            this.el.querySelector('#tour-back').textContent = t('tour.back');
            this.el.querySelector('#tour-next').textContent =
                this.index === this.steps.length - 1 ? t('tour.done') : t('tour.next');
            this.el.querySelector('#tour-back').style.visibility =
                this.index === 0 ? 'hidden' : 'visible';

            this._renderControl(step);
            this._position();
        }

        /** Inline content: either a live control or an illustration of one. */
        _renderControl(step) {
            const host = this.el.querySelector('#tour-control');
            host.innerHTML = '';
            host.className = '';

            if (step.control === 'language') {
                host.appendChild(this._languagePicker());
                return;
            }
            const targetMissing = step.target && !document.querySelector(step.target);
            if (targetMissing && step.mock) {
                host.className = 'tour-mock';
                host.innerHTML = step.mock;
            }
        }

        /**
         * A display-language picker, so a wrong detection can be corrected before
         * the user reads any further. Mirrors the Appearance dialog rather than
         * inventing a second source of truth.
         */
        _languagePicker() {
            const wrap = document.createElement('div');
            wrap.className = 'tour-language';
            const select = document.createElement('select');
            select.className = 'settings-select';
            select.id = 'tour-language-select';

            const i18n = window.i18n;
            if (!i18n) return wrap;

            const auto = document.createElement('option');
            auto.value = 'auto';
            auto.textContent = (window.t || ((k) => k))('appearance.languageDetectValue', {
                language: i18n.localeInfo(i18n.detected()).endonym,
            });
            select.appendChild(auto);

            for (const locale of i18n.available()) {
                const opt = document.createElement('option');
                opt.value = locale.code;
                opt.textContent = locale.endonym;
                select.appendChild(opt);
            }
            select.value = i18n.getPreference();

            select.addEventListener('change', async () => {
                i18n.setPreference(select.value);
                await i18n.activate(select.value === 'auto' ? i18n.resolve() : select.value);
                // Re-render so the tour itself switches language immediately —
                // the most direct proof to the user that the setting took.
                this._render();
            });

            wrap.appendChild(select);
            return wrap;
        }

        /* ---------------------------- positioning -------------------------- */

        _position() {
            const step = this.steps[this.index];
            const spotlight = this.el.querySelector('#tour-spotlight');
            const card = this.el.querySelector('#tour-card');
            const target = step.target ? document.querySelector(step.target) : null;

            if (!target) {
                // Nothing to point at: centre the card and hide the cutout.
                spotlight.style.display = 'none';
                card.style.left = '50%';
                card.style.top = '50%';
                card.style.transform = 'translate(-50%, -50%)';
                return;
            }

            const r = target.getBoundingClientRect();
            const pad = 6;
            spotlight.style.display = 'block';
            spotlight.style.left = `${r.left - pad}px`;
            spotlight.style.top = `${r.top - pad}px`;
            spotlight.style.width = `${r.width + pad * 2}px`;
            spotlight.style.height = `${r.height + pad * 2}px`;

            card.style.transform = 'none';
            const cardRect = card.getBoundingClientRect();
            const gap = 14;
            // Prefer below the target, flip above when there is no room.
            let top = r.bottom + gap;
            if (top + cardRect.height > window.innerHeight - 8) {
                top = Math.max(8, r.top - cardRect.height - gap);
            }
            let left = r.left + r.width / 2 - cardRect.width / 2;
            left = Math.max(8, Math.min(left, window.innerWidth - cardRect.width - 8));
            card.style.top = `${top}px`;
            card.style.left = `${left}px`;
        }

        /* ------------------------------ finish ----------------------------- */

        finish() {
            this.markSeen();
            document.removeEventListener('keydown', this._onKey);
            window.removeEventListener('resize', this._onResize);
            if (this.el) { this.el.remove(); this.el = null; }
        }

        /**
         * Run once, after the privacy prompt has been dealt with — a tour on top
         * of a consent dialog is both unreadable and presumptuous.
         */
        maybeStart() {
            if (this.hasSeen()) return;
            if (!localStorage.getItem('scirepl_privacy_accepted')) return;
            setTimeout(() => { if (!this.hasSeen()) this.start(); }, 600);
        }
    }

    const onboarding = new Onboarding();
    onboarding.STEPS = STEPS;
    window.onboarding = onboarding;

    /**
     * Replay entry points. Help is the natural home, but the tour is partly
     * *about* where Help is — so an entry only inside Help is circular for the
     * user who most needs it. The main menu carries one too.
     */
    const REPLAY_TRIGGERS = ['btn-show-tour', 'btn-show-tour-menu'];

    const ready = () => {
        for (const id of REPLAY_TRIGGERS) {
            const btn = document.getElementById(id);
            if (!btn) continue;
            btn.addEventListener('click', () => {
                // Whichever modal the trigger lives in has to get out of the way.
                for (const m of ['help-modal', 'menu-modal']) {
                    const el = document.getElementById(m);
                    if (el) el.classList.add('hidden');
                }
                onboarding.start();
            });
        }
        onboarding.maybeStart();
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', ready, { once: true });
    } else {
        ready();
    }
})();
