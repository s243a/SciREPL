/**
 * composer_collapse.js — reclaim notebook height on short landscape screens.
 *
 * The composer remains expanded by default.  A real button (not a gesture-only
 * affordance) lets the user collapse it. Once hidden, its restore button moves
 * into the header so the footer consumes no notebook height. An upward swipe
 * beginning near the bottom edge is a passive convenience: it never prevents
 * notebook scrolling, text selection, or horizontal edge gestures.
 * While the Android keyboard covers a short-landscape viewport, focusing an
 * existing cell editor temporarily collapses the new-cell composer as well.
 */
(function () {
    'use strict';

    const QUERY = '(orientation: landscape) and (max-height: 500px)';
    const AXIS_LOCK_PX = 8;
    const SWIPE_PX = 44;
    const VERTICAL_RATIO = 1.5;
    const BOTTOM_EDGE_PX = 72;
    const IME_MIN_INSET_PX = 80;

    class LandscapeComposer {
        constructor() {
            this.bar = document.getElementById('input-bar');
            this.content = document.getElementById('composer-content');
            this.toggle = document.getElementById('composer-toggle');
            this.restore = document.getElementById('composer-restore-btn');
            this.input = document.getElementById('code-input');
            this.query = window.matchMedia ? window.matchMedia(QUERY) : null;
            this.collapsed = false;
            this._gesture = null;
            this._suppressPointerClick = null;
            this._toggleHadFocus = false;
            this._edgeGesture = null;
            this._imeAutoCollapsed = false;
            this._imeSyncFrame = 0;
            this._vvTarget = null;
            this._viewportBaseline = 0;
            this._wasEligible = false;
            this._destroyed = false;
            if (this.bar && this.content && this.toggle && this.restore) this.init();
        }

        init() {
            this._onQueryChange = () => {
                this._applyEligibility();
                this._queueImeSync();
            };
            if (this.query) {
                if (this.query.addEventListener) this.query.addEventListener('change', this._onQueryChange);
                else if (this.query.addListener) this.query.addListener(this._onQueryChange);
            }

            this._onClick = (event) => {
                const pending = this._suppressPointerClick;
                this._suppressPointerClick = null;
                // A completed swipe is followed by a synthetic pointer click.
                // Consume that one event, but never discard keyboard or
                // assistive-technology activation (reported with detail 0).
                // Any later genuine tap has its own pointerdown, which clears
                // the marker first. This intentionally does not rely on the
                // click's pointerId: some Android WebViews report a different
                // id for the compatibility click than for its source pointer.
                if (pending && event.detail !== 0) return;
                this.setCollapsed(!this.collapsed);
            };
            this._onRestoreClick = () => {
                // Keep a keyboard/screen-reader user's focus on the paired
                // footer control. Focusing the textarea here would also summon
                // the Android keyboard merely from revealing the panel.
                this.setCollapsed(false, { focusToggle: true });
            };
            this._onPointerDown = (event) => this._pointerDown(event);
            this._onPointerMove = (event) => this._pointerMove(event);
            this._onPointerUp = (event) => this._pointerUp(event);
            this._onPointerCancel = () => { this._gesture = null; };
            this._onLanguageChange = () => this._refreshLabel();
            // Chromium can blur a focused element before delivering the media
            // query change caused by rotation. Remember the last real focus
            // target so that transition can still make an intentional handoff.
            this._onFocusIn = (event) => {
                this._toggleHadFocus = event.target === this.toggle
                    || event.target === this.restore;
                this._queueImeSync();
            };
            this._onFocusOut = () => this._queueImeSync();
            this._onViewportChange = () => this._queueImeSync();
            this._onEdgePointerDown = (event) => {
                if (event.pointerType === 'touch') return;
                if (event.button !== undefined && event.button !== 0) return;
                this._beginEdgeGesture(
                    event.clientX, event.clientY, event.pointerId, event.target, 'pointer');
            };
            this._onEdgePointerUp = (event) => {
                if (event.pointerType === 'touch') return;
                this._finishEdgeGesture(event.clientX, event.clientY, event.pointerId);
            };
            this._onEdgePointerCancel = (event) => {
                // Chrome emits pointercancel when a real touch becomes a
                // scroll gesture. Its matching TouchEvent stream still ends
                // normally, so do not clear a gesture owned by that stream.
                if (this._edgeGesture?.source !== 'touch'
                    && (this._edgeGesture?.id === undefined
                        || this._edgeGesture.id === event.pointerId)) {
                    this._edgeGesture = null;
                }
            };
            this._onEdgeTouchStart = (event) => {
                if (event.touches.length !== 1) {
                    this._edgeGesture = null;
                    return;
                }
                const touch = event.touches[0];
                this._beginEdgeGesture(
                    touch.clientX, touch.clientY, touch.identifier, event.target, 'touch');
            };
            this._onEdgeTouchEnd = (event) => {
                const gesture = this._edgeGesture;
                if (!gesture) return;
                let touch = null;
                for (let i = 0; i < event.changedTouches.length; i += 1) {
                    if (event.changedTouches[i].identifier === gesture.id) {
                        touch = event.changedTouches[i];
                        break;
                    }
                }
                if (touch) this._finishEdgeGesture(touch.clientX, touch.clientY, touch.identifier);
            };
            this._onEdgeTouchCancel = () => { this._edgeGesture = null; };

            this.toggle.addEventListener('click', this._onClick);
            this.restore.addEventListener('click', this._onRestoreClick);
            this.toggle.addEventListener('pointerdown', this._onPointerDown);
            this.toggle.addEventListener('pointermove', this._onPointerMove, { passive: false });
            this.toggle.addEventListener('pointerup', this._onPointerUp);
            this.toggle.addEventListener('pointercancel', this._onPointerCancel);
            document.addEventListener('i18n:changed', this._onLanguageChange);
            document.addEventListener('focusin', this._onFocusIn);
            document.addEventListener('focusout', this._onFocusOut);
            window.addEventListener('resize', this._onViewportChange);
            this._attachVisualViewportListeners();
            document.addEventListener('pointerdown', this._onEdgePointerDown, true);
            document.addEventListener('pointerup', this._onEdgePointerUp, true);
            document.addEventListener('pointercancel', this._onEdgePointerCancel, true);
            document.addEventListener('touchstart', this._onEdgeTouchStart,
                { capture: true, passive: true });
            document.addEventListener('touchend', this._onEdgeTouchEnd,
                { capture: true, passive: true });
            document.addEventListener('touchcancel', this._onEdgeTouchCancel,
                { capture: true, passive: true });

            this._applyEligibility();
            this._queueImeSync();
        }

        isEligible() {
            return !!(this.query && this.query.matches);
        }

        _applyEligibility() {
            const eligible = this.isEligible();
            if (eligible && !this._wasEligible) {
                this._viewportBaseline = Number(window.visualViewport?.height) || window.innerHeight;
            } else if (!eligible) {
                this._viewportBaseline = 0;
            }
            this._wasEligible = eligible;
            const toggleHadFocus = document.activeElement === this.toggle
                || document.activeElement === this.restore || this._toggleHadFocus;
            if (!eligible) {
                this.setCollapsed(false, { focus: false, force: true });
                // Rotation must not strand focus on a control that is about to
                // become hidden. The editor has just been restored and retains
                // its selection, making it the least surprising destination.
                if (toggleHadFocus && this.input) this.input.focus({ preventScroll: true });
            }
            this._syncControls(eligible);
            this.bar.classList.toggle('composer-collapse-enabled', eligible);
            this._refreshLabel();
            this._publishGeometry();
        }

        setCollapsed(collapsed, options = {}) {
            if (this._destroyed) return false;
            if (options.reason !== 'ime') this._imeAutoCollapsed = false;
            const next = !!collapsed;
            if (next && !this.isEligible() && !options.force) return false;

            const focusWasInside = this.content.contains(document.activeElement)
                || document.activeElement === this.toggle;
            if (next && window.mathMode && typeof window.mathMode.setOpen === 'function') {
                window.mathMode.setOpen(false);
            }
            this.collapsed = next;
            this.content.hidden = next;
            this.bar.classList.toggle('composer-collapsed', next);
            document.getElementById('app-header')?.classList.toggle(
                'composer-is-collapsed', next);
            this.toggle.setAttribute('aria-expanded', String(!next));
            this.restore.setAttribute('aria-expanded', String(!next));
            this._syncControls(this.isEligible());
            if (next && focusWasInside) this.restore.focus({ preventScroll: true });
            if (!next && options.focusToggle) {
                this.toggle.focus({ preventScroll: true });
            }
            this._refreshLabel();
            this._publishGeometry();
            document.dispatchEvent(new CustomEvent('scirepl:composer-visibility-changed', {
                detail: { collapsed: next, reason: options.reason || 'user' },
            }));
            return true;
        }

        _attachVisualViewportListeners() {
            if (this._vvTarget === window.visualViewport) return;
            if (this._vvTarget?.removeEventListener) {
                this._vvTarget.removeEventListener('resize', this._onViewportChange);
                this._vvTarget.removeEventListener('scroll', this._onViewportChange);
            }
            this._vvTarget = window.visualViewport || null;
            if (this._vvTarget?.addEventListener) {
                this._vvTarget.addEventListener('resize', this._onViewportChange);
                this._vvTarget.addEventListener('scroll', this._onViewportChange);
            }
        }

        _queueImeSync() {
            if (this._destroyed || this._imeSyncFrame) return;
            this._imeSyncFrame = requestAnimationFrame(() => {
                this._imeSyncFrame = 0;
                this._syncImeCollapse();
            });
        }

        _cellEditorHasFocus() {
            const active = document.activeElement;
            return active instanceof Element
                && active.matches('.card-input.editing .cell-editor')
                && active.offsetParent !== null;
        }

        _isNativeApp() {
            const capacitor = window.Capacitor;
            if (!capacitor) return false;
            if (typeof capacitor.isNativePlatform === 'function') {
                return !!capacitor.isNativePlatform();
            }
            if (typeof capacitor.getPlatform === 'function') {
                return capacitor.getPlatform() !== 'web';
            }
            return false;
        }

        _imeIsVisible() {
            const viewport = window.visualViewport;
            if (!viewport || !Number.isFinite(viewport.height)) return false;
            const baselineInset = Math.max(0, this._viewportBaseline - viewport.height);
            // A browser's URL bar can make visualViewport shorter than
            // innerHeight before editing begins, so web/PWA builds use the
            // learned baseline. Native Capacitor has no browser chrome; its
            // direct inset also catches rotation while the IME is already up.
            const nativeInset = this._isNativeApp()
                ? Math.max(0, window.innerHeight - viewport.height) : 0;
            return Math.max(baselineInset, nativeInset) >= IME_MIN_INSET_PX;
        }

        _syncImeCollapse() {
            if (this._destroyed) return;
            this._attachVisualViewportListeners();
            const eligible = this.isEligible();
            const viewportHeight = Number(window.visualViewport?.height);
            if (eligible && !this._imeAutoCollapsed && Number.isFinite(viewportHeight)) {
                this._viewportBaseline = Math.max(this._viewportBaseline, viewportHeight);
            }
            const imeVisible = eligible && this._imeIsVisible();
            const shouldAutoCollapse = imeVisible && this._cellEditorHasFocus();
            if (shouldAutoCollapse) {
                // Never claim a panel that the user had already hidden. That
                // state must remain hidden after the keyboard closes.
                if (!this.collapsed) {
                    this._imeAutoCollapsed = true;
                    this.setCollapsed(true, { reason: 'ime' });
                }
                return;
            }
            // If an Apply/Cancel action removes the editor before Android has
            // finished dismissing its keyboard, keep the footer out of the way
            // until the visual viewport actually recovers. Explicit Show is
            // still immediate because its ordinary setCollapsed() call clears
            // _imeAutoCollapsed first.
            if (this._imeAutoCollapsed && (!imeVisible || !eligible)) {
                this._imeAutoCollapsed = false;
                this.setCollapsed(false, { reason: 'ime', focus: false });
            }
        }

        _syncControls(eligible = this.isEligible()) {
            this.toggle.hidden = !eligible || this.collapsed;
            this.restore.hidden = !eligible || !this.collapsed;
            document.dispatchEvent(new CustomEvent('scirepl:header-controls-changed'));
        }

        _refreshLabel() {
            const key = this.collapsed ? 'composer.expand' : 'composer.collapse';
            const fallback = this.collapsed ? 'Show new-cell panel' : 'Hide new-cell panel';
            const text = (window.t && window.t(key)) || fallback;
            this.toggle.setAttribute('data-i18n-title', key);
            this.toggle.setAttribute('data-i18n-aria-label', key);
            this.toggle.setAttribute('title', text);
            this.toggle.setAttribute('aria-label', text);
            const label = this.toggle.querySelector('.composer-toggle-label');
            if (label) {
                label.setAttribute('data-i18n', key);
                label.textContent = text;
            }
            const glyph = this.toggle.querySelector('.composer-toggle-glyph');
            if (glyph) glyph.textContent = this.collapsed ? '⌃' : '⌄';
            this.restore.setAttribute('data-i18n-title', 'composer.expand');
            this.restore.setAttribute('data-i18n-aria-label', 'composer.expand');
            this.restore.setAttribute('title', (window.t && window.t('composer.expand'))
                || 'Show new-cell panel');
            this.restore.setAttribute('aria-label', (window.t && window.t('composer.expand'))
                || 'Show new-cell panel');
        }

        _edgeBottom() {
            const viewport = window.visualViewport;
            return viewport ? viewport.offsetTop + viewport.height : window.innerHeight;
        }

        _beginEdgeGesture(x, y, id, target, source) {
            this._edgeGesture = null;
            if (!this.collapsed || !this.isEligible()) return;
            if (document.querySelector('.modal:not(.hidden)')) return;
            const bottom = this._edgeBottom();
            if (y < bottom - BOTTOM_EDGE_PX || y > bottom + 1) return;
            // Keep the Android back/gesture edges free. The header button
            // remains the universal path.
            if (x < window.innerWidth * 0.2 || x > window.innerWidth * 0.8) return;
            if (!(target instanceof Element)
                || target.closest('button, a, input, textarea, select, [contenteditable="true"]')) return;
            const scroller = target.closest('#repl, .repl-container');
            if (!scroller || scroller.offsetParent === null) return;
            // Do not turn an ordinary upward notebook scroll into a layout
            // change. At the tail (including a notebook too short to scroll),
            // a further upward swipe is unambiguously a reveal gesture.
            if (scroller.scrollTop + scroller.clientHeight < scroller.scrollHeight - 2) return;
            this._edgeGesture = { x, y, id, source };
        }

        _finishEdgeGesture(x, y, id) {
            const gesture = this._edgeGesture;
            this._edgeGesture = null;
            if (!gesture || gesture.id !== id || !this.collapsed) return;
            const dx = x - gesture.x;
            const dy = y - gesture.y;
            if (dy <= -SWIPE_PX && Math.abs(dy) > VERTICAL_RATIO * Math.abs(dx)) {
                this.setCollapsed(false);
            }
        }

        _publishGeometry() {
            if (window.mathMode && typeof window.mathMode.publishPaletteSpace === 'function') {
                window.mathMode.publishPaletteSpace();
            }
        }

        _pointerDown(event) {
            if (!this.isEligible() || (event.button !== undefined && event.button !== 0)) return;
            // A real new pointer interaction is not the compatibility click
            // generated by the previous swipe.
            this._suppressPointerClick = null;
            this._gesture = {
                id: event.pointerId,
                x: event.clientX,
                y: event.clientY,
                axis: null,
            };
            if (this.toggle.setPointerCapture && event.pointerId !== undefined) {
                try { this.toggle.setPointerCapture(event.pointerId); } catch (_) { /* optional */ }
            }
        }

        _pointerMove(event) {
            const g = this._gesture;
            if (!g || (g.id !== undefined && event.pointerId !== g.id)) return;
            const dx = event.clientX - g.x;
            const dy = event.clientY - g.y;
            if (!g.axis && Math.hypot(dx, dy) >= AXIS_LOCK_PX) {
                g.axis = Math.abs(dy) > VERTICAL_RATIO * Math.abs(dx) ? 'vertical' : 'other';
            }
            if (g.axis === 'vertical') event.preventDefault();
        }

        _pointerUp(event) {
            const g = this._gesture;
            if (!g || (g.id !== undefined && event.pointerId !== g.id)) return;
            this._gesture = null;
            const dx = event.clientX - g.x;
            const dy = event.clientY - g.y;
            if (Math.abs(dy) < SWIPE_PX || Math.abs(dy) <= VERTICAL_RATIO * Math.abs(dx)) return;

            // Down closes; up opens.  A gesture that already describes the
            // current state is harmless and must not be followed by a click
            // that flips it in the opposite direction.
            this._suppressPointerClick = { id: event.pointerId };
            this.setCollapsed(dy > 0);
            event.preventDefault();
        }

        destroy() {
            if (this._destroyed) return;
            const toggleHadFocus = document.activeElement === this.toggle
                || document.activeElement === this.restore;
            this.setCollapsed(false, { focus: false, force: true });
            if (toggleHadFocus && this.input) this.input.focus({ preventScroll: true });
            if (this.query) {
                if (this.query.removeEventListener) this.query.removeEventListener('change', this._onQueryChange);
                else if (this.query.removeListener) this.query.removeListener(this._onQueryChange);
            }
            this.toggle.removeEventListener('click', this._onClick);
            this.restore.removeEventListener('click', this._onRestoreClick);
            this.toggle.removeEventListener('pointerdown', this._onPointerDown);
            this.toggle.removeEventListener('pointermove', this._onPointerMove);
            this.toggle.removeEventListener('pointerup', this._onPointerUp);
            this.toggle.removeEventListener('pointercancel', this._onPointerCancel);
            document.removeEventListener('i18n:changed', this._onLanguageChange);
            document.removeEventListener('focusin', this._onFocusIn);
            document.removeEventListener('focusout', this._onFocusOut);
            window.removeEventListener('resize', this._onViewportChange);
            if (this._vvTarget?.removeEventListener) {
                this._vvTarget.removeEventListener('resize', this._onViewportChange);
                this._vvTarget.removeEventListener('scroll', this._onViewportChange);
            }
            this._vvTarget = null;
            if (this._imeSyncFrame) cancelAnimationFrame(this._imeSyncFrame);
            this._imeSyncFrame = 0;
            document.removeEventListener('pointerdown', this._onEdgePointerDown, true);
            document.removeEventListener('pointerup', this._onEdgePointerUp, true);
            document.removeEventListener('pointercancel', this._onEdgePointerCancel, true);
            document.removeEventListener('touchstart', this._onEdgeTouchStart, true);
            document.removeEventListener('touchend', this._onEdgeTouchEnd, true);
            document.removeEventListener('touchcancel', this._onEdgeTouchCancel, true);
            this.toggle.hidden = true;
            this.restore.hidden = true;
            document.getElementById('app-header')?.classList.remove('composer-is-collapsed');
            this.bar.classList.remove('composer-collapse-enabled');
            this._gesture = null;
            this._suppressPointerClick = null;
            this._edgeGesture = null;
            this._imeAutoCollapsed = false;
            this._viewportBaseline = 0;
            this._wasEligible = false;
            this._destroyed = true;
        }
    }

    window.LandscapeComposer = LandscapeComposer;
    window.landscapeComposer = new LandscapeComposer();
})();
