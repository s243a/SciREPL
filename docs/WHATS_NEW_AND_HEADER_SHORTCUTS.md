# What's New and header shortcuts

## User behavior

`What's New` opens in two situations:

- after a new user reaches **Done** on the first-run tour; and
- once when an existing installation loads a different app version.

Skipping or dismissing the first-run tour suppresses the page for that app
version. Privacy and runtime-download dialogs always take priority: an open
What's New page yields to them and resumes after they close. The page remains
available from **Help → What's new in this version** after the one-time prompt.

The marker is `scirepl_whats_new_seen_version`. It stores the exact app version,
not a boolean, so an upgrade is a simple version comparison.

## Release maintenance

`package.json` is the canonical app version and declares an explicit
`releaseChannel` of `development` or `release`. `npm run configure` copies both
values into `KERNEL_CONFIG.app`; browser UI must read that generated metadata
rather than infer release state from whether a frozen history entry happens to
share the base version. The same metadata provides the stable GitHub
releases-index link.

While developing a release, edit the localized key list under `unreleased` in
`www/js/release_highlights.js`. The page labels that list **Unreleased changes ·
base version …**, so post-release work is never attributed to an already
published version. During release preparation:

1. bump `package.json` and the platform build/release numbers;
2. move the `unreleased` list under the new version key and clear
   `unreleased`;
3. set `package.json` `releaseChannel` to `release`;
4. run `npm run configure` and commit the generated config;
5. translate every new key in all shipped catalogues and run
   `npm run i18n:check`; and
6. add any new browser assets to the service-worker shell, bump its cache
   version, and run `npm run sw:lock`.

`npm run release:check` evaluates the real `release_highlights.js` table. A
development build must have unreleased notes. A release build must have frozen
notes for its exact version and an empty `unreleased` list; tagged builds must
use the `release` channel. After tagging, the next development commit switches
the channel back to `development` before accumulating new highlights.

## Header shortcuts

Tour (`🧭`) is visible by default; Formula (`∑`) is off by default (its inserts
are context-specific — SymPy for Python code, LaTeX templates for Markdown —
and it hides entirely for other composer languages). Users can toggle either in
**Menu → Appearance → Header shortcuts**. The first tour panel also carries a
checked Tour-shortcut option, making that choice available before the user has
learned the rest of the interface.

Hiding Formula closes the formula palette first, since its header button is the
palette's toggle and close control. Hiding a shortcut never removes its stored
setting or feature; both choices can be restored from Appearance, and **Reset
to defaults** restores the defaults: Tour visible, Formula hidden.

The relevant preferences are:

- `scirepl_appearance_show_tour_shortcut`
- `scirepl_appearance_show_formula_shortcut`

Because Formula reads its own key, upgrading applies the new opt-in default
to existing installations as well; an explicit earlier choice, stored under
its own key, is preserved.

Preference storage semantics: Tour is opt-out (`showTourShortcut` absent or
any value other than `"0"` means visible); Formula is opt-in (`showFormulaShortcut`
must be exactly `"1"` to be visible — absence means hidden).
