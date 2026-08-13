# Proposal: searchable catalog, language filter, and catalog sources

**Status:** design note. Nothing here is implemented.

The Browse Packages, Bundles & Workbooks modal is a hardcoded list in
`www/js/package_catalog.js`. Every curated entry is shown, in a fixed
Packages → Bundles → Workbooks order, with no search, no kernel filter, and
no way to point SciREPL at another repo. This note proposes keeping that
curated list as the **default view**, then adding:

1. A search field that can surface **additional** items, not just filter the
   defaults.
2. A language filter that **defaults to the kernel currently selected** in
   the editor (`#lang-selector` / `kernelManager.currentLanguage`).
3. A Sources panel for **catalog index URLs** (typically GitHub repos that
   publish workbooks and packages).

The hard part is not the UI. It is where those extra items live, and which
platforms can fetch them. SciREPL has no production backend. The `/proxy`
on `npm run serve` is a local-dev GitHub-release helper, not a PWA feature.

## Why this shape

The current catalog is small on purpose: it is the set of items that install
offline from same-origin `pages_url` copies bundled with the app. That is
the right default. Hiding it behind a remote registry, or replacing it with
whatever a search index returns, would make the first-open experience
depend on the network and on CORS.

Search should **widen** the pool, not replace it:

| Search box | What you see |
| --- | --- |
| Empty | Built-in curated entries, after the language filter |
| Non-empty | Built-in matches **plus** matches from enabled catalog sources |

Typing a query is what justifies extra network work. Opening Browse with an
empty search stays a local, offline-capable view of the same items as today
(language-sliced).

## Current behaviour (the baseline we must not regress)

- Catalog data is a JS array getter, `PackageCatalog.packages`.
- Each entry is `package`, `bundle`, or `workbook`, with `kernels`, optional
  `requires` / `items`, and a fetch source (`pages_url` and/or `url`).
- Install tries `pages_url` first (same-origin, works in the PWA, Android
  WebView, and Electron), then the GitHub release `url`.
- `_fetchPackage` already has a platform cascade:

  1. Same-origin / relative URL → `fetch`
  2. Capacitor native `Filesystem.downloadFile` (Android)
  3. Direct `fetch` (needs CORS)
  4. `/proxy?url=...` (dev server only; GitHub **release downloads** only)

- Production GitHub Pages has **no proxy**. Release URLs without CORS only
  work because the same files are also shipped as `pages_url`.
- Electron enables `webSecurity` and exposes **no download IPC**. The
  renderer is treated as untrusted (notebook JS shares `window`). Electron
  is therefore in the same CORS boat as the PWA, not the same boat as
  Android.
- `test_browse_catalog.mjs` asserts the modal opens with all three sections
  and at least 17 cards. A default language filter will hide entries unless
  tests select “All languages” or the current kernel is one that every
  fixture uses.

## UI

Mobile-first, inside the existing catalog modal. No stacked second modal for
the everyday controls; Sources is a panel you push/pop in the same dialog.

```
┌ Browse Packages, Bundles & Workbooks ──────────── × ┐
│ One-click install packages, bundles, and workbooks. │
│                                                     │
│ [ Search packages, bundles, workbooks… ]  [Sources] │
│ Language: [ Python            v ]                   │
│                                                     │
│ Packages                                            │
│   UnifyWeaver SciREPL          prolog, python  [✓]  │
│ Bundles                                             │
│   … only if they include Python …                   │
│ Workbooks                                           │
│   Life Expectancy Analysis     python, r      [Install]
│   Compute Pi …                 python         [Install]
│   Tidyverse Data Wrangling     python, r      [Install]
└─────────────────────────────────────────────────────┘
```

With Python selected and an empty search, Prolog-only and R-only cards
disappear. That is the filter working, not a different catalog. **All
languages** restores today’s full list in one tap.

Sources panel (same modal, back chevron):

```
┌ ‹ Catalog sources ──────────────────────────────── × ┐
│ Built-in SciREPL catalog              on  (pinned)   │
│                                                      │
│ [ https://github.com/user/workbooks          ] [Add] │
│                                                      │
│ My workbooks  github.com/user/workbooks              │
│   last fetched 2h ago · 12 items            [on] [–] │
│   fetch failed: blocked by browser CORS      [Retry] │
│                                                      │
│ Extra items appear when you search. HTTPS only.      │
│ GitHub repos need a scirepl-catalog.json that the    │
│ browser is allowed to read (see CORS below).         │
└──────────────────────────────────────────────────────┘
```

### Language filter rules

- Options: **All languages**, then every kernel in `#lang-selector`
  (python, prolog, bash, javascript, r, lua, typr, clojurescript).
- On open, set the filter to `kernelManager.currentLanguage`. Changing the
  editor language while the modal is already open does **not** retarget the
  filter; reopening does.
- An entry matches when `kernels` is missing, or contains the selected
  kernel. Multi-kernel workbooks (python+r) show for either kernel.
- A bundle matches if its own `kernels` matches, or if any of its `items`
  would match. Showing a bundle that then installs hidden Prolog workbooks
  is acceptable; the bundle card already lists what it contains.
- Empty sections omit their header (already true).
- Persist the last **explicit** choice? No. Always re-default to the
  current kernel on open, so the control stays a view over “what I am
  writing now”, not a hidden setting.

### Search rules

- Filter name, description, id, kernel ids, and bundle contents.
- Case-insensitive substring is enough for v1. No fuzzy ranking.
- Empty query: built-in entries only (after language filter). **Do not**
  show remote-source items, and **do not** fetch remote indexes.
- Non-empty query: union of built-in matches and enabled-source matches.
  Fetch each enabled source the first time a query is run this session
  (then keep it in memory). A Sources “Retry” / toggle-on also fetches.
- Built-in hits stay at the top of each section; source hits follow, with
  a small origin label (`user/workbooks`) so it is obvious they are not
  curated.
- Offline / CORS failure on a source: keep built-in results, show one
  non-blocking line under the toolbar (“2 sources unavailable”). Never
  empty the default catalog because a remote index failed.

### Sources rules

- Built-in catalog is pinned, always on, not editable.
- User sources persist in `localStorage` (same family as installed-package
  state). Shape: `{ id, url, enabled, label?, lastFetchedAt?, lastError? }`.
- HTTPS only. Reject credentials in the URL, `javascript:`, and non-https
  schemes. Same stance as Electron’s external-open policy.
- Adding a **GitHub repo URL** (`https://github.com/owner/repo`) is a
  convenience: resolve it to a catalog index, do not scrape HTML.
- Adding a **direct index URL** (`…/scirepl-catalog.json`) is the
  primitive. Repo paste is sugar over that.
- Removing a source does not uninstall anything already imported.

## Catalog index format

Keep it aligned with the in-app entry schema so `_renderCard` / `_install`
can consume remote items without a second type.

```json
{
  "format_version": "1.0",
  "name": "Example workbooks",
  "source": "https://github.com/example/scirepl-workbooks",
  "items": [
    {
      "id": "example-pi",
      "name": "Compute Pi",
      "description": "Archimedean bounds notebook.",
      "type": "workbook",
      "kernels": ["python"],
      "url": "https://raw.githubusercontent.com/example/scirepl-workbooks/main/pi.srwb",
      "size": "~6 KB",
      "revision": 1,
      "format": "srwb"
    }
  ]
}
```

Rules for remote items:

- `id` must be unique **within that source**. The app namespaces as
  `sourceId:itemId` so two repos can both ship `intro`.
- `url` is the installable artifact. For the PWA it must be a CORS-open
  HTTPS URL (see below). `pages_url` on a remote item is only useful if it
  is same-origin with the running app, which community repos will not be.
- No `displayNameKey` / i18n keys from remote JSON. Remote text is shown
  as authored. The chrome (Search, Sources, section headers, errors)
  stays in the i18n catalogues.
- Ignore unknown fields. Reject the whole index if `format_version` is
  newer than we understand, and say so in `lastError`.
- Cap index size (e.g. 500 items / 1 MB JSON) so a huge file cannot stall
  a phone.

### Resolving a GitHub repo URL

Try, in order, and stop on the first JSON that parses as a catalog:

1. `https://cdn.jsdelivr.net/gh/owner/repo@HEAD/scirepl-catalog.json`
2. `https://raw.githubusercontent.com/owner/repo/HEAD/scirepl-catalog.json`
3. `https://owner.github.io/repo/scirepl-catalog.json` (often **fails CORS**
   when `owner` is not the SciREPL Pages host)

Do **not** call `api.github.com` from every Browse session. Unauthenticated
GitHub API is 60 requests/hour/IP; a popular PWA would burn that immediately.

jsDelivr is already in the privacy policy for runtime version checks, so it
is a known optional network peer. Prefer it as the first probe because it
sends CORS headers and sits on a CDN.

## Cross-origin: what actually works

This is the issue. There is no general “fetch this GitHub repo” that works
everywhere.

| Surface | Built-in `pages_url` | GitHub **release** zip/ipynb | `raw.githubusercontent.com` / jsDelivr | Other GitHub Pages origin | Arbitrary HTTPS |
| --- | --- | --- | --- | --- | --- |
| PWA on GitHub Pages | Yes (same origin) | **No** (no CORS, no `/proxy`) | Yes, if the file is public | **Usually no** (Pages does not send `ACAO`) | Only if that host sends CORS |
| `npm run serve` | Yes | Yes, via `/proxy` **only** for `github.com/…/releases/download/` | Yes, if CORS | Usually no | No, proxy will 403 |
| Android (Capacitor) | Yes | Yes (native HTTP) | Yes | Yes | Yes (native HTTP) |
| Electron | Yes | **No** (CORS, and no download IPC) | Yes, if CORS | Usually no | Only if CORS |

Two surprises relative to the usual “native apps ignore CORS” intuition:

1. **Electron is not Android.** `desktop/electron/security.js` treats the
   renderer as fully untrusted because the JavaScript kernel (and Scittle,
   Fengari, Pyodide’s JS bridge) share `window`. There is no privileged
   “download this URL” channel, on purpose. Adding one for catalog sources
   would be reachable from notebook code. **Do not add it for this feature.**
   Electron stays on the PWA fetch rules.
2. **The PWA cannot grow a proxy** without becoming a hosted backend, which
   SciREPL is not. Extending `server.js` `/proxy` helps local development
   only. It does not help `*.github.io` installs, F-Droid WebView builds
   that load Pages, or a service-worker-cached PWA opened from the home
   screen.

### Practical consequence for source authors

If a catalog is meant to work in the **PWA and Electron**, both the index
and the artifacts must be on a CORS-open host. The reliable public options
today:

- `raw.githubusercontent.com/owner/repo/…`
- `cdn.jsdelivr.net/gh/owner/repo@ref/…`

GitHub **Releases** (`github.com/…/releases/download/…`) are the right
place for large zips in the *built-in* catalog, because we also ship
`pages_url`. They are the **wrong** default for community sources: they
install on Android, and on `npm run serve`, and nowhere else.

Same-org GitHub Pages is a narrow extra: `https://s243a.github.io/other-repo/…`
is same-origin with the SciREPL PWA, so it would work without CORS. That is
an implementation accident, not a community-source strategy.

### Error copy when CORS blocks an install

Do not dump a raw `TypeError: Failed to fetch`. Say which platform can
still do it, and offer the existing manual path:

> This file is on a host the browser will not read (cross-origin). On
> Android it would download directly. Elsewhere, download it yourself and
> use Menu → Import Package.

Sources that fail at **index** fetch get a Retry on the Sources panel, not
a modal.

## Privacy and consent

Today, catalog installs are user-initiated downloads from GitHub, already
disclosed. Two new behaviours need a policy line **when they ship**, not
in this design-only PR:

1. Fetching a user-added `scirepl-catalog.json` (and jsDelivr/GitHub as
   the resolved host).
2. Fetching the artifact URL when the user taps Install on a search hit.

Empty-search Browse must not hit the network. That keeps the default view
honest offline and avoids a surprise request on every menu open.

Do not probe sources in the background. Do not send the search string to
any server; filtering is local against indexes the user enabled.

## Trust

A catalog source is as trusted as “Import Package” from a URL the user
pasted. SciREPL already executes installed notebooks and package JS
wrappers. Sources do not change that, but the UI should make origin
visible on every remote card.

Refuse to follow redirects off HTTPS. Cap download size with the same
instinct as package install (show `size` from the index; if the host
sends a huge `Content-Length`, abort).

## What we are not doing

- A central SciREPL registry or search API. No backend.
- Scraping GitHub repo file trees or README pages.
- Using `api.github.com` as the everyday index.
- Auto-adding community repos. The built-in list stays the default.
- Changing which items are in the built-in array. Search finds *more*;
  it does not demote UnifyWeaver, ggplot2, TypR, etc.
- An Electron or PWA CORS bypass.
- Filtering by UI locale. “Language” here is the **kernel**, not i18n.

## Suggested implementation order

Keep the comparison/filter layer pure and testable without a browser,
same split as `docs/proposal-package-update-checks.md`.

1. **Pure filter** — given entries, a query string, and a kernel id,
   return the visible list. Unit-testable in node. Covers “empty query
   ⇒ built-in only”, kernel membership, bundle matching, namespacing.
2. **Catalog UI** — search input, language `<select>`, empty-state copy.
   Wired only to the built-in array. `test_browse_catalog.mjs` must
   select All languages (or the test kernel) before counting cards, so
   the default-filter change does not look like a missing workbook.
3. **Index fetch + Sources panel** — persist sources, resolve GitHub
   repo URLs, parse `scirepl-catalog.json`, union on search. CORS
   failures are first-class UI, not console noise.
4. **Install from remote hits** — reuse `_fetchPackage`. On PWA/Electron
   CORS failure, the manual-import message above. Android uses native
   HTTP as it already does.
5. **Privacy policy** — one paragraph for user-added catalog sources,
   kept in sync with `privacy:check`.
6. **Docs** — a short “Publishing a catalog source” section in
   `docs/packages.md` once the JSON schema is real.

Phase 2 is already a useful PR on its own (search + language filter over
today’s list). Phase 3 is what makes search find *more*. Do not ship
Sources without the CORS error path; a button that adds a GitHub release
URL and then fails silently on the PWA is worse than no button.

## Test notes

- `test_browse_catalog.mjs` currently assumes every built-in card is
  visible on open. After phase 2 it should assert:
  - default filter equals the current kernel (python in the fixture);
  - All languages restores ≥ 17 cards and the three section headers;
  - a query that matches only a remote fixture appears only after the
    source is enabled (phase 3, with a stub index, not live GitHub).
- Do not hit the network in CI for source tests. Serve a tiny
  `scirepl-catalog.json` from the same origin via `server.js`.
- A Playwright case that points at a cross-origin URL **without** CORS
  headers should assert the unavailable-source line, not a thrown error.

## Open questions

1. **Default language vs “same defaults”.** Defaulting to the current
   kernel *does* hide some of today’s cards (open Browse on Python, and
   the Lua/TypR/Prolog-only workbooks are gone until you pick All). That
   matches “filter defaults to the selected language.” If first-open
   must be byte-for-byte the current list, default the control to All
   and keep “Current language” as a one-tap chip instead. Recommendation:
   default to the current kernel; All is one tap.
2. **Should a non-empty search that matches nothing in sources still
   show built-in misses?** No. Search filters everything. Zero hits is
   allowed; keep the empty copy explicit (“No matches in the built-in
   catalog or 2 sources”).
3. **jsDelivr vs raw.githubusercontent.com as the documented author
   path.** Both work in the PWA. jsDelivr caches; raw is canonical.
   Resolve both; document raw as the file you put in the repo and
   jsDelivr as the URL the app will try first.
4. **F-Droid / Android WebView loading Pages rather than the Capacitor
   shell.** If a build ever loads the PWA URL inside a WebView *without*
   the Filesystem plugin, it inherits PWA CORS. Native HTTP is a
   Capacitor-shell feature, not “any Android”.
5. **Related work.** Package *update* checks
   (`docs/proposal-package-update-checks.md`) also need a fetch layer
   and must not cache mutable indexes forever. If both ship, they should
   share “fetch this HTTPS JSON with CORS/native cascade” rather than
   growing two helpers. Out of scope for the first catalog-browse PR.
