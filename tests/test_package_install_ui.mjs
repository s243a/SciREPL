/** Real app-owned dialog buttons; no DevTools/native JavaScript dialog responses. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const source = read('www/js/package_install_ui.js');
const css = read('www/css/style.css');
const locales = JSON.parse(read('www/i18n/manifest.json')).locales.map(item => item.code);
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const context = await browser.newContext({ viewport: { width: 360, height: 800 }, serviceWorkers: 'block' });
await context.route('**/*', route => route.abort('blockedbyclient'));
const page = await context.newPage();
let nativeDialogs = 0, checks = 0;
page.on('dialog', async dialog => { nativeDialogs++; await dialog.dismiss(); });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
function check(value, label) { assert.ok(value, label); checks++; }
async function choose(name = 'Synthetic package') {
    await page.evaluate(name => {
        delete window.choice;
        window.PackageInstallUI.choose({ name }).then(value => { window.choice = value; });
    }, name);
    await page.locator('#package-install-choice-modal').waitFor();
}
async function chosen(expected) {
    await page.waitForFunction(() => Object.prototype.hasOwnProperty.call(window, 'choice'));
    check(await page.evaluate(() => window.choice) === expected, `choice result ${expected}`);
    check(await page.locator('#package-install-choice-modal').count() === 0, 'choice modal removed, no queued dialog');
}
try {
    await page.setContent(`<html><head><style>${css}</style></head><body><button id="launcher">Synthetic launcher</button></body></html>`);
    await page.evaluate(() => {
        window.t = (key, vars = {}) => (window.localeStrings?.[key] || key).replace(/\{(\w+)\}/g, (whole, name) => vars[name] ?? whole);
    });
    await page.addScriptTag({ content: source });
    await page.addScriptTag({ content: read('www/js/android_back.js') });
    const english = JSON.parse(read('www/i18n/en.json')).strings;
    await page.evaluate(strings => { window.localeStrings = strings; }, english);
    await page.locator('#launcher').focus();
    await choose('<img src=x onerror="window.fixtureInjected=true">');
    check(await page.locator('#package-install-persistent').isChecked(), 'persistent installation is explicit default');
    check(await page.locator('#package-install-choice-modal img').count() === 0, 'untrusted package name is text, not HTML');
    check(await page.evaluate(() => !window.fixtureInjected && !Object.prototype.hasOwnProperty.call(window, 'choice')), 'choice remains pending until a real control is used');
    check(await page.evaluate(() => PackageInstallUI.choose({ name: 'Must not queue' })) === null, 're-entry fails closed instead of queuing');
    await page.locator('#package-install-cancel').click();
    await chosen(null);
    check(await page.evaluate(() => document.activeElement.id) === 'launcher', 'focus restored after cancellation');

    await choose();
    await page.locator('#package-install-confirm').click();
    await chosen('persistent');
    await choose();
    await page.locator('#package-install-session').check();
    await page.locator('#package-install-confirm').click();
    await chosen('session');
    await choose();
    await page.keyboard.press('Escape');
    await chosen(null);
    await choose();
    check(await page.evaluate(() => SciReplAndroidBack.dismissTopmostUi()) === 'modal', 'Android Back uses semantic cancellation');
    await chosen(null);

    // Focus is trapped at both ends, including when focus starts on a radio.
    await choose();
    await page.locator('#package-install-confirm').focus();
    await page.keyboard.press('Tab');
    check(await page.evaluate(() => document.activeElement.id) === 'package-install-choice-modal-close', 'Tab wraps inside choice dialog');
    await page.keyboard.press('Shift+Tab');
    check(await page.evaluate(() => document.activeElement.id) === 'package-install-confirm', 'Shift+Tab wraps inside choice dialog');
    await page.locator('#package-install-cancel').click(); await chosen(null);

    for (const locale of locales) {
        const catalogue = JSON.parse(read(`www/i18n/${locale}.json`));
        const strings = catalogue.strings;
        const required = Object.keys(english).filter(key => key.startsWith('packageInstall.'));
        for (const key of required) check(typeof strings[key] === 'string' && strings[key].length > 0, `${locale} has ${key}`);
        for (const key of required) {
            const parameters = value => [...value.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();
            check(JSON.stringify(parameters(strings[key])) === JSON.stringify(parameters(english[key])), `${locale} retains placeholders in ${key}`);
        }
        await page.evaluate(({ strings, dir, locale }) => {
            window.localeStrings = strings; document.documentElement.dir = dir; document.documentElement.lang = locale;
        }, { strings, dir: catalogue.__meta.dir, locale });
        for (const viewport of [{ width: 360, height: 800 }, { width: 800, height: 360 }]) {
            await page.setViewportSize(viewport);
            await choose('Synthetic package / حزمة تجريبية');
            check(await page.locator('#package-install-choice-modal label').first().innerText() === strings['packageInstall.persistent'], `${locale} visible persistent label translated`);
            check(await page.locator('#package-install-choice-modal label').nth(1).innerText() === strings['packageInstall.session'], `${locale} visible session label translated`);
            check(await page.locator('#package-install-choice-modal [role="dialog"]').evaluate(element => element.scrollWidth <= element.clientWidth + 1), `${locale} choice dialog no horizontal overflow`);
            await page.locator('#package-install-confirm').scrollIntoViewIfNeeded();
            const button = await page.locator('#package-install-confirm').boundingBox();
            check(button && button.x >= 0 && button.y >= 0 && button.x + button.width <= viewport.width + 1 && button.y + button.height <= viewport.height + 1,
                `${locale} install button stays within viewport`);
            await page.locator('#package-install-cancel').click(); await chosen(null);
            await page.evaluate(() => {
                window.conflictNoticeClosed = false;
                PackageInstallUI.notify({ code: 'PACKAGE_FILE_CONFLICT' }).then(() => { window.conflictNoticeClosed = true; });
            });
            await page.locator('#package-install-notice-modal').waitFor();
            check(await page.locator('#package-install-notice-modal p').innerText() === strings['packageInstall.conflict'],
                `${locale} file-conflict notice is translated`);
            check(await page.locator('#package-install-notice-modal [role="dialog"]').evaluate(element => element.scrollWidth <= element.clientWidth + 1),
                `${locale} file-conflict notice has no horizontal overflow`);
            await page.locator('#package-install-notice-close').click();
            await page.waitForFunction(() => conflictNoticeClosed);
            check(await page.locator('#package-install-notice-modal').count() === 0, `${locale} file-conflict notice closes with no queued dialog`);
        }
    }
    await page.setViewportSize({ width: 360, height: 800 });
    await page.evaluate(strings => { window.localeStrings = strings; document.documentElement.dir = 'ltr'; }, english);
    await page.evaluate(() => {
        window.fixtureRemovals = [];
        let records = [{ id: 'a'.repeat(64), name: '<img src=x onerror="window.fixtureInjected=true">', filename: 'fixture.zip', size: 1024 }];
        window.fixtureStore = {
            async list() { return records.slice(); },
            async remove(id) { fixtureRemovals.push(id); records = records.filter(item => item.id !== id); },
        };
        PackageInstallUI.manage(fixtureStore).then(value => { window.managed = value; });
    });
    await page.locator('[data-package-remove]').waitFor();
    check(await page.locator('#package-install-manage-modal img').count() === 0, 'saved metadata rendered as inert text');
    await page.locator('[data-package-remove]').click();
    check(await page.evaluate(() => fixtureRemovals.length) === 0, 'remove requires separate confirmation');
    await page.locator('#package-install-remove-cancel').click();
    await page.locator('[data-package-remove]').waitFor();
    check(await page.evaluate(() => fixtureRemovals.length) === 0, 'cancel deletion makes no store call');
    await page.locator('[data-package-remove]').click();
    await page.locator('#package-install-remove-confirm').click();
    await page.waitForFunction(() => fixtureRemovals.length === 1);
    await page.locator('#package-install-manage-close').click();
    check(await page.evaluate(() => managed.changed) === true, 'manager reports confirmed removal');
    check(await page.locator('#package-install-manage-modal').count() === 0, 'manager closes cleanly');

    await page.evaluate(() => {
        PackageInstallUI.manage({ async list() { throw { code: 'STORE_UNAVAILABLE' }; } }).then(value => { window.unavailableManaged = value; });
    });
    await page.waitForFunction(() => document.querySelector('#package-install-manage-modal [role="status"]')?.textContent.length > 0);
    check((await page.locator('#package-install-manage-modal [role="status"]').innerText()) === english['packageInstall.unavailable'], 'manager shows storage failure without native alert');
    await page.locator('#package-install-manage-close').click();
    await page.evaluate(() => { PackageInstallUI.notify({ code: 'ARCHIVE_STORE_FULL' }).then(value => { window.notified = value; }); });
    check(await page.locator('#package-install-notice-modal p').innerText() === english['packageInstall.full'], 'coded storage notice translated');
    await page.locator('#package-install-notice-close').click();
    check(await page.evaluate(() => notified) === true, 'notice completion requires real button');
    check(nativeDialogs === 0, 'no native JavaScript dialogs used');
    check(errors.length === 0, `no uncaught browser errors: ${errors.join('; ')}`);
    console.log(`Package installation UI: ${checks} checks passed across ${locales.length} locales and two orientations; no native dialogs.`);
} finally { await browser.close(); }
