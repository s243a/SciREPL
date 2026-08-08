# Translating SciREPL

This directory holds one JSON catalogue per language. `en.json` is the base;
every other catalogue is scored against it.

If you are handing this to a translator — human or model — this file is the
brief. Following it is the difference between a translation that ships and one
that has to be redone.

## Adding a language

1. Copy `en.json` to `<code>.json`, using a
   [BCP 47](https://www.rfc-editor.org/rfc/rfc5646) code (`ar`, `ja`, `pt-BR`).
2. Translate the values under `strings`. **Do not change the keys.**
3. Fill in `__meta` — `endonym` is the language's own name for itself
   (`العربية`, not `Arabic`), and `dir` is `rtl` for Arabic, Hebrew, Persian and
   Urdu, `ltr` otherwise.
4. Set `"status": "draft"`.
5. Run `npm run i18n:manifest`. No code change is needed — the app discovers
   locales from the generated manifest.

A draft catalogue can be committed and reviewed but **is not offered to users**
until someone who reads the language changes `status` to `reviewed`. That gate
exists because a translation can be 100% complete and still be wrong — register,
terminology, or plain inaccuracy — and the completeness score cannot see any of
that.

## What must NOT be translated

These are identifiers, not prose. Translating them breaks what users type,
search for, and read in error messages:

| Category | Examples |
| --- | --- |
| File extensions | `.srwb` `.ipynb` `.csv` `.py` `.zip` `.tar.gz` |
| Kernel and language names | Python, Bash, Prolog, Lua, R, JavaScript, TypR, ClojureScript |
| Product and library names | SciREPL, Pyodide, webR, SWI-Prolog, Scittle, Fengari |
| Placeholders | `{pixels}`, `{language}`, `{percent}` |

Keep placeholders exactly as written. You **may** move them within the sentence
to suit your word order — `"{percent}% translated"` and
`"traducido al {percent}%"` are both fine.

## Strings that contain markup

Some values carry inline HTML, because the English sentence wraps a code sample
or a link:

```json
"help.installPurePythonPackagesFrom": "Install pure-Python packages from PyPI with <code>%pip install</code>:"
```

Translate the prose around the tags and leave the tags and their contents alone.
`%pip install` is a command the user types; translating it breaks it.

Only `<code>`, `<strong>`, `<em>`, `<b>`, `<i>`, `<br>`, `<span>` and `<a href>`
survive. Anything else is stripped at render time — including any styling your
editor might paste in — and attributes other than `href` are dropped. So paste
as plain text, and do not add markup that was not in the English.

You may reorder the tags within the sentence if your language needs it.

If a whole string is meant to stay identical to English, list its key in
`strings.__literal`. Keys listed there are excluded from the completeness score,
so they do not count against you as untranslated.

## Word senses

"Cell", "Run", "Kernel", "Language" and "Workbook" all mean something specific
in a scientific notebook and something else in ordinary use. Translating them
from the English alone is guesswork, and the guess is often wrong in exactly the
way a reviewer then has to catch.

So a sense is named **once**, with a short mnemonic, in `en.json`'s `__senses` —
rather than every string that happens to contain the word re-explaining it:

```json
"__senses": {
  "Cell-Notebook": "The unit of code and its output in a notebook document. Not biological, not a spreadsheet cell, not a prison cell.",
  "Language-Interface": "The display language of the app's own menus and messages — the locale.",
  "Language-Programming": "The programming language a cell's code is written in (Python, Prolog, R…)."
}
```

Strings then point at the senses they carry, in `__senseOf`:

```json
"__senseOf": {
  "menu.runAll": ["Run-Execute", "Cell-Notebook"],
  "tour.newCellLanguage.title": ["Language-Programming", "Cell-Notebook"]
}
```

The `Language-Interface` / `Language-Programming` split is the one that matters
most here. This app has both, English uses one word for them, and most languages
do not — Spanish takes *idioma* and *lenguaje*. Getting that backwards in the
onboarding tour would actively mislead the newcomer it exists to orient.

### Your glossary

Decide your term for each sense **once**, before translating, and record it in
your catalogue's `__glossary`:

```json
"__glossary": {
  "Cell-Notebook": "celda",
  "Language-Interface": "idioma",
  "Language-Programming": "lenguaje"
}
```

Then use it consistently. This is what makes "consistent terminology" something
a reviewer can actually check, rather than a instruction they have to hold in
their head across 60 strings.

**The glossary is a decision record, not a lint rule.** The build verifies that
every sense id referenced actually exists — a typo fails the build — but it does
**not** check that your strings contain your declared term. Inflection,
agglutination and scripts without word boundaries make that kind of substring
matching produce confident nonsense. The value is in forcing the decision once
and making it visible, not in mechanical enforcement.

If you add a string whose meaning is not obvious in isolation, tag it with a
sense (or add a new one) at the same time. Per-string prose that is *not* about
a term — "keep the trailing ellipsis", "this is a step counter" — still goes in
`__context`. `__`-prefixed keys are ignored by the completeness score, so none
of this costs you anything.

## Right-to-left languages

Latin identifiers keep their own direction inside an RTL sentence. Write the
sentence naturally in your language and leave the identifier alone — the browser
handles the bidirectional run:

```
"Import File (.srwb, .ipynb, .csv)"
"استيراد ملف (.srwb, .ipynb, .csv)"
```

Do not reverse the extension list, and do not add directional marks unless
something actually renders wrongly.

**Before reviewing an RTL translation, check the layout separately.** Run:

```js
window.i18n.activate('en-x-rtl')
```

That renders the English strings right-to-left, so layout problems can be found
and fixed without a translator wading through them. A reviewer's time should go
on language, not on misplaced margins.

> **Known limitation.** The app's CSS still uses ~56 physical, direction-
> dependent declarations (`margin-left`, `text-align: left`, `left:`) rather
> than logical ones (`margin-inline-start`, `text-align: start`,
> `inset-inline-start`). RTL layout is therefore **not yet correct**, and that
> should be fixed before an RTL locale is marked `reviewed`.

## Privacy and consent text is separate

Privacy strings live in their own catalogue, `privacy.<code>.json`, with its own
`status`. A locale can have a fully reviewed UI and a draft policy at the same
time — the manifest records both — and the two never block each other.

This is deliberate. A mistranslated button is a papercut; a mistranslated
privacy disclosure is a legal document that says the wrong thing, and Google
Play requires the policy to be accurate.

**Every translated policy is informational only. The English version is the
official one, and the translation must say so.** That notice is itself a string
(`privacy.translationNotice`) precisely because it is the sentence a reader of a
translated policy most needs to understand — so it must appear in their
language, not in English.

A privacy catalogue should not be marked `reviewed` on the strength of a
fluent-sounding draft. It needs someone accountable for the claims it makes.

## Regenerating the manifest

`i18n/manifest.json` is generated, not hand-edited. After adding or changing any
catalogue:

```bash
npm run i18n:manifest     # regenerate
npm run i18n:check        # verify it is current (CI-friendly)
```

The app reads the manifest to populate the language picker, so a locale that is
not in it will not appear no matter how complete the catalogue is.

## Tone

SciREPL is a tool for scientific and technical work. Aim for clear, neutral,
professional register — the voice a well-written IDE uses. Prefer your
language's established computing vocabulary over literal translations of the
English, and prefer regionally neutral forms unless the code says otherwise
(`pt-BR` is deliberately Brazilian; plain `pt` is not).

## Checking your work

With the dev server running:

```bash
node server.js
node test_appearance.mjs
```

In the app's console:

```js
window.i18n.completeness          // per-locale score, 0..1
window.i18n.available()           // what the picker will actually offer
window.i18n.statusOf('ar')        // 'draft' or 'reviewed'
await window.i18n.activate('ar')  // switch, including direction
```

A catalogue that merely copies the English values scores as **untranslated** —
that check exists so a stub cannot look finished.

### What the completeness score does *not* tell you

It measures how much of the **catalogue** is translated, not how much of the
**app** is. Those diverged once already: the catalogue was 100% translated while
91% of the interface was still hard-coded English, and nothing complained.

`npm run i18n:manifest` now also counts visible strings that are not wired for
translation and refuses to let that number grow, printing a line like:

```
[i18n] UI coverage: 230/248 strings wired (93%), 18 unwired (baseline 18).
```

If you add UI, tag it (`data-i18n`, `data-i18n-html`, `data-i18n-title`,
`data-i18n-placeholder`, `data-i18n-aria-label`) and add the key, or the build
fails and lists what you missed. The remaining 18 are decorative `×` glyphs and
one status badge written from JavaScript.

## Reviewing a draft

You are checking that the language is right, not that it is present:

- correct meaning, not just plausible words;
- consistent terminology across the whole catalogue;
- the register above;
- identifiers and placeholders untouched (see the table);
- for RTL, that the layout has already been fixed — otherwise report layout
  separately rather than treating it as a translation defect.

When satisfied, change `"status": "draft"` to `"reviewed"` and say in the commit
who reviewed it.
