/** Android archive installation choices. App-owned dialogs, never native confirm(). */
(function () {
    'use strict';
    let active = false;
    const fallback = {
        title: 'Install {name}',
        persistent: 'Keep installed on this device',
        session: 'This session only',
        edits: 'To keep edits to package support files, save a copy under a different path.',
        explanation: 'Notebooks are saved in either mode. Keeping the package also restores its supporting files offline after restarting; it does not run notebook cells.',
        manage: 'Saved packages',
        managedHelp: 'Removing a saved copy keeps existing notebooks and this session\'s files. Its supporting files will no longer be restored after restarting.',
        empty: 'No saved package archives.',
        remove: 'Remove saved copy',
        removeTitle: 'Remove saved package?',
        removeQuestion: 'Remove {name} from saved packages?',
        limits: 'Up to 32 packages, 32 MiB per archive and 96 MiB in total.',
        tooLarge: 'This package is too large to save. The archive limit is 32 MiB.',
        full: 'Saved package storage is full. Remove a saved copy or choose this session only.',
        corrupt: 'The package archive is invalid or damaged. Import it again from a trusted source.',
        unavailable: 'Saved package storage is unavailable. Nothing was installed. You can retry or explicitly choose this session only.',
        failed: 'The package operation failed. Nothing was silently changed to a session-only install.',
        conflict: 'This package would replace an existing file. Move or rename the conflicting file, or use a different package folder, then try again.',
        unsupported: 'This archive format cannot be kept installed. Use a ZIP or tar.gz package.',
        restoreFailed: 'Some saved packages could not be restored: {names}.',
        notice: 'Package installation',
    };
    function text(key, variables = {}) {
        const fullKey = `packageInstall.${key}`;
        const translated = typeof window.t === 'function' ? window.t(fullKey, variables) : fullKey;
        const value = typeof translated === 'string' && translated !== fullKey ? translated : fallback[key] || fullKey;
        return value.replace(/\{(\w+)\}/g, (whole, name) => Object.prototype.hasOwnProperty.call(variables, name) ? String(variables[name]) : whole);
    }
    function common(key, english) {
        const value = typeof window.t === 'function' ? window.t(key) : key;
        return typeof value === 'string' && value !== key ? value : english;
    }
    function node(tag, value, attributes = {}) {
        const element = document.createElement(tag);
        if (value !== null && value !== undefined) element.textContent = value;
        for (const [key, attribute] of Object.entries(attributes)) element.setAttribute(key, attribute);
        return element;
    }
    function action(label, id, handler, primary = false) {
        const button = node('button', label, { type: 'button', id });
        button.className = `vfs-btn${primary ? ' primary' : ''}`;
        button.style.cssText = 'min-height:44px;white-space:normal;overflow-wrap:anywhere';
        button.addEventListener('click', handler);
        return button;
    }
    function surface(id, title, onCancel) {
        const previousFocus = document.activeElement;
        const overlay = node('div', null, { id });
        overlay.className = 'modal';
        overlay.style.zIndex = '2147482000';
        const panel = node('div', null, { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': `${id}-title`, tabindex: '-1' });
        panel.className = 'modal-content modal-content-scroll';
        panel.style.cssText = 'width:min(92vw,620px);max-width:620px;max-height:85dvh;overflow:auto;box-sizing:border-box;overflow-wrap:anywhere';
        const heading = node('h2', title, { id: `${id}-title` });
        heading.style.paddingInlineEnd = '36px';
        const close = action('×', `${id}-close`, onCancel);
        close.className = 'modal-close';
        close.setAttribute('aria-label', common('common.close', 'Close'));
        close.setAttribute('data-android-back-cancel', '');
        panel.append(close, heading);
        overlay.append(panel);
        const focusable = () => [...panel.querySelectorAll('button, input, [tabindex="0"]')].filter(element => !element.disabled && !element.hidden);
        const keydown = event => {
            if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); onCancel(); return; }
            if (event.key !== 'Tab') return;
            const controls = focusable();
            if (!controls.length) { event.preventDefault(); panel.focus(); return; }
            const first = controls[0], last = controls[controls.length - 1];
            if (event.shiftKey && (document.activeElement === first || !panel.contains(document.activeElement))) {
                event.preventDefault(); last.focus();
            } else if (!event.shiftKey && (document.activeElement === last || !panel.contains(document.activeElement))) {
                event.preventDefault(); first.focus();
            }
        };
        document.addEventListener('keydown', keydown, true);
        document.body.append(overlay);
        panel.focus();
        return {
            panel, heading, close,
            destroy() {
                document.removeEventListener('keydown', keydown, true);
                overlay.remove();
                if (previousFocus?.isConnected && typeof previousFocus.focus === 'function') previousFocus.focus();
            },
        };
    }
    class PackageInstallUI {
        static choose({ name = '' } = {}) {
            // No queue: a second caller must not surface a stale authorization later.
            if (active || !document.body) return Promise.resolve(null);
            active = true;
            return new Promise(resolve => {
                let settled = false, modal;
                const finish = value => {
                    if (settled) return;
                    settled = true; modal?.destroy(); active = false; resolve(value);
                };
                try {
                    modal = surface('package-install-choice-modal', text('title', { name }), () => finish(null));
                    const help = node('p', text('explanation'), { id: 'package-install-explanation' });
                    modal.panel.setAttribute('aria-describedby', help.id);
                    const choices = node('fieldset');
                    choices.style.cssText = 'border:0;margin:0;padding:0;min-width:0';
                    for (const [value, label] of [['persistent', text('persistent')], ['session', text('session')]]) {
                        const wrapper = node('label');
                        wrapper.style.cssText = 'display:flex;align-items:center;gap:12px;min-height:48px;padding:8px 0;cursor:pointer';
                        const radio = node('input', null, { type: 'radio', name: 'package-install-mode', value, id: `package-install-${value}` });
                        radio.checked = value === 'persistent';
                        radio.style.cssText = 'flex:0 0 auto;width:20px;height:20px';
                        wrapper.append(radio, node('span', label)); choices.append(wrapper);
                    }
                    const buttons = node('div');
                    buttons.style.cssText = 'display:flex;flex-wrap:wrap;justify-content:flex-end;gap:12px;margin-top:18px';
                    const cancel = action(common('common.cancel', 'Cancel'), 'package-install-cancel', () => finish(null));
                    cancel.setAttribute('data-android-back-cancel', '');
                    const install = action(common('packageCatalog.install', 'Install'), 'package-install-confirm', () => {
                        const chosen = choices.querySelector('input:checked')?.value;
                        finish(chosen === 'persistent' || chosen === 'session' ? chosen : null);
                    }, true);
                    buttons.append(cancel, install);
                    modal.panel.append(help, choices, node('p', text('edits')), node('p', text('limits')), buttons);
                    choices.querySelector('input:checked').focus();
                } catch (_) { finish(null); }
            });
        }
        static message(error) {
            if (error?.code === 'RESTORE_FAILED') return text('restoreFailed', { names: error.names });
            const key = {
                ARCHIVE_TOO_LARGE: 'tooLarge', ARCHIVE_STORE_FULL: 'full',
                ARCHIVE_CORRUPT: 'corrupt', ARCHIVE_INVALID: 'corrupt', INVALID_ARCHIVE: 'corrupt',
                STORE_UNAVAILABLE: 'unavailable', ARCHIVE_UNSUPPORTED: 'unsupported',
                PACKAGE_FILE_CONFLICT: 'conflict',
            }[error?.code] || 'failed';
            return text(key);
        }
        static notify(error) {
            if (active || !document.body) return Promise.resolve(false);
            active = true;
            return new Promise(resolve => {
                let modal, settled = false;
                const finish = () => {
                    if (settled) return;
                    settled = true; modal?.destroy(); active = false; resolve(true);
                };
                try {
                    modal = surface('package-install-notice-modal', text('notice'), finish);
                    const body = node('p', PackageInstallUI.message(error));
                    const close = action(common('common.ok', 'OK'), 'package-install-notice-close', finish, true);
                    close.setAttribute('data-android-back-cancel', '');
                    modal.panel.append(body, close); close.focus();
                } catch (_) { finish(); }
            });
        }
        static manage(store) {
            if (active || !document.body) return Promise.resolve({ changed: false, busy: true });
            active = true;
            return new Promise(resolve => {
                let modal, changed = false, pending = false, settled = false, lastError = '';
                const finish = () => {
                    if (settled || pending) return;
                    settled = true; modal?.destroy(); active = false; resolve({ changed });
                };
                try {
                    modal = surface('package-install-manage-modal', text('manage'), finish);
                    const help = node('p', text('managedHelp'));
                    const list = node('div', null, { id: 'package-install-saved-list' });
                    const status = node('p', '', { role: 'status', 'aria-live': 'polite' });
                    const close = action(common('common.close', 'Close'), 'package-install-manage-close', finish);
                    close.setAttribute('data-android-back-cancel', '');
                    modal.panel.append(help, node('p', text('limits')), list, status, close);
                    const controls = enabled => { modal.close.disabled = !enabled; close.disabled = !enabled; };
                    const render = async () => {
                        pending = true; controls(false); list.replaceChildren(); status.textContent = lastError; lastError = '';
                        try {
                            const records = await store.list();
                            if (!records.length) list.append(node('p', text('empty')));
                            for (const record of records) {
                                const row = node('div');
                                row.style.cssText = 'border-top:1px solid var(--border-color,#ccc);padding:12px 0;display:flex;flex-wrap:wrap;align-items:center;gap:10px';
                                const info = node('span', `${record.name} — ${record.filename} (${(record.size / 1048576).toFixed(2)} MiB) · ${record.id.slice(0, 8)}`);
                                info.style.cssText = 'flex:1 1 160px;min-width:0;overflow-wrap:anywhere';
                                const remove = action(text('remove'), '', () => {
                                    if (pending) return;
                                    list.replaceChildren();
                                    list.append(node('h3', text('removeTitle')), node('p', text('removeQuestion', { name: record.name })));
                                    const cancel = action(common('common.cancel', 'Cancel'), 'package-install-remove-cancel', () => render());
                                    const confirm = action(text('remove'), 'package-install-remove-confirm', async () => {
                                        if (pending) return;
                                        pending = true; controls(false); cancel.disabled = true; confirm.disabled = true;
                                        try { await store.remove(record.id); changed = true; }
                                        catch (error) { lastError = PackageInstallUI.message(error); }
                                        finally { pending = false; await render(); }
                                    });
                                    list.append(cancel, confirm); cancel.focus();
                                });
                                remove.setAttribute('data-package-remove', record.id);
                                row.append(info, remove); list.append(row);
                            }
                        } catch (error) { status.textContent = PackageInstallUI.message(error); }
                        finally { pending = false; controls(true); }
                    };
                    void render();
                } catch (_) { pending = false; finish(); }
            });
        }
    }
    window.PackageInstallUI = PackageInstallUI;
})();
