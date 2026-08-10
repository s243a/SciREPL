# Recovering from broken custom appearance

Appearance → Advanced lets you paste raw CSS. It is genuinely unrestricted, so
it can make the app hard or impossible to use. There are three layers of
recovery, in the order they take effect.

## 1. Automatic rollback (no action needed)

Whenever custom CSS is applied — including on every launch, as the stored CSS is
re-applied — the app checks that the way back to Appearance still works: the menu
button must be visible and not covered, and the menu must still show the
Appearance entry. If the CSS breaks that path, it is **rolled back in the same
frame**, before it can lock you out.

The CSS is not discarded. It is kept aside ("quarantined"), a notice explains
what happened, and the next time you open Appearance → Advanced the editor is
pre-filled with it so you can fix the offending line and apply again. A clean
edit clears the quarantine.

This is the normal path, and it works on every platform including Android — the
bad CSS never sticks, so the menu is always reachable.

## 2. Reset to defaults

Appearance → **Reset to defaults** clears the top margin, button scale, theme,
custom theme and custom CSS in one step. Use it if appearance is wrong but the
menu is still reachable.

## 3. Safe mode (last resort)

If custom CSS somehow makes the app unusable in a way the automatic check did not
catch, load the app with `?safe` in the address:

```
https://<your-scirepl-url>/?safe
```

Safe mode ignores the custom theme and custom CSS for that session without
deleting them, so you can then open Appearance and Reset to defaults.

On desktop and web this is a URL edit. In an installed Android/PWA build the
address bar may not be available.

## What the guard does and does not guarantee

The automatic check (layer 1) catches the hiding techniques it knows about:
setting the recovery path to `display:none`, `visibility:hidden`, near-zero
opacity, `pointer-events:none`, zero/off-screen geometry, a covering overlay
(including an ancestor pseudo-element), and — by inspecting keyframes at apply
time — animations and transitions that would hide the path after a delay. It
re-runs on every launch, so a lockout built from those techniques does not
survive a restart, and it re-checks a short time after applying to catch
transitions a static scan cannot predict.

It is **not** a proof that arbitrary CSS is recoverable. Raw CSS is
Turing-adjacent in its ability to reposition and obscure, and a sufficiently
novel rule could evade the heuristics. This is why custom CSS carries a warning,
is collapsed behind "Advanced", and is not a supported way to restyle the app so
much as an escape hatch for people who accept the risk. If you rely on custom
CSS, keep layer 2 (Reset to defaults) and layer 3 (`?safe`) in mind; on an
installed Android build where neither the URL nor a broken menu is reachable,
uninstalling and reinstalling the PWA clears stored preferences as the last
resort.
