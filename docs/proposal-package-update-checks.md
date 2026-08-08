# Proposal: package update checks

**Status:** design note for a follow-up PR. Nothing here is implemented.

Recorded while adding the desktop runtime cache (PR #57), because that cache and
this feature share one constraint: an update checker is only as good as the
freshness of the data it reads.

## Why this is a separate change

PR #57 added a persistent runtime cache so language runtimes keep working
offline. That is a *runtime asset* concern. Deciding whether an installed
**package** is out of date is a *user-facing product* concern with its own UI,
settings and consent rules. Bundling them would have made a cache fix into a
feature release.

The one piece that could not wait is the cache policy itself — see
[Cache constraints](#cache-constraints).

## Scope

A "Check for package updates" command under the **Packages** menu, plus the
surrounding behaviour:

| Behaviour | Default |
| --- | --- |
| Manual **Check for package updates** command | always available |
| Automatic background checks | **off** initially |
| Outdated-package notification | non-blocking; never a modal that interrupts work |
| **Update** action | always requires explicit confirmation |
| **Ignore this version** | per package, per version |
| **Don't notify for this package** | per package, permanent until reset |
| Global "disable update warnings" | in Settings, alongside the existing runtime-download toggle |
| Offline | keep using installed versions; never block, never nag |

Two rules that should not be negotiable:

1. **Never update automatically without confirmation.** Packages can change
   notebook behaviour. A silent update that alters a result is worse than an
   outdated package.
2. **Never block work on a check.** A failed or slow update check is a
   background condition, not an error state.

## Cache constraints

This is the part that constrains implementation, and it is already handled in
PR #57 so a future checker starts from correct data.

`repo.r-wasm.org` is a **mutable** package repository: its `PACKAGES` indexes
describe what exists *right now*. The desktop runtime cache keeps responses
indefinitely, which is right for version-pinned runtime assets and wrong for
repository metadata — an update checker reading a permanently cached index would
report "up to date" forever.

PR #57 therefore splits the policy:

| Request | Cached? |
| --- | --- |
| `…/v0.5.4/R.wasm`, `scittle@0.6.22/…`, `ggplot2_3.5.1.tgz` | yes, indefinitely — version-pinned and immutable |
| `…/PACKAGES`, `PACKAGES.gz`, `PACKAGES.rds`, `PACKAGES.json` | **never** — mutable repository index |
| any URL with a query string | **never** — assumed parameterised |
| `404` on a version-pinned path | yes — permanently true, and webR's `HEAD` probes need it offline |
| `404` on a mutable path | **never** — a package absent today may exist tomorrow |

Consequence to keep in mind when building this feature: **checking for updates
requires a network connection**, by design. Offline, the honest answer is "not
checked recently", not a stale "up to date".

The same reasoning applies to the GitHub release metadata behind
`package_catalog.js` (`api.github.com`), which is deliberately not on the
cacheable-host list at all.

## Suggested shape

1. **A pure comparison layer first** — given installed versions and available
   versions, produce a list of outdated packages. Testable with no network and
   no UI, and shareable across the PWA, Android and desktop.
2. **A fetch layer** that reads the catalogue/index, with explicit
   `checkedAt` timestamps so the UI can say *when* it last knew.
3. **UI last**, once the first two are covered by tests.

State worth persisting per package: `ignoredVersion`, `notifyDisabled`,
`lastCheckedAt`, `lastKnownAvailable`. This belongs in the same
`localStorage`-backed settings the rest of the app uses, so it survives restarts
and stays consistent across platforms.

## Cross-platform

The comparison and fetch layers belong in shared `www/` code so the PWA,
Android and the desktop shell behave identically — the same rule that made the
runtime-download consent setting work everywhere. Only the *presentation* should
differ, and ideally not even that.

## Open questions

1. Which sources are in scope — SciREPL workbook/package catalogue only, or also
   R (`repo.r-wasm.org`) and Python (`micropip`/PyPI)? Each has different
   version semantics.
2. What does "outdated" mean for a workbook whose content changed but whose
   version did not?
3. Should an automatic check ever run on a metered connection?
4. How is a check surfaced when it fails repeatedly — silently, or once?
