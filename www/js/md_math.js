/**
 * md_math.js — ONE escape-aware Markdown math tokenizer, shared by the
 * renderer (app.js renderMarkdown) and the Formula palette (math_mode.js).
 * Loaded before both; no DOM, no dependencies, so it runs under node for
 * regression tests and is precached in the service-worker shell.
 *
 * The scanner walks the text once, left to right, and produces disjoint
 * regions covering the whole string:
 *   - code:  fenced code blocks (``` / ~~~, 3+ markers, up to 3 leading
 *            spaces, closed by a same-char fence at least as long) and
 *            inline code spans (a run of N backticks closed by the next run
 *            of exactly N — CommonMark's rule); dollars inside are inert
 *   - math:  $...$ (inline, single line, non-empty) and $$...$$ (display,
 *            may span lines, non-empty); '$$' and '$' are distinct tokens
 *   - text:  everything else
 * '\' escapes the next character everywhere outside code, so '\$5' is
 * currency, '\\$x$' is an escaped backslash followed by real math, and
 * unclosed delimiters stay literal text.
 */
(function () {
    'use strict';

    /** Disjoint regions covering [0, text.length):
     *  {type:'text'|'code'|'math', start, end} — math regions also carry
     *  {display, bodyStart, bodyEnd}. */
    function scan(text) {
        const s = String(text);
        const len = s.length;
        const regions = [];
        let i = 0;
        let textStart = 0;
        let atLineStart = true;
        const pushText = (end) => { if (end > textStart) regions.push({ type: 'text', start: textStart, end }); };

        while (i < len) {
            const ch = s[i];

            if (atLineStart && (ch === '`' || ch === '~' || ch === ' ')) {
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
            }

            if (ch === '\n') { i++; atLineStart = true; continue; }
            atLineStart = false;

            if (ch === '\\') { i += 2; continue; }       // escape consumes the next char

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
                if (s[i + 1] === '$') {
                    // display math: next unescaped '$$', any distance
                    let j = i + 2, close = -1;
                    while (j < len) {
                        if (s[j] === '\\') { j += 2; continue; }
                        if (s[j] === '$' && s[j + 1] === '$') { close = j; break; }
                        j++;
                    }
                    if (close !== -1 && close > i + 2) {
                        pushText(i);
                        regions.push({ type: 'math', display: true, start: i, end: close + 2, bodyStart: i + 2, bodyEnd: close });
                        i = close + 2; textStart = i;
                    } else {
                        i += 2;                          // unclosed/empty: literal
                    }
                    continue;
                }
                // inline math: closing unescaped '$' on the same line; a
                // backtick aborts (the code span wins, as in CommonMark)
                let j = i + 1, close = -1;
                while (j < len && s[j] !== '\n' && s[j] !== '`') {
                    if (s[j] === '\\') { j += 2; continue; }
                    if (s[j] === '$') { close = j; break; }
                    j++;
                }
                if (close !== -1 && close > i + 1) {
                    pushText(i);
                    regions.push({ type: 'math', display: false, start: i, end: close + 1, bodyStart: i + 1, bodyEnd: close });
                    i = close + 1; textStart = i;
                } else {
                    i++;                                 // unclosed/empty: literal
                }
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

    globalThis.MdMath = { scan, mathSegments, stateAt };
})();
