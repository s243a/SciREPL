# Localization scope — what is and is not translated

This is deliberately honest about coverage, because "the app is localized" is a
claim a user relies on and a half-truth there is worse than none.

## What IS localized

Everything wired through the i18n catalogues (`www/i18n/`), rendered via
`data-i18n*` attributes or `window.t()`:

- The application shell in `index.html` — header, menus, the main dialogs.
- The **Appearance** dialog in full.
- The **onboarding tour**.
- The **privacy policy** (via its own domain catalogue, `privacy.<code>.json`,
  gated on that catalogue's review status).

The build reports this surface and holds a ratchet against regressions:

```
npm run i18n:manifest
# [i18n] UI coverage: 232/250 strings wired (93%), 18 unwired ...
```

The 18 unwired are decorative `×` close glyphs and one JS-written status badge.
`scripts/check-i18n-keys.mjs` additionally fails the build if code references a
key the catalogues do not define.

## What is NOT localized yet

Roughly 90 strings are generated in JavaScript, in app subsystems this PR did not
touch, and remain English regardless of the selected language:

| Area | File | Examples |
| --- | --- | --- |
| Files & storage / VFS | `file_io.js` | "Click again to confirm clear" |
| Prolog settings panel | `prolog_settings.js` | "Click to select folder" |
| Export flow dialogs | `export.js` | "No cells to export." |
| Notebook rename/manage | `notebook_manager.js` | "Rename Notebook" |
| Editor placeholders | `app.js` | "Type Markdown here…" |

These are not wired through `window.t()`. Translating them is a follow-up
localization pass, not a bug in this one — the machinery is in place (add the
key to `en.json`, call `window.t('…')`, and `check-i18n-keys.mjs` will keep it
honest), but the strings themselves have not been extracted.

## Why this boundary

The coverage ratchet measures the **static** shell, which is why it can honestly
report 93% while the dynamic strings above are still English: they never appear
in the HTML the ratchet scans. That is a real limitation of the measure, stated
here so the number is not mistaken for total coverage. Extending the ratchet to
the dynamic surface, and extracting those strings, is the next localization
increment.
