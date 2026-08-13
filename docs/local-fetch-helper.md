# Local fetch helper: installing from hosts the browser can't read

Some catalog items — and some catalog sources — live on hosts that don't send
CORS headers. When you tap **Install** on one of those in the PWA (or in the
Electron app), the browser refuses the download and SciREPL shows a
cross-origin error. This page explains your options, from least to most
friction.

## Option 1: Use the Android app (least friction)

The Android build downloads through Capacitor's native HTTP layer, which is
not bound by browser CORS rules at all. The same install that failed in the
PWA just works there. If you have an Android device and expect to install
from GitHub Releases or other non-CORS hosts regularly, this is the
lowest-friction path.

> **What about Electron?** The plan is to give the desktop shell a
> narrow, allowlist-scoped fetch channel in the main process: the
> renderer asks for a URL, the main process fetches it (no CORS outside a
> renderer), and only destinations on a fixed allowlist are permitted —
> with the GitHub family (`github.com`, `raw.githubusercontent.com`,
> `objects.githubusercontent.com`, `cdn.jsdelivr.net`) on that list by
> default. This is safe to expose even though notebook code shares
> `window` with the UI, because the filter constrains the *destination*,
> not the *caller* — the worst a hostile notebook can do is download
> content from an allowlisted host.
>
> Until that channel ships, Electron enforces the same CORS rules as the
> PWA (`webSecurity` is on, and today there is no privileged download
> IPC), so treat it as "PWA rules" and use this helper or Android. Once
> it ships, Electron joins Android as a low-friction path for
> GitHub-hosted content.

## Option 2: Run the local fetch helper

The helper is a tiny Node server you run on your own machine. It fetches the
URL for you — no CORS in a plain server-to-server fetch — and hands the bytes
back to the app with the headers the browser requires. This is the same
pattern as SciREPL's dev-server `/proxy`, generalized beyond GitHub
Releases, and the same sidecar pattern UnifyWeaver uses for browser agents.

### Requirements

- Node.js 18 or newer (`node --version` to check). No npm install, no
  dependencies — it uses only the standard library.

### Start it

```bash
node local-fetch-helper.mjs
# SciREPL local fetch helper: http://127.0.0.1:8787/
```

Then retry the install in SciREPL. Leave the helper running while you
install; stop it with Ctrl+C when you're done.

To use a different port: `PORT=9000 node local-fetch-helper.mjs`.

### What it does and doesn't allow

- Listens on `127.0.0.1` **only** — nothing else on your network can reach it.
- Fetches `https://` URLs only. No embedded credentials, no `http:`, at most
  5 redirects, and a redirect that downgrades to `http:` is refused.
- Caps responses at 64 MB (`MAX_BYTES` to change), so a broken or hostile
  upstream can't eat your disk.
- Sends `Access-Control-Allow-Origin: *` and answers Private Network Access
  preflights — that's the point of the helper, and also its trade-off:
  **while it runs, any web page open in your browser can ask it to fetch
  anything your machine can reach over HTTPS.** The URLs it fetches are
  whatever a page asks for. If that makes you uncomfortable, run it only
  during installs (as suggested above) rather than leaving it up.

### If the app is a hosted PWA (https://…github.io)

A secure public page calling `http://127.0.0.1` is a *private network
request*. Chrome sends a CORS preflight with
`Access-Control-Request-Private-Network: true`, and the helper answers with
`Access-Control-Allow-Private-Network: true`, which is what current Chrome
requires. If a future browser version blocks this flow anyway, the fallback
is to serve SciREPL itself locally (`npm run serve`) so page and helper are
both on localhost.

### Verifying it's running

```bash
curl http://127.0.0.1:8787/health
# {"ok":true}
```

## Option 3: Serve SciREPL locally

`npm run serve` starts the dev server, which includes its own `/proxy` for
GitHub release downloads, and puts the app and the proxy on the same
localhost origin — sidestepping both CORS and Private Network Access rules.
This is the power-user configuration and works today; the helper above is
the lighter-weight version of the same idea.

The deeper advantage of running your own server is that it can serve
**custom content**, not just relay GitHub. A server you control can:

- **Front a special API.** Add an endpoint that calls a private or
  rate-limited API and re-shapes the response for the app. Because the
  request originates server-side, CORS never applies — and API keys can
  live in the server's environment instead of in renderer code or a
  notebook. (Notebooks can still *call* your local endpoint, so treat the
  endpoint itself as public-within-your-machine, but the key never has to
  leave the server.)
- **Publish a local catalog source.** Put a `scirepl-catalog.json` and its
  artifacts behind your server and add `http://127.0.0.1:PORT/…` — or a LAN
  address, for a household/lab server — as a source. Content that never
  touches GitHub at all: private datasets, generated workbooks,
  institution-internal packages.
- **Extend rather than replace.** `server.js` is ~100 lines of plain Node;
  adding a route is a few lines. The same file serves the app, the proxy,
  and whatever you add, all on one origin.

If you go this route, the helper's security rules still apply: bind to
`127.0.0.1` unless you genuinely mean to serve your LAN, validate upstream
URLs, and cap response sizes.

## Option 4: Manual import

Every install card is ultimately just a file. Download it yourself in the
browser (no CORS applies to a plain navigation/download), then use
**Menu → Import Package** in SciREPL. No helper, no server, works on every
platform.

## For catalog source authors

If you publish a catalog (`scirepl-catalog.json`) or workbooks meant for
PWA and Electron users, host both the index and the artifacts on a
CORS-open host so none of the above is needed:

- `raw.githubusercontent.com/<owner>/<repo>/…`
- `cdn.jsdelivr.net/gh/<owner>/<repo>@<ref>/…`

GitHub Releases (`github.com/…/releases/download/…`) are convenient for
large files but install only on Android, via a local helper/proxy, or by
manual import — they send no CORS headers.
