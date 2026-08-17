/**
 * md_math.js — the ONE source of truth for what counts as math in Markdown,
 * shared by the renderer and the Formula palette. No DOM, no dependencies.
 *
 * Renderer side: markedExtensions(renderMath) returns marked inline
 * extensions, so math is recognized STRUCTURALLY — only in eligible inline
 * text, never in link destinations, image sources, autolinks, raw-HTML
 * attributes, inline code, fenced code, or indented code (marked's own
 * tokenizers consume those before the extension is consulted, and marked's
 * escape rule consumes '\$' first). No placeholders, no post-hoc HTML
 * string replacement.
 *
 * Palette side: stateAt(text, caret) reports the caret's context over the
 * SAME protected regions ('inline' | 'display' | 'code' | 'outside'),
 * with in-progress (unclosed-delimiter) semantics so mid-formula insertion
 * never nests delimiters.
 */
(function () {
    'use strict';

    // CommonMark-shaped raw-HTML tag: attribute values must be quoted
    // strings (which may contain '>' and '$') or unquoted spec tokens —
    // '<b$ ok' is NOT a tag, so '$a<b$' stays math, while
    // '<span title="a > $x$">' IS one.
    const SPEC_TAG = /^<\/?[a-zA-Z][a-zA-Z0-9-]*(?:\s+[a-zA-Z_:][a-zA-Z0-9_.:-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*\s*\/?>/;
    const AUTOLINK = /^<[a-zA-Z][a-zA-Z0-9+.-]*:[^<>\s]*>/;

    /** Length of the HTML construct (comment, autolink, or spec tag)
     *  starting exactly at src[i], or 0. */
    function htmlConstructAt(src, i) {
        if (src[i] !== '<') return 0;
        const rest = src.slice(i, i + 4096);
        if (rest.startsWith('<!--')) {
            const close = rest.indexOf('-->', 4);
            return close === -1 ? rest.length : close + 3;
        }
        const auto = AUTOLINK.exec(rest);
        if (auto) return auto[0].length;
        const tag = SPEC_TAG.exec(rest);
        return tag ? tag[0].length : 0;
    }

    /** A math span may never SWALLOW a construct Markdown would tokenize —
     *  a '$' in ordinary text must not find its closing '$' inside a link
     *  or image destination or a bare GFM URL. (Raw-HTML/autolink/comment
     *  crossings are aborted during the scan itself, at the '<'.)
     *  Fail-safe direction: a rare legitimate formula like '$f[x](y)$'
     *  renders literally, never the other way around. */
    function bodyCrossesProtected(body) {
        return /\]\(/.test(body)                                   // into a link/image destination
            || /(?:^|[^\w.+-])(?:https?:\/\/|www\.)/i.test(body);  // a bare GFM URL
    }

    /** '$$body$$' at the start of src (display math): escape-aware, body
     *  non-empty, may span newlines within one inline run. */
    function matchDisplay(src) {
        if (!(src[0] === '$' && src[1] === '$')) return null;
        let i = 2;
        while (i < src.length) {
            if (src[i] === '\\') { i += 2; continue; }
            if (src[i] === '<' && htmlConstructAt(src, i) > 0) return null;
            if (src[i] === '$' && src[i + 1] === '$') {
                if (i === 2) return null;                // empty body
                const body = src.slice(2, i);
                if (bodyCrossesProtected(body)) return null;
                return { raw: src.slice(0, i + 2), body };
            }
            i++;
        }
        return null;
    }

    /** '$body$' at the start of src (inline math): single line, non-empty,
     *  escape-aware; a backtick or an HTML construct aborts (those
     *  tokenizations win, as in marked). */
    function matchInline(src) {
        if (src[0] !== '$' || src[1] === '$') return null;
        let i = 1;
        while (i < src.length && src[i] !== '\n') {
            if (src[i] === '\\') { i += 2; continue; }
            if (src[i] === '`') return null;
            if (src[i] === '<' && htmlConstructAt(src, i) > 0) return null;
            if (src[i] === '$') {
                if (i === 1) return null;                // empty body
                const body = src.slice(1, i);
                if (bodyCrossesProtected(body)) return null;
                return { raw: src.slice(0, i + 1), body };
            }
            i++;
        }
        return null;
    }

    /**
     * marked inline extensions rendering math via renderMath(tex, display).
     * Display is tried before inline at the same position ('$$' vs '$').
     */
    function markedExtensions(renderMath) {
        return [{
            name: 'sciDisplayMath',
            level: 'inline',
            start(src) { const p = src.indexOf('$$'); return p === -1 ? undefined : p; },
            tokenizer(src) {
                const m = matchDisplay(src);
                if (m) return { type: 'sciDisplayMath', raw: m.raw, body: m.body };
            },
            renderer(token) { return renderMath(token.body.trim(), true); },
        }, {
            name: 'sciInlineMath',
            level: 'inline',
            start(src) { const p = src.indexOf('$'); return p === -1 ? undefined : p; },
            tokenizer(src) {
                const m = matchInline(src);
                if (m) return { type: 'sciInlineMath', raw: m.raw, body: m.body };
            },
            renderer(token) { return renderMath(token.body.trim(), false); },
        }];
    }

    /** Disjoint regions covering [0, text.length):
     *  {type:'text'|'code'|'math', start, end} — math regions also carry
     *  {display, bodyStart, bodyEnd}. 'code' covers every context the
     *  renderer protects: fenced and indented code, inline code spans,
     *  autolinks, raw-HTML tags, and link/image destinations. */
    function scan(text) {
        const s = String(text);
        const len = s.length;
        const regions = [];
        let i = 0;
        let textStart = 0;
        let atLineStart = true;
        const pushText = (end) => { if (end > textStart) regions.push({ type: 'text', start: textStart, end }); };
        const prevLineBlank = (pos) => {
            // is the line ENDING at pos-1 blank (or are we at document start)?
            if (pos === 0) return true;
            let j = pos - 1;                             // the '\n' ending the previous line
            let k = j - 1;
            while (k >= 0 && s[k] !== '\n') {
                if (s[k] !== ' ' && s[k] !== '\t') return false;
                k--;
            }
            return true;
        };

        while (i < len) {
            const ch = s[i];

            if (atLineStart) {
                const nl = s.indexOf('\n', i);
                const line = s.slice(i, nl === -1 ? len : nl);
                const fm = /^ {0,3}(`{3,}|~{3,})/.exec(line);
                if (fm) {
                    const fenceChar = fm[1][0];
                    const fenceLen = fm[1].length;
                    const closeRe = new RegExp('^ {0,3}\\' + fenceChar + '{' + fenceLen + ',}[ \t]*$');
                    let j = nl === -1 ? len : nl + 1;
                    let end = len;                       // unclosed fence runs to EOF
                    while (j < len) {
                        const le = s.indexOf('\n', j);
                        if (closeRe.test(s.slice(j, le === -1 ? len : le))) { end = le === -1 ? len : le; break; }
                        if (le === -1) break;
                        j = le + 1;
                    }
                    pushText(i);
                    regions.push({ type: 'code', start: i, end });
                    i = end; textStart = i; atLineStart = false;
                    continue;
                }
                // reference definition: the whole line is protected
                if (/^ {0,3}\[[^\]]*\]:\s?/.test(line)) {
                    const end = nl === -1 ? len : nl;
                    pushText(i);
                    regions.push({ type: 'code', start: i, end });
                    i = end; textStart = i; atLineStart = false;
                    continue;
                }
                // indented code block: 4 spaces / tab after a blank line
                if (/^(?: {4}|\t)/.test(line) && line.trim() !== '' && prevLineBlank(i)) {
                    let j = i, end = len;
                    while (j < len) {
                        const le = s.indexOf('\n', j);
                        const l2 = s.slice(j, le === -1 ? len : le);
                        if (l2.trim() !== '' && !/^(?: {4}|\t)/.test(l2)) { end = j; break; }
                        if (le === -1) { end = len; break; }
                        j = le + 1;
                    }
                    pushText(i);
                    regions.push({ type: 'code', start: i, end });
                    i = end; textStart = i; atLineStart = true;
                    continue;
                }
            }

            if (ch === '\n') { i++; atLineStart = true; continue; }
            atLineStart = false;

            if (ch === '\\') { i += 2; continue; }       // escape consumes the next char

            if (ch === '<') {
                // HTML comment, autolink, or spec-shaped raw-HTML tag
                // (quoted attributes may contain '>'): protected in full
                const consumed = htmlConstructAt(s, i);
                if (consumed > 0) {
                    pushText(i);
                    regions.push({ type: 'code', start: i, end: i + consumed });
                    i += consumed; textStart = i;
                    continue;
                }
                i++; continue;
            }

            if ((ch === 'h' || ch === 'w') && (i === 0 || /[^\w.+-]/.test(s[i - 1]))) {
                // bare GFM URL: protected in full
                const m = /^(?:https?:\/\/|www\.)[^\s<]+/.exec(s.slice(i, i + 2048));
                if (m) {
                    pushText(i);
                    regions.push({ type: 'code', start: i, end: i + m[0].length });
                    i += m[0].length; textStart = i;
                    continue;
                }
                i++; continue;
            }

            if (ch === ']' && s[i + 1] === '(') {
                // link/image DESTINATION: protected until the matching ')'
                let j = i + 2, depth = 1;
                while (j < len && depth > 0) {
                    if (s[j] === '\\') { j += 2; continue; }
                    if (s[j] === '(') depth++;
                    else if (s[j] === ')') depth--;
                    j++;
                }
                pushText(i);
                regions.push({ type: 'code', start: i, end: j });
                i = j; textStart = i;
                continue;
            }

            if (ch === '`') {
                // inline code span: run of N backticks, closed by the next
                // run of EXACTLY N backticks
                let n = 1;
                while (s[i + n] === '`') n++;
                let j = i + n, close = -1;
                while (j < len) {
                    if (s[j] === '`') {
                        let m = 1;
                        while (s[j + m] === '`') m++;
                        if (m === n) { close = j; break; }
                        j += m;
                    } else j++;
                }
                if (close !== -1) {
                    pushText(i);
                    regions.push({ type: 'code', start: i, end: close + n });
                    i = close + n; textStart = i;
                } else {
                    i += n;                              // unclosed run: literal
                }
                continue;
            }

            if (ch === '$') {
                const rest = s.slice(i);
                const dm = matchDisplay(rest);
                if (dm) {
                    pushText(i);
                    regions.push({ type: 'math', display: true, start: i, end: i + dm.raw.length, bodyStart: i + 2, bodyEnd: i + dm.raw.length - 2 });
                    i += dm.raw.length; textStart = i;
                    continue;
                }
                const im = matchInline(rest);
                if (im) {
                    pushText(i);
                    regions.push({ type: 'math', display: false, start: i, end: i + im.raw.length, bodyStart: i + 1, bodyEnd: i + im.raw.length - 1 });
                    i += im.raw.length; textStart = i;
                    continue;
                }
                i += (s[i + 1] === '$') ? 2 : 1;         // unclosed/empty: literal
                continue;
            }

            i++;
        }
        pushText(len);
        return regions;
    }

    /** Only the math regions of scan(). */
    function mathSegments(text) {
        return scan(text).filter(r => r.type === 'math');
    }

    /** In-progress delimiter state from `from` to `to` inside one TEXT
     *  region (closed spans were already consumed by scan, so any opener
     *  found here is unclosed — the state the caret is typing inside). */
    function unclosedState(s, from, to) {
        let state = 'outside';
        for (let i = from; i < to; i++) {
            const c = s[i];
            if (c === '\\') { i++; continue; }
            // inline math cannot cross a newline: an unfinished single-$
            // span RESETS (display math intentionally persists)
            if (c === '\n') { if (state === 'inline') state = 'outside'; continue; }
            if (c !== '$') continue;
            if (s[i + 1] === '$' && i + 1 < to) {
                if (state === 'outside') state = 'display';
                else if (state === 'display') state = 'outside';
                i++;                                     // '$$' in inline stays literal
                continue;
            }
            if (state === 'outside') state = 'inline';
            else if (state === 'inline') state = 'outside';
        }
        return state;
    }

    /**
     * Caret context at position pos: 'inline' | 'display' | 'code' |
     * 'outside'. Inside a CLOSED math region the delimiters themselves
     * count as inside (typing between '$' and '$'); a caret in plain text
     * after an UNCLOSED opener reports that opener's state, so the palette
     * never nests delimiters while the user is mid-formula.
     */
    function stateAt(text, pos) {
        const s = String(text);
        const p = Math.max(0, Math.min(pos | 0, s.length));
        for (const r of scan(s)) {
            if (p <= r.start) break;
            const inside = p < r.end || (r.type === 'text' && p === r.end);
            if (!inside) continue;
            if (r.type === 'math') return r.display ? 'display' : 'inline';
            if (r.type === 'code') return 'code';
            return unclosedState(s, r.start, p);
        }
        return 'outside';
    }

    globalThis.MdMath = { scan, mathSegments, stateAt, matchDisplay, matchInline, markedExtensions };
})();
