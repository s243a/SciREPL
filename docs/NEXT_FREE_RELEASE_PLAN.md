# Next SciREPL Free release

Planning snapshot: November 13, 2026 (America/Edmonton). The release number
and Android versionCode are not reserved. The audited Free main was
`902190960e53`, also the `v1.5.0` tag; GitHub lists it as a prerelease.
That is not evidence of the current Play track. This plan does not reopen
the 1.5.0 bundle or authorize publication.

## Proposed scope

- **Make this a localization and maintenance release.** The standalone
  `feat/free-italian-polish-ui` branch at `c97fd06` adds draft Turkish,
  Italian and Polish app UI, including Windows menus, and localized Getting
  Started guides. Total: 16 UI languages. Test the three languages on fresh
  launch, when switched in place, and offline. The longer tutorials and
  historical release notes remain explicitly labeled English where needed;
  official privacy text stays English for the new locales. No native-speaker
  approval is implied.
- **Keep the guides and their links together.** These three small public Help
  pages explain the same Free workflow: run and edit Python, then export a
  workbook. Keep `?edition=free` through the language picker and tutorial
  index. Do not add these languages to the frozen full-tutorial or 1.5.0
  release-note inventories.
- **Fix two independently reproduced Free bugs in separate PRs.**
  - **Files: protect byte-backed text from corruption.** With a synthetic
    UTF-8 JSON file, opening the Files editor and saving without edits wrote
    comma-separated byte numbers into the file. Preserve bytes on no-op save,
    decode valid UTF-8 for recognized text formats, and keep binary/invalid
    data out of the text editor. Verify edited non-ASCII text, binary handling,
    and byte-identical export after a no-op.
  - **Prolog: preserve radix literals when splitting statements.** Bundled
    SWI in Chromium correctly read a standalone radix value but silently
    skipped the query after a combined assertion containing `16'ff`. Add the
    failing test first; port only the needed statement-split logic, not Pro's
    different arity scanner. Test character codes, quoted atoms and bad input
    as well as hex/binary cases.
  - Do not port Pro's AI ownership or credential changes into Free. Existing
    1.5.0 fixes are a regression baseline, not new features to reannounce.
- **Prepare version-specific release materials after scope freeze.** Draft
  GitHub notes, tagged Play notes for the supported Play listings, the
  localized What's New text, and versioned Pages highlights. Verify Play
  locale selections in the owner's account; app locale identifiers are not
  necessarily Play listing tags. Preserve the old note routes and do not
  point a distributed app at unpublished new routes.

### Open Free PRs at the snapshot

| PR | Handling |
| --- | --- |
| [#132](https://github.com/s243a/SciREPL/pull/132) — Pro 1.5.0 public highlights and Help | Separate Free-hosted content for Pro. Review and deploy independently if Pro needs those routes; it is not a change to the Free Android binary. |
| [#103](https://github.com/s243a/SciREPL/pull/103) — illustrated landscape tutorial | Optional Help follow-up. Update the captures and review privacy before adopting; do not make it a release gate. |
| [#76](https://github.com/s243a/SciREPL/pull/76) — Formula/navigation ideas | Planning notes, not shipped behavior. Reconcile separately with current UI. |

Do not put Store packaging, F-Droid, a full Help reorganization, or another
language wave on this release's critical path. The Microsoft Store work has
[its own pilot plan](WINDOWS_STORE_PILOT.md).

## Release gates in order

1. Review the exact localization PR and any separately approved Free fix.
   Verify locale key sets, static checks, public Help, app-shell hashes,
   browser regressions, and offline PWA. On the localization checkpoint,
   the offline PWA, public Help, 1,228 tutorial-link checks, six new
   locale-launch profiles, and What's New all passed locally. That is not
   remote CI or device clearance.
2. Freeze the source and notes. Verify the highest Free build code actually
   uploaded to Google Play before picking a strictly higher one. Preserve
   Android target API 36 and existing minSdk 23 unless the owner chooses a
   compatibility change. Check the intended Play protection setting against
   this actual bundle; do not change it or raise minSdk as part of a locale PR.
3. Test on both phone layouts: a retained-data upgrade on the S10+ with
   three-button navigation and an S24+ gesture-navigation check. Cover the
   three new language pickers, Help and What's New, official-English
   disclosure, rotation, workbook open/save/export, and targeted notebook
   regressions on the exact candidate. Debug/device and signed Closed
   testing are distinct evidence.
4. On separate release authorization, build the exact tag through release
   CI and verify artifacts, provenance and actual Pages deployment. Check
   all three starter routes, the Free filter, and the versioned release
   notes before distributing a build with those links. Signing, uploading
   and Play Closed testing remain separate from tag CI and Pages.
