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

If a whole string is meant to stay identical to English, list its key in
`strings.__literal`. Keys listed there are excluded from the completeness score,
so they do not count against you as untranslated.

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
