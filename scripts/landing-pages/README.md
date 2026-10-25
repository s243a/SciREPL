# Pro guide pages

Short, demonstration-led pages about specific uses of SciREPL, published at
`https://s243a.github.io/SciREPL/pro/guides/<slug>/`. Each page explains what
works and what doesn't, shows examples you can reproduce, and links to both the
free edition and SciREPL Pro on Google Play.

| Path | What it is |
| --- | --- |
| `scripts/landing-pages/<slug>.json` | Page content. All copy lives here. |
| `scripts/landing-pages/template.mjs` | Renderer (no dependencies). |
| `scripts/build-landing-pages.mjs` | Validates every config and writes the pages. |
| `www/pro/guides/assets/` | Shared stylesheet and images, served as-is. |
| `www/pro/guides/<slug>/index.html` | Generated page. Do not edit by hand. |

```bash
node scripts/build-landing-pages.mjs          # regenerate the pages
node scripts/build-landing-pages.mjs --check  # verify (part of npm run test:help)
```

The build checks each config: required fields, title ≤60 characters, meta
description 70–160, alt text on every image, image files that exist, and unique
section ids.

## Why under `/pro/`

`www/sw.js` serves everything under `/SciREPL/` from the PWA's app cache,
except the `pro/` and `help/` folders (`PUBLIC_PAGE_ROOTS`), which go to the
network. Pages here are always fresh and stay out of the app cache. A push to
`main` that touches `www/pro/**` also redeploys Pages without a new release
(see `.github/workflows/deploy-pages.yml`).

## Adding a page

1. Copy an existing config to `scripts/landing-pages/<slug>.json` and rewrite
   it.
2. Section types: `cards`, `examples` (code with an optional phone
   screenshot), `checks`, `limits`, `steps`, `table`. An example takes either
   `code` (one cell) or `cells` (an array, one Copy button per cell). Never put
   two cells in one block: pasted as one cell, a Prolog query after a rule is
   loaded as a fact instead of being run. Keep the section ids
   `examples`, `free-vs-pro`, `limits` and `start`, so links to those anchors
   work on every page.
3. Text fields accept only `` `code` `` and `[text](url)` as markup. Everything
   else is escaped.
4. Run the build and commit the generated `index.html` with the config.

## Behaviour

- **Play links** carry a `referrer`, so Play Console can credit installs to
  their source. A visitor who arrives with UTM tags has those tags copied into
  the referrer by a small inline script. The referrer is serialised with
  `URLSearchParams` and then encoded, so values containing `+`, `&` or `=`
  arrive intact. Everyone else gets the page default.
  Without JavaScript the links still work, using the default.
- **Copy buttons** on code blocks appear only when the Clipboard API is
  available.
- **Analytics** are off. Setting `analytics.cloudflareToken` in a config would
  load Cloudflare Web Analytics; update the privacy policy before doing that.
- **No external requests:** system fonts, an inline favicon, no CDN libraries.
- **Theme:** dark by default, matching the app; follows the system light theme.

## Screenshots

The images in `assets/img/` were captured from the live web edition at phone
size, by running the exact code shown next to each one. The page footer says
so. Screenshots taken on an Android phone would be a good replacement.
`og-android-notebooks.png` (1200×630) is the link-preview image.
