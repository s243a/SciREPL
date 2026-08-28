/**
 * completion_surface.js — provider-neutral completion UI for plain textareas.
 *
 * The textarea remains the sole source of truth.  The mirror is presentation
 * only, and a provider result is applied only while the complete editor
 * snapshot (value, UTF-16 selection, context, and revision) still matches.
 */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.CompletionSurface = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    function stableContext(value) {
        const context = value && typeof value === 'object' ? value : {};
        const ordered = {};
        for (const key of Object.keys(context).sort()) ordered[key] = context[key];
        return JSON.stringify(ordered);
    }

    function validSuggestion(value) {
        return value && typeof value.text === 'string' && value.text.length > 0
            && value.range && Number.isSafeInteger(value.range.start)
            && Number.isSafeInteger(value.range.end)
            && value.range.start >= 0 && value.range.end >= value.range.start;
    }

    let generatedEditorId = 0;

    class CompletionController {
        constructor(options = {}) {
            this.providers = [];
            this.surfaces = new Set();
            this.enabled = typeof options.enabled === 'function' ? options.enabled : () => true;
        }

        registerProvider(provider) {
            if (!provider || typeof provider.suggest !== 'function') {
                throw new TypeError('completion provider must implement suggest(snapshot, options)');
            }
            this.providers.push(provider);
            this.providers.sort((a, b) => (a.priority || 0) - (b.priority || 0));
            return () => {
                const index = this.providers.indexOf(provider);
                if (index !== -1) this.providers.splice(index, 1);
            };
        }

        attach(textarea, options = {}) {
            if (!textarea) throw new TypeError('completion surface requires a textarea');
            const existing = [...this.surfaces].find((surface) => surface.textarea === textarea);
            if (existing) return existing;
            const surface = new TextareaCompletionSurface(this, textarea, options);
            this.surfaces.add(surface);
            surface.request('automatic');
            return surface;
        }

        detach(textarea) {
            const surface = [...this.surfaces].find((item) => item.textarea === textarea);
            if (surface) surface.destroy();
        }

        refreshAll() {
            for (const surface of this.surfaces) surface.refresh();
        }

        dismissAll() {
            for (const surface of this.surfaces) surface.dismiss();
        }

        destroyWithin(root) {
            if (!root) return;
            for (const surface of [...this.surfaces]) {
                if (root.contains(surface.textarea)) surface.destroy();
            }
        }

        async suggest(snapshot, trigger, signal) {
            if (!this.enabled()) return null;
            for (const provider of this.providers) {
                if (signal?.aborted) return null;
                if (trigger === 'automatic' && provider.automatic === false) continue;
                const suggestion = await provider.suggest(snapshot, { trigger, signal });
                if (signal?.aborted) return null;
                if (suggestion) return suggestion;
            }
            return null;
        }
    }

    class TextareaCompletionSurface {
        constructor(controller, textarea, options) {
            this.controller = controller;
            this.textarea = textarea;
            this.options = options;
            this.revision = 0;
            this.generation = 0;
            this.composing = false;
            this.destroyed = false;
            this.suggestion = null;
            this.requestAbort = null;
            this.layoutRequestFrame = null;
            this.dismissedFingerprint = null;
            if (!textarea.id) {
                textarea.id = 'completion-editor-' + (++generatedEditorId);
                this.generatedTextareaId = true;
            }
            this.previousAriaAutocomplete = textarea.getAttribute('aria-autocomplete');
            textarea.setAttribute('aria-autocomplete', 'inline');

            this._mountMirror();
            this._mountAcceptButton();
            this._bind();
        }

        _mountMirror() {
            const textarea = this.textarea;
            const parent = textarea.parentNode;
            this.wrapper = document.createElement('div');
            this.wrapper.className = 'completion-editor completion-editor-' + (this.options.surface || 'cell');
            parent.insertBefore(this.wrapper, textarea);
            this.wrapper.appendChild(textarea);

            // Do not use <pre>: legacy cell/source code deliberately queries
            // `inputCard.querySelector('pre')`. A presentation mirror must
            // never impersonate the authoritative source node and be rewritten
            // by highlighting, VFS, search/replace, or import paths.
            this.mirror = document.createElement('div');
            this.mirror.className = 'completion-ghost';
            this.mirror.setAttribute('aria-hidden', 'true');
            this.mirrorPrefix = document.createElement('span');
            this.mirrorPrefix.className = 'completion-ghost-prefix';
            this.mirrorSuffix = document.createElement('span');
            this.mirrorSuffix.className = 'completion-ghost-suffix';
            this.mirror.append(this.mirrorPrefix, this.mirrorSuffix);
            this.wrapper.appendChild(this.mirror);
            this._syncMirrorMetrics();

            if (typeof ResizeObserver === 'function') {
                this.resizeObserver = new ResizeObserver(() => {
                    this._syncMirrorMetrics();
                    this._scheduleLayoutRequest();
                });
                this.resizeObserver.observe(textarea);
            }
        }

        _syncMirrorMetrics() {
            if (this.destroyed || !this.mirror) return;
            const style = getComputedStyle(this.textarea);
            const copied = [
                'fontFamily', 'fontSize', 'fontStyle', 'fontWeight', 'fontVariant',
                'fontStretch', 'fontSizeAdjust', 'fontKerning', 'fontFeatureSettings',
                'fontVariationSettings', 'lineHeight', 'letterSpacing', 'wordSpacing',
                'textIndent', 'textAlign', 'textTransform', 'textRendering',
                'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
                'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
                'borderTopStyle', 'borderRightStyle', 'borderBottomStyle', 'borderLeftStyle',
                'boxSizing', 'tabSize', 'whiteSpace', 'wordBreak', 'overflowWrap',
                'lineBreak', 'hyphens', 'direction', 'unicodeBidi'
            ];
            for (const property of copied) this.mirror.style[property] = style[property];
            this.mirror.style.width = this.textarea.offsetWidth + 'px';
            this.mirror.style.height = this.textarea.offsetHeight + 'px';
            this._syncScroll();
        }

        _mountAcceptButton() {
            const host = this.options.acceptHost || this.wrapper;
            this.acceptHost = host;
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'completion-accept-btn';
            if (host === this.wrapper) button.classList.add('completion-accept-overlay');
            button.hidden = true;
            button.setAttribute('aria-controls', this.textarea.id || '');
            button.setAttribute('aria-keyshortcuts', 'Tab');
            button.setAttribute('data-i18n', 'autocomplete.accept');
            button.setAttribute('data-i18n-aria-label', 'autocomplete.acceptLocalAria');
            button.textContent = 'Accept';
            button.setAttribute('aria-label', 'Accept local completion');
            if (this.options.acceptBefore && this.options.acceptBefore.parentNode === host) {
                host.insertBefore(button, this.options.acceptBefore);
            } else {
                host.appendChild(button);
            }
            this.acceptButton = button;
            if (typeof window !== 'undefined' && window.setI18nText) {
                window.setI18nText(button, 'autocomplete.accept');
                window.setI18nAttr(button, 'aria-label', 'autocomplete.acceptLocalAria');
            }
        }

        _bind() {
            this._onInput = () => {
                this.revision++;
                this.dismissedFingerprint = null;
                if (!this.composing) this.request('automatic');
            };
            this._onKeydown = (event) => {
                if (this.composing || event.isComposing) {
                    // Do not let the app's existing Tab indentation, Escape
                    // cancel, or run shortcuts splice/run an uncommitted IME
                    // composition. Stop only the app listener: cancelling the
                    // browser default here would interfere with the IME itself.
                    if (event.key === 'Tab' || event.key === 'Escape'
                        || event.key === 'ArrowUp' || event.key === 'ArrowDown'
                        || (event.key === 'Enter' && (event.shiftKey || event.ctrlKey))) {
                        event.stopImmediatePropagation();
                    }
                    return;
                }
                if (event.key === 'Tab' && !event.shiftKey && !event.altKey
                    && !event.ctrlKey && !event.metaKey && this.suggestion) {
                    this.accept();
                    event.preventDefault();
                    event.stopImmediatePropagation();
                    return;
                }
                if (event.key === 'Escape' && this.suggestion) {
                    event.preventDefault();
                    event.stopImmediatePropagation();
                    this.dismiss(true);
                }
            };
            this._onKeyup = (event) => {
                if (!this.composing && ['ArrowLeft', 'ArrowRight', 'Home', 'End', 'ArrowUp', 'ArrowDown']
                    .includes(event.key)) this.request('automatic');
            };
            this._onSelect = () => { if (!this.composing) this.request('automatic'); };
            this._onSelectionChange = () => {
                if (document.activeElement === this.textarea && !this.composing) this.request('automatic');
            };
            this._onScroll = () => {
                this._syncScroll();
                if (!this.composing) this.request('automatic');
            };
            this._onCompositionStart = () => {
                this.composing = true;
                this.dismiss();
            };
            this._onCompositionEnd = () => {
                this.composing = false;
                // The committed input event is authoritative.  A zero-delay
                // fallback covers engines that commit before compositionend.
                setTimeout(() => {
                    if (!this.destroyed && !this.composing) this.request('automatic');
                }, 0);
            };
            this._onBlur = (event) => {
                if (event.relatedTarget !== this.acceptButton) this.dismiss();
            };
            this._onFocus = () => { if (!this.composing) this.request('automatic'); };
            this._onI18nChanged = () => {
                this._updateAcceptLabel();
                // A translated action can be materially wider. Re-evaluate
                // the whole visible proposal on the next frame so no stale
                // completion remains outside its card/viewport.
                this._scheduleLayoutRequest();
            };
            this._onViewportResize = () => {
                if (!this.composing) this.request('automatic');
            };

            this.textarea.addEventListener('input', this._onInput);
            this.textarea.addEventListener('keydown', this._onKeydown);
            this.textarea.addEventListener('keyup', this._onKeyup);
            this.textarea.addEventListener('select', this._onSelect);
            this.textarea.addEventListener('scroll', this._onScroll);
            this.textarea.addEventListener('compositionstart', this._onCompositionStart);
            this.textarea.addEventListener('compositionend', this._onCompositionEnd);
            this.textarea.addEventListener('blur', this._onBlur);
            this.textarea.addEventListener('focus', this._onFocus);
            document.addEventListener('selectionchange', this._onSelectionChange);
            document.addEventListener('i18n:changed', this._onI18nChanged);
            window.addEventListener('resize', this._onViewportResize);
            if (window.visualViewport) {
                window.visualViewport.addEventListener('resize', this._onViewportResize);
                window.visualViewport.addEventListener('scroll', this._onViewportResize);
            }
            this.scrollContainer = this.textarea.closest('#repl, .repl-container');
            if (this.scrollContainer) {
                this.scrollContainer.addEventListener('scroll', this._onScroll);
                if (this.resizeObserver) this.resizeObserver.observe(this.scrollContainer);
            }
            this.appBody = document.getElementById('app-body');
            if (this.appBody && this.resizeObserver) this.resizeObserver.observe(this.appBody);

            if (this.acceptButton) {
                this._onAcceptPointerDown = (event) => event.preventDefault();
                this._onAcceptClick = () => {
                    this.accept();
                    this.textarea.focus();
                };
                this.acceptButton.addEventListener('pointerdown', this._onAcceptPointerDown);
                this.acceptButton.addEventListener('mousedown', this._onAcceptPointerDown);
                this.acceptButton.addEventListener('click', this._onAcceptClick);
            }
        }

        context() {
            return typeof this.options.getContext === 'function'
                ? (this.options.getContext() || {}) : {};
        }

        snapshot() {
            const context = this.context();
            return Object.freeze({
                editorId: this.options.editorId || this.textarea.id || '',
                value: this.textarea.value,
                selectionStart: this.textarea.selectionStart,
                selectionEnd: this.textarea.selectionEnd,
                revision: this.revision,
                context: Object.freeze({ ...context }),
                contextKey: stableContext(context)
            });
        }

        _isCurrent(snapshot) {
            return !this.destroyed && !this.composing
                && this.revision === snapshot.revision
                && this.textarea.value === snapshot.value
                && this.textarea.selectionStart === snapshot.selectionStart
                && this.textarea.selectionEnd === snapshot.selectionEnd
                && stableContext(this.context()) === snapshot.contextKey;
        }

        async request(trigger = 'automatic') {
            const generation = ++this.generation;
            if (this.requestAbort) this.requestAbort.abort();
            const requestAbort = typeof AbortController === 'function' ? new AbortController() : null;
            this.requestAbort = requestAbort;
            this._clearVisual();
            if (this.destroyed || this.composing || !this.controller.enabled()
                || document.activeElement !== this.textarea || !this.textarea.isConnected) return;
            if (Number.isSafeInteger(this.options.maxAutomaticChars)
                && trigger === 'automatic'
                && this.textarea.value.length > this.options.maxAutomaticChars) return;
            const snapshot = this.snapshot();
            const fingerprint = this._fingerprint(snapshot);
            if (fingerprint === this.dismissedFingerprint) return;
            let suggestion = null;
            try {
                suggestion = await this.controller.suggest(
                    snapshot, trigger, requestAbort ? requestAbort.signal : undefined);
            } catch (error) {
                if (!requestAbort || !requestAbort.signal.aborted) {
                    console.warn('[completion] provider failed:', error);
                }
                return;
            }
            if (generation !== this.generation || !this._isCurrent(snapshot)
                || !validSuggestion(suggestion)) return;
            if (suggestion.range.start !== snapshot.selectionStart
                || suggestion.range.end !== snapshot.selectionEnd) return;
            this.suggestion = Object.freeze({ ...suggestion, snapshot });
            this.mirrorPrefix.textContent = snapshot.value;
            this.mirrorSuffix.textContent = suggestion.text;
            this.wrapper.classList.add('has-completion');
            this.wrapper.dataset.completionSource = suggestion.source || 'local';
            if (this.acceptButton) this.acceptButton.hidden = false;
            this._updateAcceptLabel();
            if (this.acceptHost) this.acceptHost.classList.add('completion-visible');
            this._syncMirrorMetrics();
            if (!this._presentationFits()) this._clearVisual();
        }

        refresh() {
            this.revision++;
            this.dismissedFingerprint = null;
            return this.request('automatic');
        }

        _fingerprint(snapshot) {
            return `${snapshot.revision}\u0000${snapshot.selectionStart}\u0000${snapshot.selectionEnd}`
                + `\u0000${snapshot.contextKey}\u0000${snapshot.value}`;
        }

        dismiss(remember = false) {
            if (remember && !this.destroyed) this.dismissedFingerprint = this._fingerprint(this.snapshot());
            this.generation++;
            if (this.requestAbort) this.requestAbort.abort();
            this.requestAbort = null;
            this._clearVisual();
        }

        _clearVisual() {
            this.suggestion = null;
            if (this.mirrorPrefix) this.mirrorPrefix.textContent = '';
            if (this.mirrorSuffix) this.mirrorSuffix.textContent = '';
            if (this.wrapper) {
                this.wrapper.classList.remove('has-completion');
                delete this.wrapper.dataset.completionSource;
            }
            if (this.acceptButton) this.acceptButton.hidden = true;
            this._updateAcceptLabel();
            if (this.acceptHost) this.acceptHost.classList.remove('completion-visible');
        }

        _updateAcceptLabel() {
            if (!this.acceptButton) return;
            const proposed = this.suggestion?.completionLabel || this.suggestion?.text;
            if (proposed) {
                const safe = String(proposed).replace(/\s+/g, ' ').slice(0, 160);
                const fallback = `Accept local code completion: ${safe}`;
                this.acceptButton.setAttribute('aria-label',
                    typeof window !== 'undefined' && typeof window.t === 'function'
                        ? window.t('autocomplete.acceptLocalAriaWithSuggestion', {
                            completion: safe
                        }) : fallback);
            } else if (typeof window !== 'undefined' && typeof window.t === 'function') {
                this.acceptButton.setAttribute('aria-label',
                    window.t('autocomplete.acceptLocalAria'));
            } else {
                this.acceptButton.setAttribute('aria-label', 'Accept local completion');
            }
            this.acceptButton.setAttribute('title', this.acceptButton.getAttribute('aria-label'));
        }

        _syncScroll() {
            if (!this.mirror) return;
            this.mirror.scrollTop = this.textarea.scrollTop;
            this.mirror.scrollLeft = this.textarea.scrollLeft;
        }

        _scheduleLayoutRequest() {
            if (this.destroyed || this.layoutRequestFrame !== null) return;
            this.layoutRequestFrame = requestAnimationFrame(() => {
                this.layoutRequestFrame = null;
                if (!this.destroyed && !this.composing) this.request('automatic');
            });
        }

        _presentationFits() {
            if (!this.suggestion || !this.mirrorSuffix || !this.acceptButton) return false;
            const mirrorRect = this.mirror.getBoundingClientRect();
            const range = document.createRange();
            range.selectNodeContents(this.mirrorSuffix);
            const suffixRects = [...range.getClientRects()];
            const epsilon = 1;
            if (!suffixRects.length || suffixRects.some((rect) =>
                rect.left < mirrorRect.left - epsilon || rect.right > mirrorRect.right + epsilon
                || rect.top < mirrorRect.top - epsilon || rect.bottom > mirrorRect.bottom + epsilon)) {
                return false;
            }

            const viewport = window.visualViewport;
            let visibleTop = viewport ? viewport.offsetTop : 0;
            let visibleLeft = viewport ? viewport.offsetLeft : 0;
            let visibleRight = visibleLeft + (viewport ? viewport.width : window.innerWidth);
            let visibleBottom = visibleTop + (viewport ? viewport.height : window.innerHeight);
            if (this.options.surface === 'cell') {
                const scroller = this.scrollContainer
                    || this.textarea.closest('#repl, .repl-container');
                const appBody = this.appBody || document.getElementById('app-body');
                for (const element of [scroller, appBody]) {
                    if (!element) continue;
                    const rect = element.getBoundingClientRect();
                    visibleTop = Math.max(visibleTop, rect.top);
                    visibleLeft = Math.max(visibleLeft, rect.left);
                    visibleRight = Math.min(visibleRight, rect.right);
                    visibleBottom = Math.min(visibleBottom, rect.bottom);
                }
            }
            const buttonRect = this.acceptButton.getBoundingClientRect();
            const suffixWithinVisibleBand = suffixRects.every((rect) =>
                rect.left >= visibleLeft - epsilon && rect.right <= visibleRight + epsilon
                && rect.top >= visibleTop - epsilon && rect.bottom <= visibleBottom + epsilon);
            return suffixWithinVisibleBand
                && visibleBottom - visibleTop + epsilon >= buttonRect.height
                && buttonRect.left >= visibleLeft - epsilon
                && buttonRect.right <= visibleRight + epsilon
                && buttonRect.top >= visibleTop - epsilon
                && buttonRect.bottom <= visibleBottom + epsilon;
        }

        accept() {
            const current = this.suggestion;
            if (!current || !this._isCurrent(current.snapshot)) {
                this.dismiss();
                return false;
            }
            const { start, end } = current.range;
            const caret = start + current.text.length;
            const value = this.textarea.value;
            let beforeInput;
            try {
                beforeInput = new InputEvent('beforeinput', {
                    bubbles: true,
                    cancelable: true,
                    inputType: 'insertText',
                    data: current.text
                });
            } catch (_) {
                beforeInput = new Event('beforeinput', { bubbles: true, cancelable: true });
            }
            if (!this.textarea.dispatchEvent(beforeInput)) return false;
            let inputDispatched = false;
            const markInput = () => { inputDispatched = true; };
            this.textarea.addEventListener('input', markInput, { once: true });
            this.textarea.focus({ preventScroll: true });
            this.textarea.selectionStart = start;
            this.textarea.selectionEnd = end;
            this.dismiss();

            // Chromium/WebView records execCommand('insertText') as a native
            // textarea edit transaction, so completion acceptance participates
            // in Undo/Redo.  Keep a deterministic standards-based fallback for
            // engines that do not expose it.
            let inserted = false;
            try {
                inserted = typeof document.execCommand === 'function'
                    && document.execCommand('insertText', false, current.text);
            } catch (_) { /* use the fallback below */ }
            if (!inserted) {
                if (typeof this.textarea.setRangeText === 'function') {
                    this.textarea.setRangeText(current.text, start, end, 'end');
                } else {
                    this.textarea.value = value.slice(0, start) + current.text + value.slice(end);
                    this.textarea.selectionStart = this.textarea.selectionEnd = caret;
                }
            }
            this.textarea.removeEventListener('input', markInput);
            if (!inputDispatched) {
                let event;
                try {
                    event = new InputEvent('input', {
                        bubbles: true, inputType: 'insertText', data: current.text
                    });
                } catch (_) {
                    event = new Event('input', { bubbles: true });
                }
                this.textarea.dispatchEvent(event);
            }
            return true;
        }

        destroy() {
            if (this.destroyed) return;
            this.dismiss();
            this.destroyed = true;
            this.textarea.removeEventListener('input', this._onInput);
            this.textarea.removeEventListener('keydown', this._onKeydown);
            this.textarea.removeEventListener('keyup', this._onKeyup);
            this.textarea.removeEventListener('select', this._onSelect);
            this.textarea.removeEventListener('scroll', this._onScroll);
            this.textarea.removeEventListener('compositionstart', this._onCompositionStart);
            this.textarea.removeEventListener('compositionend', this._onCompositionEnd);
            this.textarea.removeEventListener('blur', this._onBlur);
            this.textarea.removeEventListener('focus', this._onFocus);
            document.removeEventListener('selectionchange', this._onSelectionChange);
            document.removeEventListener('i18n:changed', this._onI18nChanged);
            window.removeEventListener('resize', this._onViewportResize);
            if (window.visualViewport) {
                window.visualViewport.removeEventListener('resize', this._onViewportResize);
                window.visualViewport.removeEventListener('scroll', this._onViewportResize);
            }
            if (this.scrollContainer) {
                this.scrollContainer.removeEventListener('scroll', this._onScroll);
            }
            if (this.acceptButton) {
                this.acceptButton.removeEventListener('pointerdown', this._onAcceptPointerDown);
                this.acceptButton.removeEventListener('mousedown', this._onAcceptPointerDown);
                this.acceptButton.removeEventListener('click', this._onAcceptClick);
                this.acceptButton.remove();
            }
            if (this.resizeObserver) this.resizeObserver.disconnect();
            if (this.layoutRequestFrame !== null) cancelAnimationFrame(this.layoutRequestFrame);
            if (this.wrapper && this.wrapper.parentNode) {
                this.wrapper.parentNode.insertBefore(this.textarea, this.wrapper);
                this.wrapper.remove();
            }
            if (this.generatedTextareaId) this.textarea.removeAttribute('id');
            if (this.previousAriaAutocomplete === null) {
                this.textarea.removeAttribute('aria-autocomplete');
            } else {
                this.textarea.setAttribute('aria-autocomplete', this.previousAriaAutocomplete);
            }
            this.controller.surfaces.delete(this);
        }
    }

    return { CompletionController, TextareaCompletionSurface, stableContext };
});
