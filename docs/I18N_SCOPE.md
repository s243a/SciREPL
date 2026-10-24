# Localization scope — coverage and its limits

Catalogue completeness, interface wiring, runtime behavior and language quality
are different claims. A successful machine check establishes only the scope it
actually inspects, not that every screen is localized or ready for release.

## What the catalogue checks cover

App interface strings live in `www/i18n/` and are consumed through `data-i18n*`
attributes, `window.t()` and the runtime localization helpers. This includes
static shell text as well as runtime-generated dialogs and messages; JavaScript
generation alone is not evidence that a string remains English.

The UI catalogue's completeness score compares its values with the English base,
subject to declared literal identifiers. It does not count every possible app
message, verify its meaning, or confer native-speaker approval. A `draft`
catalogue remains under review even when its measured coverage is complete.

Privacy and consent text use a separate domain catalogue,
`privacy.<code>.json`, with a separate review status. A draft translated policy
does not replace the official English policy body or its consent button; the
localized unofficial-translation notice remains available independently.

## Static coverage and source checks

Run:

```bash
npm run i18n:manifest
npm run i18n:check
```

The manifest generator counts recognized visible elements in `index.html` that
are wired for translation and holds the unwired count at or below a configured
ratchet baseline. The reported ratio is a **static HTML wiring measure**, not an
app-wide translation percentage. The baseline is an upper limit, not a current
inventory of untranslated text.

`scripts/check-i18n-keys.mjs` also scans supported literal key/reference forms in
production sources, verifies that the English catalogue defines them, and checks
supported literal fallback values against that catalogue. Its narrow
`help.keyboardTrustNotice` guard requires translated keyboard-safety copy in
every UI locale. These checks do not exhaustively analyze computed keys,
runtime-generated prose or all possible execution paths.

Translation lint can flag placeholder, identifier, markup or possible content
problems, but passing it does not prove that the wording is correct. Intentional
identifier literals and fallback behavior must not be mistaken for defects.

## Runtime and release evidence remain separate

Browser checks must exercise dialogs, generated messages, error paths and
language changes while views are open, as well as narrow-screen and RTL layout.
Native-wrapper surfaces require their own platform validation; a browser result
does not establish native behavior or native-language quality.

There is no current exhaustive count here of remaining dynamic English strings.
Any reported gap should identify the observed screen, locale and execution path
rather than infer it from an old subsystem list or a catalogue percentage.
Keep review statuses honest until accountable language review is recorded.

App catalogue checks also do not establish tutorial/workbook rendering, link
validation, publication or native release-check completion. Those outputs and
release gates need their own evidence.
