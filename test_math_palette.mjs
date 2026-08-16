// Playwright regressions: Formula palette contexts, Markdown LaTeX insertion,
// footer layout invariants, and the Capacitor bottom-inset fallback.
// Run the dev server first: node server.js   (PORT=8085 by default)
// Set RUN_LIVE_CDN=1 to also run the %pip matplotlib same-cell image test
// (fetches real wheels from the Pyodide CDN — not part of normal CI).
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const PORT = process.env.PORT || 8085;
const APP_URL = `http://localhost:${PORT}/index.html`;

let failures = 0;
const check = (name, ok, detail = '') => {
    console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ': ' + detail : ''}`);
    if (!ok) failures++;
};

const browser = await chromium.launch({ headless: true });

async function freshPage(opts = {}) {
    const ctx = await browser.newContext({ viewport: opts.viewport || { width: 800, height: 800 } });
    const page = await ctx.newPage();
    await page.addInitScript((extra) => {
        localStorage.setItem('scirepl_privacy_accepted', '1');
        localStorage.setItem('scirepl_onboarding_seen', '1');
        for (const [k, v] of Object.entries(extra || {})) localStorage.setItem(k, v);
        addEventListener('DOMContentLoaded', () => localStorage.setItem(
            'scirepl_whats_new_seen_version', window.KERNEL_CONFIG?.app?.version || ''), { once: true });
    }, opts.storage || {});
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__SCIREPL_APP_READY === true, null, { timeout: 120000 });
    return page;
}
const enableFormula = (page) => page.evaluate(() => window.appearance.setShowFormulaShortcut(true));
const btnState = (page) => page.evaluate(() => {
    const b = document.getElementById('math-mode-btn');
    const p = document.getElementById('math-palette');
    return {
        hidden: b.classList.contains('lang-hidden') || b.classList.contains('header-shortcut-hidden'),
        paletteOpen: !p.classList.contains('hidden'),
        context: p.dataset.context,
    };
});

try {
    console.log('0. Static guard: every mandatory local script is in the app shell');
    {
        const html = readFileSync('www/index.html', 'utf8');
        const sw = readFileSync('www/sw.js', 'utf8');
        const shellStart = sw.indexOf('const APP_SHELL');
        const shellBlock = sw.slice(shellStart, sw.indexOf('];', shellStart));
        const scripts = [...html.matchAll(/<script src="(js\/[^"]+)"><\/script>/g)].map(m => m[1]);
        const missing = scripts.filter(src => !shellBlock.includes(`'./${src}'`));
        check('all index.html local scripts precached in APP_SHELL', scripts.length > 10 && missing.length === 0, missing.join());
    }

    console.log('1. Composer contexts drive the palette');
    let page = await freshPage();
    await enableFormula(page);
    check('Python context by default', (await btnState(page)).context === 'python');
    await page.click('#math-mode-btn');
    check('palette opens for Python', (await btnState(page)).paletteOpen);
    await page.selectOption('#lang-selector', 'r');
    await page.waitForTimeout(50);
    let st = await btnState(page);
    check('switching to R hides the control and closes the palette', st.hidden && !st.paletteOpen);
    await page.selectOption('#lang-selector', 'python');
    await page.waitForTimeout(50);
    check('back to Python restores the control', !(await btnState(page)).hidden);
    await page.click('#cell-type-toggle');
    await page.waitForTimeout(50);
    st = await btnState(page);
    check('Markdown cell type selects the LaTeX palette', !st.hidden && st.context === 'markdown');
    const rows = await page.evaluate(() => {
        const vis = [...document.querySelectorAll('#math-palette .math-row')]
            .filter(r => getComputedStyle(r).display !== 'none');
        return vis.map(r => r.dataset.context);
    });
    check('only markdown rows are visible in markdown context', rows.length === 2 && rows.every(c => c === 'markdown'), rows.join());
    await page.context().close();

    console.log('2. Programmatic changes cannot bypass synchronization');
    page = await freshPage({ storage: { scirepl_default_language: 'r' } });
    await enableFormula(page);
    check('saved non-Python default boots with Formula hidden', (await btnState(page)).hidden);
    await page.evaluate(() => {
        // simulate a programmatic path that only calls the central notifier
        document.getElementById('lang-selector').value = 'python';
        window.notifyComposerContextChanged();
    });
    check('central notifier resyncs after a silent value write', !(await btnState(page)).hidden);
    await page.evaluate(() => {
        document.getElementById('lang-selector').value = 'lua';
        window.notifyComposerContextChanged();
    });
    check('and hides again for a palette-less language', (await btnState(page)).hidden);
    await page.evaluate(() => window.fileIO && window.fileIO._rebuildLanguageDropdowns && window.fileIO._rebuildLanguageDropdowns());
    check('language/profile rebuild leaves the control consistent', (await btnState(page)).hidden);
    await page.context().close();

    console.log('3. Markdown LaTeX insertion');
    page = await freshPage();
    await enableFormula(page);
    await page.click('#cell-type-toggle');
    await page.click('#math-mode-btn');
    await page.click('#math-palette button[title="Fraction"]');
    let composer = await page.evaluate(() => ({
        v: document.getElementById('code-input').value,
        pos: document.getElementById('code-input').selectionStart,
    }));
    check('fraction inserts wrapped in $…$', composer.v === '$\\frac{}{}$', JSON.stringify(composer.v));
    check('caret lands inside the first argument', composer.v.slice(0, composer.pos).endsWith('\\frac{'), String(composer.pos));
    await page.click('#math-palette button[title="Square root"]');
    composer = await page.evaluate(() => document.getElementById('code-input').value);
    check('inserting INSIDE a math span does not nest delimiters',
        composer === '$\\frac{\\sqrt{}}{}$', JSON.stringify(composer));
    // escaped dollars are literal text, not delimiters
    await page.evaluate(() => {
        const i = document.getElementById('code-input');
        i.value = 'costs \\$5 today ';
        i.selectionStart = i.selectionEnd = i.value.length;
    });
    await page.click('#math-palette button[title="Square root"]');
    composer = await page.evaluate(() => document.getElementById('code-input').value);
    check('escaped \\$ does not open a math span (insert is wrapped)',
        composer === 'costs \\$5 today $\\sqrt{}$', JSON.stringify(composer));
    // explicit inline case: caret inside $x$
    await page.evaluate(() => {
        const i = document.getElementById('code-input');
        i.value = '$x$';
        i.selectionStart = i.selectionEnd = 2;   // between x and closing $
    });
    await page.click('#math-palette button[title="Superscript"]');
    composer = await page.evaluate(() => document.getElementById('code-input').value);
    check('caret inside $x$ inserts bare superscript', composer === '$x^{}$', JSON.stringify(composer));

    // rendered output: run a markdown cell built from the palette
    await page.evaluate(() => { const i = document.getElementById('code-input'); i.value = ''; });
    await page.click('#math-palette button[title="Fraction"]');
    await page.evaluate(() => {
        const i = document.getElementById('code-input');
        const p = i.selectionStart;
        i.value = i.value.slice(0, p) + '1}{2' + i.value.slice(p);
    });
    await page.click('#run-btn');
    await page.waitForSelector('.katex', { timeout: 30000 });
    check('palette-built markdown renders through KaTeX', await page.evaluate(() => !!document.querySelector('.katex')));
    await page.context().close();

    console.log('4. Footer layout invariants');
    // baseline: closed palette
    page = await freshPage({ viewport: { width: 320, height: 640 } });
    const baseline = await page.evaluate(() => document.getElementById('input-bar').getBoundingClientRect().height);
    await enableFormula(page);
    const afterEnable = await page.evaluate(() => document.getElementById('input-bar').getBoundingClientRect().height);
    check('closed-palette layout unchanged by enabling the shortcut', baseline === afterEnable, `${baseline} vs ${afterEnable}`);
    await page.click('#math-mode-btn');
    const open = await page.evaluate(() => {
        const bar = document.getElementById('input-bar').getBoundingClientRect();
        const input = document.getElementById('code-input').getBoundingClientRect();
        const run = document.getElementById('run-btn').getBoundingClientRect();
        const vh = window.innerHeight;
        return {
            composerVisible: input.top >= 0 && input.bottom <= vh && input.height > 20,
            runVisible: run.top >= 0 && run.bottom <= vh,
            barTop: bar.top,
        };
    });
    check('open palette keeps composer and Run usable at 320x640', open.composerVisible && open.runVisible, JSON.stringify(open));
    // content visibility at max scroll
    await page.evaluate(async () => {
        for (let i = 0; i < 6; i++) {
            const inp = document.getElementById('code-input');
            inp.value = `line ${i}`;
            document.getElementById('cell-type-toggle');
        }
    });
    // create tall content via markdown cells
    for (let i = 0; i < 4; i++) {
        await page.evaluate((n) => { document.getElementById('code-input').value = `# Heading ${n}\n\ntext ${n}`; }, i);
        const isMd = await page.evaluate(() => document.getElementById('cell-type-toggle').classList.contains('markdown-active'));
        if (!isMd) await page.click('#cell-type-toggle');
        await page.click('#run-btn');
        await page.waitForTimeout(200);
    }
    const visibility = await page.evaluate(async () => {
        // the app scrolls inside main#repl (flex column: repl above footer);
        // scroll-behavior:smooth animates, so force an instant scroll
        const scroller = document.getElementById('repl');
        scroller.style.scrollBehavior = 'auto';
        scroller.scrollTop = scroller.scrollHeight;
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        const last = scroller.lastElementChild;
        if (!last) return { ok: false, why: 'no content in #repl' };
        const r = last.getBoundingClientRect();
        const bar = document.getElementById('input-bar').getBoundingClientRect();
        return { ok: r.bottom <= bar.top + 1, lastBottom: r.bottom, barTop: bar.top };
    });
    check('final content stays visible above the footer at max scroll', visibility.ok, JSON.stringify(visibility));
    await page.context().close();

    // hit-testing at 320x240
    page = await freshPage({ viewport: { width: 320, height: 240 } });
    await enableFormula(page);
    await page.click('#math-mode-btn');
    const hits = await page.evaluate(() => {
        const palette = document.getElementById('math-palette');
        const buttons = [...palette.querySelectorAll('button')]
            .filter(b => getComputedStyle(b).display !== 'none' && b.offsetParent !== null);
        const results = [];
        for (const b of buttons) {
            b.scrollIntoView({ block: 'nearest' });
            const r = b.getBoundingClientRect();
            const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
            results.push(b === el || b.contains(el));
        }
        return { total: buttons.length, hittable: results.filter(Boolean).length };
    });
    check('every visible palette button is hittable at 320x240', hits.total > 0 && hits.hittable === hits.total, JSON.stringify(hits));
    await page.context().close();

    console.log('5. Capacitor bottom-inset variable');
    page = await freshPage();
    const pad = await page.evaluate(() => {
        document.documentElement.style.setProperty('--safe-area-inset-bottom', '48px');
        return getComputedStyle(document.getElementById('input-bar')).paddingBottom;
    });
    check('injected --safe-area-inset-bottom: 48px yields 58px footer padding', pad === '58px', pad);
    await page.context().close();

    console.log('6. Help text conveys the new defaults (meaning, not stale equality)');
    const en = JSON.parse(readFileSync('www/i18n/en.json', 'utf8')).strings['help.headerShortcuts'];
    check('EN says Formula is off by default', /off by default/i.test(en) && !/buttons are shown by default/i.test(en));
    const legacy = 'se muestran de forma predeterminada. Oculta o restaura';
    for (const loc of ['es', 'de', 'fr', 'pt-BR', 'id', 'ru', 'ja', 'zh', 'ko', 'hi', 'bn', 'ar']) {
        const v = JSON.parse(readFileSync(`www/i18n/${loc}.json`, 'utf8')).strings['help.headerShortcuts'];
        check(`${loc} translation updated and localized`, v && v !== en && !v.includes(legacy) && v.includes('∑'));
    }

    console.log('5b. Display math ($$…$$) insertion');
    page = await freshPage();
    await enableFormula(page);
    await page.click('#cell-type-toggle');
    await page.click('#math-mode-btn');
    await page.evaluate(() => {
        const i = document.getElementById('code-input');
        i.value = '$$x';
        i.selectionStart = i.selectionEnd = 3;   // caret after x, inside $$…
    });
    await page.click('#math-palette button[title="Fraction"]');
    let dm = await page.evaluate(() => document.getElementById('code-input').value);
    check('caret inside $$…$$ inserts bare (no nested delimiters)', dm === '$$x\\frac{}{}', JSON.stringify(dm));
    await page.evaluate(() => {
        const i = document.getElementById('code-input');
        const p = i.selectionStart;
        i.value = i.value.slice(0, p) + '1}{2' + i.value.slice(p) + '$$';
    });
    await page.click('#run-btn');
    await page.waitForSelector('.katex-display, .katex', { timeout: 30000 });
    check('display math built via the palette renders through KaTeX',
        await page.evaluate(() => !!document.querySelector('.katex')));
    await page.context().close();

    console.log('5c. Second notebook and growing composer keep the reservation');
    page = await freshPage({ viewport: { width: 320, height: 640 } });
    await enableFormula(page);
    const madeSecond = await page.evaluate(() => {
        try { return !!(window.notebookManager && window.notebookManager.createNotebook({ name: 'second' })); }
        catch (_) { return false; }
    });
    await page.click('#math-mode-btn');
    await page.waitForTimeout(150);
    const noOverlap = () => page.evaluate(() => {
        const bar = document.getElementById('input-bar').getBoundingClientRect();
        const el = [...document.querySelectorAll('#repl, .repl-container')].find(e => e.offsetParent !== null);
        const run = document.getElementById('run-btn').getBoundingClientRect();
        return {
            scrollerClear: el.getBoundingClientRect().bottom <= bar.top + 1,
            runOnScreen: run.bottom <= innerHeight + 1 && run.top >= 0,
            barOnScreen: bar.bottom <= innerHeight + 1,
        };
    });
    let inv = await noOverlap();
    check('open palette: scroller never under the footer' + (madeSecond ? ' (second notebook)' : ''),
        inv.scrollerClear && inv.runOnScreen && inv.barOnScreen, JSON.stringify(inv));
    // growing composer keeps the invariant (footer participates in layout)
    await page.evaluate(() => {
        const i = document.getElementById('code-input');
        i.value = Array.from({ length: 8 }, (_, n) => 'line ' + n).join('\n');
        i.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.waitForTimeout(250);
    inv = await noOverlap();
    check('composer growth keeps scroller and Run clear', inv.scrollerClear && inv.runOnScreen, JSON.stringify(inv));
    await page.context().close();

    console.log('5d. Desktop width keeps the reservation (responsive padding rule)');
    page = await freshPage({ viewport: { width: 1024, height: 500 } });
    await enableFormula(page);
    await page.click('#math-mode-btn');
    await page.waitForTimeout(150);
    const desktopInv = await page.evaluate(() => {
        const bar = document.getElementById('input-bar').getBoundingClientRect();
        const el = [...document.querySelectorAll('#repl, .repl-container')].find(e => e.offsetParent !== null);
        return { clear: el.getBoundingClientRect().bottom <= bar.top + 1, barBottom: Math.round(bar.bottom), vh: innerHeight };
    });
    check('>=900px: scroller clear of the footer', desktopInv.clear && desktopInv.barBottom <= desktopInv.vh + 1, JSON.stringify(desktopInv));
    await page.context().close();

    console.log("5d2. 800px tablet width keeps the reservation");
    page = await freshPage({ viewport: { width: 800, height: 500 } });
    await enableFormula(page);
    await page.click('#math-mode-btn');
    await page.waitForTimeout(150);
    const tabletInv = await page.evaluate(() => {
        const bar = document.getElementById('input-bar').getBoundingClientRect();
        const el = [...document.querySelectorAll('#repl, .repl-container')].find(e => e.offsetParent !== null);
        return { clear: el.getBoundingClientRect().bottom <= bar.top + 1, barBottom: Math.round(bar.bottom), vh: innerHeight };
    });
    check('800px: scroller clear of the footer', tabletInv.clear && tabletInv.barBottom <= tabletInv.vh + 1, JSON.stringify(tabletInv));
    await page.context().close();

    console.log('5f. Safe-area change AFTER opening re-measures');
    page = await freshPage({ viewport: { width: 320, height: 640 } });
    await enableFormula(page);
    await page.click('#math-mode-btn');
    await page.waitForTimeout(150);
    await page.evaluate(() => document.documentElement.style.setProperty('--safe-area-inset-bottom', '48px'));
    await page.waitForTimeout(250);
    const lateInset = await page.evaluate(() => {
        const bar = document.getElementById('input-bar').getBoundingClientRect();
        const el = [...document.querySelectorAll('#repl, .repl-container')].find(e => e.offsetParent !== null);
        const run = document.getElementById('run-btn').getBoundingClientRect();
        return {
            barBottomOnScreen: Math.round(bar.bottom) <= innerHeight + 1,
            padApplied: parseInt(getComputedStyle(document.getElementById('input-bar')).paddingBottom) >= 58,
            runVisible: run.bottom <= innerHeight - 40,   // above the 48px inset zone
            scrollerClear: el.getBoundingClientRect().bottom <= bar.top + 1,
        };
    });
    check('a 48px inset applied AFTER opening keeps composer above it (layout reflows)',
        lateInset.barBottomOnScreen && lateInset.padApplied && lateInset.runVisible && lateInset.scrollerClear,
        JSON.stringify(lateInset));
    await page.context().close();

    console.log('5g. Landscape side insets, LTR and RTL');
    for (const dir of ['ltr', 'rtl']) {
        page = await freshPage();
        const pads = await page.evaluate((d) => {
            document.documentElement.dir = d;
            document.documentElement.style.setProperty('--safe-area-inset-left', '30px');
            document.documentElement.style.setProperty('--safe-area-inset-right', '20px');
            const cs = getComputedStyle(document.getElementById('input-bar'));
            return { left: parseInt(cs.paddingLeft), right: parseInt(cs.paddingRight) };
        }, dir);
        check(`side insets respected physically (${dir})`, pads.left === 42 && pads.right === 32, JSON.stringify(pads));
        await page.context().close();
    }

    console.log('5h. Invalid %pip lines: zero installs, zero CDN fetches');
    page = await freshPage();
    await page.waitForFunction(() => !document.getElementById('run-btn').disabled, null, { timeout: 180000 });
    const netProbe = await page.evaluate(async () => {
        let cdnFetches = 0;
        const origFetch = window.fetch;
        window.fetch = (...args) => {
            if (String(args[0]).includes('cdn.jsdelivr.net')) cdnFetches++;
            return origFetch(...args);
        };
        let pipInstalls = 0;
        await window.kernelManager.ensureReady('python');
        const py = window.kernelManager.getKernel('python').getPyodide();
        py.runPython('import builtins\n_real_pi = pip_install\nasync def pip_install(*a):\n    import js; js._pipCount()\n    await _real_pi(*a)');
        window._pipCount = () => { pipInstalls++; };
        const before = { cdnFetches, pipInstalls };
        // drive the %pip flow through the real UI for two invalid lines
        const runLine = async (text) => {
            document.getElementById('code-input').value = text;
            document.getElementById('run-btn').click();
            await new Promise(r => {
                const t = setInterval(() => { if (!document.getElementById('run-btn').disabled) { clearInterval(t); r(); } }, 100);
            });
        };
        await runLine('%pip install -r requirements.txt');
        await runLine('%pip install pkg @ https://example.com/x.whl');
        await runLine('%pip install pandas[performance]');
        window.fetch = origFetch;
        return {
            cdnFetches: cdnFetches - before.cdnFetches,
            pipInstalls: pipInstalls - before.pipInstalls,
            text: document.body.innerText,
        };
    });
    check('invalid/extras lines: ZERO pip_install calls', netProbe.pipInstalls === 0, String(netProbe.pipInstalls));
    check('invalid/extras lines: ZERO CDN fetches', netProbe.cdnFetches === 0, String(netProbe.cdnFetches));
    check('extras give a clear unsupported error',
        netProbe.text.includes('extras are not supported yet') && netProbe.text.includes('pandas[performance]'));
    check('all three lines report skipped entirely',
        (netProbe.text.match(/line skipped entirely/g) || []).length >= 3);
    await page.context().close();

    console.log('5e. Offline upgrade: resolver is in the precached shell');
    {
        const ctx = await browser.newContext();   // service worker ACTIVE
        const p2 = await ctx.newPage();
        await p2.addInitScript(() => {
            localStorage.setItem('scirepl_privacy_accepted', '1');
            localStorage.setItem('scirepl_onboarding_seen', '1');
            addEventListener('DOMContentLoaded', () => localStorage.setItem(
                'scirepl_whats_new_seen_version', window.KERNEL_CONFIG?.app?.version || ''), { once: true });
        });
        await p2.goto(APP_URL, { waitUntil: 'domcontentloaded' });
        await p2.waitForFunction(() => window.__SCIREPL_APP_READY === true, null, { timeout: 120000 });
        await p2.evaluate(() => navigator.serviceWorker.ready);
        await p2.waitForTimeout(3000);   // let the shell precache settle
        await ctx.setOffline(true);
        await p2.reload({ waitUntil: 'domcontentloaded' });
        const offlineResolver = await p2.evaluate(() => typeof globalThis.PipResolver === 'object' && !!globalThis.PipResolver.parsePipLine)
            .catch(() => false);
        check('offline reload still has PipResolver (precached)', offlineResolver === true, String(offlineResolver));
        await ctx.close();
    }

    if (process.env.RUN_LIVE_CDN === '1') {
        console.log('7. LIVE: %pip matplotlib same-cell image (Pyodide CDN)');
        page = await freshPage();
        await page.waitForFunction(() => !document.getElementById('run-btn').disabled, null, { timeout: 180000 });
        await page.fill('#code-input', '%pip install matplotlib\nimport matplotlib.pyplot as plt\nplt.plot([1, 4, 2, 3])\nplt.title("Matplotlib")\nplt.show()');
        await page.click('#run-btn');
        await page.waitForFunction(() => document.body.innerText.includes('Traceback')
            || !!document.querySelector('img[src^="data:image"]'), null, { timeout: 480000 });
        const live = await page.evaluate(() => ({
            img: !!document.querySelector('img[src^="data:image"]'),
            tb: document.body.innerText.includes('Traceback'),
        }));
        check('same cell: install + import + plot mounts an image', live.img && !live.tb, JSON.stringify(live));
        await page.context().close();
    } else {
        console.log('7. (skipped) live %pip matplotlib test — set RUN_LIVE_CDN=1');
    }
} finally {
    await browser.close();
}

console.log(`\n${failures ? `FAILED: ${failures}` : 'All math-palette tests passed.'}`);
process.exitCode = failures ? 1 : 0;
