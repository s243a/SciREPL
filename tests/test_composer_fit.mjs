// Playwright regression: the composer's Run button gives the code field room
// in long-label locales, and Appearance can force either form.
// Run the dev server first (PORT=8085 by default), then: node test_composer_fit.mjs
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const PORT = process.env.PORT || 8085;
const APP_URL = `http://localhost:${PORT}/index.html`;
const TIMEOUT = 60_000;
const LOCALES = ['en', 'ar', 'bn', 'de', 'es', 'fr', 'hi', 'id', 'ja', 'ko', 'pt-BR', 'ru', 'zh'];
const STRINGS = Object.fromEntries(LOCALES.map((l) => [l,
    JSON.parse(readFileSync(new URL(`../www/i18n/${l}.json`, import.meta.url), 'utf8')).strings]));

let failures = 0;
let checks = 0;
const check = (name, ok, detail = '') => {
    checks++;
    if (!ok) failures++;
    console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ': ' + String(detail).slice(0, 200) : ''}`);
};
const plain = (v) => String(v ?? '').replace(/[⁦-⁩‎‏؜▶]/g, '').replace(/\s+/g, ' ').trim();

const browser = await chromium.launch({ headless: true });

async function open(width, storage = {}) {
    const context = await browser.newContext({ viewport: { width, height: 780 }, hasTouch: true });
    await context.addInitScript((extra) => {
        localStorage.setItem('scirepl_privacy_accepted', '1');
        localStorage.setItem('scirepl_privacy_accepted_revision', '2026-09-network-guard-v1');
        localStorage.setItem('scirepl_onboarding_seen', '1');
        localStorage.setItem('scirepl_auto_download', '1');
        for (const [k, v] of Object.entries(extra)) localStorage.setItem(k, v);
        addEventListener('DOMContentLoaded', () => localStorage.setItem(
            'scirepl_whats_new_seen_version', window.KERNEL_CONFIG?.app?.version || ''), { once: true });
    }, storage);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(async () => {
        if (window.i18n?.init) await window.i18n.init();
        return window.__SCIREPL_APP_READY === true && !!window.composerFit;
    }, null, { timeout: 120_000 });
    await page.evaluate(() => { for (const m of document.querySelectorAll('.modal')) m.classList.add('hidden'); });
    return { context, page, errors };
}
const activate = async (page, locale) => {
    await page.evaluate(async (code) => { window.i18n.setPreference(code); await window.i18n.activate(code); }, locale);
    await page.waitForFunction((code) => document.documentElement.lang === code, locale, { timeout: TIMEOUT });
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
};
const state = (page) => page.evaluate(() => {
    const bar = document.getElementById('input-bar');
    const row = bar.querySelector('.input-row') || bar;
    const input = document.getElementById('code-input');
    const run = document.getElementById('run-btn');
    const r = run.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    const cs = getComputedStyle(run);
    return {
        compact: bar.classList.contains('run-compact'), mode: window.composerFit.getMode(),
        rowWidth: Math.round(row.getBoundingClientRect().width), inputWidth: Math.round(input.getBoundingClientRect().width),
        runWidth: Math.round(r.width), runHeight: Math.round(r.height), runText: run.textContent,
        labelPainted: parseFloat(cs.fontSize) > 0, hittable: !!hit && (hit === run || run.contains(hit)),
        threshold: Math.max(window.composerFit.MIN_INPUT_PX, Math.round(row.getBoundingClientRect().width * window.composerFit.MIN_INPUT_FRACTION)),
        overflow: document.documentElement.scrollWidth <= innerWidth,
    };
});

try {
    console.log('1. Auto: every locale keeps the code field usable at 360px');
    let { context, page, errors } = await open(360);
    for (const locale of LOCALES) {
        await activate(page, locale);
        const s = await state(page);
        const label = plain(STRINGS[locale]['inputControls.run']);
        check(`${locale}: code field ≥ ${s.threshold}px (got ${s.inputWidth}, compact=${s.compact})`,
            s.inputWidth >= s.threshold && s.overflow, JSON.stringify(s));
        check(`${locale}: Run is a 44px target with its translated name`, s.runWidth >= 44 && s.runHeight >= 44
            && s.hittable && plain(s.runText).includes(label), JSON.stringify({ text: s.runText, w: s.runWidth, h: s.runHeight }));
    }
    let en = (await activate(page, 'en'), await state(page));
    check('English at 360px does not need the compact form', !en.compact && en.labelPainted, JSON.stringify(en));
    let ru = (await activate(page, 'ru'), await state(page));
    check('Russian at 360px uses the compact form', ru.compact && !ru.labelPainted, JSON.stringify(ru));
    check('no page errors', errors.length === 0, errors.join(' | '));
    await context.close();

    console.log('2. Re-evaluates on viewport changes');
    ({ context, page, errors } = await open(412));
    await activate(page, 'ru');
    const wide = await state(page);
    await page.setViewportSize({ width: 320, height: 700 });
    await page.waitForFunction(() => document.getElementById('input-bar').classList.contains('run-compact'), null, { timeout: 5000 }).catch(() => {});
    const narrow = await state(page);
    await page.setViewportSize({ width: 800, height: 600 });
    await page.waitForFunction(() => !document.getElementById('input-bar').classList.contains('run-compact'), null, { timeout: 5000 }).catch(() => {});
    const landscape = await state(page);
    check('narrowing the viewport switches Russian to compact', narrow.compact && narrow.inputWidth >= narrow.threshold, JSON.stringify({ wide: wide.compact, narrow }));
    check('an 800px landscape viewport restores the label', !landscape.compact && landscape.labelPainted, JSON.stringify(landscape));
    await context.close();

    console.log('3. Appearance setting: Icon only / Always show the label');
    ({ context, page, errors } = await open(412));
    const select = await page.evaluate(() => {
        const s = document.getElementById('appearance-run-button');
        return s ? { options: [...s.options].map((o) => o.value), value: s.value, inModal: !!s.closest('#appearance-modal') } : null;
    });
    check('Appearance has a Run button row with auto/compact/full', select && select.options.join(',') === 'auto,compact,full' && select.value === 'auto' && select.inModal, JSON.stringify(select));
    await page.evaluate(() => {
        const s = document.getElementById('appearance-run-button');
        s.value = 'compact';
        s.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const forced = await state(page);
    check('Icon only applies in English at 412px and persists', forced.compact && forced.mode === 'compact'
        && await page.evaluate(() => localStorage.getItem('scirepl_run_button') === 'compact'), JSON.stringify(forced));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__SCIREPL_APP_READY === true && window.composerFit, null, { timeout: 120_000 });
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const afterReload = await state(page);
    check('the choice survives a reload', afterReload.compact && afterReload.mode === 'compact', JSON.stringify(afterReload));
    await page.evaluate(() => window.composerFit.setMode('full'));
    await page.setViewportSize({ width: 360, height: 740 });
    await activate(page, 'ru');
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const full = await state(page);
    check('Always show the label keeps the Russian label even at 360px', !full.compact && full.labelPainted && full.mode === 'full', JSON.stringify(full));
    await page.evaluate(() => window.composerFit.setMode('auto'));
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const backToAuto = await state(page);
    check('back to Auto restores the width rule', backToAuto.compact, JSON.stringify(backToAuto));
    const settingLabel = await page.evaluate(() => document.querySelector('label[for="appearance-run-button"]')?.textContent);
    check('the setting label is translated in Russian', settingLabel && settingLabel === STRINGS.ru['appearance.runButton'], settingLabel);
    check('no page errors', errors.length === 0, errors.join(' | '));
    await context.close();
} catch (error) {
    failures++;
    console.error('  [FAIL] suite aborted:', error);
} finally {
    await browser.close();
}
console.log(`\n${checks - failures}/${checks} composer-fit checks passed${failures ? `, ${failures} failed` : ''}.`);
process.exit(failures ? 1 : 0);
