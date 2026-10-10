# Pro AI tutorial screenshots

The three original settings pictures are direct screenshots of the actual
SciREPL Pro **browser** UI. The separate `phone-*.png` pictures below are actual
Android screenshots, including a real low-cost online completion.

## Browser settings captures

### Provenance

- Source: `SciREPL-Pro` commit `38316dbb3d12cc628b57af392c9ede49f36d71d0`.
- Source identity: version `1.4.0`, **development** channel, Android version code
  `25`. This is the pinned repository UI at capture time, not independent evidence of Play rollout.
- These captures predate Pro #136's execution-consent update. In particular,
  `assistant-open.png` shows the older Open label; the upcoming approval,
  code-preview and execution-override dialogs are not pictured. The tutorial
  marks their availability as proposed Pro 1.5.0 (unreleased, provisional).
  This note does not change any recorded source SHA, screenshot or receipt.
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

### Images

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

### Network policy and limits

The temporary server listened only on `127.0.0.1:8108` and served unchanged
static files from Pro's `www/`. It rejected proxy routes and non-GET requests.
Browser routing allowed same-origin GETs only, aborted every external request
and every non-GET, and blocked service workers. The final successful capture
recorded **zero external requests attempted, zero external responses and zero
page errors**. The source SHA was asserted before capture; the clean tracked
worktree was checked before and after. The server and browser were closed afterward.

No provider request, API key, model download, native installation, generated
completion, inference, phone performance, or Android rendering was exercised.
The browser's unavailable native-only local-model state was not fabricated or
pictured. These three browser images demonstrate UI navigation and configuration only.

### Additional key-setup capture

`assistant-key-setup.png` is a separate fresh, keyless browser capture from the
same clean, pinned Pro source, taken on 2026-10-08 at 22:11 UTC. Its own script
(`capture-pro-key-setup.mjs`) and receipt (`capture-pro-key-setup.json`) record
the source guards, empty provider store and API-key input, and zero external
requests, responses or page errors. The actual dialog controls select
AI Assistant → OpenRouter → GLM 5.3 Flash; Save was below the cropped upper
region and was not pressed. The 390 × 538 PNG is unmodified. Its matching,
editable `assistant-key-setup-overlay.svg` contains four yellow borders using
measured control bounds. The faint `sk-…` is the empty input's placeholder.

The yellow borders over `completion-general.png` are a separate, editable
SVG (`completion-general-overlay.svg`, 414 × 820, matching the screenshot).
They locate section titles and the Suggestions / Suggestion chips controls.
The original PNG and its capture-receipt hash are unchanged; the full-image
link opens it without annotations.

`assistant-open-overlay.svg` adds five yellow outlines to the existing
390 × 1100 `assistant-open.png`: Auto-run, Allow source browsing, Agent writes,
Max steps and Security Level. Each outline reaches the GUI's left and right
margins, with a 3-pixel inset so its stroke remains inside the screenshot.
The positions were checked against the original image; no screenshot pixels,
controls or values were changed. The tutorial uses
a CSS crop through pixel 713 to focus on these settings rather than Remote/MCP,
and links the unmodified full PNG. Max steps is already visible in this capture,
so the Continue explanation uses the same figure, not a new capture. This remains
the older browser UI, not a new phone test or execution-permission verification.

### Custom-model capture

`assistant-custom-model.png` is a separate real browser capture from clean Pro
head `6dbc4d0793e04f0ea051d2e464032bf8fcab09d5` (the approved #136 head), not
from the older source used for the pictures above. The custom-ID field already
exists in released Pro 1.4.0. This newer capture does not show execution-consent
dialogs or change the provenance of any previous picture.

`capture-pro-custom-model.mjs` selects AI Assistant → OpenRouter using the actual
controls, then fills the custom-model input with `anthropic/claude-haiku-5.5`.
That ID is genuinely absent from this source's dropdown and was verified against
the provider's model page and ID-format documentation on 8 October 2026. It is
not an invented option, injected label or provider-availability test. The listed
GLM model remains visible; the tutorial explains that the custom field takes
precedence on Save. No Save was pressed and no key was entered.

The unmodified PNG is 390 × 456, cropped through the custom field, before API
Key and Save. The editable `assistant-custom-model-overlay.svg` contains yellow
borders drawn from measured Backend/custom-field bounds. Its own receipt,
`capture-pro-custom-model.json`, records the exact source, browser, capture time,
hashes, empty provider store, and zero external requests/responses or page errors.
The temporary same-origin GET-only server on 127.0.0.1:8187 and the fresh browser
are closed after capture. No phone, model inference, billing or API compatibility
test was performed. The script uses the same source/dependency/output environment
variables as the earlier capture scripts and refuses to overwrite existing files.

## Android completion captures

- Actual Galaxy S24+ (`SM-S926W`), `com.unifyweaver.scirepl.pro.debug`, version
  `1.4.0-debug`, version code `25`, development UI, active app cache `v461`.
  The installed app's Git commit was not independently identified; do not
  treat the browser source SHA above as the phone's build SHA.
- Original pictures captured 2026-10-08 UTC (2026-10-07–08 local); the agent
  result was refreshed on 2026-10-10 UTC (2026-10-09 local). English/dark theme, portrait,
  1080 × 2340, using Android's `screencap`. These are unmodified full-screen
  PNGs. The four composer pictures use a CSS detail view of their lower
  700 pixels; the expanded Suggestions menu shows original pixels 775–1415;
  the agent result uses the full-height picture. Each links to
  its full screenshot. No code, labels or results were painted into them.
- A separate practice workbook contained only toy code. No existing workbook
  source or provider credential is included in the published screenshots or
  receipt. The software keyboard was dismissed for the published pictures.
- `phone-completion-position.png`: captured at 2026-10-08 22:09 UTC. The real
  Android Suggestions menu is open with At cursor selected and End of cell
  only beneath it. It overlays the adjacent indentation settings; the tutorial
  says so rather than presenting those controls as visible. No API request
  was made and the three temporary Completion settings were restored. The
  screenshot contains only General settings, not a key or workbook source.
- `phone-table-javascript.png`: checked on the phone at 2026-10-08 21:59 UTC
  (8 October local). JavaScript `cons` offers the faint suffix `t`, with
  Suggestion chips On and extra keys Off. Pressing the real Accept button
  inserted exactly `const`; the incomplete declaration was not run. Online
  suggestions and the local model were Off, with zero provider requests.
  The previous workbook, draft, language and snapshotted settings, including
  the extra-key setting, were restored. The screenshot precedes acceptance.
- `phone-table-ghost.png`: re-checked on the phone at 2026-10-08 04:30 UTC
  (7 October local). Python `pri` offers the faint suffix `nt` with the actual
  Suggestion chips control set to On. No provider request was sent; the
  previous workbook, draft, language and snapshotted settings were restored.
  `phone-table-chips.png`: earlier source declares
  `sample_mean` and `sample_median`, then `sample_m` offers both names. Online
  suggestions and the local model were off; neither Python example was run.
- `phone-online-chips.png`: a real, independently selected
  `google/gemini-3.5-flash-lite` completion through OpenRouter, while the
  Assistant's model stayed `z-ai/glm-5.3-flash`. The exact toy payload was
  reviewed and sent once. The first returned option used `reduce`; the second
  used unnecessary `eval`, explicitly rejected in the tutorial.
- The completion response was HTTP 200, with 172 input and 125 output tokens,
  provider-reported cost $0.0003641, and app-ledger settlement $0.0007282.
  Those are distinct figures, not a promise about the final provider bill.
  The single request took about 2.6 s in this session, not a latency benchmark.
- `phone-agent-result.png`: refreshed at 2026-10-10 02:08 UTC using the tutorial's
  exact seeded-vector prompt. GLM 5.3 Flash created a Markdown explanation and
  the JavaScript `summary_demo` cell. The first bounded run reached the four-step
  limit; one Continue press made one further provider request, then showed Done. Open was
  selected, auto-run and source browsing were off, JavaScript execution was
  Ask, writes were limited to the practice workbook, and Remote/Terminal were
  off. The source was inspected before manually pressing the saved cell's Run.
  It generated `1, 11, 15, 6, 8, 4, 20, 11, 11, 6`, with count 10, mean 9.3,
  min 1 and max 20; a second manual Run reproduced the entire output without
  changing the source. The picture shows all output and part of the source,
  with the seed and first lines above the scrolled position. Neither code nor
  screenshot pixels were rewritten to obtain this result.
  Five HTTP 200 provider responses reported a combined $0.0023609; this is
  reported usage, not an independently audited bill. Each request was limited
  to 2,048 output tokens, with the app's per-run USD guard set to $0.03.
  The installed cache was still v461; its build commit remains unidentified,
  so this is not evidence of the newer execution-consent implementation.
  The online completion alternatives were not run.
- After the check, the original workbook, draft and language were restored,
  along with only the snapshotted temporary completion/agent settings. The
  practice workbook and its checked output remain available. The newly saved
  provider key and actual spending tallies were retained. The provider-policy consent accepted
  for these authorized requests was not rolled back.
- `capture-pro-phone.json` records the screenshot hashes and narrowly scoped
  observations. No key, hint, authorization header, account id, phone network
  address, or private workbook transcript is retained there.

No expensive model, local-model inference/download, Play installation or
S10+ performance test was used to obtain these phone pictures.
