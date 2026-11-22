# Android package installation choices

This companion work is based on Free main
`4e9e947bd3835a265ff212194dd6d78378fd4cd5` and does not port the Pro native
file-boundary or protected-provider branches. It does not change browser or
Electron package-import behavior, release identity, privacy acceptance text,
or the separately prepared Turkish/Italian/Polish Free language branch.

## User choices

Manual package-archive imports and non-bundled catalogue packages on Android
now offer an app-owned choice before installation side effects:

- **Keep installed on this device** is selected by default. The validated
  original archive is committed to a bounded local IndexedDB store before
  importing its contents. A failure to save is an error, not permission to
  silently install for one session.
- **This session only** explicitly skips archive retention.
- **Cancel**, close, Escape and Android Back do not import or save anything.
  A second install cannot leave a queued stale confirmation behind the first.

Imported notebooks are saved in either installation mode. Persistent mode
additionally restores supporting files/search paths from the retained archive
when Prolog first runs after a restart. Restoration does not recreate
notebooks, run their cells, evaluate JavaScript wrappers, instantiate package
WASM modules, consult Prolog source, or download an archive.

The fixed app-bundled package already has local archive bytes and does not
need a duplicate retained copy or an installation-mode prompt. Standalone
`.srwb` workbook imports are not archive installations and retain their
existing flow. Browser/Electron imports are unchanged.

**Browse Packages → Saved packages** lists retained copies and lets the user
remove one. Removing a saved archive does not close or delete existing
notebooks, remove copies in other storage, or tear down files already mounted
in the current kernel. The saved archive will no longer be replayed on a
subsequent restart.

## Limits and trust boundary

The retained-archive store holds at most 32 distinct archives, 32 MiB per
archive and 96 MiB total. These are separate from any Android share-cache
limits. Existing archives are never evicted silently to make space. The store
checks capacity and writes metadata/bytes atomically, verifies SHA-256 and
record shape on reads, and reports unavailable/full/corrupt storage explicitly.
Users can remove a saved copy, retry, or explicitly choose session-only mode.
App-data clearing or uninstalling the app also removes this local store.

ZIP and tar.gz/tgz are supported. Both choices use bounded validation:
32 MiB compressed input, 64 MiB expanded output and 4,096 entries. Validation
checks paths, link/special-entry restrictions, ZIP CRCs, TAR checksums,
manifest references, virtual destinations and search-path syntax before
mounting. Unsupported RAR archives remain unsupported; persistence does not
add a new extractor or native filesystem authority.

Startup treats remembered URLs as metadata, not download authorization.
Android restores only retained validated bytes or a fixed same-origin
app-bundled archive. It does not introduce a startup remote URL fallback,
dev-proxy path, redirect permission or broad native downloader. Free's
pre-existing native bridge itself is outside this companion's scope and is
not newly exposed or removed by it.

Restoration preserves pre-existing user-edited Prolog files and persistent
SharedVFS data. Retained archives are replayed in explicit installation order;
later installed packages win conflicts among archive-restored files. Reusing
an already saved archive records the user's latest explicit installation
order without storing duplicate bytes.

Package-managed Prolog files and exact search-path pairs are not copied into
ordinary workspace snapshots: otherwise session-only files, or support from
a removed archive, could silently survive through that second persistence
mechanism. Persistent SharedVFS files retain normal startup restoration before
Python or another kernel runs. Session-only shared files are excluded from
SharedVFS snapshots. Removing a retained archive does not delete independent
persistent SharedVFS copies.

Edits to managed Prolog files and session-only shared files stay in the current
app session; save a copy under a different path to keep those edits as ordinary
user data. Persistent SharedVFS edits retain their existing storage behavior.
Initial managed imports reject conflicting unowned destinations before any
write, rather than delete or replace an existing user copy. Unknown legacy
snapshot files are not automatically deleted or claimed as package-owned.

## Local and device verification

Use Node 22 and `npm run test:package-persistence`. The suite covers real browser
IndexedDB transactions, corrupted/oversized archives, failed saves and
rollback ownership, installation-mode semantics, Free integration, no-cell-
execution, offline support-only remounts, and actual HTML dialog controls in
all 13 shipped Free locales in portrait/landscape. New translated UI text is
draft translation, not native-speaker approval. Existing catalogue workbook
SHA/size gates, CSV entry, browse shortcut and cached-source clearing remain.

Before release, still verify an exact device candidate:

1. Tap the real persistent/session radio controls and Install/Cancel buttons.
   Confirm the dialog disappears and no queued native JavaScript dialog remains.
2. Import a populated fixture with a Prolog support file and notebook. Restart
   with network unavailable; persistent support returns without duplicate
   notebooks or cell execution. Session-only support is not archive-restored.
3. Remove only that fixture's retained copy and restart. Check that notebooks
   survive and no archive replay occurs.
4. Exercise capacity/storage errors without losing an existing retained package
   or silently falling back to a session install.
5. Repeat relevant picker and Back behavior on both navigation modes. Local
   browser verification is not signed-device or Play release clearance.
