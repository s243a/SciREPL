# Verified catalogue sources

SciREPL Free can extend its bundled, offline catalogue with translated
workbooks from the official
[SciREPL Catalog](https://github.com/s243a/SciREPL-Catalog). Open **Menu →
Browse Packages, Bundles & Workbooks** to load the selected source. The app
keeps its bundled entries available if consent is declined, the network is
offline, or a remote update fails verification.

## Source channels

| Channel | Resolution | GitHub API | Update behavior |
| --- | --- | --- | --- |
| Latest stable (default) | `stable.json` on the configured static host | No | Checks at most once per 24 hours and uses the last verified copy while offline |
| Specific release | `releases/<tag>/release.json` on the static host | No | Immutable after its tag, commit, index size, and index hash are trusted |
| Specific commit | Full 40-character commit on `raw.githubusercontent.com` | No | Immutable |
| Development branch | Lightweight Git ref lookup, then a full commit on `raw.githubusercontent.com` | Yes | Volatile; intended for testing rather than normal use |

The official static host is
`https://s243a.github.io/SciREPL-Catalog/`. Stable and named-release channels
can use a compatible HTTPS mirror on platforms that permit its origin. The
mirror's descriptor paths remain relative to that host, while every release
still pins the official immutable raw commit as an integrity fallback for its
index and workbook bytes. The specific-commit and development-branch channels
use the official raw repository directly; the static-host setting does not
redirect them. The source parser accepts loopback HTTP only for explicit local
testing.

The default route therefore does not spend GitHub API quota. GitHub Pages is a
small release-distribution layer, not a second source of truth: release
descriptors pin an exact Git commit and the raw-byte size and SHA-256 of the
catalogue index. Each workbook entry independently pins its own size and
SHA-256.

## Platform support

| Platform | Official SciREPL Catalog | Arbitrary compatible HTTPS mirror |
| --- | --- | --- |
| PWA | Yes, subject to the host's CORS policy | Yes, subject to CORS |
| Android | Yes, subject to WebView network policy and CORS | Yes, subject to those policies |
| Free Electron v1 | Yes | No, unless its exact origin was reviewed and included in that Electron build |

Free Electron deliberately grants `https://s243a.github.io` a **connect-only**
Content Security Policy capability. It is not a script, stylesheet, image, or
font source, and Electron does not allow arbitrary `https:` connections. A
custom mirror that works in the PWA or Android app therefore fails closed in
Free Electron v1 unless its exact origin is added to
`CONNECT_ONLY_ORIGINS` in `desktop/electron/protocol.js` and shipped in a new
reviewed build. This restriction is a desktop-shell boundary, not a claim that
the mirror's contents have failed catalogue integrity verification.

## Visibility and language selection

Official remote workbooks that match the selected spoken-language preference
chain appear even when the search box is empty. This is deliberate: selecting
Spanish with fallbacks and **Always show built-in items** disabled lists the
Spanish release workbooks without requiring a search term. Future community
sources remain search-only unless they are explicitly given equivalent trusted
status.

Built-in entries remain an offline fallback. They can be shown regardless of
language, or restricted through **Always show built-in items** and the ordered
fallback-language controls.

## Verification, cache, and release movement

Descriptor, index, and workbook bytes are streamed under fixed size caps,
decoded as strict UTF-8 where applicable, and verified before activation.
Remote JSON is transformed through an allowlist; it cannot inject application
fields or executable URLs. Verified snapshots and content-addressed workbook
bytes use a separate IndexedDB database named `scirepl_catalog`. Cached bytes
are re-hashed and re-validated before reuse.

Release tags use trust on first use. The tag pin and snapshot activation happen
in one IndexedDB transaction. If a previously trusted tag maps to a different
commit or index digest, SciREPL keeps the trusted copy and asks before accepting
the change. Failed or concurrent refreshes cannot replace the active pointer
with an older response.

Installed notebooks retain the source id, release or selector, exact commit,
repository-relative path, revision, and artifact digest. This provenance is
used for update matching and survives app restart and canonical `.srwb` save.
Verified remote workbooks use the app's atomic import path and never execute
imported code automatically, even if auto-execute is enabled for ordinary file
imports.

## Privacy

No catalogue request occurs until Browse is opened and the current network
disclosure has been accepted. Requests omit credentials and referrers. The app
does not put notebook content, search text, language choices, or kernel filters
in catalogue URLs. Selecting a development branch additionally contacts
`api.github.com` to resolve it to a full commit.
