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

The header carries three optional buttons in Free — Browse (`📦`), Formula (`∑`)
and Tour (`🧭`) — and two in Pro, which does not yet ship Browse. Each has
**three** states, chosen in **Menu → Appearance → Header shortcuts**:

| state | meaning |
| --- | --- |
| `always` | keep it, even if the header has to wrap to a second row |
| `auto` | keep it only while it fits on one row |
| `never` | hide it |

Defaults: Browse `auto`, Tour `auto`, Formula `never`. Formula stays opt-in
because its inserts are context-specific — SymPy for Python code, LaTeX
templates for Markdown — and it hides entirely for other composer languages.

**`auto` means the button can be absent without anyone having hidden it.** It is
a measurement, not a preference: what constrains the header is the width left
after the title, the notebook selector, the mandatory buttons and the status
badge, and that changes with the viewport, the button scale and the locale. The
same settings therefore give a different header in portrait and in landscape.

Fit also depends on what the rest of the header needs, not only on the viewport.
The notebook selector is a flex sibling: with a second notebook its buttons need
about 120px, and if the shortcuts have taken the width it is squeezed to 30-49px
and its buttons overflow into them — a Delete button whose centre hit-tests to
Search. That counts as "no room", so `auto` candidates stand down — lowest
priority first, and as many as it takes — until the selector has its width back.
At 411-430px with a second notebook that is BOTH of them, not one.

Measured figures below are **with Browse and Tour at `auto`** — which IS the
default: Browse and Tour default to `auto` and Formula to `never`, so a default
install matches this table exactly. Measured at the shipped button scale:

| scenario | result |
| --- | --- |
| 320px, one notebook | no candidate fits |
| ~379px, one notebook | exactly one candidate fits |
| 412px, one notebook | both candidates fit |
| 411-430px, two notebooks | both candidates stand down (`shortcutsDropped="2"`) so the selector fits |

A single-notebook measurement is not a safe guide once the selector is
populated: the same width holds fewer shortcuts.

**Known limitation.** From roughly 320px up to about 400px, a populated
selector still collides with the mandatory controls: both optional shortcuts
are already dropped (`shortcutsDropped="2"`), yet the selector's buttons
overlap Search, Menu and Help — controls the fitter may never hide. Probed at
~10px steps with two notebooks, mis-hits persist through 400px and clear by
405px, so this includes common phone widths, not just 320px. It is
pre-existing baseline behaviour that needs a change to the selector's own
layout — tracked separately; do not expect the fitter to fix it.

### Priority

When the `auto` shortcuts cannot all fit, the one **lowest** in the priority
order stands down first. The default order is Browse, Formula, Tour — Browse is
used on every visit, Tour is mostly a first-run aid. Users reorder it with the
arrow controls beside each row, and each row's arrows name their own shortcut so
the order can be changed without sight.

Hiding Formula closes the formula palette first, since its header button is the
palette's toggle and close control. Standing a shortcut down never removes its
stored setting or feature, and **Reset to defaults** restores Browse `auto`,
Tour `auto`, Formula `never`.

The first tour panel carries the same three-state control for Tour, so the
choice is available before the user has learned the rest of the interface. It is
a select rather than a checkbox deliberately: a checkbox reported the default as
"on" while `auto` had stood the shortcut down for lack of width, and ticking it
back rewrote the choice to `always`, opting the user into a wrapped header they
never asked for.

### Storage and migration

The relevant preferences are:

- `scirepl_appearance_show_browse_shortcut` (Free only)
- `scirepl_appearance_show_formula_shortcut`
- `scirepl_appearance_show_tour_shortcut`
- `scirepl_appearance_shortcut_priority` — a JSON array, highest priority first

Each shortcut key stores `"always"`, `"auto"` or `"never"`. **Legacy Boolean
values keep their original meaning**: `"1"` reads as `always` and `"0"` as
`never`, so anyone who made an explicit choice before the third state existed
keeps exactly that choice, and only installations still on the default move to
`auto`. An absent key means the shortcut's default.

Unknown or missing names in the priority array fall back to the registry order,
so a stored list can never strand a shortcut, and shortcuts whose button this
edition does not ship are filtered out — which is how one implementation serves
both Free and Pro.
