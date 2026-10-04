/**
 * help_examples.js — one-tap Copy and Insert for the code examples in Help.
 *
 * Every example is a static `<pre data-example-lang="<id>"><code>` in
 * index.html. This module decorates each one with a small toolbar:
 *
 *   [Python]                         [⧉ Copy] [+ Insert]
 *
 *   - Copy puts the example's text on the clipboard (Clipboard API, with a
 *     hidden-textarea fallback for insecure contexts such as LAN-IP dev).
 *   - Insert appends the example as a NEW cell at the end of the active
 *     workbook via window.importCells(..., { autoExecute: false }). It never
 *     runs the cell: examples include %pip installs, runtime downloads, and a
 *     Lua line that deliberately overwrites cell 1.
 *
 * Help stays open after Insert, so the reader keeps their place and can add
 * several examples. A short "Added as cell N · Show · Undo" line offers the
 * way back: Show closes the dialog and focuses the new cell; Undo removes it
 * with the same window.deleteCell() the cell's ✕ button uses.
 *
 * Code is read with textContent and every node is built with createElement,
 * so nothing here goes through innerHTML. Labels carry their i18n key on the
 * element (setI18nText / setI18nAttr), so a locale switch re-translates an
 * already-decorated Help dialog.
 */
(function () {
    'use strict';

    const CONFIRM_MS = 2000;
    const NOTICE_MS = 8000;
    const MARKDOWN = 'markdown';
    // Language names are identifiers, never translated (www/i18n/README.md).
    const FALLBACK_LABELS = {
        python: 'Python', r: 'R', prolog: 'Prolog', bash: 'Bash',
        javascript: 'JavaScript', lua: 'Lua', typr: 'TypR',
        clojurescript: 'ClojureScript', markdown: 'Markdown',
    };

    function languageLabel(id) {
        const meta = window.FileIO && window.FileIO.LANGUAGE_META
            || (window.fileIO && window.fileIO.constructor && window.fileIO.constructor.LANGUAGE_META);
        const hit = Array.isArray(meta) ? meta.find((l) => l.id === id) : null;
        return (hit && hit.label) || FALLBACK_LABELS[id] || id;
    }

    function setText(el, key, vars) {
        if (typeof window.setI18nText === 'function') window.setI18nText(el, key, vars);
        else el.textContent = key;
        return el;
    }

    function setAria(el, key, vars) {
        if (typeof window.setI18nAttr === 'function') window.setI18nAttr(el, 'aria-label', key, vars);
        return el;
    }

    /** The runnable text of an example: its code, minus trailing whitespace. */
    function exampleCode(pre) {
        const code = pre.querySelector('code') || pre;
        return code.textContent.replace(/\s+$/, '');
    }

    function legacyCopy(text) {
        const area = document.createElement('textarea');
        area.value = text;
        area.setAttribute('readonly', '');
        area.setAttribute('aria-hidden', 'true');
        area.className = 'visually-hidden';
        const active = document.activeElement;
        document.body.appendChild(area);
        let ok = false;
        try {
            area.select();
            ok = Boolean(document.execCommand && document.execCommand('copy'));
        } catch (_) {
            ok = false;
        } finally {
            area.remove();
            if (active && typeof active.focus === 'function') {
                try { active.focus({ preventScroll: true }); } catch (_) { /* detached */ }
            }
        }
        return ok;
    }

    /** Copy text; resolves true on success. Never throws. */
    async function copyText(text) {
        try {
            if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
                await navigator.clipboard.writeText(text);
                return true;
            }
        } catch (_) { /* fall through to the legacy path */ }
        return legacyCopy(text);
    }

    function selectContents(node) {
        try {
            const range = document.createRange();
            range.selectNodeContents(node);
            const selection = window.getSelection();
            selection.removeAllRanges();
            selection.addRange(range);
        } catch (_) { /* best effort */ }
    }

    function liveRegionFor(node) {
        const scope = (node && node.closest('.modal-content')) || document.body;
        let region = scope.querySelector(':scope > .help-examples-live');
        if (!region) {
            region = document.createElement('div');
            region.className = 'help-examples-live visually-hidden';
            region.setAttribute('role', 'status');
            region.setAttribute('aria-live', 'polite');
            region.setAttribute('aria-atomic', 'true');
            scope.appendChild(region);
        }
        return region;
    }

    /**
     * Polite announcement. Clearing first makes a repeated message re-read.
     * The region deliberately carries no data-i18n: a later locale switch
     * would otherwise rewrite it and re-announce a stale message.
     */
    function announce(node, key, vars) {
        const region = liveRegionFor(node);
        region.textContent = '';
        region.removeAttribute('data-i18n');
        region.removeAttribute('data-i18n-vars');
        setTimeout(() => {
            region.textContent = typeof window.t === 'function' ? window.t(key, vars) : key;
        }, 50);
    }

    function flash(button, labelEl, confirmedKey, restoreKey) {
        clearTimeout(button._helpExampleTimer);
        button.classList.add('is-confirmed');
        setText(labelEl, confirmedKey);
        button._helpExampleTimer = setTimeout(() => {
            button.classList.remove('is-confirmed');
            setText(labelEl, restoreKey);
        }, CONFIRM_MS);
    }

    function makeButton(className, icon, labelKey, ariaKey, vars) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `vfs-btn help-example-btn ${className}`;
        const iconEl = document.createElement('span');
        iconEl.className = 'help-example-icon';
        iconEl.setAttribute('aria-hidden', 'true');
        iconEl.textContent = icon;
        const labelEl = document.createElement('span');
        labelEl.className = 'help-example-label';
        setText(labelEl, labelKey);
        button.append(iconEl, labelEl);
        setAria(button, ariaKey, vars);
        return { button, labelEl };
    }

    /** Close through the modal's own close control so its handlers run. */
    function closeOwningModal(node) {
        const modal = node.closest('.modal');
        if (!modal) return;
        const close = modal.querySelector('.modal-close');
        if (close) close.click();
        if (!modal.classList.contains('hidden')) modal.classList.add('hidden');
    }

    /*
     * An inserted cell is remembered as { cell, notebookId }: the cell OBJECT
     * (ids repeat across notebooks, so a numeric id alone could name some
     * other notebook's cell) and the notebook that received it. Show and Undo
     * act only when that exact object is in the open notebook's cell list.
     */
    function notebookManager() {
        const nm = window.notebookManager;
        return nm && typeof nm.getActiveNotebook === 'function' ? nm : null;
    }

    function activeNotebookId() {
        const nm = notebookManager();
        const active = nm && nm.getActiveNotebook();
        return active ? active.id : null;
    }

    function notebookIdOf(cell) {
        if ((window._cells || []).includes(cell)) return activeNotebookId();
        const nm = notebookManager();
        const all = nm && typeof nm.getNotebooks === 'function' ? nm.getNotebooks() : [];
        const owner = all.find((nb) => Array.isArray(nb.cells) && nb.cells.includes(cell));
        return owner ? owner.id : null;
    }

    /** True when the remembered cell is that same object in the open notebook. */
    function isLive(target) {
        if (!target || !target.cell) return false;
        if (target.notebookId !== null && activeNotebookId() !== target.notebookId) return false;
        return (window._cells || []).includes(target.cell);
    }

    /**
     * Make the target's notebook the open one through the app's own switch
     * path (as a tab click would). Returns whether the cell is now live.
     */
    function revealNotebook(target) {
        if (isLive(target)) return true;
        const nm = notebookManager();
        if (!target || target.notebookId === null || !nm || typeof nm.switchTo !== 'function') return false;
        const nb = typeof nm.getNotebook === 'function' ? nm.getNotebook(target.notebookId) : null;
        if (!nb || !Array.isArray(nb.cells) || !nb.cells.includes(target.cell)) return false;
        nm.switchTo(target.notebookId);
        return isLive(target);
    }

    function showCell(cell) {
        const card = cell && cell.inputCard;
        if (!card || !card.isConnected) return false;
        if (!card.hasAttribute('tabindex')) card.setAttribute('tabindex', '-1');
        try {
            card.scrollIntoView({ block: 'center' });
        } catch (_) {
            card.scrollIntoView();
        }
        try { card.focus({ preventScroll: true }); } catch (_) { card.focus(); }
        return true;
    }

    function decorate(pre) {
        if (pre.dataset.exampleReady === '1') return;
        const lang = String(pre.dataset.exampleLang || '').trim();
        if (!lang) return;
        pre.dataset.exampleReady = '1';
        if (!pre.hasAttribute('dir')) pre.setAttribute('dir', 'ltr');
        const vars = { language: languageLabel(lang) };

        const wrapper = document.createElement('div');
        wrapper.className = 'help-example';
        wrapper.dataset.exampleLang = lang;

        const bar = document.createElement('div');
        bar.className = 'help-example-bar';

        const chip = document.createElement('span');
        chip.className = `lang-badge lang-${lang} help-example-lang`;
        chip.setAttribute('dir', 'ltr');
        chip.textContent = vars.language;

        const actions = document.createElement('div');
        actions.className = 'help-example-actions';

        const copy = makeButton('help-example-copy', '⧉',
            'help.exampleCopy', 'help.exampleCopyAria', vars);
        actions.appendChild(copy.button);

        // importCells comes from app.js; the click handler checks for it, so
        // the button is never hidden just because of script order.
        const insert = makeButton('help-example-insert', '+',
            'help.exampleInsert', 'help.exampleInsertAria', vars);
        actions.appendChild(insert.button);

        bar.append(chip, actions);

        const notice = document.createElement('div');
        notice.className = 'help-example-notice';
        notice.hidden = true;
        const noticeText = document.createElement('span');
        noticeText.className = 'help-example-notice-text';
        const showBtn = document.createElement('button');
        showBtn.type = 'button';
        showBtn.className = 'help-example-link help-example-show';
        setText(showBtn, 'help.exampleShow');
        const undoBtn = document.createElement('button');
        undoBtn.type = 'button';
        undoBtn.className = 'help-example-link help-example-undo';
        setText(undoBtn, 'help.exampleUndo');
        notice.append(noticeText, showBtn, undoBtn);

        pre.parentNode.insertBefore(wrapper, pre);
        wrapper.append(bar, notice, pre);
        // A live region must already be in the tree before its text changes,
        // or screen readers may miss the first announcement.
        liveRegionFor(wrapper);

        let lastInsert = null;
        let noticeTimer = 0;
        const hideNotice = () => {
            clearTimeout(noticeTimer);
            notice.hidden = true;
            lastInsert = null;
        };
        const showNotice = (key, vars, withActions) => {
            setText(noticeText, key, vars);
            showBtn.hidden = !withActions;
            undoBtn.hidden = !withActions;
            notice.hidden = false;
            clearTimeout(noticeTimer);
            noticeTimer = setTimeout(hideNotice, NOTICE_MS);
        };

        copy.button.addEventListener('click', async () => {
            const ok = await copyText(exampleCode(pre));
            if (ok) {
                flash(copy.button, copy.labelEl, 'help.exampleCopied', 'help.exampleCopy');
                announce(wrapper, 'help.exampleCopied');
            } else {
                selectContents(pre.querySelector('code') || pre);
                announce(wrapper, 'help.exampleCopyFailed');
            }
        });

        insert.button.addEventListener('click', async () => {
            if (typeof window.importCells !== 'function') return;
            const code = exampleCode(pre);
            const def = lang === MARKDOWN
                ? { code, type: MARKDOWN, language: MARKDOWN }
                : { code, type: 'code', language: lang };
            insert.button.disabled = true;
            try {
                const created = await window.importCells([def], { autoExecute: false });
                const cell = Array.isArray(created) && created.length
                    ? created[created.length - 1]
                    : (window._cells || [])[(window._cells || []).length - 1];
                if (!cell) return;
                const added = { cell, notebookId: notebookIdOf(cell) };
                flash(insert.button, insert.labelEl, 'help.exampleAdded', 'help.exampleInsert');
                showNotice('help.exampleAddedAsCell', { cellId: String(cell.id) }, true);
                lastInsert = added;
                announce(wrapper, 'help.exampleAddedAsCell', { cellId: String(cell.id) });
            } finally {
                insert.button.disabled = false;
            }
        });

        showBtn.addEventListener('click', () => {
            const target = lastInsert;
            hideNotice();
            const live = revealNotebook(target);
            closeOwningModal(wrapper);
            if (!live || !showCell(target.cell)) {
                const helpBtn = document.getElementById('help-btn');
                if (helpBtn) helpBtn.focus();
                announce(document.body, 'help.exampleShowUnavailable');
            }
        });

        undoBtn.addEventListener('click', () => {
            const target = lastInsert;
            hideNotice();
            insert.button.focus();
            if (!target || typeof window.deleteCell !== 'function') return;
            // Never delete by id alone: the open notebook may hold a different
            // cell with the same number.
            const sameObject = isLive(target)
                && (window._cells || []).find((c) => c.id === target.cell.id) === target.cell;
            if (!sameObject) {
                showNotice('help.exampleUndoUnavailable', undefined, false);
                announce(wrapper, 'help.exampleUndoUnavailable');
                return;
            }
            window.deleteCell(target.cell.id);
            announce(wrapper, 'help.exampleRemoved');
        });
    }

    /** Decorate every tagged example below root (idempotent). */
    function init(root = document) {
        for (const pre of root.querySelectorAll('pre[data-example-lang]')) decorate(pre);
        // Announcements made after Help closes (Show could not find the cell).
        if (document.body) liveRegionFor(document.body);
    }

    window.helpExamples = { init, copyText, exampleCode };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => init(), { once: true });
    } else {
        init();
    }
})();
