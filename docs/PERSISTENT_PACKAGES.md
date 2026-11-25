# Android package installation choices

This companion work is based on Free main
`4e9e947bd3835a265ff212194dd6d78378fd4cd5` and does not port the Pro native
file-boundary or protected-provider branches. It does not change browser or
Electron package-import behavior, release identity, privacy acceptance text,
or the separately prepared Turkish/Italian/Polish Free language branch.

### Integration with current main

The forward merge integrates canonical main
`fc74cd224df5e99c8ec0cb254e7700404e95dc4e` with the reviewed persistence tip
`5834f717c34df50f1ed42c9dc56a7c559090a6b5`. Both parents had independently
recorded different shell hashes for `v246` and `v247`. Neither historical
variant may be represented as the only variant that ever existed.

The generated lock keeps main's canonical history and nonconflicting feature
pins, and preserves the **complete original feature lock** under
`archivedForks["5834f717c34df50f1ed42c9dc56a7c559090a6b5"]`. Its source-lock
SHA-256 is
`cdf13ace71f3910220c7773b5a2dbb3ed4fdc5037ffc29ab5d6c3217892bfaab`.
The archive is integrity/provenance evidence, not cryptographic authentication
against an editor who changes both the captured lock and its digest. Archived
IDs also contribute to the monotonic version floor. Integrated shell bytes
start at a fresh `v254`; future shell edits must append another fresh ID.

`scripts/reconcile-sw-shell-history.mjs --canonical FULL_MAIN_SHA --feature
FULL_FEATURE_SHA` previews reconciliation from exact Git objects. `--write`
requires that exact two-parent merge in progress and refuses to overwrite
additional working-lock data, including an appended integration pin. It can
replace only a parent lock, its own exact generated result, or the pristine
pinned Git conflict. Never hand-edit the lock or rerun reconciliation to erase
a subsequently appended pin. `npm run sw:lock` handles ordinary future appends
while preserving and validating the archive. `npm run test:sw-history` and the
original guard tests cover these constraints in disposable repositories.

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

Ownership is scoped to a filesystem (`shared` or `prolog`) and normalized path:
an independent same-path file in one cannot change the other's bytes, snapshot
policy or overwrite authority. Prolog intentionally mirrors `/shared`, `/tmp`,
`/education` and `/user/education`. Managed manifest and raw installs apply the
Shared collision and persistence policy to every mirrored destination before
native mounting; a later cell must not introduce an untracked durable copy.
Persistent SharedVFS entries retain an inert archive identity through IndexedDB
and fallback snapshots. Only the matching validated archive and unchanged bytes
can restore ownership after restart, so an untouched copy can be reinstalled.
Edits clear provenance and overwrite authority without promoting session-only
data into persistence. Untagged copies (even identical ones), malformed tags and
older snapshots without provenance remain protected rather than being claimed.
Unchanged native mirror writes are skipped, preserving provenance and ownership;
actual edits still release overwrite authority while keeping session exclusion.
On cold restart a missing native mirror is seeded only from matching validated
archive/provenance/Shared bytes, never over an existing native user file.

For overlapping archives, prior native replay ownership cannot bypass matching
Shared bytes/provenance. Saved or edited Shared copies remain authoritative;
only untouched copies created during this restore pass may advance through
retained archive order. A later Shared-only winner updates a native mirror
created by the same pass, without text-decoding binary bytes. Private paths keep
their prior replay policy. If Shared data is lost AND a failed deduplicated
attempt advanced archive metadata, that metadata alone cannot reconstruct the
last successful install; no new success ledger is added by this correction.

## Local and device verification

Use Node 22 and `npm run test:package-persistence`. The suite covers real browser
IndexedDB transactions, corrupted/oversized archives, failed saves and
rollback ownership, installation-mode semantics, Free integration, no-cell-
execution, offline support-only remounts, and actual HTML dialog controls in
all 13 shipped Free locales in portrait/landscape. New translated UI text is
draft translation, not native-speaker approval. Existing catalogue workbook
SHA/size gates, CSV entry, browse shortcut and cached-source clearing remain.

`npm run test:package-shared-roots` uses actual bundled SWI-Prolog execution and
native sync, real IndexedDB and cold page/runtime reloads. It covers all four
roots, raw education archives, existing Shared user files, native session-file
edits, snapshot exclusion, and persistent cold-restart queries. Runtime assets
load from loopback before offline archive replay; this is not offline PWA boot
or a device result. The surrounding notebook/manager UI is a local fixture.

`npm run test:package-overlap` adds real-kernel overlap checks across two cold
restarts: normal and deduplicated installation order, failed reinstall with a
saved Shared copy, missing Shared snapshots, edited user copies, and mixed
Shared-only/text/binary winners. Provider and phone access are not used.

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
6. Reinstall the same persistent archive after a cold restart with SharedVFS
   support restored. Then edit its support file and verify reinstall refuses to
   replace the edit. The local ownership suite covers both filesystem directions,
   binary and fallback snapshots, and unprovenanced/edited-copy controls.
