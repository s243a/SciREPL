/**
 * export.js — HTML, Markdown, PDF, and DOCX export for SciREPL notebooks.
 * Scrapes cell content and output from the DOM since outputs are not persisted.
 */

class ExportManager {
    constructor() {
        this._docxLoaded = false;
    }

    /**
     * Syntax-highlight code using highlight.js if available.
     * Returns highlighted HTML string, or falls back to escaped HTML.
     */
    _highlightCode(code, language) {
        if (typeof window.hljs !== 'undefined') {
            // Map SciREPL language names to hljs names
            const langMap = { python: 'python', javascript: 'javascript', r: 'r', bash: 'bash', prolog: 'prolog' };
            const hljsLang = langMap[language];
            if (hljsLang && window.hljs.getLanguage(hljsLang)) {
                try {
                    return window.hljs.highlight(code, { language: hljsLang }).value;
                } catch (e) { /* fall through */ }
            }
        }
        return this._escapeHtml(code);
    }

    /**
     * Parse hljs-highlighted HTML into an array of { text, color } segments.
     * Used by DOCX export to create colored TextRuns.
     */
    _parseHljsTokens(highlightedHtml) {
        // Token class → color mapping (atom-one-dark inspired, but for light DOCX)
        const colorMap = {
            'hljs-keyword': '8B008B',      // dark magenta
            'hljs-built_in': 'B8860B',     // dark goldenrod
            'hljs-type': 'B8860B',
            'hljs-literal': '0000FF',      // blue
            'hljs-number': '098658',       // teal
            'hljs-string': 'A31515',       // dark red
            'hljs-regexp': 'A31515',
            'hljs-addition': 'A31515',
            'hljs-attribute': 'A31515',
            'hljs-comment': '008000',      // green
            'hljs-quote': '008000',
            'hljs-doctag': '8B008B',
            'hljs-formula': '8B008B',
            'hljs-section': '0000FF',
            'hljs-name': 'E06C75',
            'hljs-selector-tag': 'E06C75',
            'hljs-deletion': 'E06C75',
            'hljs-subst': 'E06C75',
            'hljs-meta': '4078F2',
            'hljs-title': '4078F2',
            'hljs-link': '4078F2',
            'hljs-symbol': '4078F2',
            'hljs-bullet': '4078F2',
            'hljs-variable': 'D19A66',
            'hljs-template-variable': 'D19A66',
            'hljs-selector-class': 'D19A66',
            'hljs-selector-attr': 'D19A66',
            'hljs-selector-pseudo': 'D19A66',
            'hljs-class': 'E6C07B',
            'hljs-title.class_': 'E6C07B'
        };

        const segments = [];
        // Use a regex to split on hljs spans
        // Handles: <span class="hljs-keyword">text</span> and plain text
        const spanRegex = /<span class="([^"]+)">([^<]*)<\/span>|([^<]+)/g;
        let match;
        while ((match = spanRegex.exec(highlightedHtml)) !== null) {
            if (match[1]) {
                // Span with class — find the first matching color
                const classes = match[1].split(' ');
                let color = null;
                for (const cls of classes) {
                    if (colorMap[cls]) { color = colorMap[cls]; break; }
                }
                // Unescape HTML entities in the text
                const text = match[2].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;/g, "'");
                segments.push({ text, color: color || '000000' });
            } else if (match[3]) {
                const text = match[3].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;/g, "'");
                segments.push({ text, color: '000000' });
            }
        }
        return segments;
    }

    // ── Helpers ──

    _escapeHtml(str) {
        return str
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    _getNotebookName() {
        if (window.notebookManager) {
            try {
                const nb = window.notebookManager.getActiveNotebook();
                if (nb && nb.name) return nb.name;
            } catch (e) { /* ignore */ }
        }
        return 'SciREPL Notebook';
    }

    _getTimestamp() {
        return new Date().toLocaleString();
    }

    // ── Image Helpers ──

    /**
     * Convert any image src (blob: or data: URL) to a Uint8Array.
     */
    async _srcToBytes(src) {
        if (src.startsWith('blob:')) {
            const resp = await fetch(src);
            const buf = await resp.arrayBuffer();
            return new Uint8Array(buf);
        }
        const base64 = src.split(',')[1];
        if (!base64) return null;
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return bytes;
    }

    /**
     * Convert any image src (blob: or data: URL) to a data URL.
     */
    async _srcToDataURL(src) {
        if (!src.startsWith('blob:')) return src;
        const resp = await fetch(src);
        const blob = await resp.blob();
        return new Promise(r => {
            const fr = new FileReader();
            fr.onload = () => r(fr.result);
            fr.readAsDataURL(blob);
        });
    }

    // ── DOM Scraping ──

    /**
     * Walk window._cells and extract structured data from the live DOM.
     * Returns array of { id, type, language, code, outputs[] }.
     */
    _scrapeCells() {
        const cells = window._cells || [];
        if (cells.length === 0) return [];

        const results = [];

        for (const cell of cells) {
            const scraped = {
                id: cell.id,
                type: cell.type || 'code',
                language: cell.language || 'python',
                code: cell.code || '',
                outputs: []
            };

            const outputCard = cell.outputCard;
            if (!outputCard) {
                results.push(scraped);
                continue;
            }

            const body = outputCard.querySelector('.card-body');
            if (!body) {
                results.push(scraped);
                continue;
            }

            // Markdown cell — the body itself has class markdown-body
            if (body.classList.contains('markdown-body')) {
                scraped.outputs.push({ kind: 'markdown', html: body.innerHTML });
                results.push(scraped);
                continue;
            }

            // Walk children of .card-body
            for (const child of body.children) {
                if (child.matches('pre.text-result')) {
                    scraped.outputs.push({ kind: 'text', content: child.textContent });
                } else if (child.matches('pre.error-result')) {
                    scraped.outputs.push({ kind: 'error', content: child.textContent });
                } else if (child.classList.contains('latex-result')) {
                    scraped.outputs.push({ kind: 'latex', html: child.innerHTML, element: child });
                } else if (child.tagName === 'TABLE') {
                    scraped.outputs.push({ kind: 'table', html: child.outerHTML, element: child });
                } else if (child.tagName === 'IMG') {
                    scraped.outputs.push({ kind: 'image', src: child.src });
                } else if (child.classList.contains('plot-container')) {
                    scraped.outputs.push({ kind: 'plot', element: child });
                }
            }

            results.push(scraped);
        }

        return results;
    }

    // ── Plotly Screenshot ──

    /**
     * Convert a Plotly plot container to a PNG data URL.
     * Tries canvas first (WebGL), then SVG serialization.
     */
    async _plotToImage(plotContainer) {
        // Try canvas (WebGL mode)
        const canvas = plotContainer.querySelector('canvas');
        if (canvas) {
            try {
                return canvas.toDataURL('image/png');
            } catch (e) { /* tainted canvas, fall through */ }
        }

        // SVG serialization
        const svg = plotContainer.querySelector('.main-svg');
        if (!svg) return null;

        const svgClone = svg.cloneNode(true);
        // Ensure SVG has width/height attributes
        const rect = svg.getBoundingClientRect();
        svgClone.setAttribute('width', rect.width);
        svgClone.setAttribute('height', rect.height);

        const svgData = new XMLSerializer().serializeToString(svgClone);
        const svgBlob = new Blob([svgData], { type: 'image/svg+xml;charset=utf-8' });
        const url = URL.createObjectURL(svgBlob);

        return new Promise((resolve) => {
            const img = new Image();
            img.onload = () => {
                const c = document.createElement('canvas');
                c.width = img.naturalWidth || rect.width;
                c.height = img.naturalHeight || rect.height;
                const ctx = c.getContext('2d');
                ctx.drawImage(img, 0, 0);
                URL.revokeObjectURL(url);
                resolve(c.toDataURL('image/png'));
            };
            img.onerror = () => {
                URL.revokeObjectURL(url);
                resolve(null);
            };
            img.src = url;
        });
    }

    // ── Extract TeX from KaTeX ──

    _extractTexFromKaTeX(latexEl) {
        if (latexEl.dataset && latexEl.dataset.tex) return latexEl.dataset.tex;
        const annotation = latexEl.querySelector('annotation[encoding="application/x-tex"]');
        if (annotation) return annotation.textContent;
        return latexEl.textContent.trim();
    }

    // ── TeX → OMML (Office Math Markup Language) ──

    /**
     * Convert a TeX string to an OMML object for docx export.
     * Pipeline: TeX → KaTeX MathML → DOMParser → walk MathML → OMML objects.
     * Returns a prepForXml-compatible object or null on failure.
     */
    _texToOmml(texStr) {
        try {
            if (typeof katex === 'undefined') return null;
            const html = katex.renderToString(texStr, { output: 'mathml', throwOnError: false });
            const doc = new DOMParser().parseFromString(html, 'text/html');
            const mathEl = doc.querySelector('math');
            if (!mathEl) return null;
            const children = this._walkMathML(mathEl);
            if (!children || children.length === 0) return null;
            return {
                'm:oMathPara': [
                    { _attr: { 'xmlns:m': 'http://schemas.openxmlformats.org/officeDocument/2006/math' } },
                    { 'm:oMath': children }
                ]
            };
        } catch (e) {
            return null;
        }
    }

    /**
     * Recursively walk a MathML DOM subtree and return an array of
     * OMML-compatible objects (prepForXml format used by docx.js).
     */
    _walkMathML(node) {
        const results = [];
        for (const child of node.childNodes) {
            if (child.nodeType === 3) { // text node
                const text = child.textContent.trim();
                if (text) results.push({ 'm:r': [{ 'm:t': [text] }] });
                continue;
            }
            if (child.nodeType !== 1) continue;
            const tag = (child.localName || child.tagName || '').toLowerCase();

            switch (tag) {
                case 'math':
                case 'mrow':
                case 'mstyle':
                case 'mpadded':
                    results.push(...this._walkMathML(child));
                    break;

                case 'semantics':
                    for (const sc of child.children) {
                        const st = (sc.localName || sc.tagName || '').toLowerCase();
                        if (st !== 'annotation') results.push(...this._walkMathML(sc));
                    }
                    break;

                case 'mi': case 'mn': case 'mo':
                    if (child.textContent) {
                        results.push({ 'm:r': [{ 'm:t': [child.textContent] }] });
                    }
                    break;

                case 'mtext':
                    if (child.textContent) {
                        results.push({
                            'm:r': [
                                { 'm:rPr': [{ 'm:nor': [] }] },
                                { 'm:t': [child.textContent] }
                            ]
                        });
                    }
                    break;

                case 'mfrac': {
                    const kids = [...child.children];
                    results.push({
                        'm:f': [
                            { 'm:num': kids[0] ? this._walkMathML(kids[0]) : [] },
                            { 'm:den': kids[1] ? this._walkMathML(kids[1]) : [] }
                        ]
                    });
                    break;
                }

                case 'msup': {
                    const kids = [...child.children];
                    results.push({
                        'm:sSup': [
                            { 'm:sSupPr': [] },
                            { 'm:e': kids[0] ? this._walkMathML(kids[0]) : [] },
                            { 'm:sup': kids[1] ? this._walkMathML(kids[1]) : [] }
                        ]
                    });
                    break;
                }

                case 'msub': {
                    const kids = [...child.children];
                    results.push({
                        'm:sSub': [
                            { 'm:sSubPr': [] },
                            { 'm:e': kids[0] ? this._walkMathML(kids[0]) : [] },
                            { 'm:sub': kids[1] ? this._walkMathML(kids[1]) : [] }
                        ]
                    });
                    break;
                }

                case 'msubsup': {
                    const kids = [...child.children];
                    const baseTag0 = kids[0] ? (kids[0].localName || kids[0].tagName || '').toLowerCase() : '';
                    const baseText0 = kids[0] ? kids[0].textContent.trim() : '';
                    const naryChars = '\u2211\u222B\u220F\u2210\u22C3\u22C2\u22C1\u22C0\u222E\u222F\u2230\u222C\u222D';
                    if (baseTag0 === 'mo' && naryChars.includes(baseText0)) {
                        results.push({
                            'm:nary': [
                                { 'm:naryPr': [
                                    { 'm:chr': [{ _attr: { 'm:val': baseText0 } }] },
                                    { 'm:limLoc': [{ _attr: { 'm:val': 'subSup' } }] }
                                ]},
                                { 'm:sub': kids[1] ? this._walkMathML(kids[1]) : [] },
                                { 'm:sup': kids[2] ? this._walkMathML(kids[2]) : [] },
                                { 'm:e': [] }
                            ]
                        });
                    } else {
                        results.push({
                            'm:sSubSup': [
                                { 'm:sSubSupPr': [] },
                                { 'm:e': kids[0] ? this._walkMathML(kids[0]) : [] },
                                { 'm:sub': kids[1] ? this._walkMathML(kids[1]) : [] },
                                { 'm:sup': kids[2] ? this._walkMathML(kids[2]) : [] }
                            ]
                        });
                    }
                    break;
                }

                case 'msqrt':
                    results.push({
                        'm:rad': [
                            { 'm:radPr': [{ 'm:degHide': [{ _attr: { 'm:val': '1' } }] }] },
                            { 'm:deg': [] },
                            { 'm:e': this._walkMathML(child) }
                        ]
                    });
                    break;

                case 'mroot': {
                    const kids = [...child.children];
                    results.push({
                        'm:rad': [
                            { 'm:radPr': [] },
                            { 'm:deg': kids[1] ? this._walkMathML(kids[1]) : [] },
                            { 'm:e': kids[0] ? this._walkMathML(kids[0]) : [] }
                        ]
                    });
                    break;
                }

                case 'mover': case 'munder': case 'munderover': {
                    const kids = [...child.children];
                    const baseTag = kids[0] ? (kids[0].localName || kids[0].tagName || '').toLowerCase() : '';
                    const baseText = kids[0] ? kids[0].textContent.trim() : '';
                    const naryOps = '\u2211\u222B\u220F\u2210\u22C3\u22C2\u22C1\u22C0\u222E\u222F\u2230\u222C\u222D';
                    if (baseTag === 'mo' && naryOps.includes(baseText)) {
                        // Nary operator (sum, integral, product, etc.)
                        const nary = [
                            { 'm:naryPr': [
                                { 'm:chr': [{ _attr: { 'm:val': baseText } }] },
                                { 'm:limLoc': [{ _attr: { 'm:val': 'undOvr' } }] }
                            ]}
                        ];
                        if (tag === 'munder') {
                            nary.push({ 'm:sub': kids[1] ? this._walkMathML(kids[1]) : [] });
                            nary.push({ 'm:sup': [] });
                        } else if (tag === 'mover') {
                            nary.push({ 'm:sub': [] });
                            nary.push({ 'm:sup': kids[1] ? this._walkMathML(kids[1]) : [] });
                        } else {
                            nary.push({ 'm:sub': kids[1] ? this._walkMathML(kids[1]) : [] });
                            nary.push({ 'm:sup': kids[2] ? this._walkMathML(kids[2]) : [] });
                        }
                        nary.push({ 'm:e': [] });
                        results.push({ 'm:nary': nary });
                    } else if (tag === 'mover') {
                        // Accent (hat, tilde, bar, etc.)
                        const accChar = kids[1] ? kids[1].textContent.trim() : '';
                        results.push({
                            'm:acc': [
                                { 'm:accPr': [{ 'm:chr': [{ _attr: { 'm:val': accChar } }] }] },
                                { 'm:e': kids[0] ? this._walkMathML(kids[0]) : [] }
                            ]
                        });
                    } else if (tag === 'munder') {
                        results.push({
                            'm:limLow': [
                                { 'm:e': kids[0] ? this._walkMathML(kids[0]) : [] },
                                { 'm:lim': kids[1] ? this._walkMathML(kids[1]) : [] }
                            ]
                        });
                    } else {
                        // munderover without nary — render children inline
                        results.push(...this._walkMathML(child));
                    }
                    break;
                }

                case 'mfenced': {
                    const open = child.getAttribute('open') || '(';
                    const close = child.getAttribute('close') || ')';
                    results.push({ 'm:r': [{ 'm:t': [open] }] });
                    results.push(...this._walkMathML(child));
                    results.push({ 'm:r': [{ 'm:t': [close] }] });
                    break;
                }

                case 'mtable': {
                    const rows = [];
                    for (const tr of child.children) {
                        const trTag = (tr.localName || tr.tagName || '').toLowerCase();
                        if (trTag === 'mtr' || trTag === 'mlabeledtr') {
                            const cells = [];
                            for (const td of tr.children) {
                                const tdTag = (td.localName || td.tagName || '').toLowerCase();
                                if (tdTag === 'mtd') cells.push({ 'm:e': this._walkMathML(td) });
                            }
                            rows.push({ 'm:mr': cells });
                        }
                    }
                    if (rows.length > 0) {
                        results.push({ 'm:m': [{ 'm:mPr': [] }, ...rows] });
                    }
                    break;
                }

                case 'merror':
                    if (child.textContent.trim()) {
                        results.push({ 'm:r': [{ 'm:t': [child.textContent.trim()] }] });
                    }
                    break;

                case 'mspace': case 'mphantom': case 'annotation':
                case 'none':
                    break;

                default:
                    if (child.children && child.children.length > 0) {
                        results.push(...this._walkMathML(child));
                    } else if (child.textContent && child.textContent.trim()) {
                        results.push({ 'm:r': [{ 'm:t': [child.textContent.trim()] }] });
                    }
                    break;
            }
        }
        return results;
    }

    // ── HTML Table → Markdown Table ──

    _htmlTableToMarkdown(tableEl) {
        const headers = [];
        const rows = [];

        const thEls = tableEl.querySelectorAll('thead th');
        thEls.forEach(th => headers.push(th.textContent.trim()));

        const trEls = tableEl.querySelectorAll('tbody tr');
        trEls.forEach(tr => {
            const cells = [];
            tr.querySelectorAll('td').forEach(td => cells.push(td.textContent.trim()));
            rows.push(cells);
        });

        if (headers.length === 0 && rows.length === 0) return '';

        let md = '';
        if (headers.length > 0) {
            md += '| ' + headers.join(' | ') + ' |\n';
            md += '| ' + headers.map(() => '---').join(' | ') + ' |\n';
        }
        rows.forEach(row => {
            md += '| ' + row.join(' | ') + ' |\n';
        });
        return md;
    }

    // ── CSS for HTML Export ──

    _getExportCSS(theme, pageBg, margins) {
        const darkVars = `
    --bg-primary: #0d1117;
    --bg-secondary: #161b22;
    --bg-card: #1c2128;
    --bg-input: #0d1117;
    --border: #30363d;
    --text-primary: #e6edf3;
    --text-secondary: #8b949e;
    --text-muted: #484f58;
    --accent: #58a6ff;
    --green: #3fb950;
    --red: #f85149;`;

        const lightVars = `
    --bg-primary: #ffffff;
    --bg-secondary: #f6f8fa;
    --bg-card: #f0f2f5;
    --bg-input: #ffffff;
    --border: #d0d7de;
    --text-primary: #1f2328;
    --text-secondary: #656d76;
    --text-muted: #8b949e;
    --accent: #0969da;
    --green: #1a7f37;
    --red: #cf222e;`;

        const vars = theme === 'light' ? lightVars : darkVars;
        // "browser" theme = dark vars but let browser decide on print (no print-color-adjust)
        const forceColors = theme !== 'browser';

        // Page background: white, dark (#0d1117), or browser decides (no explicit bg)
        const pageBgColor = pageBg === 'dark' ? '#0d1117'
            : pageBg === 'browser' ? undefined
            : '#ffffff';

        return `
:root {${vars}
    --font-mono: 'Fira Code', 'Cascadia Code', 'JetBrains Mono', 'SF Mono', Consolas, monospace;
    --font-sans: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', Helvetica, Arial, sans-serif;
    --radius: 10px;
}

* { margin: 0; padding: 0; box-sizing: border-box; }

body {${pageBgColor ? `
    background: ${pageBgColor};` : ''}
    color: var(--text-primary);
    font-family: var(--font-sans);
    font-size: 15px;
    padding: ${pageBg === 'dark' ? '20px' : '0'};
    max-width: 900px;
    margin: 0 auto;${forceColors ? `
    print-color-adjust: exact;
    -webkit-print-color-adjust: exact;` : ''}
}

.export-header {
    margin-bottom: 24px;
    padding-bottom: 16px;
    border-bottom: 1px solid var(--border);
}

.export-header h1 {
    font-size: 22px;
    background: linear-gradient(135deg, var(--accent), #a371f7);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-clip: text;
}

.export-meta {
    font-size: 12px;
    color: var(--text-muted);
    margin-top: 4px;
}

.cell-group {
    margin-bottom: 16px;
}

.cell-input {
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    overflow: hidden;
    margin-bottom: 4px;
}

.cell-label {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 12px;
    font-size: 11px;
    color: var(--text-muted);
    font-family: var(--font-mono);
    border-bottom: 1px solid var(--border);
}

.cell-label .prompt-icon {
    color: var(--accent);
    font-weight: 700;
}

.cell-code {
    padding: 10px 12px;
    font-family: var(--font-mono);
    font-size: 13px;
    line-height: 1.5;
    color: var(--text-primary);
    white-space: pre-wrap;
    word-break: break-word;
    margin: 0;
}

.cell-output {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    overflow: hidden;
    padding: 10px 12px;
}

.cell-output .text-result {
    font-family: var(--font-mono);
    font-size: 13px;
    line-height: 1.5;
    color: var(--green);
    white-space: pre-wrap;
    word-break: break-word;
    margin: 0;
}

.cell-output .error-result {
    font-family: var(--font-mono);
    font-size: 13px;
    line-height: 1.5;
    color: var(--red);
    white-space: pre-wrap;
    word-break: break-word;
    margin: 0;
}

.cell-output .latex-result {
    padding: 8px 0;
    overflow-x: auto;
    font-size: 18px;
    text-align: center;
}

.cell-output table {
    width: 100%;
    border-collapse: collapse;
    font-family: var(--font-mono);
    font-size: 12px;
}

.cell-output table th,
.cell-output table td {
    padding: 5px 8px;
    border: 1px solid var(--border);
    text-align: right;
}

.cell-output table th {
    background: var(--bg-secondary);
    color: var(--accent);
    font-weight: 600;
}

.cell-output img {
    max-width: 100%;
    border-radius: 6px;
    margin: 4px 0;
}

.lang-badge {
    font-size: 9px;
    padding: 1px 5px;
    border-radius: 4px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
}

.lang-badge.lang-python  { color: #3fb950; background: rgba(63,185,80,0.1);  border: 1px solid rgba(63,185,80,0.3); }
.lang-badge.lang-prolog  { color: #f0883e; background: rgba(240,136,62,0.1); border: 1px solid rgba(240,136,62,0.3); }
.lang-badge.lang-bash    { color: #4ec9b0; background: rgba(78,201,176,0.1); border: 1px solid rgba(78,201,176,0.3); }
.lang-badge.lang-javascript { color: #f0d050; background: rgba(240,208,80,0.1); border: 1px solid rgba(240,208,80,0.3); }
.lang-badge.lang-r       { color: #4E7FB4; background: rgba(78,127,180,0.1); border: 1px solid rgba(78,127,180,0.3); }

/* Markdown rendered output */
.markdown-body {
    font-family: var(--font-sans);
    font-size: 14px;
    line-height: 1.7;
    color: var(--text-primary);
}
.markdown-body h1, .markdown-body h2, .markdown-body h3, .markdown-body h4 {
    margin: 16px 0 8px; color: var(--text-primary); font-weight: 600;
}
.markdown-body h1 { font-size: 22px; border-bottom: 1px solid var(--border); padding-bottom: 6px; }
.markdown-body h2 { font-size: 18px; }
.markdown-body h3 { font-size: 16px; }
.markdown-body p { margin: 8px 0; }
.markdown-body strong { color: var(--text-primary); font-weight: 600; }
.markdown-body em { color: var(--text-secondary); }
.markdown-body code {
    font-family: var(--font-mono); font-size: 13px;
    background: var(--bg-secondary); padding: 2px 6px; border-radius: 4px; color: var(--accent);
}
.markdown-body pre {
    background: var(--bg-input); border: 1px solid var(--border); border-radius: 8px;
    padding: 12px; overflow-x: auto; font-family: var(--font-mono); font-size: 12px;
    line-height: 1.5; margin: 8px 0;
}
.markdown-body pre code { background: none; padding: 0; color: var(--text-primary); }
.markdown-body ul, .markdown-body ol { padding-left: 24px; margin: 8px 0; }
.markdown-body li { margin: 4px 0; }
.markdown-body blockquote {
    border-left: 3px solid var(--accent); margin: 8px 0; padding: 4px 16px;
    color: var(--text-secondary); background: rgba(88,166,255,0.05); border-radius: 0 6px 6px 0;
}
.markdown-body a { color: var(--accent); text-decoration: none; }
.markdown-body table { width: 100%; border-collapse: collapse; margin: 8px 0; font-size: 13px; }
.markdown-body table th, .markdown-body table td {
    padding: 6px 10px; border: 1px solid var(--border); text-align: left;
}
.markdown-body table th { background: var(--bg-secondary); font-weight: 600; }

/* Syntax highlighting (highlight.js) */
${theme === 'light' ? `
/* atom-one-light */
.hljs-comment,.hljs-quote{color:#a0a1a7;font-style:italic}
.hljs-doctag,.hljs-formula,.hljs-keyword{color:#a626a4}
.hljs-deletion,.hljs-name,.hljs-section,.hljs-selector-tag,.hljs-subst{color:#e45649}
.hljs-literal{color:#0184bb}
.hljs-addition,.hljs-attribute,.hljs-meta .hljs-string,.hljs-regexp,.hljs-string{color:#50a14f}
.hljs-attr,.hljs-number,.hljs-selector-attr,.hljs-selector-class,.hljs-selector-pseudo,.hljs-template-variable,.hljs-type,.hljs-variable{color:#986801}
.hljs-bullet,.hljs-link,.hljs-meta,.hljs-selector-id,.hljs-symbol,.hljs-title{color:#4078f2}
.hljs-built_in,.hljs-class .hljs-title,.hljs-title.class_{color:#c18401}
` : `
/* atom-one-dark */
.hljs-comment,.hljs-quote{color:#5c6370;font-style:italic}
.hljs-doctag,.hljs-formula,.hljs-keyword{color:#c678dd}
.hljs-deletion,.hljs-name,.hljs-section,.hljs-selector-tag,.hljs-subst{color:#e06c75}
.hljs-literal{color:#56b6c2}
.hljs-addition,.hljs-attribute,.hljs-meta .hljs-string,.hljs-regexp,.hljs-string{color:#98c379}
.hljs-attr,.hljs-number,.hljs-selector-attr,.hljs-selector-class,.hljs-selector-pseudo,.hljs-template-variable,.hljs-type,.hljs-variable{color:#d19a66}
.hljs-bullet,.hljs-link,.hljs-meta,.hljs-selector-id,.hljs-symbol,.hljs-title{color:#61aeee}
.hljs-built_in,.hljs-class .hljs-title,.hljs-title.class_{color:#e6c07b}
`}.hljs-emphasis{font-style:italic}
.hljs-strong{font-weight:700}

/* Print overrides */
@media print {
    @page { ${margins && margins.type === 'print' ? `margin: ${margins.top}${margins.unit} ${margins.right}${margins.unit} ${margins.bottom}${margins.unit} ${margins.left}${margins.unit};` : margins && margins.type === 'virtual' ? 'margin: 0;' : pageBg === 'dark' ? 'margin: 0;' : ''} }
    ${margins && margins.type === 'virtual' ? `body { padding: ${margins.top}${margins.unit} ${margins.right}${margins.unit} ${margins.bottom}${margins.unit} ${margins.left}${margins.unit}; }` : ''}
    .cell-group { break-inside: avoid; }
    .export-header h1 {
        background: none;
        -webkit-text-fill-color: var(--accent);
        color: var(--accent);
    }
}
`;
    }

    // ── Build HTML String ──

    /**
     * Build the complete HTML document.
     * @param {Object} opts
     * @param {boolean} opts.embedImages - true = inline base64, false = image refs
     * @returns {{ html: string, images: Array<{name: string, data: Uint8Array}> }}
     */
    async _buildHTMLString(opts = {}) {
        const embedImages = opts.embedImages !== false;
        const options = { theme: opts.theme || 'keep', ...opts };
        const cells = this._scrapeCells();
        const name = this._getNotebookName();
        const images = []; // for zip mode
        let imageCounter = 0;

        let cellsHtml = '';

        for (const cell of cells) {
            cellsHtml += '<div class="cell-group">\n';

            if (cell.type === 'markdown') {
                // Markdown cell — show rendered output only
                const mdHtml = cell.outputs.length > 0 && cell.outputs[0].kind === 'markdown'
                    ? cell.outputs[0].html : '';
                cellsHtml += `<div class="cell-output"><div class="markdown-body">${mdHtml}</div></div>\n`;
            } else {
                // Code cell — input + output
                const langBadge = `<span class="lang-badge lang-${cell.language}">${cell.language}</span>`;
                cellsHtml += `<div class="cell-input">
  <div class="cell-label"><span class="prompt-icon">In [${cell.id}]</span> ${langBadge}</div>
  <pre class="cell-code"><code>${this._highlightCode(cell.code, cell.language)}</code></pre>
</div>\n`;

                if (cell.outputs.length > 0) {
                    cellsHtml += '<div class="cell-output">\n';

                    for (const out of cell.outputs) {
                        switch (out.kind) {
                            case 'text':
                                cellsHtml += `<pre class="text-result">${this._escapeHtml(out.content)}</pre>\n`;
                                break;
                            case 'error':
                                cellsHtml += `<pre class="error-result">${this._escapeHtml(out.content)}</pre>\n`;
                                break;
                            case 'latex':
                                cellsHtml += `<div class="latex-result">${out.html}</div>\n`;
                                break;
                            case 'table':
                                cellsHtml += out.html + '\n';
                                break;
                            case 'image': {
                                if (embedImages) {
                                    const imgSrc = await this._srcToDataURL(out.src);
                                    cellsHtml += `<img src="${imgSrc}" alt="Output image">\n`;
                                } else {
                                    imageCounter++;
                                    const imgName = `image_${imageCounter}.png`;
                                    cellsHtml += `<img src="images/${imgName}" alt="Output image">\n`;
                                    const bytes = await this._srcToBytes(out.src);
                                    if (bytes) images.push({ name: imgName, data: bytes });
                                }
                                break;
                            }
                            case 'plot': {
                                const dataUrl = await this._plotToImage(out.element);
                                if (dataUrl) {
                                    if (embedImages) {
                                        cellsHtml += `<img src="${dataUrl}" alt="Plot">\n`;
                                    } else {
                                        imageCounter++;
                                        const imgName = `plot_${imageCounter}.png`;
                                        cellsHtml += `<img src="images/${imgName}" alt="Plot">\n`;
                                        const base64 = dataUrl.split(',')[1];
                                        const binary = atob(base64);
                                        const bytes = new Uint8Array(binary.length);
                                        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
                                        images.push({ name: imgName, data: bytes });
                                    }
                                } else {
                                    cellsHtml += '<p style="color:var(--text-muted);font-style:italic;">[Plotly chart — screenshot unavailable]</p>\n';
                                }
                                break;
                            }
                            case 'markdown':
                                cellsHtml += `<div class="markdown-body">${out.html}</div>\n`;
                                break;
                        }
                    }
                    cellsHtml += '</div>\n';
                }
            }

            cellsHtml += '</div>\n';
        }

        // Build KaTeX CSS (stripped of @font-face)
        let katexCSS = '';
        try {
            for (const sheet of document.styleSheets) {
                if (sheet.href && sheet.href.includes('katex')) {
                    const rules = [];
                    for (const rule of sheet.cssRules) {
                        if (rule.type !== CSSRule.FONT_FACE_RULE) {
                            rules.push(rule.cssText);
                        }
                    }
                    katexCSS = rules.join('\n');
                    break;
                }
            }
        } catch (e) {
            // CORS or other issue reading stylesheets
        }

        const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${this._escapeHtml(name)}</title>
<style>${this._getExportCSS(options.theme, options.pageBg, options.margins)}</style>
${katexCSS ? '<style>' + katexCSS + '</style>' : ''}
</head>
<body>
<header class="export-header">
<h1>${this._escapeHtml(name)}</h1>
<p class="export-meta">Exported from SciREPL on ${this._getTimestamp()}</p>
</header>
<main class="export-cells">
${cellsHtml}
</main>
</body>
</html>`;

        return { html, images };
    }

    // ── HTML Export ──

    async exportHTML(opts = {}) {
        const cells = this._scrapeCells();
        if (cells.length === 0) {
            alert('No cells to export.');
            return;
        }

        const embedImages = opts.embedImages !== undefined ? opts.embedImages : true;
        const baseName = this._getNotebookName().replace(/[^a-zA-Z0-9_-]/g, '_');

        const theme = opts.theme || 'keep';
        const pageBg = opts.pageBg || 'white';

        if (embedImages) {
            const { html } = await this._buildHTMLString({ embedImages: true, theme, pageBg });
            await this._downloadFile(baseName + '.html', html, 'text/html');
        } else {
            // Zip mode
            const { html, images } = await this._buildHTMLString({ embedImages: false, theme, pageBg });

            if (typeof JSZip === 'undefined') {
                alert('JSZip not loaded. Cannot create zip archive.');
                return;
            }

            const zip = new JSZip();
            zip.file('index.html', html);

            if (images.length > 0) {
                const imgFolder = zip.folder('images');
                for (const img of images) {
                    imgFolder.file(img.name, img.data);
                }
            }

            const blob = await zip.generateAsync({ type: 'blob' });
            this._downloadBlob(baseName + '.html.zip', blob);
        }
    }

    // ── Markdown Export ──

    async exportMarkdown(opts = {}) {
        const cells = this._scrapeCells();
        if (cells.length === 0) {
            alert('No cells to export.');
            return;
        }

        const embedImages = opts.embedImages !== undefined ? opts.embedImages : false;
        const images = [];
        let imageCounter = 0;

        const name = this._getNotebookName();
        let md = `# ${name}\n\n`;
        md += `*Exported from SciREPL on ${this._getTimestamp()}*\n\n---\n\n`;

        for (const cell of cells) {
            if (cell.type === 'markdown') {
                // Raw markdown source
                md += cell.code + '\n\n';
                continue;
            }

            // Code cell
            md += `**In [${cell.id}]** *(${cell.language})*\n\n`;
            md += '```' + cell.language + '\n' + cell.code + '\n```\n\n';

            for (const out of cell.outputs) {
                switch (out.kind) {
                    case 'text':
                        md += '**Output:**\n\n```\n' + out.content + '\n```\n\n';
                        break;
                    case 'error':
                        md += '**Error:**\n\n```\n' + out.content + '\n```\n\n';
                        break;
                    case 'latex': {
                        const tex = this._extractTexFromKaTeX(out.element || this._parseHtmlFragment(out.html));
                        md += '$$\n' + tex + '\n$$\n\n';
                        break;
                    }
                    case 'table': {
                        const tableEl = out.element || this._parseHtmlFragment(out.html);
                        const tableMd = this._htmlTableToMarkdown(tableEl);
                        if (tableMd) {
                            md += tableMd + '\n';
                        }
                        break;
                    }
                    case 'image':
                        if (embedImages) {
                            const imgSrc = await this._srcToDataURL(out.src);
                            md += `![Output image](${imgSrc})\n\n`;
                        } else {
                            imageCounter++;
                            const imgName = `image_${imageCounter}.png`;
                            md += `![Output image](images/${imgName})\n\n`;
                            const bytes = await this._srcToBytes(out.src);
                            if (bytes) images.push({ name: imgName, data: bytes });
                        }
                        break;
                    case 'plot':
                        if (!embedImages && out.element && typeof Plotly !== 'undefined') {
                            try {
                                const dataUrl = await Plotly.toImage(out.element, { format: 'png', width: 800, height: 500 });
                                imageCounter++;
                                const imgName = `plot_${imageCounter}.png`;
                                md += `![Plot](images/${imgName})\n\n`;
                                const base64 = dataUrl.split(',')[1];
                                const binary = atob(base64);
                                const bytes = new Uint8Array(binary.length);
                                for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
                                images.push({ name: imgName, data: bytes });
                            } catch (_) {
                                md += '*[Interactive Plotly chart]*\n\n';
                            }
                        } else {
                            md += '*[Interactive Plotly chart]*\n\n';
                        }
                        break;
                    case 'markdown':
                        // Already handled above for markdown cells
                        break;
                }
            }

            md += '---\n\n';
        }

        const baseName = name.replace(/[^a-zA-Z0-9_-]/g, '_');

        if (!embedImages) {
            // Always zip when user chose "Separate files" mode
            if (typeof JSZip === 'undefined') {
                alert('JSZip not loaded. Cannot create zip archive.');
                return;
            }
            const zip = new JSZip();
            zip.file(baseName + '.md', md);
            if (images.length > 0) {
                const imgFolder = zip.folder('images');
                for (const img of images) {
                    imgFolder.file(img.name, img.data);
                }
            }
            const blob = await zip.generateAsync({ type: 'blob' });
            this._downloadBlob(baseName + '.md.zip', blob);
        } else {
            await this._downloadFile(baseName + '.md', md, 'text/markdown');
        }
    }

    /** Parse an HTML string into a detached element for querying. */
    _parseHtmlFragment(html) {
        const tpl = document.createElement('template');
        tpl.innerHTML = html;
        return tpl.content.firstElementChild || tpl.content;
    }

    // ── PDF Export ──

    async exportPDF(opts = {}) {
        const cells = this._scrapeCells();
        if (cells.length === 0) {
            alert('No cells to export.');
            return;
        }

        const theme = opts.theme || 'keep';
        const pageBg = opts.pageBg || 'white';
        const margins = opts.margins || null;
        const { html } = await this._buildHTMLString({ embedImages: true, theme, pageBg, margins });
        const name = this._getNotebookName();

        // Capacitor/Android: use PDF generator plugin (avoids WebView print issues)
        if (window.Capacitor && Capacitor.Plugins && Capacitor.Plugins.PdfGenerator) {
            try {
                const baseName = name.replace(/[^a-zA-Z0-9_-]/g, '_');
                const result = await Capacitor.Plugins.PdfGenerator.fromData({
                    data: html,
                    fileName: baseName
                });
                // result contains base64 PDF data or triggers share
                if (result && result.base64 && Capacitor.Plugins.Filesystem && Capacitor.Plugins.Share) {
                    const { Filesystem } = Capacitor.Plugins;
                    const { Share } = Capacitor.Plugins;
                    const writeResult = await Filesystem.writeFile({
                        path: baseName + '.pdf',
                        data: result.base64,
                        directory: 'CACHE'
                    });
                    await Share.share({
                        title: baseName + '.pdf',
                        url: writeResult.uri,
                        dialogTitle: 'Save PDF'
                    });
                }
                return;
            } catch (e) {
                console.warn('PDF generator failed:', e);
                // Fall through to browser print
            }
        }

        // Browser: use iframe + window.print()
        const iframe = document.createElement('iframe');
        iframe.style.cssText = 'position:fixed;left:-9999px;top:-9999px;width:800px;height:600px;';
        document.body.appendChild(iframe);

        const doc = iframe.contentDocument || iframe.contentWindow.document;
        doc.open();
        doc.write(html);
        doc.close();

        // Wait for content to render
        await new Promise(resolve => {
            iframe.onload = resolve;
            setTimeout(resolve, 2000);
        });

        iframe.contentWindow.print();

        setTimeout(() => {
            document.body.removeChild(iframe);
        }, 1000);
    }

    // ── DOCX Export ──

    async _loadDocxLibrary() {
        if (this._docxLoaded && window.docx) return;

        return new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = 'https://cdn.jsdelivr.net/npm/docx@9.6.0/dist/index.iife.js';
            script.onload = () => {
                this._docxLoaded = true;
                resolve();
            };
            script.onerror = () => reject(new Error('Failed to load docx library from CDN'));
            document.head.appendChild(script);
        });
    }

    async exportDOCX() {
        const cells = this._scrapeCells();
        if (cells.length === 0) {
            alert('No cells to export.');
            return;
        }

        // Load library
        try {
            await this._loadDocxLibrary();
        } catch (e) {
            alert('Could not load DOCX library. Check your internet connection.');
            return;
        }

        const { Document, Paragraph, TextRun, ImageRun, Table, TableRow, TableCell,
                Packer, HeadingLevel, BorderStyle, WidthType, AlignmentType, ShadingType,
                XmlComponent } = window.docx;

        // Helper class: wraps a raw prepForXml-compatible object as an XmlComponent
        // so it can be embedded inside Paragraph children for OOXML Math output.
        class OmmlComponent extends XmlComponent {
            constructor(obj) { super('m:oMathPara'); this._obj = obj; }
            prepForXml() { return this._obj; }
        }

        const name = this._getNotebookName();
        const children = [];

        // Title
        children.push(new Paragraph({
            children: [new TextRun({ text: name, bold: true, size: 36, color: '0969DA' })],
            heading: HeadingLevel.HEADING_1,
            spacing: { after: 200 }
        }));

        // Timestamp
        children.push(new Paragraph({
            children: [new TextRun({ text: 'Exported from SciREPL on ' + this._getTimestamp(), italics: true, size: 20, color: '656D76' })],
            spacing: { after: 400 }
        }));

        for (const cell of cells) {
            if (cell.type === 'markdown') {
                // Extract $$...$$ display math blocks, replace with placeholders
                const displayMath = [];
                let mdText = cell.code.replace(/\$\$([\s\S]*?)\$\$/g, (match, tex) => {
                    const id = `%%DISPLAY_MATH_${displayMath.length}%%`;
                    displayMath.push(tex.trim());
                    return id;
                });

                const lines = mdText.split('\n');
                for (const line of lines) {
                    // Check for display math placeholder
                    const dmMatch = line.trim().match(/^%%DISPLAY_MATH_(\d+)%%$/);
                    if (dmMatch) {
                        const tex = displayMath[parseInt(dmMatch[1])];
                        const ommlObj = this._texToOmml(tex);
                        if (ommlObj) {
                            const para = new Paragraph({ spacing: { before: 100, after: 100 } });
                            para.addChildElement(new OmmlComponent(ommlObj));
                            children.push(para);
                        } else {
                            children.push(new Paragraph({
                                children: [new TextRun({ text: tex, italics: true, font: 'Cambria Math', size: 24 })],
                                alignment: AlignmentType.CENTER,
                                spacing: { before: 100, after: 100 }
                            }));
                        }
                        continue;
                    }

                    if (line.startsWith('# ')) {
                        children.push(new Paragraph({
                            children: [new TextRun({ text: line.slice(2), bold: true, size: 32 })],
                            heading: HeadingLevel.HEADING_1, spacing: { before: 200, after: 100 }
                        }));
                    } else if (line.startsWith('## ')) {
                        children.push(new Paragraph({
                            children: [new TextRun({ text: line.slice(3), bold: true, size: 28 })],
                            heading: HeadingLevel.HEADING_2, spacing: { before: 200, after: 100 }
                        }));
                    } else if (line.startsWith('### ')) {
                        children.push(new Paragraph({
                            children: [new TextRun({ text: line.slice(4), bold: true, size: 24 })],
                            heading: HeadingLevel.HEADING_3, spacing: { before: 200, after: 100 }
                        }));
                    } else if (line.trim() === '') {
                        children.push(new Paragraph({ spacing: { after: 100 } }));
                    } else if (line.includes('$')) {
                        // Line may contain inline math $...$  — split into text + math runs
                        const parts = this._splitInlineMath(line, TextRun, OmmlComponent);
                        children.push(new Paragraph({ children: parts, spacing: { after: 60 } }));
                    } else {
                        // Parse inline bold/italic
                        const runs = this._parseInlineMarkdown(line, TextRun);
                        children.push(new Paragraph({ children: runs, spacing: { after: 60 } }));
                    }
                }
                continue;
            }

            // Code cell header
            children.push(new Paragraph({
                children: [new TextRun({ text: `In [${cell.id}] (${cell.language})`, bold: true, size: 18, color: '0969DA', font: 'Courier New' })],
                spacing: { before: 300, after: 100 }
            }));

            // Code block (with syntax highlighting if hljs available)
            const highlightedHtml = this._highlightCode(cell.code, cell.language);
            const hasHljs = highlightedHtml !== this._escapeHtml(cell.code);
            const codeLines = cell.code.split('\n');

            if (hasHljs) {
                // Parse highlighted HTML for colored TextRuns per line
                const highlightedLines = highlightedHtml.split('\n');
                for (const hLine of highlightedLines) {
                    const segments = this._parseHljsTokens(hLine);
                    const runs = segments.length > 0
                        ? segments.map(s => new TextRun({ text: s.text || ' ', font: 'Courier New', size: 20, color: s.color }))
                        : [new TextRun({ text: ' ', font: 'Courier New', size: 20 })];
                    children.push(new Paragraph({
                        children: runs,
                        shading: { type: ShadingType.SOLID, color: 'F6F8FA' },
                        spacing: { after: 0 }
                    }));
                }
            } else {
                for (const line of codeLines) {
                    children.push(new Paragraph({
                        children: [new TextRun({ text: line || ' ', font: 'Courier New', size: 20 })],
                        shading: { type: ShadingType.SOLID, color: 'F6F8FA' },
                        spacing: { after: 0 }
                    }));
                }
            }

            // Outputs
            for (const out of cell.outputs) {
                switch (out.kind) {
                    case 'text':
                        children.push(new Paragraph({
                            children: [new TextRun({ text: out.content, font: 'Courier New', size: 20, color: '1A7F37' })],
                            spacing: { before: 100, after: 100 }
                        }));
                        break;

                    case 'error':
                        children.push(new Paragraph({
                            children: [new TextRun({ text: out.content, font: 'Courier New', size: 20, color: 'CF222E' })],
                            spacing: { before: 100, after: 100 }
                        }));
                        break;

                    case 'latex': {
                        const tex = this._extractTexFromKaTeX(out.element || this._parseHtmlFragment(out.html));
                        const ommlObj = this._texToOmml(tex);
                        if (ommlObj) {
                            const para = new Paragraph({ spacing: { before: 100, after: 100 } });
                            para.addChildElement(new OmmlComponent(ommlObj));
                            children.push(para);
                        } else {
                            // Fallback: plain italic text in Cambria Math
                            children.push(new Paragraph({
                                children: [new TextRun({ text: tex, italics: true, font: 'Cambria Math', size: 24 })],
                                alignment: AlignmentType.CENTER,
                                spacing: { before: 100, after: 100 }
                            }));
                        }
                        break;
                    }

                    case 'table': {
                        const tableEl = out.element || this._parseHtmlFragment(out.html);
                        const docxTable = this._htmlTableToDocx(tableEl, { Table, TableRow, TableCell, Paragraph, TextRun, BorderStyle, WidthType });
                        if (docxTable) {
                            children.push(docxTable);
                            children.push(new Paragraph({ spacing: { after: 100 } }));
                        }
                        break;
                    }

                    case 'image': {
                        const imgData = await this._dataUrlToBuffer(out.src);
                        if (imgData) {
                            children.push(new Paragraph({
                                children: [new ImageRun({ data: imgData, transformation: { width: 500, height: 300 }, type: 'png' })],
                                spacing: { before: 100, after: 100 }
                            }));
                        }
                        break;
                    }

                    case 'plot': {
                        const dataUrl = await this._plotToImage(out.element);
                        if (dataUrl) {
                            const plotData = await this._dataUrlToBuffer(dataUrl);
                            if (plotData) {
                                children.push(new Paragraph({
                                    children: [new ImageRun({ data: plotData, transformation: { width: 500, height: 300 }, type: 'png' })],
                                    spacing: { before: 100, after: 100 }
                                }));
                            }
                        } else {
                            children.push(new Paragraph({
                                children: [new TextRun({ text: '[Plotly chart — screenshot unavailable]', italics: true, color: '656D76' })],
                                spacing: { before: 100, after: 100 }
                            }));
                        }
                        break;
                    }
                }
            }
        }

        const doc = new Document({
            sections: [{ children }]
        });

        const blob = await Packer.toBlob(doc);
        const baseName = name.replace(/[^a-zA-Z0-9_-]/g, '_');
        this._downloadBlob(baseName + '.docx', blob);
    }

    /** Convert a base64 data URL to ArrayBuffer */
    async _dataUrlToBuffer(src) {
        try {
            const bytes = await this._srcToBytes(src);
            return bytes ? bytes.buffer : null;
        } catch (e) {
            return null;
        }
    }

    /**
     * Split a line containing $...$ inline math into an array of TextRun and
     * OmmlComponent children suitable for a Paragraph.
     */
    _splitInlineMath(line, TextRun, OmmlComponent) {
        const parts = [];
        const regex = /\$([^\$\n]+?)\$/g;
        let lastIndex = 0;
        let match;

        while ((match = regex.exec(line)) !== null) {
            // Text before the math
            if (match.index > lastIndex) {
                const textBefore = line.slice(lastIndex, match.index);
                parts.push(...this._parseInlineMarkdown(textBefore, TextRun));
            }
            // Inline math
            const tex = match[1].trim();
            const ommlObj = this._texToOmml(tex);
            if (ommlObj) {
                // For inline math, use m:oMath directly (not m:oMathPara)
                const inlineOmml = ommlObj['m:oMathPara'];
                // Extract the m:oMath from inside m:oMathPara
                const oMathArr = inlineOmml ? inlineOmml.filter(c => c['m:oMath']) : null;
                if (oMathArr && oMathArr.length > 0) {
                    const inlineObj = {
                        'm:oMath': [
                            { _attr: { 'xmlns:m': 'http://schemas.openxmlformats.org/officeDocument/2006/math' } },
                            ...oMathArr[0]['m:oMath']
                        ]
                    };
                    parts.push(new OmmlComponent(inlineObj));
                } else {
                    parts.push(new TextRun({ text: tex, italics: true, font: 'Cambria Math', size: 22 }));
                }
            } else {
                parts.push(new TextRun({ text: tex, italics: true, font: 'Cambria Math', size: 22 }));
            }
            lastIndex = match.index + match[0].length;
        }

        // Remaining text after last math
        if (lastIndex < line.length) {
            parts.push(...this._parseInlineMarkdown(line.slice(lastIndex), TextRun));
        }

        if (parts.length === 0) {
            parts.push(new TextRun({ text: line, size: 22 }));
        }

        return parts;
    }

    /** Parse inline markdown (bold, italic, code) into TextRun array */
    _parseInlineMarkdown(text, TextRun) {
        const runs = [];
        // Simple regex: **bold**, *italic*, `code`
        const regex = /(\*\*(.+?)\*\*|\*(.+?)\*|`(.+?)`)/g;
        let lastIndex = 0;
        let match;

        while ((match = regex.exec(text)) !== null) {
            if (match.index > lastIndex) {
                runs.push(new TextRun({ text: text.slice(lastIndex, match.index), size: 22 }));
            }
            if (match[2]) {
                runs.push(new TextRun({ text: match[2], bold: true, size: 22 }));
            } else if (match[3]) {
                runs.push(new TextRun({ text: match[3], italics: true, size: 22 }));
            } else if (match[4]) {
                runs.push(new TextRun({ text: match[4], font: 'Courier New', size: 20 }));
            }
            lastIndex = match.index + match[0].length;
        }

        if (lastIndex < text.length) {
            runs.push(new TextRun({ text: text.slice(lastIndex), size: 22 }));
        }

        if (runs.length === 0) {
            runs.push(new TextRun({ text: text, size: 22 }));
        }

        return runs;
    }

    /** Convert HTML <table> to docx Table */
    _htmlTableToDocx(tableEl, docxTypes) {
        const { Table, TableRow, TableCell, Paragraph, TextRun, BorderStyle, WidthType } = docxTypes;

        const rows = [];
        const borderStyle = {
            top: { style: BorderStyle.SINGLE, size: 1, color: 'D0D7DE' },
            bottom: { style: BorderStyle.SINGLE, size: 1, color: 'D0D7DE' },
            left: { style: BorderStyle.SINGLE, size: 1, color: 'D0D7DE' },
            right: { style: BorderStyle.SINGLE, size: 1, color: 'D0D7DE' }
        };

        // Header
        const thEls = tableEl.querySelectorAll('thead th');
        if (thEls.length > 0) {
            const headerCells = [];
            thEls.forEach(th => {
                headerCells.push(new TableCell({
                    children: [new Paragraph({
                        children: [new TextRun({ text: th.textContent.trim(), bold: true, font: 'Courier New', size: 18, color: '0969DA' })]
                    })],
                    borders: borderStyle,
                    shading: { type: 'solid', color: 'F6F8FA' }
                }));
            });
            rows.push(new TableRow({ children: headerCells, tableHeader: true }));
        }

        // Body rows
        const trEls = tableEl.querySelectorAll('tbody tr');
        trEls.forEach(tr => {
            const cellArray = [];
            tr.querySelectorAll('td').forEach(td => {
                cellArray.push(new TableCell({
                    children: [new Paragraph({
                        children: [new TextRun({ text: td.textContent.trim(), font: 'Courier New', size: 18 })]
                    })],
                    borders: borderStyle
                }));
            });
            if (cellArray.length > 0) {
                rows.push(new TableRow({ children: cellArray }));
            }
        });

        if (rows.length === 0) return null;

        return new Table({
            rows,
            width: { size: 100, type: WidthType.PERCENTAGE }
        });
    }

    // ── LaTeX Export ──

    _escapeLatex(str) {
        return str
            .replace(/\\/g, '\\textbackslash{}')
            .replace(/([#$%&_{}])/g, '\\$1')
            .replace(/~/g, '\\textasciitilde{}')
            .replace(/\^/g, '\\textasciicircum{}');
    }

    /** Map SciREPL language names to lstlisting language names */
    _latexLanguageName(lang) {
        const map = {
            'python': 'Python',
            'javascript': 'JavaScript',
            'r': 'R',
            'prolog': 'Prolog',
            'bash': 'bash'
        };
        return map[lang] || lang;
    }

    _htmlTableToLatex(tableEl) {
        const headers = [];
        const rows = [];

        const thEls = tableEl.querySelectorAll('thead th');
        thEls.forEach(th => headers.push(th.textContent.trim()));

        const trEls = tableEl.querySelectorAll('tbody tr');
        trEls.forEach(tr => {
            const cells = [];
            tr.querySelectorAll('td').forEach(td => cells.push(td.textContent.trim()));
            rows.push(cells);
        });

        const colCount = Math.max(headers.length, rows.length > 0 ? rows[0].length : 0);
        if (colCount === 0) return '';

        let tex = '\\begin{table}[h]\n\\centering\n';
        tex += '\\begin{tabular}{' + 'l'.repeat(colCount) + '}\n';
        tex += '\\toprule\n';

        if (headers.length > 0) {
            tex += headers.map(h => this._escapeLatex(h)).join(' & ') + ' \\\\\n';
            tex += '\\midrule\n';
        }

        rows.forEach(row => {
            tex += row.map(c => this._escapeLatex(c)).join(' & ') + ' \\\\\n';
        });

        tex += '\\bottomrule\n';
        tex += '\\end{tabular}\n\\end{table}\n';
        return tex;
    }

    _markdownToLatex(text) {
        const lines = text.split('\n');
        let tex = '';

        for (const line of lines) {
            if (line.startsWith('# ')) {
                tex += '\\section{' + this._escapeLatex(line.slice(2)) + '}\n';
            } else if (line.startsWith('## ')) {
                tex += '\\subsection{' + this._escapeLatex(line.slice(3)) + '}\n';
            } else if (line.startsWith('### ')) {
                tex += '\\subsubsection{' + this._escapeLatex(line.slice(4)) + '}\n';
            } else if (line.trim() === '') {
                tex += '\n';
            } else if (line.startsWith('- ') || line.startsWith('* ')) {
                tex += '\\item ' + this._escapeLatex(line.slice(2)) + '\n';
            } else {
                // Inline formatting: **bold**, *italic*, `code`
                let processed = line;
                processed = processed.replace(/\*\*(.+?)\*\*/g, (_, t) => '\\textbf{' + this._escapeLatex(t) + '}');
                processed = processed.replace(/\*(.+?)\*/g, (_, t) => '\\textit{' + this._escapeLatex(t) + '}');
                processed = processed.replace(/`(.+?)`/g, (_, t) => '\\texttt{' + this._escapeLatex(t) + '}');
                // For lines without inline formatting, escape the whole thing
                if (processed === line) {
                    processed = this._escapeLatex(line);
                }
                tex += processed + '\n';
            }
        }

        return tex;
    }

    async _buildLatexString() {
        const cells = this._scrapeCells();
        const name = this._getNotebookName();
        const images = []; // { name, data }
        let imageCounter = 0;

        let body = '';

        for (const cell of cells) {
            if (cell.type === 'markdown') {
                body += this._markdownToLatex(cell.code) + '\n';
                continue;
            }

            // Code cell
            const langName = this._latexLanguageName(cell.language);
            body += `\\noindent\\textbf{In [${cell.id}]} \\textit{(${langName})}\n\n`;
            body += `\\begin{lstlisting}[language=${langName}]\n${cell.code}\n\\end{lstlisting}\n\n`;

            for (const out of cell.outputs) {
                switch (out.kind) {
                    case 'text':
                        body += '\\begin{verbatim}\n' + out.content + '\n\\end{verbatim}\n\n';
                        break;
                    case 'error':
                        body += '{\\color{red}\n\\begin{verbatim}\n' + out.content + '\n\\end{verbatim}\n}\n\n';
                        break;
                    case 'latex': {
                        const tex = this._extractTexFromKaTeX(out.element || this._parseHtmlFragment(out.html));
                        body += '\\[\n' + tex + '\n\\]\n\n';
                        break;
                    }
                    case 'table': {
                        const tableEl = out.element || this._parseHtmlFragment(out.html);
                        body += this._htmlTableToLatex(tableEl) + '\n';
                        break;
                    }
                    case 'image': {
                        imageCounter++;
                        const imgName = `image_${imageCounter}.png`;
                        body += `\\begin{figure}[h]\n\\centering\n\\includegraphics[width=0.8\\textwidth]{images/${imgName}}\n\\end{figure}\n\n`;
                        const imgBytes = await this._srcToBytes(out.src);
                        if (imgBytes) images.push({ name: imgName, data: imgBytes });
                        break;
                    }
                    case 'plot': {
                        const dataUrl = await this._plotToImage(out.element);
                        if (dataUrl) {
                            imageCounter++;
                            const imgName = `plot_${imageCounter}.png`;
                            body += `\\begin{figure}[h]\n\\centering\n\\includegraphics[width=0.8\\textwidth]{images/${imgName}}\n\\end{figure}\n\n`;
                            const plotBytes = await this._srcToBytes(dataUrl);
                            if (plotBytes) images.push({ name: imgName, data: plotBytes });
                        } else {
                            body += '\\textit{[Plotly chart --- screenshot unavailable]}\n\n';
                        }
                        break;
                    }
                }
            }
        }

        const tex = `\\documentclass[11pt]{article}

\\usepackage[utf8]{inputenc}
\\usepackage[T1]{fontenc}
\\usepackage{amsmath,amssymb}
\\usepackage{listings}
\\usepackage{xcolor}
\\usepackage{graphicx}
\\usepackage{booktabs}
\\usepackage[margin=1in]{geometry}
\\usepackage{hyperref}

\\lstset{
  basicstyle=\\ttfamily\\small,
  breaklines=true,
  frame=single,
  backgroundcolor=\\color{gray!10},
  numbers=none,
  tabsize=4,
  showstringspaces=false,
  keywordstyle=\\color{blue!70},
  commentstyle=\\color{green!50!black},
  stringstyle=\\color{red!60}
}

\\title{${this._escapeLatex(name)}}
\\author{SciREPL}
\\date{${this._escapeLatex(this._getTimestamp())}}

\\begin{document}

\\maketitle

${body}
\\end{document}
`;

        return { tex, images };
    }

    async exportLatex() {
        const cells = this._scrapeCells();
        if (cells.length === 0) {
            alert('No cells to export.');
            return;
        }

        const baseName = this._getNotebookName().replace(/[^a-zA-Z0-9_-]/g, '_');
        const { tex, images } = await this._buildLatexString();

        if (images.length === 0) {
            // No images — export as standalone .tex
            await this._downloadFile(baseName + '.tex', tex, 'application/x-latex');
        } else {
            // Has images — export as .tex.zip
            if (typeof JSZip === 'undefined') {
                alert('JSZip not loaded. Cannot create zip archive.');
                return;
            }

            const zip = new JSZip();
            zip.file('main.tex', tex);

            const imgFolder = zip.folder('images');
            for (const img of images) {
                imgFolder.file(img.name, img.data);
            }

            const blob = await zip.generateAsync({ type: 'blob' });
            this._downloadBlob(baseName + '.tex.zip', blob);
        }
    }

    // ── .ipynb Output Helper ──

    /**
     * Convert scraped cell outputs to Jupyter notebook output format.
     * Used by file_io.js exportNotebook().
     * @param {Object} scrapedCell — from _scrapeCells()
     * @returns {Array} Jupyter-format outputs
     */
    async scrapedOutputsToJupyter(scrapedCell) {
        const outputs = [];

        for (const out of scrapedCell.outputs) {
            switch (out.kind) {
                case 'text':
                    outputs.push({
                        output_type: 'stream',
                        name: 'stdout',
                        text: out.content.split('\n').map((line, i, arr) => i < arr.length - 1 ? line + '\n' : line)
                    });
                    break;
                case 'error':
                    outputs.push({
                        output_type: 'error',
                        ename: 'Error',
                        evalue: out.content.split('\n')[0] || '',
                        traceback: out.content.split('\n').map(line => line + '\n')
                    });
                    break;
                case 'latex': {
                    const tex = this._extractTexFromKaTeX(out.element || this._parseHtmlFragment(out.html));
                    outputs.push({
                        output_type: 'execute_result',
                        data: {
                            'text/plain': [tex],
                            'text/latex': ['$\\displaystyle ' + tex + '$']
                        },
                        metadata: {},
                        execution_count: scrapedCell.id
                    });
                    break;
                }
                case 'table':
                    outputs.push({
                        output_type: 'display_data',
                        data: { 'text/html': [out.html] },
                        metadata: {}
                    });
                    break;
                case 'image': {
                    const imgDataUrl = await this._srcToDataURL(out.src);
                    const b64 = imgDataUrl.includes(',') ? imgDataUrl.split(',')[1] : imgDataUrl;
                    outputs.push({
                        output_type: 'display_data',
                        data: { 'image/png': b64 },
                        metadata: {}
                    });
                    break;
                }
                case 'plot': {
                    const dataUrl = await this._plotToImage(out.element);
                    if (dataUrl) {
                        const b64 = dataUrl.split(',')[1];
                        outputs.push({
                            output_type: 'display_data',
                            data: { 'image/png': b64 },
                            metadata: {}
                        });
                    }
                    break;
                }
                case 'markdown':
                    // Markdown cell output is the rendered HTML — not a code output
                    break;
            }
        }

        return outputs;
    }

    // ── File Download Helpers ──

    async _downloadFile(filename, content, mimeType) {
        // Delegate to FileIO if available
        if (window.fileIO && window.fileIO.downloadFile) {
            await window.fileIO.downloadFile(filename, content, mimeType);
            return;
        }

        // Fallback
        const blob = new Blob([content], { type: mimeType || 'text/plain' });
        this._downloadBlob(filename, blob);
    }

    _downloadBlob(filename, blob) {
        // Try Capacitor
        if (window.Capacitor && Capacitor.Plugins && Capacitor.Plugins.Filesystem && Capacitor.Plugins.Share) {
            const reader = new FileReader();
            reader.onload = async () => {
                try {
                    const { Filesystem } = Capacitor.Plugins;
                    const { Share } = Capacitor.Plugins;
                    const base64 = reader.result.split(',')[1];
                    const writeResult = await Filesystem.writeFile({
                        path: filename,
                        data: base64,
                        directory: 'CACHE'
                    });
                    await Share.share({ title: filename, url: writeResult.uri, dialogTitle: 'Export ' + filename });
                } catch (e) {
                    console.warn('Capacitor share failed:', e);
                    this._webDownloadBlob(filename, blob);
                }
            };
            reader.readAsDataURL(blob);
            return;
        }

        this._webDownloadBlob(filename, blob);
    }

    _webDownloadBlob(filename, blob) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
}

// Singleton
window.exportManager = new ExportManager();
