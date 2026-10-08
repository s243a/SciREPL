# Pro AI tutorial screenshots

These are direct screenshots of the actual SciREPL Pro browser UI, not mockups,
Android-device screenshots, or native-model tests.

## Provenance

- Source: `SciREPL-Pro` commit `38316dbb3d12cc628b57af392c9ede49f36d71d0`.
- Source identity: version `1.4.0`, **development** channel, Android version code
  `25`. This is current repository UI, not independent evidence of Play rollout.
- Capture: 2026-10-08 UTC (2026-10-07 local), headless Chromium, fresh non-persistent browser
  context, English, dark app theme, viewport `430 × 1100`, device scale factor 1.
- The screenshot target was each real modal's `.modal-content`. Its normal
  scrolling/height limits remain intact; a picture does not show every setting.
- Exact browser version, capture timestamp, screenshot SHA-256 hashes and
  network assertions are retained in `capture-pro-ui.json`.
- Reproducible script: [capture-pro-ui.mjs](capture-pro-ui.mjs), run with the
  existing Node 22 and Playwright installation. No packages were installed.
  Set `SCIREPL_PRO_SOURCE` to the clean source checkout and, if needed,
  `SCIREPL_PLAYWRIGHT_ROOT` to a project with Playwright installed. Set
  `SCIREPL_CAPTURE_OUTPUT` to a new output directory; an existing receipt is
  deliberately not overwritten.

## Images

| File | Actual state shown |
| --- | --- |
| `completion-general.png` | Menu → Completion → General; Local code completion set to **On** through its real dropdown. |
| `completion-online.png` | AI suggestions (online), On tap; **Choose provider and model** selected. No provider keys are saved, so the actual UI displays its keyless/invalid-profile explanation. No usable provider/model was fabricated. Lower settings require scrolling. |
| `assistant-open.png` | AI Assistant → Settings; **Auto-run cells created by AI off**, source browsing off, **Active worksheet** scope and **Open** selected through the real controls. The dialog is scrolled to Security Level; backend/model/key fields and its heading are above the captured position. The selected option's long label is naturally truncated by the narrow dropdown. |

No visible labels, controls, provider identities, native capability state or
rendered content were inserted or altered for the pictures. The only initial
storage entries suppressed onboarding/What's New and disabled automatic
downloads. Subsequent setting changes used actual UI controls. The provider
store remained empty and the API-key input remained empty.

## Network policy and limits

The temporary server listened only on `127.0.0.1:8108` and served unchanged
static files from Pro's `www/`. It rejected proxy routes and non-GET requests.
Browser routing allowed same-origin GETs only, aborted every external request
and every non-GET, and blocked service workers. The final successful capture
recorded **zero external requests attempted, zero external responses and zero
page errors**. The source SHA and clean tracked worktree were asserted before
and after capture. The server and browser were closed after capture.

No provider request, API key, model download, native installation, generated
completion, inference, phone performance, or Android rendering was exercised.
The browser's unavailable native-only local-model state was not fabricated or
pictured. The images demonstrate UI navigation and configuration only.
