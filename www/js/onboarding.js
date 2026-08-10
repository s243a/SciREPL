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

    /** A control worth handing focus to is attached, displayed and on-screen. */
    function isVisible(el) {
        if (!el || !document.contains(el)) return false;
        const cs = getComputedStyle(el);
        if (cs.visibility === 'hidden' || cs.display === 'none') return false;
        if (el.offsetParent === null && cs.position !== 'fixed') return false;
        // Inside a hidden modal (opacity/visibility) counts as not visible even
        // though the element's own box still has size.
        if (el.closest && el.closest('.modal.hidden')) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
    }

    /** Any of the app's blocking dialogs currently on screen? */
    const BLOCKING_MODALS = ['privacy-modal', 'runtime-download-modal'];
    function blockingModalVisible() {
        return BLOCKING_MODALS.some((id) => {
            const m = document.getElementById(id);
            return m && !m.classList.contains('hidden');
        });
    }

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
            return Boolean(localStorage.getItem(SEEN_KEY));
        }

        /**
         * `how` distinguishes a tour that was actually shown from one skipped
         * because the user plainly did not need it. Nothing branches on it
         * today; it is recorded so that a later "what's new" prompt can tell
         * the two populations apart instead of guessing.
         */
        markSeen(how) {
            localStorage.setItem(SEEN_KEY, how || '1');
        }

        /**
         * Has this install been used for real work already?
         *
         * Five of the six steps explain controls an existing user already knows.
         * Walking them through "this is the menu" on an upgrade is condescending
         * and reads as a regression, so established installs are grandfathered:
         * the tour is marked seen without being shown, and stays available from
         * the menu and from Help.
         *
         * Saved cells are the signal. Consent alone is not — a brand-new user
         * accepts the privacy prompt too, so it cannot tell the two apart.
         */
        _isEstablished() {
            for (const key of ['scirepl_session_v2', 'scirepl_session_v1']) {
                const raw = localStorage.getItem(key);
                if (!raw) continue;
                let s;
                try { s = JSON.parse(raw); } catch { continue; }
                if ((s.cells && s.cells.length) || (s.history && s.history.length)) return true;
                // Work lives in notebooks in v2; a session with several
                // notebooks, or one holding cells, is plainly not a first run.
                const books = Array.isArray(s.notebooks) ? s.notebooks : [];
                if (books.length > 1) return true;
                if (books.some((b) => b && Array.isArray(b.cells) && b.cells.length)) return true;
            }
            // Settings the user can only have reached through the menu.
            for (const key of ['scirepl_appearance_theme', 'scirepl_appearance_btn_scale',
                'scirepl_appearance_top_margin', 'scirepl_language', 'scirepl_enabled_languages']) {
                if (localStorage.getItem(key) !== null) return true;
            }
            return false;
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
            // Idempotent: a second start (menu entry, consent-close, a stray
            // double-invoke) must not stack a second overlay or a second set of
            // global listeners — that was how one ArrowRight advanced two steps.
            this._teardownChrome();
            if (this._pendingStart) { clearTimeout(this._pendingStart); this._pendingStart = null; }

            // Every start must watch for blocking dialogs — not just the first-run
            // path. A replay (menu/Help) by a seen or grandfathered user reaches
            // here without maybeStart(), so without this the tour would sit over a
            // runtime-download or privacy dialog at z-index 9000.
            this._watchConsentModal();

            this.steps = this._resolveSteps();
            this.index = 0;
            this._build();
            this._render();

            // If a blocker is already up when the replay starts, hide immediately
            // rather than flashing over it for a frame.
            if (blockingModalVisible()) {
                this.el.style.display = 'none';
                this.el.setAttribute('aria-hidden', 'true');
            }
        }

        /** Remove the overlay and every global listener it installed. */
        _teardownChrome() {
            if (this._onKey) document.removeEventListener('keydown', this._onKey);
            if (this._onResize) window.removeEventListener('resize', this._onResize);
            if (this._onVV && window.visualViewport) {
                window.visualViewport.removeEventListener('resize', this._onVV);
                window.visualViewport.removeEventListener('scroll', this._onVV);
            }
            this._onKey = this._onResize = this._onVV = null;
            if (this._resurfaceTimer) { clearTimeout(this._resurfaceTimer); this._resurfaceTimer = null; }
            if (this.el) { this.el.remove(); this.el = null; }
        }

        /* ------------------------------ chrome ----------------------------- */

        _build() {
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
                if (!this.el || this.el.style.display === 'none') return;
                if (e.key === 'Escape') { e.preventDefault(); return this.finish(); }
                if (e.key === 'Tab') return this._trapFocus(e);
                // Arrow keys belong to the language <select> while it has focus,
                // and Enter should activate the focused button rather than
                // always advancing.
                const onControl = e.target && e.target.closest
                    && e.target.closest('#tour-control');
                if (onControl) return;
                if (e.key === 'ArrowRight') { e.preventDefault(); this.go(1); }
                else if (e.key === 'ArrowLeft') { e.preventDefault(); this.go(-1); }
            };
            document.addEventListener('keydown', this._onKey);
            this._onResize = () => this._position();
            window.addEventListener('resize', this._onResize);
            // Mobile keyboards and browser chrome resize the visual viewport
            // without firing resize, which leaves the card stranded off-screen.
            if (window.visualViewport) {
                this._onVV = () => this._position();
                window.visualViewport.addEventListener('resize', this._onVV);
                window.visualViewport.addEventListener('scroll', this._onVV);
            }

            // Remember where focus was so it can be handed back on exit, and
            // move it into the dialog — a modal that leaves focus behind is
            // unusable by keyboard and invisible to a screen reader.
            this._returnFocusTo = document.activeElement;
            const first = el.querySelector('#tour-next');
            if (first) first.focus();
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
                // the most direct proof to the user that the setting took. The
                // re-render replaces this <select>, so focus would fall to
                // <body> and a forward Tab could escape the dialog; move it onto
                // the replacement.
                this._render();
                const fresh = this.el && this.el.querySelector('#tour-language-select');
                if (fresh) fresh.focus();
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

            // Use the visual viewport where it exists: on mobile the layout
            // viewport does not shrink for the on-screen keyboard or the URL
            // bar, and positioning against it puts the card off-screen.
            const vv = window.visualViewport;
            const vw = vv ? vv.width : window.innerWidth;
            const vh = vv ? vv.height : window.innerHeight;
            const margin = 8;

            card.classList.remove('tour-card-docked');
            card.style.maxWidth = `${Math.max(220, vw - margin * 2)}px`;
            card.style.maxHeight = `${Math.max(160, vh - margin * 2)}px`;

            if (!target) {
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
            // Never let the card be wider than the viewport it must fit inside.
            card.style.maxWidth = `${Math.max(220, vw - margin * 2)}px`;
            const cardRect = card.getBoundingClientRect();

            // If the card cannot fit above or below the target, dock it to the
            // bottom of the viewport rather than pushing it off-screen. The
            // spotlight still marks the control, so the association survives.
            const gap = 14;
            const below = vh - r.bottom - gap;
            const above = r.top - gap;
            if (cardRect.height > Math.max(below, above)) {
                card.classList.add('tour-card-docked');
                card.style.left = `${margin}px`;
                card.style.top = `${Math.max(margin, vh - cardRect.height - margin)}px`;
                card.style.maxWidth = `${vw - margin * 2}px`;
                return;
            }

            let top = below >= cardRect.height ? r.bottom + gap : r.top - cardRect.height - gap;
            top = Math.max(margin, Math.min(top, vh - cardRect.height - margin));
            let left = r.left + r.width / 2 - cardRect.width / 2;
            left = Math.max(margin, Math.min(left, vw - cardRect.width - margin));
            card.style.top = `${top}px`;
            card.style.left = `${left}px`;
        }

        /* ------------------------------ finish ----------------------------- */

        /** Keep Tab inside the dialog, cycling at both ends. */
        _trapFocus(e) {
            const focusable = [...this.el.querySelectorAll(
                'button, select, input, a[href], [tabindex]:not([tabindex="-1"])')]
                .filter((n) => !n.disabled && n.offsetParent !== null);
            if (!focusable.length) return;
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            const active = document.activeElement;
            if (e.shiftKey && (active === first || !this.el.contains(active))) {
                e.preventDefault(); last.focus();
            } else if (!e.shiftKey && active === last) {
                e.preventDefault(); first.focus();
            }
        }

        finish() {
            this.markSeen();
            if (this._pendingStart) { clearTimeout(this._pendingStart); this._pendingStart = null; }
            this._teardownChrome();
            // The blocking-modal observer is deliberately NOT disconnected here:
            // it is a singleton that must keep gating future replays. finish()
            // only tears down this run's overlay and listeners.
            // Hand focus back where it was, or somewhere sensible.
            const back = this._returnFocusTo;
            this._returnFocusTo = null;
            if (back && document.contains(back) && isVisible(back) && back.focus) back.focus();
            else {
                const menu = document.getElementById('menu-btn');
                if (menu && isVisible(menu)) menu.focus();
            }
        }

        /**
         * Run once, after the privacy prompt has been dealt with — a tour on top
         * of a consent dialog is both unreadable and presumptuous.
         */
        maybeStart() {
            if (this.hasSeen()) return;
            if (this._isEstablished()) return this.markSeen('grandfathered');

            // Consent is requested lazily, and only for runtimes fetched from a
            // CDN. On a build with Python bundled it may never be requested at
            // all — so gating the tour on scirepl_privacy_accepted meant a
            // genuine first-run user never saw it. What the tour actually has to
            // avoid is *covering* the consent dialog, which is a question about
            // the modal being on screen, not about the flag.
            this._watchConsentModal();
            if (blockingModalVisible()) return;   // the observer resumes on close
            this._pendingStart = setTimeout(() => {
                this._pendingStart = null;
                if (!this.hasSeen() && !blockingModalVisible()) this.start();
            }, 600);
        }

        _consentVisible() {
            return blockingModalVisible();
        }

        /**
         * The consent dialog always outranks the tour, whenever it appears —
         * including part-way through, which happens the first time a user runs
         * a cell that needs a CDN runtime. Hide the tour while it is up and
         * bring it back afterwards rather than stacking two modals.
         */
        _watchConsentModal() {
            if (this._consentObserver) return;
            this._consentObserver = new MutationObserver(() => {
                const blocked = blockingModalVisible();
                if (this.el) {
                    if (blocked) {
                        if (this._resurfaceTimer) {
                            clearTimeout(this._resurfaceTimer); this._resurfaceTimer = null;
                        }
                        this.el.style.display = 'none';
                        this.el.setAttribute('aria-hidden', 'true');
                        // Focus must not linger in a display:none subtree. Hand it
                        // to the dialog now on top.
                        if (this.el.contains(document.activeElement)) {
                            const top = BLOCKING_MODALS
                                .map((id) => document.getElementById(id))
                                .find((m) => m && !m.classList.contains('hidden'));
                            const target = top && (top.querySelector(
                                'button, [href], input, select, [tabindex]:not([tabindex="-1"])'));
                            if (target) target.focus();
                            else if (document.activeElement && document.activeElement.blur) {
                                document.activeElement.blur();
                            }
                        }
                    } else {
                        // Debounce the resurface: a privacy-to-runtime handoff
                        // hides one dialog a beat before the next appears, and
                        // flashing the tour (and moving focus into it) in that gap
                        // is jarring. Re-check after the gap; if a new blocker
                        // arrived, stay hidden.
                        if (this._resurfaceTimer) clearTimeout(this._resurfaceTimer);
                        this._resurfaceTimer = setTimeout(() => {
                            this._resurfaceTimer = null;
                            if (!this.el || blockingModalVisible()) return;
                            this.el.style.display = '';
                            this.el.setAttribute('aria-hidden', 'false');
                            this._position();
                            const next = this.el.querySelector('#tour-next');
                            if (next) next.focus();
                        }, 150);
                    }
                } else if (!blocked && !this.hasSeen()) {
                    if (this._pendingStart) return;   // already scheduled
                    this._pendingStart = setTimeout(() => {
                        this._pendingStart = null;
                        if (!this.hasSeen() && !blockingModalVisible()) this.start();
                    }, 400);
                }
            });
            for (const id of BLOCKING_MODALS) {
                const m = document.getElementById(id);
                if (m) this._consentObserver.observe(m, {
                    attributes: true, attributeFilter: ['class'],
                });
            }
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
