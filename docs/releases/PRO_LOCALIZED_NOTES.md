# Localized Pro release highlights

`pro-1.5.0-highlights.json` contains four non-legal highlights for English and
the twelve existing target UI locales. Target translations remain **draft**;
passing structural/browser tests is not native-speaker approval. These pages
are deliberately labelled summaries, not translations of every paragraph in
the complete English notes.

The English source remains `www/pro/releases/v1.5.0.html`, at its existing
canonical URL. Its release status, complete limitations and validation gates
are not rewritten by the locale renderer. Each summary links back to it for
current availability and status, so a summary never claims release clearance.
The renderer adds a language chooser to the English source without replacing
its prose. Existing app builds linking to that English page can use the chooser.

Routes:

- English/full source: `/SciREPL/pro/releases/v1.5.0.html`.
- Draft summary: `/SciREPL/pro/releases/v1.5.0/<locale>/`.
- Unknown locales and versions do not get invented translated routes.

The matching Pro application change calls its allowlisted public-note resolver
on every What's New render, including a language change while the dialog is
open. It preserves the exact configured English fallback. No release-note link
points to the private Pro GitHub repository.

Regenerate only with an explicit destination, then inspect the diff:

```sh
node scripts/render-pro-release-notes.mjs --output www/pro/releases
node scripts/render-pro-release-notes.mjs --check
node tests/test_pro_public_release_notes.mjs
node tests/test_public_release_notes.mjs
node tests/test_pro_public_release_notes_browser.mjs
```

The existing Pages workflow overlays `www/pro/` recursively onto its selected
stable app. This means committed pages are published without rebuilding an
Android bundle, but a local renderer pass or source merge is not proof of a
successful Pages deployment. Verify the actual deployment and all thirteen
public routes before a Pro release may rely on them. The Pro application
change and public-site publication are separate repositories and gates.

For the next release, freeze its version and actual feature scope first, add
its own source/translated highlights and generated routes, then explicitly add
that prepared version to the Pro app's resolver allowlist. Do not point a new
version at 1.5.0 as if those were its own complete release notes. A separate
language increment must add its own draft source and public routes; it must
not be counted as localized merely because English fallback works.
