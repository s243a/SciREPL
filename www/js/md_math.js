/**
 * md_math.js — TOKEN-STRUCTURAL Markdown math, shared by the renderer and
 * the Formula palette. Requires globalThis.marked (loaded before this).
 *
 * There is exactly ONE structural analysis: marked.lexer() produces the
 * real token tree, and math is recognized ONLY inside eligible leaf runs
 * of text/escape tokens. A '$' in ordinary text therefore can never close
 * inside a link or image label, a destination, a reference, an autolink,
 * an email autolink, raw HTML (tags, comments, declarations, PI, CDATA,
 * doctype), emphasis, code, or any other nested construct — those are
 * separate tokens, not text.
 *
 * Renderer path:  transformTokens(lexerTokens) rewrites text/escape runs
 * into text + math tokens in place; marked.parser() then renders them via
 * the renderer-only extensions from markedExtensions(). No raw-source
 * scanning, no placeholders, no whole-HTML replacement.
 *
 * Palette path:   scan(src) maps the SAME token tree back to source
 * offsets, yielding disjoint regions ('code' = protected construct,
 * 'math' = a closed span, 'text' = eligible text); stateAt(src, caret)
 * reports 'inline' | 'display' | 'code' | 'outside' with in-progress
 * (unclosed-opener) semantics inside eligible text.
 */
(function () {
    'use strict';

    /** '$$body$$' at the start of src (display math): escape-aware, body
     *  non-empty, may span newlines within one text run. */
    function matchDisplay(src) {
        if (!(src[0] === '$' && src[1] === '$')) return null;
        let i = 2;
        while (i < src.length) {
            if (src[i] === '\\') { i += 2; continue; }
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
     *  escape-aware; a backtick aborts. */
    function matchInline(src) {
        if (src[0] !== '$' || src[1] === '$') return null;
        let i = 1;
        while (i < src.length && src[i] !== '\n') {
            if (src[i] === '\\') { i += 2; continue; }
            if (src[i] === '`') return null;
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

    /** Belt-and-braces for material that can legitimately sit in a text
     *  run (unmatched constructs, URLs marked's flavor didn't linkify —
     *  including uppercase forms): a math body may not contain a
     *  link-destination opener or a bare URL. Case-insensitive. */
    function bodyCrossesProtected(body) {
        return /\]\(/.test(body)
            || /(?:^|[^\w.+-])(?:https?:\/\/|www\.)/i.test(body);
    }

    /** All math spans inside one eligible text run (relative offsets). */
    function findMathSpans(raw) {
        const spans = [];
        let k = 0;
        while (k < raw.length) {
            const c = raw[k];
            if (c === '\\') { k += 2; continue; }
            if (c === '$') {
                const rest = raw.slice(k);
                const dm = matchDisplay(rest);
                if (dm) { spans.push({ start: k, end: k + dm.raw.length, body: dm.body, display: true }); k += dm.raw.length; continue; }
                const im = matchInline(rest);
                if (im) { spans.push({ start: k, end: k + im.raw.length, body: im.body, display: false }); k += im.raw.length; continue; }
                k += (raw[k + 1] === '$') ? 2 : 1;       // unclosed/empty: literal
                continue;
            }
            k++;
        }
        return spans;
    }

    const isLeafText = (t) => (t.type === 'text' && !Array.isArray(t.tokens)) || t.type === 'escape';

    // ---------------- renderer path: rewrite the token tree ----------------

    /** Rewrite one inline token array in place: maximal text/escape runs
     *  become text/escape/math sequences; containers recurse. */
    function transformInline(tokens) {
        const out = [];
        let i = 0;
        while (i < tokens.length) {
            const t = tokens[i];
            if (!isLeafText(t)) {
                recurseContainers(t);
                out.push(t);
                i++;
                continue;
            }
            let j = i;
            while (j < tokens.length && isLeafText(tokens[j])) j++;
            out.push(...mathifyRun(tokens.slice(i, j)));
            i = j;
        }
        tokens.length = 0;
        tokens.push(...out);
    }

    function recurseContainers(t) {
        // image "labels" are ALT TEXT — an HTML attribute that renders
        // literally, so they are never mathified
        if (t.type === 'image') return;
        // autolinks, email autolinks, and GFM bare-URL links: the visible
        // text IS the destination — never mathify it
        if (t.type === 'link' && !t.raw.startsWith('[')) return;
        // never descend into code, codespan, or html — they have no .tokens
        if (Array.isArray(t.tokens)) transformInline(t.tokens);
        if (Array.isArray(t.items)) for (const it of t.items) if (Array.isArray(it.tokens)) transformInline(it.tokens);
        if (Array.isArray(t.header)) for (const c of t.header) if (Array.isArray(c.tokens)) transformInline(c.tokens);
        if (Array.isArray(t.rows)) for (const row of t.rows) for (const c of row) if (Array.isArray(c.tokens)) transformInline(c.tokens);
    }

    /** Split a run of text/escape tokens around its math spans. Escape
     *  tokens are atomic (a span boundary can never split one, since the
     *  matchers treat '\x' atomically). */
    function mathifyRun(run) {
        const raw = run.map(t => t.raw).join('');
        const spans = findMathSpans(raw);
        if (!spans.length) return run;
        const result = [];
        let pos = 0, ti = 0, tOff = 0;
        const takeUpTo = (target, sink) => {
            while (pos < target) {
                const t = run[ti];
                const avail = t.raw.length - tOff;
                const need = target - pos;
                if (need >= avail) {
                    if (tOff === 0) sink.push(t);
                    else sink.push({ type: 'text', raw: t.raw.slice(tOff), text: t.raw.slice(tOff), escaped: false });
                    pos += avail; ti++; tOff = 0;
                } else {
                    sink.push({ type: 'text', raw: t.raw.slice(tOff, tOff + need), text: t.raw.slice(tOff, tOff + need), escaped: false });
                    tOff += need; pos += need;
                }
            }
        };
        const discard = [];
        for (const sp of spans) {
            takeUpTo(sp.start, result);
            takeUpTo(sp.end, discard);
            result.push({
                type: sp.display ? 'sciDisplayMath' : 'sciInlineMath',
                raw: raw.slice(sp.start, sp.end),
                body: sp.body,
            });
        }
        takeUpTo(raw.length, result);
        return result;
    }

    /** Rewrite a lexer token tree (top-level array) in place. */
    function transformTokens(tokens) {
        for (const t of tokens) {
            if (Array.isArray(t.tokens) && (t.type === 'paragraph' || t.type === 'heading' || t.type === 'text')) {
                transformInline(t.tokens);
            } else {
                recurseContainers(t);
            }
        }
        return tokens;
    }

    /** Renderer-only extensions: the tokens are created by transformTokens,
     *  never by raw-source tokenizing. */
    function markedExtensions(renderMath) {
        return [
            { name: 'sciDisplayMath', level: 'inline', renderer(token) { return renderMath(token.body.trim(), true); } },
            { name: 'sciInlineMath', level: 'inline', renderer(token) { return renderMath(token.body.trim(), false); } },
        ];
    }

    // ------------- palette path: map the SAME tree to offsets -------------

    /** Disjoint source regions from the token tree: {type:'code'|'math'|
     *  'text', start, end} (math also carries display/bodyStart/bodyEnd).
     *  'code' covers every protected construct; gaps (structural markers
     *  like emphasis delimiters, list bullets) belong to no region. */
    function scan(src) {
        const marked = globalThis.marked;
        const regions = [];
        if (!marked || typeof marked.lexer !== 'function') return regions;
        let tokens;
        try { tokens = marked.lexer(String(src)); } catch (_) { return regions; }
        const s = String(src);
        const pushCode = (a, b) => { if (b > a) regions.push({ type: 'code', start: a, end: b }); };
        const align = (raw, cur) => s.startsWith(raw, cur) ? cur : s.indexOf(raw, cur);

        const emitRun = (raw, offset) => {
            const spans = findMathSpans(raw);
            let last = 0;
            for (const sp of spans) {
                if (sp.start > last) regions.push({ type: 'text', start: offset + last, end: offset + sp.start });
                regions.push({
                    type: 'math', display: sp.display,
                    start: offset + sp.start, end: offset + sp.end,
                    bodyStart: offset + sp.start + (sp.display ? 2 : 1),
                    bodyEnd: offset + sp.end - (sp.display ? 2 : 1),
                });
                last = sp.end;
            }
            if (raw.length > last) regions.push({ type: 'text', start: offset + last, end: offset + raw.length });
        };

        /** Line-wise mapped emit for stripped-prefix containers: builds a
         *  rawIndex -> sourceIndex map (each line located WITHIN the
         *  container's [cur, limit) bound, so a coincidental match inside
         *  a later fence or sibling can never be claimed), then runs ONE
         *  combined span analysis over the whole run — display math that
         *  crosses lines keeps its identity and its in-progress state. */
        const emitRunMapped = (raw, cur, limit) => {
            const lines = raw.split('\n');
            const map = new Array(raw.length + 1).fill(-1);
            let rawPos = 0;
            let c = cur;
            let any = false;
            for (const line of lines) {
                if (line.trim()) {
                    const at = s.indexOf(line, c);
                    if (at !== -1 && at + line.length <= limit) {
                        for (let k = 0; k <= line.length; k++) map[rawPos + k] = at + k;
                        c = at + line.length;
                        any = true;
                    }
                }
                rawPos += line.length + 1;
            }
            if (!any) return c;
            const spans = findMathSpans(raw);
            const emitText = (a, b) => {
                let segStart = -1;
                for (let k = a; k <= b; k++) {
                    const ok = k < b && map[k] !== -1;
                    if (ok && segStart === -1) segStart = k;
                    if (!ok && segStart !== -1) {
                        regions.push({ type: 'text', start: map[segStart], end: map[k - 1] + 1 });
                        segStart = -1;
                    }
                }
            };
            let last = 0;
            for (const sp of spans) {
                emitText(last, sp.start);
                const a = map[sp.start], b = map[sp.end - 1];
                if (a !== -1 && b !== -1) {
                    const d = sp.display ? 2 : 1;
                    regions.push({
                        type: 'math', display: sp.display, start: a, end: b + 1,
                        bodyStart: map[sp.start + d] !== -1 ? map[sp.start + d] : a + d,
                        bodyEnd: map[sp.end - 1 - d] !== -1 ? map[sp.end - 1 - d] + 1 : b + 1 - d,
                    });
                }
                last = sp.end;
            }
            emitText(last, raw.length);
            return c;
        };

        const walkArray = (arr, base, limit) => {
            let cur = base;
            let i = 0;
            const bounded = (raw, from) => {
                const at = align(raw, from);
                return (at !== -1 && at + raw.length <= limit) ? at : -1;
            };
            while (i < arr.length) {
                const t = arr[i];
                if (isLeafText(t)) {
                    // gather the maximal leaf run's concatenated raw
                    let raw = '';
                    while (i < arr.length && isLeafText(arr[i])) { raw += arr[i].raw; i++; }
                    const runStart = bounded(raw, cur);
                    if (runStart !== -1) {
                        emitRun(raw, runStart);
                        cur = runStart + raw.length;
                    } else {
                        cur = emitRunMapped(raw, cur, limit);
                    }
                    continue;
                }
                const start = bounded(t.raw, cur);
                if (start === -1) {
                    // stripped-prefix container (its raw omits '> '/indent
                    // prefixes): its CHILDREN can still be located, bounded
                    // by the same container extent
                    if (Array.isArray(t.tokens)) cur = walkArray(t.tokens, cur, limit);
                    else if (Array.isArray(t.items)) {
                        for (const it of t.items) {
                            if (Array.isArray(it.tokens)) cur = walkArray(it.tokens, cur, limit);
                        }
                    }
                    i++;
                    continue;
                }
                const end = start + t.raw.length;
                visit(t, start, end);
                cur = end;
                i++;
            }
            return cur;
        };

        const visit = (t, start, end) => {
            switch (t.type) {
                case 'code':        // fenced AND indented code blocks
                case 'codespan':
                case 'html':        // raw HTML blocks/tags/comments/decls/PI/CDATA/doctype
                case 'def':         // reference definitions incl. multiline titles
                    pushCode(start, end);
                    return;
                case 'image':
                    // alt text renders LITERALLY (it becomes an attribute),
                    // so the whole image token is protected — the palette
                    // must agree with the renderer that $x$ in alt text is
                    // not active math
                    pushCode(start, end);
                    return;
                case 'link': {
                    // autolink, email autolink, or GFM bare URL: protected whole
                    if (!t.raw.startsWith('[')) { pushCode(start, end); return; }
                    // '[label](dest)' / '[label][id]' / '[label][]' /
                    // '[label]': the label is eligible text, everything
                    // else is protected
                    const labelBase = start + 1;
                    pushCode(start, labelBase);
                    let labelEnd = labelBase;
                    if (Array.isArray(t.tokens) && t.tokens.length) {
                        labelEnd = walkArray(t.tokens, labelBase, end);
                    } else if (typeof t.text === 'string') {
                        labelEnd = labelBase + t.text.length;
                        emitRun(s.slice(labelBase, labelEnd), labelBase);
                    }
                    pushCode(labelEnd, end);
                    return;
                }
                case 'space':
                case 'hr':
                case 'br':
                    return;
                default: {
                    // paragraph, heading, blockquote, list(+items), table,
                    // em/strong/del, generic containers
                    if (Array.isArray(t.tokens)) { walkArray(t.tokens, start, end); return; }
                    if (Array.isArray(t.items)) {
                        let cur = start;
                        for (const it of t.items) {
                            const a = align(it.raw, cur);
                            if (a === -1 || a + it.raw.length > end) {
                                // NESTED item whose raw is prefix-stripped:
                                // never skip it — walk its children bounded
                                // by the list's own extent
                                if (Array.isArray(it.tokens)) cur = walkArray(it.tokens, cur, end);
                                continue;
                            }
                            if (Array.isArray(it.tokens)) walkArray(it.tokens, a, a + it.raw.length);
                            cur = a + it.raw.length;
                        }
                        return;
                    }
                    if (Array.isArray(t.header) || Array.isArray(t.rows)) {
                        const cells = [...(t.header || []), ...(t.rows || []).flat()];
                        let cur = start;
                        for (const c of cells) {
                            if (!Array.isArray(c.tokens)) continue;
                            cur = walkArray(c.tokens, cur, end);
                        }
                        return;
                    }
                }
            }
        };

        // Top level with GAP DETECTION: marked consumes reference
        // definitions (including multiline titles) WITHOUT emitting any
        // token — they only appear in tokens.links. Source ranges consumed
        // without a token are therefore protected.
        let cur = 0;
        for (const t of tokens) {
            const start = align(t.raw, cur);
            if (start === -1) continue;
            if (start > cur) pushCode(cur, start);
            visit(t, start, start + t.raw.length);
            cur = start + t.raw.length;
        }
        if (cur < s.length) pushCode(cur, s.length);
        regions.sort((a, b) => a.start - b.start);
        return regions;
    }

    /** Only the math regions of scan(). */
    function mathSegments(text) {
        return scan(text).filter(r => r.type === 'math');
    }

    /** In-progress delimiter state inside one eligible TEXT region (closed
     *  spans were already extracted as math regions, so any opener found
     *  here is unclosed). An unfinished single-$ RESETS at a newline;
     *  display math persists intentionally. */
    function unclosedState(s, from, to) {
        let state = 'outside';
        for (let i = from; i < to; i++) {
            const c = s[i];
            if (c === '\\') { i++; continue; }
            if (c === '\n') { if (state === 'inline') state = 'outside'; continue; }
            if (c !== '$') continue;
            if (s[i + 1] === '$' && i + 1 < to) {
                if (state === 'outside') state = 'display';
                else if (state === 'display') state = 'outside';
                i++;
                continue;
            }
            if (state === 'outside') state = 'inline';
            else if (state === 'inline') state = 'outside';
        }
        return state;
    }

    /**
     * Caret context at pos: 'inline' | 'display' | 'code' | 'outside'.
     * Derived from the SAME structural tokenization as rendering. A caret
     * in a structural gap (emphasis markers, bullets, blockquote prefixes)
     * or past all regions is 'outside'. While the user types, the tail of
     * the source may not yet be a closed construct — the containing text
     * region's unclosed-opener state is reported so the palette never
     * nests delimiters mid-formula.
     */
    function stateAt(text, pos) {
        const s = String(text);
        const p = Math.max(0, Math.min(pos | 0, s.length));
        for (const r of scan(s)) {
            if (p <= r.start) continue;
            const inside = p < r.end || (r.type === 'text' && p === r.end);
            if (!inside) continue;
            if (r.type === 'math') return r.display ? 'display' : 'inline';
            if (r.type === 'code') return 'code';
            return unclosedState(s, r.start, p);
        }
        return 'outside';
    }

    globalThis.MdMath = {
        scan, mathSegments, stateAt,
        matchDisplay, matchInline, findMathSpans,
        transformTokens, markedExtensions,
    };
})();
