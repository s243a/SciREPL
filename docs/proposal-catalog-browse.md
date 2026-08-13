# Proposal: searchable catalog, language filters, and catalog sources

**Status:** design note. Nothing here is implemented.

The Browse Packages, Bundles & Workbooks modal is a hardcoded list in
`www/js/package_catalog.js`. Every curated entry is shown, in a fixed
Packages → Bundles → Workbooks order, with no search, no filters, and no
way to point SciREPL at another repo. This note proposes keeping that
curated list as the **default view**, then adding:

1. A search field that can surface **additional** items, not just filter the
   defaults.
2. A **spoken-language** filter (interface / content locale) that **defaults
   to the app’s current locale** (`i18n.current`).
3. A **programming-language** filter (kernel) as a second control, defaulting
   to All so the first-open list stays the same as today.
4. A Sources panel for **catalog index URLs** (typically GitHub repos that
   publish workbooks and packages).

The two “language” controls are different senses. The i18n catalogues
already keep them apart (`Language-Interface` vs `Language-Programming` in
`www/i18n/manifest.json`). The first draft of this note used the kernel for
the default filter; that was the wrong sense. Spoken language is the one
that should follow the app. Kernel is optional extra narrowing.

The hard part is still not the UI. It is where extra items live, and which
platforms can fetch them. SciREPL has no production backend. The `/proxy`
on `npm run serve` is a local-dev GitHub-release helper, not a PWA feature.

## Why this shape

The current catalog is small on purpose: it is the set of items that install
offline from same-origin `pages_url` copies bundled with the app. That is
the right default. Hiding it behind a remote registry, or replacing it with
whatever a search index returns, would make the first-open experience
depend on the network and on CORS.

Search should **widen** the pool, not replace it:

| Search box | Spoken language | What you see |
| --- | --- | --- |
| Empty | app locale (default) | Built-in curated entries, same as today. Kernel filter only if the user changed it from All. |
| Non-empty | app locale (default) | Built-in matches **plus** source matches whose **content locale** includes the selected spoken language |
| Non-empty | All spoken languages | Built-in matches plus source matches in any locale |

Typing a query is what justifies extra network work. Opening Browse with an
empty search stays a local, offline-capable view of the same items as today.

That split also resolves the locale mismatch in the built-in catalog:
**card chrome is translated, notebook content is English.** A Japanese UI
still shows UnifyWeaver and ggplot2 on first open (names and descriptions
come from `www/i18n/ja.json`). Search is how you find a Japanese-language
workbook from a source you added. The spoken-language filter is the default
scope for that wider pool, not a knife that cuts the curated list down to
whatever happens to be authored in `ja`.

## Current behaviour (the baseline we must not regress)

- Catalog data is a JS array getter, `PackageCatalog.packages`.
- Each entry is `package`, `bundle`, or `workbook`, with `kernels`, optional
  `requires` / `items`, and a fetch source (`pages_url` and/or `url`).
- Display names and descriptions for built-in entries go through
  `displayNameKey` / `descriptionKey`. The notebooks themselves are English.
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
  and at least 17 cards. With the rules below, that still holds: empty
  search + default filters = the current list.

## UI

Mobile-first, inside the existing catalog modal. No stacked second modal for
the everyday controls; Sources is a panel you push/pop in the same dialog.

```
┌ Browse Packages, Bundles & Workbooks ──────────── × ┐
│ One-click install packages, bundles, and workbooks. │
│                                                     │
│ [ Search packages, bundles, workbooks… ]  [Sources] │
│ Spoken language: [ 日本語                 v ]       │
│ Kernel:          [ All                    v ]       │
│                                                     │
│ Packages                                            │
│   UnifyWeaver SciREPL     prolog, python  EN  [✓]   │
│ Bundles                                             │
│   UnifyWeaver Tutorials…  4 workbooks     EN  [Install]
│ Workbooks                                           │
│   Life Expectancy Analysis  python, r     EN  [Install]
│   …every built-in card, same as today…              │
└─────────────────────────────────────────────────────┘
```

After typing a query, with spoken language still 日本語:

```
│ Workbooks                                           │
│   Compute Pi …            python          EN  [Install]  ← built-in hit
│   円周率の計算            python          JA  [Install]  ← source hit
│     example/scirepl-workbooks                       │
```

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

On a narrow phone the two selects wrap under the search row. Labels must
use the existing senses so translators do not collapse them: spoken
language is `Language-Interface`, kernel is `Language-Programming`.
Endonyms in the spoken-language dropdown come from `i18n/manifest.json`
(`日本語`, `Deutsch`, `English`, …), not from English names.

### Spoken-language filter (defaults to the app locale)

- Options: **All spoken languages**, then every locale in the i18n
  manifest that the app is willing to activate (same usability rule as
  `i18n.resolve()`: complete enough, reviewed or drafts-shown).
- On open, set the filter to `window.i18n.current`. Changing the app
  locale while the modal is already open does **not** retarget the
  filter; reopening does. Listen to `i18n:changed` only to relabel the
  chrome, not to override a choice the user already made in the dropdown.
- This filter does **not** hide built-in curated entries. Those are the
  default view. Their titles and descriptions are already translated;
  their notebook bodies are English and stay English.
- It **does** scope extra items from catalog sources. A source item
  matches when its `locales` list (see [Catalog index format](#catalog-index-format))
  includes the selected locale, or shares the primary subtag (`pt-BR`
  matches `pt`; `zh` matches `zh-Hans` only if we store the primary
  subtag — keep matching simple: equal code, or equal `code.split('-')[0]`).
- Missing `locales` on an item means `['en']`. English is the content
  language of everything we ship today.
- **All spoken languages** makes search return source hits in every
  locale. Use that when you are hunting for a title you saw in another
  language.
- Persist the last explicit spoken-language choice? No. Always
  re-default to `i18n.current` on open, so the control tracks the app,
  not a hidden setting.

### Programming-language filter (defaults to All)

- Options: **All**, then every kernel in `#lang-selector` (python, prolog,
  bash, javascript, r, lua, typr, clojurescript).
- Default **All**, so first-open still shows Prolog workbooks when the
  editor is on Python. That is the “same defaults” constraint.
- A one-tap “This kernel” chip (the current `#lang-selector` value) is
  worth adding if the two-select toolbar feels like too many steps to
  get to “Python only”. It is not the default.
- An entry matches All, or when `kernels` is missing, or when `kernels`
  contains the selected kernel. Multi-kernel workbooks (python+r) match
  either kernel.
- A bundle matches if its own `kernels` matches, or if any of its `items`
  would match. Showing a bundle that then installs a Prolog workbook the
  kernel filter would have hidden is acceptable; the bundle card already
  lists what it contains.
- Empty sections omit their header (already true).
- Changing the editor kernel while the modal is open does not retarget
  this filter either.

### Content-locale badge

When the card’s content locale is not the same as the spoken-language
filter (or, if the filter is All, not the same as `i18n.current`), show a
short badge (`EN`, `JA`, `PT-BR`). Japanese UI + English built-in
workbook → `EN`. That is honest without hiding the card.

Skip the badge when they match, so a Japanese source hit in a Japanese
UI is not noisy.

### Search rules

- Filter name, description, id, kernel ids, bundle contents, and locale
  codes / endonyms.
- Case-insensitive substring is enough for v1. No fuzzy ranking.
- Empty query: built-in entries only, after the **kernel** filter.
  Spoken language does not hide them. **Do not** show remote-source
  items, and **do not** fetch remote indexes.
- Non-empty query: union of built-in matches and enabled-source matches
  that pass both filters. Fetch each enabled source the first time a
  query is run this session (then keep it in memory). A Sources “Retry”
  / toggle-on also fetches.
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
  "name": "日本語ワークブック",
  "source": "https://github.com/example/scirepl-workbooks",
  "locales": ["ja"],
  "items": [
    {
      "id": "example-pi",
      "name": "円周率の計算",
      "description": "アルキメデスの上下界で円周率を挟むノートブック。",
      "type": "workbook",
      "kernels": ["python"],
      "locales": ["ja"],
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
- `locales` is the **content** language of the notebook or package, BCP 47
  tags from the same set the app uses (`en`, `ja`, `pt-BR`, …). It is not
  the kernel. A bilingual notebook lists both (`["en", "ja"]`) and matches
  either spoken-language filter.
- Index-level `locales` is the default for items that omit the field.
  Item-level wins. If both are missing, treat as `["en"]`.
- `name` / `description` are in the content language. v1 does not take
  per-locale maps (`{ "en": "…", "ja": "…" }`). A second-language edition
  is a second item (or a second source), not a parallel string table.
- No `displayNameKey` / i18n keys from remote JSON. Remote text is shown
  as authored. The chrome (Search, Sources, section headers, errors)
  stays in the i18n catalogues.
- `url` is the installable artifact. For the PWA it must be a CORS-open
  HTTPS URL (see below). `pages_url` on a remote item is only useful if it
  is same-origin with the running app, which community repos will not be.
- Ignore unknown fields. Reject the whole index if `format_version` is
  newer than we understand, and say so in `lastError`.
- Cap index size (e.g. 500 items / 1 MB JSON) so a huge file cannot stall
  a phone.

Built-in entries should grow an explicit `locales: ['en']` when this
ships, even though the filter will not hide them. That feeds the badge
and keeps the schema one shape.

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

Do not probe sources in the background. Do not send the search string, the
spoken-language filter, or the kernel filter to any server; filtering is
local against indexes the user enabled.

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
- Hiding built-in English workbooks because the UI is in another locale.
  Chrome is translated; content locale is a badge, not a gate, for
  curated entries.
- Per-locale string maps on remote items in v1.
- An Electron or PWA CORS bypass.
- Defaulting the kernel filter to the editor language. That would hide
  most of today’s list. Kernel defaults to All.

## Suggested implementation order

Keep the comparison/filter layer pure and testable without a browser,
same split as `docs/proposal-package-update-checks.md`.

1. **Pure filter** — given entries, a query string, a spoken-language
   code (`null` = All), a kernel id (`null` = All), and a bit that marks
   built-in vs source, return the visible list. Unit-testable in node.
   Covers “empty query ⇒ built-in only, locale ignored”, “non-empty ⇒
   locale gates source items”, kernel membership, bundle matching,
   namespacing, primary-subtag locale match.
2. **Catalog UI** — search input, spoken-language `<select>` defaulting
   to `i18n.current`, kernel `<select>` defaulting to All, locale badge,
   empty-state copy. Wired only to the built-in array. First-open card
   count must stay ≥ 17 so `test_browse_catalog.mjs` does not look like
   a missing workbook.
3. **Index fetch + Sources panel** — persist sources, resolve GitHub
   repo URLs, parse `scirepl-catalog.json`, union on search with locale
   gating. CORS failures are first-class UI, not console noise.
4. **Install from remote hits** — reuse `_fetchPackage`. On PWA/Electron
   CORS failure, the manual-import message above. Android uses native
   HTTP as it already does.
5. **Privacy policy** — one paragraph for user-added catalog sources,
   kept in sync with `privacy:check`.
6. **Docs** — a short “Publishing a catalog source” section in
   `docs/packages.md` once the JSON schema is real, including `locales`.

Phase 2 is already a useful PR on its own (search + both filters over
today’s list). Phase 3 is what makes search find *more*, and what makes
the spoken-language default do something beyond labelling. Do not ship
Sources without the CORS error path; a button that adds a GitHub release
URL and then fails silently on the PWA is worse than no button.

## Test notes

- `test_browse_catalog.mjs` currently assumes every built-in card is
  visible on open. After phase 2 it should still assert that on a stock
  English (or any) locale with kernel = All.
- Additional assertions:
  - spoken-language select equals `i18n.current` on open;
  - kernel select equals All on open;
  - switching kernel to `lua` hides non-Lua built-in cards and All
    restores them;
  - a query that matches only a remote fixture tagged `ja` appears when
    spoken language is `ja` (or All) and not when it is `en` (phase 3,
    stub index, not live GitHub).
- Do not hit the network in CI for source tests. Serve a tiny
  `scirepl-catalog.json` from the same origin via `server.js`.
- A Playwright case that points at a cross-origin URL **without** CORS
  headers should assert the unavailable-source line, not a thrown error.

## Open questions

1. **Should a future built-in Japanese workbook be a second catalog
   entry, or a locale variant of an English one?** Recommendation: a
   second entry with `locales: ['ja']`. Variants need a grouping id we
   do not have yet, and the default view is allowed to show both (built-in
   is never locale-gated). Search + spoken-language = `ja` would still
   prefer the Japanese source hits by ranking them with the built-in `ja`
   entry, not by hiding the English twin.
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
6. **Draft locales.** If the user has opted into draft UI translations,
   should those codes appear in the spoken-language filter? Yes — the
   filter lists the same locales the app can activate. A draft UI locale
   with no community content just means search will not add source hits
   until someone publishes a `locales: ['bn']` index.
