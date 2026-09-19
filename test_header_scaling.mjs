// Header controls under scaled text: boxes must follow glyphs (docs/HEADER_TEXT_ZOOM.md).
// Android WebView zooms px text with the system font scale but not px boxes; the
// header controls are sized in em so both grow together. Headless Chromium cannot
// emulate text zoom, so the Button size setting (which multiplies the same
// font-size) stands in for it: at scale s the geometry equals text zoom s.
// Run the dev server first (PORT=8085 by default), then: node test_header_scaling.mjs
import { chromium } from 'playwright';

const PORT = process.env.PORT || 8085;
const APP_URL = `http://localhost:${PORT}/index.html`;
let failures = 0, checks = 0;
const check = (name, ok, detail = '') => { checks++; if (!ok) failures++; console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ': ' + String(detail).slice(0, 240) : ''}`); };

const browser = await chromium.launch({ headless: true });
try {
    for (const width of [360, 412]) {
        const context = await browser.newContext({ viewport: { width, height: 780 } });
        await context.addInitScript(() => {
            localStorage.setItem('scirepl_privacy_accepted', '1');
            localStorage.setItem('scirepl_privacy_accepted_revision', '2026-09-network-guard-v1');
            localStorage.setItem('scirepl_onboarding_seen', '1');
            localStorage.setItem('scirepl_auto_download', '1');
            addEventListener('DOMContentLoaded', () => localStorage.setItem('scirepl_whats_new_seen_version', window.KERNEL_CONFIG?.app?.version || ''), { once: true });
        });
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', (e) => errors.push(String(e)));
        await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(async () => { if (window.i18n?.init) await window.i18n.init(); return window.__SCIREPL_APP_READY === true && !!window.appearance && !!window.notebookManager; }, null, { timeout: 120_000 });
        await page.evaluate(() => { for (const m of document.querySelectorAll('.modal')) m.classList.add('hidden'); });
        // A second workbook so the selector is present and can be squeezed.
        await page.evaluate(() => { try { window.notebookManager.createNotebook({ name: 'Second workbook with a long name' }); } catch (e) { /* older API */ } });
        console.log(`${width}px`);
        for (const scale of [1, 1.3, 1.5, 2]) {
            await page.evaluate((s) => window.appearance.setButtonScale(s), scale);
            await page.waitForTimeout(500);
            const r = await page.evaluate((scale) => {
                const ids = ['notebook-sidebar-toggle', 'notebook-selector-container', 'search-btn', 'math-mode-btn', 'tour-shortcut-btn', 'menu-btn', 'help-btn', 'status-badge'];
                const els = ids.map((id) => document.getElementById(id)).filter((e) => e && e.getBoundingClientRect().width > 0 && getComputedStyle(e).visibility !== 'hidden');
                // The selector container overflowing is the designed signal the shortcut
                // fitter reacts to, so only glyph controls and the badge are spill-checked.
                const rects = els.map((e) => ({ id: e.id, r: e.getBoundingClientRect(), spill: e.id !== 'notebook-selector-container' && (e.scrollWidth > e.clientWidth + 1 || e.scrollHeight > e.clientHeight + 1) }));
                const overlaps = [];
                for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
                    const a = rects[i].r, c = rects[j].r;
                    const ox = Math.min(a.right, c.right) - Math.max(a.left, c.left), oy = Math.min(a.bottom, c.bottom) - Math.max(a.top, c.top);
                    if (ox > 1 && oy > 1) overlaps.push(`${rects[i].id}×${rects[j].id}`);
                }
                const buttons = [...document.querySelectorAll('#app-header .icon-btn')].filter((b) => b.getBoundingClientRect().width > 0);
                const glyphInside = buttons.every((b) => { const box = b.getBoundingClientRect(); const range = document.createRange(); range.selectNodeContents(b); const ink = range.getBoundingClientRect(); return ink.width === 0 || (ink.left >= box.left - 1 && ink.right <= box.right + 1 && ink.top >= box.top - 1 && ink.bottom <= box.bottom + 1); });
                const sizes = buttons.map((b) => Math.round(b.getBoundingClientRect().width));
                const expected = Math.round(28 * scale);
                const badge = document.getElementById('status-badge');
                const selector = document.querySelector('.notebook-dropdown');
                const header = document.getElementById('app-header');
                return { overlaps, spilling: rects.filter((x) => x.spill).map((x) => x.id), sizes, expected,
                    badgeFits: !badge || badge.scrollWidth <= badge.clientWidth + 1,
                    selectorWidth: selector ? Math.round(selector.getBoundingClientRect().width) : null,
                    headerNoScrollX: header.scrollWidth <= header.clientWidth + 1, glyphInside };
            }, scale);
            check(`scale ${scale}: buttons are ${r.expected}px squares following the font`, r.sizes.length > 0 && r.sizes.every((s) => Math.abs(s - r.expected) <= 1), JSON.stringify(r.sizes));
            check(`scale ${scale}: no header control overlaps another`, r.overlaps.length === 0 && r.headerNoScrollX, JSON.stringify(r.overlaps));
            check(`scale ${scale}: glyphs stay inside their circles and the badge fits its pill`, r.glyphInside && r.badgeFits && r.spilling.length === 0, JSON.stringify({ spilling: r.spilling, badge: r.badgeFits }));
            // Selector width under squeeze is tracked separately (docs/HEADER_TEXT_ZOOM.md §4).
        }
        await page.evaluate(() => window.appearance.setButtonScale(1));
        check(`${width}px: no page errors`, errors.length === 0, errors.join(' | '));
        await context.close();
    }
} catch (error) {
    failures++; console.error('  [FAIL] suite aborted:', error);
} finally { await browser.close(); }
console.log(`\n${checks - failures}/${checks} header-scaling checks passed${failures ? `, ${failures} failed` : ''}.`);
process.exit(failures ? 1 : 0);
