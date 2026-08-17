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

    console.log('3b. ONE shared tokenizer: renderer and palette agree on what is math');
    page = await freshPage();
    await enableFormula(page);
    check('md_math.js is loaded and shared', await page.evaluate(() =>
        typeof window.MdMath === 'object' && !!window.MdMath.scan && !!window.MdMath.stateAt));
    await page.click('#cell-type-toggle');
    await page.click('#math-mode-btn');
    // Sol's rendering regression: escaped currency + one real formula
    const renderProbe = await page.evaluate(() => {
        const html = window._appInternals.renderMarkdown('costs \\$5 today $\\sqrt{}$');
        const div = document.createElement('div');
        div.innerHTML = html;
        const outside = div.cloneNode(true);
        outside.querySelectorAll('.katex').forEach(k => k.remove());
        return {
            katexCount: div.querySelectorAll('.katex').length,
            sqrtRendered: !!div.querySelector('.katex .sqrt, .katex .mord.sqrt, .katex svg'),
            text: div.textContent,
            textOutsideMath: outside.textContent,
        };
    });
    check('exactly ONE KaTeX expression', renderProbe.katexCount === 1, String(renderProbe.katexCount));
    check('\\$5 stays literal currency text', renderProbe.text.includes('$5'), JSON.stringify(renderProbe.text));
    check('the expression is the sqrt (KaTeX markup present)', renderProbe.sqrtRendered);
    // KaTeX embeds the TeX source in its MathML annotation, so "no raw
    // trailing formula text" means: nothing OUTSIDE the .katex elements
    check('no raw trailing formula text remains outside the math',
        !renderProbe.textOutsideMath.includes('\\sqrt') && !renderProbe.textOutsideMath.includes('$\\'),
        JSON.stringify(renderProbe.textOutsideMath));
    // dollars inside code spans and fences are inert for the RENDERER
    const codeProbe = await page.evaluate(() => {
        const one = (t) => {
            const d = document.createElement('div');
            d.innerHTML = window._appInternals.renderMarkdown(t);
            return { katex: d.querySelectorAll('.katex').length, text: d.textContent };
        };
        return {
            span: one('`$5` and $x$'),
            fence: one('```\n$notmath$\n```\n\n$y$'),
            doubletick: one('``a`$b`` then $z$'),
        };
    });
    check('inline code span protects its $ (one katex from $x$)',
        codeProbe.span.katex === 1 && codeProbe.span.text.includes('$5'), JSON.stringify(codeProbe.span));
    check('fenced block protects its $ (one katex from $y$)',
        codeProbe.fence.katex === 1 && codeProbe.fence.text.includes('$notmath$'), JSON.stringify(codeProbe.fence));
    check('variable-length backtick span protects its $',
        codeProbe.doubletick.katex === 1 && codeProbe.doubletick.text.includes('a`$b'), JSON.stringify(codeProbe.doubletick));
    // STRUCTURAL protection: math is recognized only in eligible inline
    // text — link destinations, autolinks, image sources, raw-HTML
    // attributes, and indented code stay byte-for-byte intact.
    const structProbe = await page.evaluate(() => {
        const one = (t) => {
            const d = document.createElement('div');
            d.innerHTML = window._appInternals.renderMarkdown(t);
            return { katex: d.querySelectorAll('.katex').length, html: d.innerHTML,
                     aHref: d.querySelector('a') ? d.querySelector('a').getAttribute('href') : null,
                     imgSrc: d.querySelector('img') ? d.querySelector('img').getAttribute('src') : null,
                     spanTitle: d.querySelector('span[title]') ? d.querySelector('span[title]').getAttribute('title') : null,
                     pre: d.querySelector('pre') ? d.querySelector('pre').textContent : null,
                     text: d.textContent };
        };
        return {
            linkDest: one('[link](https://example.com/$x$/file)'),
            autolink: one('<https://example.com/$x$/file>'),
            imageSrc: one('![alt](https://example.com/$x$.png)'),
            htmlAttr: one('<span title="$x$">label</span>'),
            indented: one('para\n\n    $x$'),
            placeholder: one('literal %%MATH_BLOCK_0%% and $y$'),
            labelMath: one('[$x$](https://example.com/)'),
            sanitizer: one('$x$ <img src=x onerror="window.__pwned=1">'),
        };
    });
    check('link DESTINATION with $x$ stays byte-intact (no katex, href whole)',
        structProbe.linkDest.katex === 0 && structProbe.linkDest.aHref === 'https://example.com/$x$/file',
        JSON.stringify(structProbe.linkDest.aHref));
    check('autolink with $x$ stays byte-intact',
        structProbe.autolink.katex === 0 && structProbe.autolink.aHref === 'https://example.com/$x$/file',
        JSON.stringify(structProbe.autolink.aHref));
    // the app sanitizer strips NETWORK image srcs by design (privacy
    // policy, pre-existing); byte-intactness of the URL is asserted at the
    // marked stage, and the sanitizer's stripping is asserted unchanged
    const imgStage = await page.evaluate(() => {
        const d = document.createElement('div');
        d.innerHTML = window.marked.parse('![alt](https://example.com/$x$.png)');
        const img = d.querySelector('img');
        return { katex: d.querySelectorAll('.katex').length, src: img ? img.getAttribute('src') : null };
    });
    check('image SOURCE with $x$ stays byte-intact at the markdown stage',
        imgStage.katex === 0 && imgStage.src === 'https://example.com/$x$.png', JSON.stringify(imgStage));
    check('sanitizer still strips network image srcs (no katex, no truncated URL)',
        structProbe.imageSrc.katex === 0 && structProbe.imageSrc.imgSrc === null
        && !structProbe.imageSrc.html.includes('example.com/$'),
        JSON.stringify(structProbe.imageSrc.imgSrc));
    check('raw-HTML attribute with $x$ stays intact (no katex, title whole)',
        structProbe.htmlAttr.katex === 0 && structProbe.htmlAttr.spanTitle === '$x$'
        && structProbe.htmlAttr.text.includes('label'),
        JSON.stringify({ t: structProbe.htmlAttr.spanTitle, text: structProbe.htmlAttr.text }));
    check('indented code block with $x$ is NOT math',
        structProbe.indented.katex === 0 && (structProbe.indented.pre || '').includes('$x$'),
        JSON.stringify(structProbe.indented.pre));
    check('literal %%MATH_BLOCK_0%% stays where the user wrote it, $y$ still renders',
        structProbe.placeholder.katex === 1 && structProbe.placeholder.text.includes('%%MATH_BLOCK_0%%'),
        JSON.stringify(structProbe.placeholder.text));
    check('math in a link LABEL still renders (one katex inside the anchor)',
        structProbe.labelMath.katex === 1 && structProbe.labelMath.aHref === 'https://example.com/',
        JSON.stringify(structProbe.labelMath.aHref));
    check('sanitized output stays inert (onerror stripped, math still rendered)',
        structProbe.sanitizer.katex === 1 && !structProbe.sanitizer.html.includes('onerror'),
        structProbe.sanitizer.html.slice(0, 120));
    // palette insertion AFTER code regions containing $ — caret is outside
    // math, so the insert must still wrap (the code-span $ must not flip state)
    const insertAfter = async (prefix) => {
        await page.evaluate((v) => {
            const i = document.getElementById('code-input');
            i.value = v;
            i.selectionStart = i.selectionEnd = v.length;
        }, prefix);
        await page.click('#math-palette button[title="Square root"]');
        return page.evaluate(() => document.getElementById('code-input').value);
    };
    check('insertion after inline code with $ wraps correctly',
        (await insertAfter('`$a` ')) === '`$a` $\\sqrt{}$');
    check('insertion after fenced code with $ wraps correctly',
        (await insertAfter('```\n$x\n```\n')) === '```\n$x\n```\n$\\sqrt{}$');
    check('escaped-backslash parity: \\\\ then $x -> caret is INSIDE math (bare insert)',
        (await insertAfter('\\\\$x')) === '\\\\$x\\sqrt{}');
    check('escaped dollar: \\$x is NOT math (wrapped insert)',
        (await insertAfter('\\$x ')) === '\\$x $\\sqrt{}$');
    // caret INSIDE a code span: not math, so the palette wraps (WYSIWYG text)
    const inCode = await page.evaluate(() => {
        const i = document.getElementById('code-input');
        i.value = '`code`';
        i.selectionStart = i.selectionEnd = 3;
        return window.MdMath.stateAt(i.value, 3);
    });
    check("caret inside a code span reports 'code' (never inline/display)", inCode === 'code', inCode);
    // palette context matches the renderer's protected contexts
    const ctxProbe = await page.evaluate(() => {
        const st = (v, p) => window.MdMath.stateAt(v, p);
        return {
            inLinkDest: st('[t](https://e.com/$x$/f)', 12),           // inside the URL
            afterLinkDest: st('[t](https://e.com/$x$/f) ', 25),       // after the link
            inAutolink: st('<https://e.com/$x$/f>', 10),
            inHtmlAttr: st('<span title="$x$">', 15),
            inIndented: st('para\n\n    $x$\n', 12),
            afterIndented: st('para\n\n    $x$\n\ntail ', 21),
        };
    });
    check("caret inside a link destination reports 'code'", ctxProbe.inLinkDest === 'code', ctxProbe.inLinkDest);
    check("caret after a $-bearing link is 'outside' (URL $ did not flip state)", ctxProbe.afterLinkDest === 'outside', ctxProbe.afterLinkDest);
    check("caret inside an autolink reports 'code'", ctxProbe.inAutolink === 'code', ctxProbe.inAutolink);
    check("caret inside a raw-HTML attribute reports 'code'", ctxProbe.inHtmlAttr === 'code', ctxProbe.inHtmlAttr);
    check("caret inside indented code reports 'code'", ctxProbe.inIndented === 'code', ctxProbe.inIndented);
    check("caret after indented code is 'outside'", ctxProbe.afterIndented === 'outside', ctxProbe.afterIndented);
    // insertion after a $-bearing URL wraps correctly (parity preserved)
    check('insertion after a link with $ in its URL wraps correctly',
        (await insertAfter('[t](https://e.com/$x$/f) ')) === '[t](https://e.com/$x$/f) $\\sqrt{}$');

    // ---- math may NEVER cross into a protected construct ----
    const crossProbe = await page.evaluate(() => {
        const one = (t) => {
            const d = document.createElement('div');
            d.innerHTML = window._appInternals.renderMarkdown(t);
            const a = d.querySelector('a');
            return { katex: d.querySelectorAll('.katex').length, text: d.textContent,
                     href: a ? a.getAttribute('href') : null,
                     anchorText: a ? a.textContent : null,
                     spanTitle: d.querySelector('span[title]') ? d.querySelector('span[title]').getAttribute('title') : null };
        };
        return {
            link: one('cost $5 [query](https://e.com/?$filter=x)'),
            bareUrl: one('cost $5 https://e.com/?$filter=x done'),
            autolink: one('pay $5 <https://e.com/$x> now'),
            html: one('amt $5 <span title="a > $x">label</span>'),
            refdef: one('[id]: https://e.com/$x$/f\n\nbody text'),
        };
    });
    check("Sol's link case: $5 literal, anchor and href COMPLETE, zero katex",
        crossProbe.link.katex === 0 && crossProbe.link.href === 'https://e.com/?$filter=x'
        && crossProbe.link.anchorText === 'query' && crossProbe.link.text.includes('$5'),
        JSON.stringify(crossProbe.link));
    check('bare GFM URL survives a preceding $5 (whole href, zero katex)',
        crossProbe.bareUrl.katex === 0 && crossProbe.bareUrl.href === 'https://e.com/?$filter=x',
        JSON.stringify(crossProbe.bareUrl));
    check('autolink survives a preceding $5',
        crossProbe.autolink.katex === 0 && crossProbe.autolink.href === 'https://e.com/$x',
        JSON.stringify(crossProbe.autolink));
    check("raw HTML with '>' inside a quoted attribute survives a preceding $5",
        crossProbe.html.katex === 0 && crossProbe.html.spanTitle === 'a > $x'
        && crossProbe.html.text.includes('label'),
        JSON.stringify(crossProbe.html));
    // ---- round 7: TOKEN-STRUCTURAL — math only in eligible text tokens ----
    const tokProbe = await page.evaluate(() => {
        const one = (t) => {
            const d = document.createElement('div');
            d.innerHTML = window._appInternals.renderMarkdown(t);
            const a = d.querySelector('a');
            return { katex: d.querySelectorAll('.katex').length, text: d.textContent,
                     href: a ? a.getAttribute('href') : null,
                     anchorHasKatex: a ? !!a.querySelector('.katex') : false,
                     anchorText: a ? a.textContent : null };
        };
        return {
            labelMixed: one('cost $5 [query $filter$](https://e.com/)'),
            email: one('mail <foo$bar@example.com> now'),
            emphasis: one('cost $5 *emph $x* done'),
            refLink: one('see [label $a$][id]\n\n[id]: https://e.com/$x$/f'),
            collapsedRef: one('see [label][]\n\n[label]: https://e.com/$q$'),
            shortcutRef: one('see [label]\n\n[label]: https://e.com/$q$'),
        };
    });
    check("Sol's case: $5 literal, anchor COMPLETE, $filter$ renders INSIDE the label",
        tokProbe.labelMixed.katex === 1 && tokProbe.labelMixed.anchorHasKatex
        && tokProbe.labelMixed.href === 'https://e.com/' && tokProbe.labelMixed.text.includes('$5'),
        JSON.stringify(tokProbe.labelMixed));
    check('email autolink with $ stays intact (mailto, zero katex)',
        tokProbe.email.katex === 0 && tokProbe.email.href === 'mailto:foo$bar@example.com',
        JSON.stringify(tokProbe.email));
    check('unmatched $ before emphasis stays literal (math never crosses em)',
        tokProbe.emphasis.katex === 0 && tokProbe.emphasis.text.includes('$5')
        && tokProbe.emphasis.text.includes('$x'),
        JSON.stringify(tokProbe.emphasis.text));
    check('reference link: label math renders, href byte-intact',
        tokProbe.refLink.katex === 1 && tokProbe.refLink.anchorHasKatex
        && tokProbe.refLink.href === 'https://e.com/$x$/f',
        JSON.stringify(tokProbe.refLink));
    check('collapsed reference intact', tokProbe.collapsedRef.href === 'https://e.com/$q$'
        && tokProbe.collapsedRef.katex === 0, JSON.stringify(tokProbe.collapsedRef));
    check('shortcut reference intact', tokProbe.shortcutRef.href === 'https://e.com/$q$'
        && tokProbe.shortcutRef.katex === 0, JSON.stringify(tokProbe.shortcutRef));
    // palette context from the SAME tokenization
    const tokCtx = await page.evaluate(() => {
        const st = (v, p) => window.MdMath.stateAt(v, p);
        return {
            multilineDefTitle: st('[id]: https://e.com\n  "title $x$ line"', 32),
            refId: st('see [label][id $x]\n\n[id $x]: https://e.com', 16),
            htmlBlock: st('<div>\n$x$\n</div>', 8),
            declaration: st('<!DOCTYPE html> $x', 8),
            pi: st('<?php $x ?> end', 7),
            cdata: st('<![CDATA[$x]]> end', 10),
            upperHttps: st('HTTPS://E.COM/$x$/f end', 16),
            upperWww: st('WWW.EXAMPLE.COM/$x$ end', 17),
            emailAuto: st('<foo$bar@example.com> end', 6),
            labelEligible: st('[t $x$ u](https://e.com/)', 5),
        };
    });
    for (const [k, want] of [['multilineDefTitle', 'code'], ['refId', 'code'], ['htmlBlock', 'code'],
        ['declaration', 'code'], ['pi', 'code'], ['cdata', 'code'], ['emailAuto', 'code'],
        ['labelEligible', 'inline']]) {
        check(`stateAt ${k} -> ${want}`, tokCtx[k] === want, tokCtx[k]);
    }
    check('stateAt uppercase HTTPS:// never inline', tokCtx.upperHttps !== 'inline' && tokCtx.upperHttps !== 'display', tokCtx.upperHttps);
    check('stateAt uppercase WWW. never inline', tokCtx.upperWww !== 'inline' && tokCtx.upperWww !== 'display', tokCtx.upperWww);

    check('reference definition line is consumed as a definition (no katex, no leak)',
        crossProbe.refdef.katex === 0 && crossProbe.refdef.text.includes('body text')
        && !crossProbe.refdef.text.includes('[id]'),
        JSON.stringify(crossProbe.refdef.text));

    // ---- insertion-PLUS-render: caret context and output agree ----
    // Sol's reproduction: an unclosed $ before a newline must NOT leave the
    // palette thinking it is inside math at EOF
    await page.evaluate(() => {
        const i = document.getElementById('code-input');
        i.value = 'price $5\nnext line ';
        i.selectionStart = i.selectionEnd = i.value.length;
    });
    await page.click('#math-palette button[title="Square root"]');
    const nlValue = await page.evaluate(() => document.getElementById('code-input').value);
    check('unclosed $ before a newline: insertion at EOF is WRAPPED',
        nlValue === 'price $5\nnext line $\\sqrt{}$', JSON.stringify(nlValue));
    await page.click('#run-btn');
    await page.waitForSelector('.katex', { timeout: 30000 });
    const nlRender = await page.evaluate(() => {
        const cell = window._cells[window._cells.length - 1];
        const out = (cell && cell.outputCard) || document.body;
        return { katex: out.querySelectorAll('.katex').length, text: out.textContent };
    });
    check('...and it RENDERS: exactly one formula, $5 stays literal',
        nlRender.katex === 1 && nlRender.text.includes('$5'), JSON.stringify(nlRender));
    // protected-context insertions stay wrapped (never bare LaTeX)
    check('insertion after a bare URL with $ wraps',
        (await insertAfter('https://e.com/$x$/f ')) === 'https://e.com/$x$/f $\\sqrt{}$');
    check('insertion after an HTML comment with $ wraps',
        (await insertAfter('<!-- $x$ --> ')) === '<!-- $x$ --> $\\sqrt{}$');
    // multiline lists and quotations: palette agrees with the renderer
    const mlProbe = await page.evaluate(() => {
        const st = (v, p) => window.MdMath.stateAt(v, p);
        const list2 = '1. first line\n   continued $x$ here';
        const quote2 = '> line one $a$\n> line two $x$';
        const img = '![alt $a$](https://e.com/i.png)';
        const render = (t) => {
            const d = document.createElement('div');
            d.innerHTML = window._appInternals.renderMarkdown(t);
            return { katex: d.querySelectorAll('.katex').length, text: d.textContent };
        };
        return {
            listState: st(list2, list2.indexOf('$x$') + 1),
            listRender: render(list2),
            quoteState: st(quote2, quote2.indexOf('$x$') + 1),
            quoteRender: render(quote2),
            imgAltState: st(img, img.indexOf('$a$') + 1),
            imgRender: render(img),
        };
    });
    check('multiline list continuation: palette reports inline AND it renders',
        mlProbe.listState === 'inline' && mlProbe.listRender.katex === 1, JSON.stringify({ s: mlProbe.listState, k: mlProbe.listRender.katex }));
    check('multiline blockquote: palette reports inline AND it renders',
        mlProbe.quoteState === 'inline' && mlProbe.quoteRender.katex === 2, JSON.stringify({ s: mlProbe.quoteState, k: mlProbe.quoteRender.katex }));
    check('image ALT text: palette reports protected AND renderer keeps it literal',
        mlProbe.imgAltState === 'code' && mlProbe.imgRender.katex === 0
        && mlProbe.imgRender.text.indexOf('$a$') === -1 /* alt is an attribute, not text */,
        JSON.stringify({ s: mlProbe.imgAltState, k: mlProbe.imgRender.katex }));
    // insertion inside a multiline list item does NOT nest delimiters
    await page.evaluate(() => {
        const i = document.getElementById('code-input');
        i.value = '1. first line\n   continued $x$ here';
        i.selectionStart = i.selectionEnd = i.value.indexOf('$x$') + 2;   // inside the span
    });
    await page.click('#math-palette button[title="Square root"]');
    const mlInsert = await page.evaluate(() => document.getElementById('code-input').value);
    check('insertion INSIDE list-item math is bare (no nested delimiters)',
        mlInsert === '1. first line\n   continued $x\\sqrt{}$ here', JSON.stringify(mlInsert));

    // round 9: nested lists, display math across lines, fence immunity
    const r9map = await page.evaluate(() => {
        const st = (v, p) => window.MdMath.stateAt(v, p);
        const deepNest = '1. outer\n   - mid\n     - deep $x$ end';
        const dispList = '- item\n  $$a\n  b$$ tail';
        const dispProgress = '> quote\n> $$x\n> unfinished';
        const fenceTrap = '- item text\n\n```\nitem text $x$ here\n```';
        return {
            deepNest: st(deepNest, deepNest.indexOf('$x$') + 1),
            listInQuote: st('> - item $x$ in quote-list', 10),
            dispAcross: st(dispList, dispList.indexOf('b$$')),
            dispProgress: st(dispProgress, dispProgress.length),
            fenceSafe: st(fenceTrap, fenceTrap.indexOf('$x$') + 1),
        };
    });
    check('deeply nested list item math reports inline', r9map.deepNest === 'inline', r9map.deepNest);
    check('list inside blockquote math reports inline', r9map.listInQuote === 'inline', r9map.listInQuote);
    check('display math ACROSS lines in a list keeps display state', r9map.dispAcross === 'display', r9map.dispAcross);
    check('in-progress display math in a quote keeps display state', r9map.dispProgress === 'display', r9map.dispProgress);
    check('a fence whose text matches a list line is NEVER claimed as math', r9map.fenceSafe === 'code', r9map.fenceSafe);
    // round 10: TAB indentation and fences inside items
    const r10map = await page.evaluate(() => {
        const st = (v, p) => window.MdMath.stateAt(v, p);
        const tabList = '1. first\n\t- tabbed item $x$ end';
        const tabCont = '- item\n\tcontinued $x$ here';
        const itemFence = '- item text $a$\n\n  ```\n  item text $a$\n  ```';
        return {
            tabNested: st(tabList, tabList.indexOf('$x$') + 1),
            tabCont: st(tabCont, tabCont.indexOf('$x$') + 1),
            itemFenceInside: st(itemFence, itemFence.lastIndexOf('$a$') + 1),
            itemMathOutside: st(itemFence, itemFence.indexOf('$a$') + 1),
        };
    });
    check('TAB-indented nested list item math reports inline', r10map.tabNested === 'inline', r10map.tabNested);
    check('TAB continuation line math reports inline', r10map.tabCont === 'inline', r10map.tabCont);
    check('a fence INSIDE a list item is protected even when its text matches item text',
        r10map.itemFenceInside === 'code', r10map.itemFenceInside);
    check('...while the real item math before it still reports inline',
        r10map.itemMathOutside === 'inline', r10map.itemMathOutside);
    // insertion inside TAB-indented math stays bare
    await page.evaluate(() => {
        const i = document.getElementById('code-input');
        i.value = '1. first\n\t- tabbed item $x$ end';
        i.selectionStart = i.selectionEnd = i.value.indexOf('$x$') + 2;
    });
    await page.click('#math-palette button[title="Square root"]');
    const tabInsert = await page.evaluate(() => document.getElementById('code-input').value);
    check('insertion INSIDE tab-indented list math is bare (no corruption)',
        tabInsert === '1. first\n\t- tabbed item $x\\sqrt{}$ end', JSON.stringify(tabInsert));
    // insertion inside a nested list item stays bare
    await page.evaluate(() => {
        const i = document.getElementById('code-input');
        i.value = '1. outer\n   - mid\n     - deep $x$ end';
        i.selectionStart = i.selectionEnd = i.value.indexOf('$x$') + 2;
    });
    await page.click('#math-palette button[title="Square root"]');
    const nestedInsert = await page.evaluate(() => document.getElementById('code-input').value);
    check('insertion INSIDE nested-list math is bare (no corruption)',
        nestedInsert === '1. outer\n   - mid\n     - deep $x\\sqrt{}$ end', JSON.stringify(nestedInsert));

    check('insertion after a reference definition wraps',
        (await insertAfter('[id]: https://e.com/$x$/f\n')) === '[id]: https://e.com/$x$/f\n$\\sqrt{}$');
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

    console.log('5c. SECOND notebook (really switched to) and growing composer');
    page = await freshPage({ viewport: { width: 320, height: 640 } });
    await enableFormula(page);
    // create AND SWITCH via the real notebook-switch path, then verify the
    // second container is the active one before exercising anything
    const madeSecond = await page.evaluate(() => {
        try {
            const nm = window.notebookManager;
            if (!nm) return false;
            const before = nm.getActiveNotebook && nm.getActiveNotebook();
            const nb = nm.createNotebook({ name: 'second' });
            nm.switchTo(nb.id);
            const active = nm.getActiveNotebook();
            const visible = nb.replContainer && nb.replContainer.offsetParent !== null
                && getComputedStyle(nb.replContainer).display !== 'none';
            return !!(active && active.id === nb.id && (!before || before.id !== nb.id) && visible);
        } catch (_) { return false; }
    });
    check('second notebook is created, switched to, and its container is active', madeSecond === true);
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
    check('composer growth keeps scroller and Run clear (second notebook)', inv.scrollerClear && inv.runOnScreen, JSON.stringify(inv));
    // safe-inset change while the SECOND notebook is active
    await page.evaluate(() => document.documentElement.style.setProperty('--safe-area-inset-bottom', '48px'));
    await page.waitForTimeout(250);
    inv = await noOverlap();
    check('late 48px inset on the second notebook keeps everything clear', inv.scrollerClear && inv.runOnScreen && inv.barOnScreen, JSON.stringify(inv));
    // fill the second notebook and scroll ITS container to the bottom
    for (let i = 0; i < 3; i++) {
        await page.evaluate((n) => {
            const inp = document.getElementById('code-input');
            inp.value = `# Second notebook heading ${n}\n\ncontent ${n}`;
            inp.dispatchEvent(new Event('input', { bubbles: true }));
        }, i);
        const isMd = await page.evaluate(() => document.getElementById('cell-type-toggle').classList.contains('markdown-active'));
        if (!isMd) await page.click('#cell-type-toggle');
        await page.click('#run-btn');
        await page.waitForTimeout(200);
    }
    const secondScroll = await page.evaluate(async () => {
        const scroller = [...document.querySelectorAll('#repl, .repl-container')].find(e => e.offsetParent !== null);
        scroller.style.scrollBehavior = 'auto';
        scroller.scrollTop = scroller.scrollHeight;
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        const last = scroller.lastElementChild;
        if (!last) return { ok: false, why: 'no content' };
        const bar = document.getElementById('input-bar').getBoundingClientRect();
        return { ok: last.getBoundingClientRect().bottom <= bar.top + 1, hasContent: scroller.children.length > 0 };
    });
    check('second notebook at max scroll: content clear of the footer', secondScroll.ok && secondScroll.hasContent, JSON.stringify(secondScroll));
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

    console.log('5i. SAFE-AREA BOUNDARY: every control above the TRUE usable boundary');
    // boundary = min(innerHeight, visualViewport.offsetTop + height) - inset
    // (inset from the footer's RESOLVED padding); notebook is measured as
    // the VISIBLE intersection with #app-body, never a clipped child rect
    const boundaryProbe = () => page.evaluate(() => {
        const bar = document.getElementById('input-bar');
        const inset = Math.max(0, (parseFloat(getComputedStyle(bar).paddingBottom) || 0) - 10);
        const vv = window.visualViewport;
        const usableBottom = vv ? Math.min(innerHeight, vv.offsetTop + vv.height) : innerHeight;
        const boundary = usableBottom - inset;
        const headerBottom = document.getElementById('app-header').getBoundingClientRect().bottom;
        const within = (r) => r.top >= headerBottom - 1 && r.bottom <= boundary + 1;
        const input = document.getElementById('code-input').getBoundingClientRect();
        const run = document.getElementById('run-btn').getBoundingClientRect();
        const appBody = document.getElementById('app-body').getBoundingClientRect();
        const scroller = [...document.querySelectorAll('#repl, .repl-container')].find(e => e.offsetParent !== null);
        // TRUTHFUL visible notebook: scroller ∩ #app-body ∩ the visual
        // viewport band ∩ the area ABOVE the (possibly transformed) footer
        let notebookVisible = 0;
        if (scroller) {
            const r = scroller.getBoundingClientRect();
            const barTop = bar.getBoundingClientRect().top;
            const vvTop = vv ? vv.offsetTop : 0;
            const vvBottom = vv ? Math.min(innerHeight, vv.offsetTop + vv.height) : innerHeight;
            notebookVisible = Math.max(0,
                Math.min(r.bottom, appBody.bottom, vvBottom, barTop)
                - Math.max(r.top, appBody.top, vvTop));
        }
        const palette = document.getElementById('math-palette');
        return {
            boundary: Math.round(boundary),
            composerOk: within(input) && input.height >= 30,
            runOk: within(run) && run.height >= 20,
            notebookVisible: Math.round(notebookVisible * 10) / 10,
            paletteCollapsed: palette.classList.contains('space-collapsed'),
            visibleButtons: [...palette.querySelectorAll('button')].filter(b => b.offsetParent !== null).length,
            inputBottom: Math.round(input.bottom), runBottom: Math.round(run.bottom),
        };
    });
    const paletteFullRect = () => page.evaluate(async () => {
        const bar = document.getElementById('input-bar');
        const inset = Math.max(0, (parseFloat(getComputedStyle(bar).paddingBottom) || 0) - 10);
        const vv = window.visualViewport;
        const usableBottom = vv ? Math.min(innerHeight, vv.offsetTop + vv.height) : innerHeight;
        const boundary = usableBottom - inset;
        const headerBottom = document.getElementById('app-header').getBoundingClientRect().bottom;
        const palette = document.getElementById('math-palette');
        const buttons = [...palette.querySelectorAll('button')]
            .filter(b => getComputedStyle(b).display !== 'none' && b.offsetParent !== null);
        let ok = 0; const bad = [];
        for (const b of buttons) {
            b.scrollIntoView({ block: 'nearest', behavior: 'instant' });
            await new Promise(r => requestAnimationFrame(r));
            const r = b.getBoundingClientRect();
            const pts = [[r.left + 3, r.top + 3], [r.right - 3, r.top + 3],
                [r.left + 3, r.bottom - 3], [r.right - 3, r.bottom - 3],
                [(r.left + r.right) / 2, (r.top + r.bottom) / 2]];
            const hitAll = pts.every(([x, y]) => {
                const el = document.elementFromPoint(x, y);
                return el === b || b.contains(el);
            });
            const inBounds = r.top >= headerBottom - 1 && r.bottom <= boundary + 1;
            if (hitAll && inBounds) ok++; else bad.push(b.textContent.trim());
        }
        return { total: buttons.length, ok, bad: bad.join(',') };
    });
    const growComposer = () => page.evaluate(() => {
        const i = document.getElementById('code-input');
        i.value = Array.from({ length: 10 }, (_, n) => 'line ' + n).join('\n');
        i.dispatchEvent(new Event('input', { bubbles: true }));
    });

    // configs A (320x240+48) and C (shrink to 220 with the inset RETAINED)
    // in BOTH directions
    for (const dir of ['ltr', 'rtl']) {
        page = await freshPage({ viewport: { width: 320, height: 240 } });
        await enableFormula(page);
        await page.evaluate((d) => {
            document.documentElement.dir = d;
            document.documentElement.style.setProperty('--safe-area-inset-bottom', '48px');
        }, dir);
        await page.click('#cell-type-toggle');
        await page.click('#math-mode-btn');
        await growComposer();
        await page.waitForTimeout(350);
        const a = await boundaryProbe();
        check(`320x240+48 (${dir}): composer and Run FULL RECTS above the safe boundary`,
            a.composerOk && a.runOk, JSON.stringify(a));
        const aHits = await paletteFullRect();
        check(`320x240+48 (${dir}): all ${aHits.total} palette buttons full-rect hittable above the boundary`,
            aHits.total >= 10 && aHits.ok === aHits.total, JSON.stringify(aHits));
        // C: keyboard-style shrink, inset RETAINED — not even one full
        // button row fits, so the palette must DELIBERATELY collapse
        // (never a clipped strip) and the notebook becomes visible again
        await page.setViewportSize({ width: 320, height: 220 });
        await page.waitForTimeout(350);
        const c = await boundaryProbe();
        check(`320x220+48 (${dir}): composer and Run stay above the boundary`,
            c.composerOk && c.runOk, JSON.stringify(c));
        check(`320x220+48 (${dir}): palette deliberately collapsed, zero clipped buttons`,
            c.paletteCollapsed && c.visibleButtons === 0, JSON.stringify(c));
        check(`320x220+48 (${dir}): freed space is GENUINELY visible notebook`,
            c.notebookVisible > 5, String(c.notebookVisible));
        // accessibility: a collapsed palette must not read as expanded,
        // and the desired-open state must restore when space returns
        const aria = await page.evaluate(() => ({
            expanded: document.getElementById('math-mode-btn').getAttribute('aria-expanded'),
            active: document.getElementById('math-mode-btn').classList.contains('active'),
        }));
        check(`320x220+48 (${dir}): collapsed palette NOT exposed as expanded/active`,
            aria.expanded === 'false' && !aria.active, JSON.stringify(aria));
        await page.setViewportSize({ width: 320, height: 320 });
        await page.waitForTimeout(350);
        const restored = await page.evaluate(() => ({
            expanded: document.getElementById('math-mode-btn').getAttribute('aria-expanded'),
            active: document.getElementById('math-mode-btn').classList.contains('active'),
            collapsed: document.getElementById('math-palette').classList.contains('space-collapsed'),
            visibleButtons: [...document.querySelectorAll('#math-palette button')]
                .filter(b => b.offsetParent !== null).length,
        }));
        check(`restore to 320 (${dir}): palette visible again, aria-expanded true`,
            restored.expanded === 'true' && restored.active && !restored.collapsed
            && restored.visibleButtons >= 10, JSON.stringify(restored));
        await page.context().close();
    }

    // config B: 320x320+48 — everything plus a real notebook slice.
    // The notebook gets REAL content including a TALL final cell, so the
    // max-scroll tail assertions below never test an empty notebook.
    page = await freshPage({ viewport: { width: 320, height: 320 } });
    await enableFormula(page);
    await page.evaluate(() => document.documentElement.style.setProperty('--safe-area-inset-bottom', '48px'));
    for (const md of ['# Intro\n\nshort', '# Tall final\n\n' + Array.from({ length: 25 }, (_, n) => 'line ' + n).join('\n\n')]) {
        await page.evaluate((v) => {
            const inp = document.getElementById('code-input');
            inp.value = v;
            inp.dispatchEvent(new Event('input', { bubbles: true }));
        }, md);
        const isMd = await page.evaluate(() => document.getElementById('cell-type-toggle').classList.contains('markdown-active'));
        if (!isMd) await page.click('#cell-type-toggle');
        await page.click('#run-btn');
        await page.waitForTimeout(200);
    }
    await page.click('#math-mode-btn');
    await growComposer();
    await page.waitForTimeout(350);
    const b320 = await boundaryProbe();
    check('320x320+48: composer and Run above the safe boundary', b320.composerOk && b320.runOk, JSON.stringify(b320));
    const bHits = await paletteFullRect();
    check(`320x320+48: all ${bHits.total} palette buttons full-rect hittable`,
        bHits.total >= 10 && bHits.ok === bHits.total, JSON.stringify(bHits));
    check('320x320+48: notebook slice GENUINELY visible (clipped intersection >= 20px)',
        b320.notebookVisible >= 20, String(b320.notebookVisible));

    // visual-viewport-ONLY keyboard shrink: innerHeight stays 320 while the
    // visual viewport drops to 200 — the footer must LIFT above the
    // overlaid keyboard. The stub is a REAL EventTarget so the component's
    // own 'scroll'/'resize' subscriptions are exercised.
    await page.evaluate(() => {
        document.documentElement.style.setProperty('--safe-area-inset-bottom', '0px');
        const stub = new EventTarget();
        stub.height = 200; stub.offsetTop = 0; stub.width = innerWidth;
        Object.defineProperty(window, 'visualViewport', { configurable: true, value: stub });
        window.mathMode._attachVisualViewportListeners();
        window.mathMode.publishPaletteSpace();
    });
    await page.waitForTimeout(350);
    const vvProbe = await boundaryProbe();
    check('visualViewport-only shrink to 200: composer and Run above the VISUAL boundary',
        vvProbe.composerOk && vvProbe.runOk && vvProbe.runBottom <= 201,
        JSON.stringify(vvProbe));
    // truthful notebook: the naive child∩app-body rect measure would still
    // report the area now covered by the LIFTED footer — the truthful
    // measure may not (this assertion fails under the old measurement)
    const truth = await page.evaluate(() => {
        const bar = document.getElementById('input-bar');
        const appBody = document.getElementById('app-body').getBoundingClientRect();
        const scroller = [...document.querySelectorAll('#repl, .repl-container')].find(e => e.offsetParent !== null);
        const r = scroller.getBoundingClientRect();
        const vv = window.visualViewport;
        const vvBottom = Math.min(innerHeight, vv.offsetTop + vv.height);
        const barTop = bar.getBoundingClientRect().top;
        const naive = Math.max(0, Math.min(r.bottom, appBody.bottom) - Math.max(r.top, appBody.top));
        const truthful = Math.max(0,
            Math.min(r.bottom, appBody.bottom, vvBottom, barTop) - Math.max(r.top, appBody.top, vv.offsetTop));
        return { naive: Math.round(naive), truthful: Math.round(truthful),
                 barTop: Math.round(barTop), appBodyTop: Math.round(appBody.top) };
    });
    check('truthful notebook measure subtracts the lifted-footer overlap',
        truth.truthful <= Math.max(0, truth.barTop - truth.appBodyTop) + 1
        && truth.naive >= truth.truthful,
        JSON.stringify(truth));
    // NOTE: since the app body now ABSORBS the lift (round 9), the naive
    // child-rect measure agrees with the truthful one in this state — the
    // discrepancy the truthful measure guarded against no longer exists in
    // the layout itself. The invariant that remains is one-sided:
    check('...and the naive rect measure never reads LESS than the truthful one',
        truth.naive >= truth.truthful, JSON.stringify(truth));
    // EVENTFUL pan: ONLY offsetTop changes, and only 'scroll' is
    // dispatched — the subscription itself must trigger the re-layout
    const panProbe = async (offsetTop) => {
        await page.evaluate((ot) => {
            const vv = window.visualViewport;
            vv.offsetTop = ot;
            vv.dispatchEvent(new Event('scroll'));
        }, offsetTop);
        await page.waitForTimeout(300);
        return page.evaluate(() => {
            const vv = window.visualViewport;
            const top = vv.offsetTop, bottom = vv.offsetTop + vv.height;
            const input = document.getElementById('code-input').getBoundingClientRect();
            const run = document.getElementById('run-btn').getBoundingClientRect();
            const btns = [...document.querySelectorAll('#math-palette button')]
                .filter(b => b.offsetParent !== null)
                .map(b => b.getBoundingClientRect());
            const inBand = (r) => r.top >= top - 1 && r.bottom <= bottom + 1;
            return {
                composerInBand: inBand(input), runInBand: inBand(run),
                buttonsInBand: btns.every(inBand), buttons: btns.length,
                band: [Math.round(top), Math.round(bottom)],
            };
        });
    };
    const panDown = await panProbe(60);
    check('pan DOWN (offsetTop 60, scroll event only): controls within both visual boundaries',
        panDown.composerInBand && panDown.runInBand && panDown.buttonsInBand,
        JSON.stringify(panDown));
    const panBack = await panProbe(0);
    check('pan BACK (offsetTop 0, scroll event only): controls within both visual boundaries',
        panBack.composerInBand && panBack.runInBand && panBack.buttonsInBand,
        JSON.stringify(panBack));

    // REPEATED pan events must not accumulate: 20 alternating scroll
    // events, then the reservation and geometry must equal the value
    // after the FIRST event (the old measurement fed its own padding back
    // into the next measurement and grew without bound)
    const reservationAfter = async (rounds) => {
        for (let n = 0; n < rounds; n++) {
            await page.evaluate((ot) => {
                const vv = window.visualViewport;
                vv.offsetTop = ot;
                vv.dispatchEvent(new Event('scroll'));
            }, n % 2 ? 60 : 0);
            await page.waitForTimeout(60);
        }
        return page.evaluate(() => {
            const scroller = [...document.querySelectorAll('#repl, .repl-container')].find(e => e.offsetParent !== null);
            return {
                reserve: parseInt(scroller.style.getPropertyValue('--footer-overlay-local')) || 0,
                appBodyH: Math.round(document.getElementById('app-body').getBoundingClientRect().height),
                scrollerH: Math.round(scroller.getBoundingClientRect().height),
            };
        });
    };
    const after2 = await reservationAfter(2);
    const after20 = await reservationAfter(18);   // 20 total
    check('20 pan events: footer reservation does NOT grow (P1 accumulation fixed)',
        after20.reserve === after2.reserve && after20.appBodyH === after2.appBodyH
        && after20.scrollerH === after2.scrollerH,
        JSON.stringify({ after2, after20 }));

    // panning the HEADER out of the visual band frees its space: a
    // palette collapsed for lack of room must RESTORE after the pan
    await page.evaluate(() => {
        const vv = window.visualViewport;
        vv.height = 180; vv.offsetTop = 0;
        vv.dispatchEvent(new Event('resize'));
    });
    await page.waitForTimeout(350);
    const beforePan = await page.evaluate(() => ({
        collapsed: document.getElementById('math-palette').classList.contains('space-collapsed'),
    }));
    check('vv 180 with header in band: palette collapsed (precondition)', beforePan.collapsed, JSON.stringify(beforePan));
    await page.evaluate(() => {
        const vv = window.visualViewport;
        vv.offsetTop = 90;                        // header (bottom ~80) now above the band
        vv.dispatchEvent(new Event('scroll'));
    });
    await page.waitForTimeout(350);
    const afterPan = await page.evaluate(() => ({
        collapsed: document.getElementById('math-palette').classList.contains('space-collapsed'),
        expanded: document.getElementById('math-mode-btn').getAttribute('aria-expanded'),
        visibleButtons: [...document.querySelectorAll('#math-palette button')].filter(b => b.offsetParent !== null).length,
    }));
    check('panning the header away RESTORES the palette (space is genuinely free)',
        !afterPan.collapsed && afterPan.expanded === 'true' && afterPan.visibleButtons >= 10,
        JSON.stringify(afterPan));

    // focus rescue: collapsing while a palette button has keyboard focus
    // must move focus to the Formula toggle, never drop it to <body>
    await page.evaluate(() => {
        [...document.querySelectorAll('#math-palette button')].find(b => b.offsetParent !== null).focus();
        const vv = window.visualViewport;
        vv.offsetTop = 0; vv.height = 180;        // back to the collapsing geometry
        vv.dispatchEvent(new Event('resize'));
    });
    await page.waitForTimeout(350);
    const focusProbe = await page.evaluate(() => ({
        collapsed: document.getElementById('math-palette').classList.contains('space-collapsed'),
        activeId: document.activeElement ? document.activeElement.id : null,
        onBody: document.activeElement === document.body,
    }));
    check('collapse with a focused palette button moves focus to the Formula toggle',
        focusProbe.collapsed && focusProbe.activeId === 'math-mode-btn' && !focusProbe.onBody,
        JSON.stringify(focusProbe));

    // the LIFTED footer must never hide the tail of the notebook at
    // maximum scroll: the app body absorbs the lift, so the last content
    // is either fully above the footer or the notebook is honestly empty
    for (let c = 0; c < 3; c++) {
        const cfg = [[0, 200], [60, 200], [0, 140]][c];
        await page.evaluate(({ ot, h }) => {
            const vv = window.visualViewport;
            vv.offsetTop = ot; vv.height = h;
            vv.dispatchEvent(new Event('scroll'));
        }, { ot: cfg[0], h: cfg[1] });
        await page.waitForTimeout(350);
        const tail = await page.evaluate(async () => {
            const scroller = [...document.querySelectorAll('#repl, .repl-container')].find(e => e.offsetParent !== null);
            scroller.style.scrollBehavior = 'auto';
            scroller.scrollTop = scroller.scrollHeight;
            await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
            const last = scroller.lastElementChild;
            const barTop = document.getElementById('input-bar').getBoundingClientRect().top;
            const notebookH = document.getElementById('app-body').getBoundingClientRect().height;
            const lastBottom = last ? last.getBoundingClientRect().bottom : 0;
            const cs = getComputedStyle(scroller);
            const padFloor = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
            return { hasContent: !!last && scroller.children.length >= 2,
                     ok: lastBottom <= barTop + 1 || notebookH <= 1,
                     scrollerOverflow: Math.round(scroller.getBoundingClientRect().bottom
                         - document.getElementById('app-body').getBoundingClientRect().bottom),
                     padFloor,
                     gap: Math.round(lastBottom - barTop), notebookH: Math.round(notebookH) };
        });
        check(`lifted footer @vv ${cfg[0]}/${cfg[1]}: REAL tall content, tail never half-hidden at max scroll`,
            tail.hasContent && tail.ok, JSON.stringify(tail));
        // the scroller may exceed the app body only by its incompressible
        // padding floor (a box can never shrink below its own padding);
        // anything beyond that means the flex chain stopped shrinking —
        // the wrapper bug that hid the tail on the previous head
        check(`lifted footer @vv ${cfg[0]}/${cfg[1]}: scroller shrink-tracks the app body (padding floor only)`,
            tail.scrollerOverflow <= tail.padFloor + 1, JSON.stringify({ o: tail.scrollerOverflow, floor: tail.padFloor }));
    }


    // config D: keyboard shrink where the platform CLEARS the inset
    await page.evaluate(() => {
        Object.defineProperty(window, 'visualViewport', { configurable: true, value: undefined });
        document.documentElement.style.setProperty('--safe-area-inset-bottom', '0px');
    });
    await page.setViewportSize({ width: 320, height: 180 });
    await page.waitForTimeout(350);
    const d180 = await boundaryProbe();
    check('keyboard shrink to 180 with the inset cleared: composer and Run stay usable',
        d180.composerOk && d180.runOk, JSON.stringify(d180));

    // destroy() detaches everything: after destroy, the toggle is inert
    // (runs LAST — it removes the listeners the other checks depend on)
    const destroyProbe = await page.evaluate(() => {
        window.mathMode.destroy();
        const before = document.getElementById('math-palette').classList.contains('hidden');
        document.getElementById('math-mode-btn').click();
        const after = document.getElementById('math-palette').classList.contains('hidden');
        return { inert: before === after };
    });
    check('destroy() detaches UI handlers (toggle click is inert afterwards)', destroyProbe.inert, JSON.stringify(destroyProbe));
    await page.context().close();

    console.log('5j. Tablet/desktop editor width restored (768/800/1024) + narrow phone');
    for (const width of [768, 800, 1024]) {
        page = await freshPage({ viewport: { width, height: 600 } });
        const geo = await page.evaluate(() => {
            const bar = document.getElementById('input-bar').getBoundingClientRect();
            const input = document.getElementById('code-input').getBoundingClientRect();
            return { barW: Math.round(bar.width), inputW: Math.round(input.width),
                     barLeft: Math.round(bar.left), barRight: Math.round(innerWidth - bar.right) };
        });
        check(`${width}px: footer takes full available width up to 720px cap`,
            geo.barW === Math.min(width, 720), JSON.stringify(geo));
        check(`${width}px: editor is wide (not collapsed)`, geo.inputW >= geo.barW - 220, JSON.stringify(geo));
        check(`${width}px: footer is centered`, Math.abs(geo.barLeft - geo.barRight) <= 2, JSON.stringify(geo));
        await page.context().close();
    }
    page = await freshPage({ viewport: { width: 320, height: 640 } });
    const phoneGeo = await page.evaluate(() => {
        const bar = document.getElementById('input-bar').getBoundingClientRect();
        const input = document.getElementById('code-input').getBoundingClientRect();
        return { barW: Math.round(bar.width), inputW: Math.round(input.width) };
    });
    check('narrow phone regression: footer spans the viewport', phoneGeo.barW === 320, JSON.stringify(phoneGeo));
    check('narrow phone regression: editor not collapsed', phoneGeo.inputW >= 130, JSON.stringify(phoneGeo));
    await page.context().close();

    console.log('5g. Landscape side insets, LTR and RTL — actual control rectangles');
    for (const dir of ['ltr', 'rtl']) {
        page = await freshPage({ viewport: { width: 640, height: 320 } });   // landscape
        const probe = await page.evaluate((d) => {
            document.documentElement.dir = d;
            document.documentElement.style.setProperty('--safe-area-inset-left', '30px');
            document.documentElement.style.setProperty('--safe-area-inset-right', '20px');
            const cs = getComputedStyle(document.getElementById('input-bar'));
            const hcs = getComputedStyle(document.getElementById('app-header'));
            // actual rectangles: every visible header control and the
            // composer/Run in the footer must respect the PHYSICAL insets
            const rects = [];
            const collect = (root, label) => {
                for (const el of root.querySelectorAll('button, select, textarea, h1')) {
                    if (el.offsetParent === null) continue;
                    const r = el.getBoundingClientRect();
                    if (r.width === 0) continue;
                    rects.push({ label: label + ':' + (el.id || el.tagName), left: r.left, right: r.right });
                }
            };
            collect(document.getElementById('app-header'), 'header');
            collect(document.querySelector('#input-bar .input-row') || document.getElementById('input-bar'), 'footer');
            const bad = rects.filter(r => r.left < 30 - 0.5 || r.right > innerWidth - 20 + 0.5).map(r => r.label);
            return {
                footerPad: { left: parseInt(cs.paddingLeft), right: parseInt(cs.paddingRight) },
                headerPad: { left: parseInt(hcs.paddingLeft), right: parseInt(hcs.paddingRight) },
                controls: rects.length,
                violations: bad,
            };
        }, dir);
        check(`footer side padding physical (${dir})`, probe.footerPad.left === 42 && probe.footerPad.right === 32, JSON.stringify(probe.footerPad));
        check(`header side padding physical (${dir})`, probe.headerPad.left === 46 && probe.headerPad.right === 36, JSON.stringify(probe.headerPad));
        check(`no header/footer control intrudes into the insets (${dir}, ${probe.controls} controls)`,
            probe.controls >= 4 && probe.violations.length === 0, probe.violations.join());
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
    check('all three lines report nothing installed',
        (netProbe.text.match(/nothing on this line was installed/g) || []).length >= 3);
    check('all three rejected lines FAIL their cell',
        (netProbe.text.match(/the rest of this cell was not executed/g) || []).length >= 3);
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
        const offlineMdMath = await p2.evaluate(() => typeof globalThis.MdMath === 'object' && !!globalThis.MdMath.stateAt)
            .catch(() => false);
        check('offline reload still has the shared MdMath tokenizer (precached)', offlineMdMath === true, String(offlineMdMath));
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
