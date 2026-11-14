# Running the SciREPL PWA from the release zip

Each GitHub release includes `SciREPL-v<version>-pwa.zip`, the complete web
app for that version. Unzip it and serve the folder with any static web
server. The app then runs in your browser, can be installed from the
address bar, and works offline after the first load.

You don't need the zip just to use SciREPL in a browser: the
[live PWA](https://s243a.github.io/SciREPL/) is the same app, already hosted.
It runs the newest tagged version, which can be a pre-release newer than the
latest release. Use the zip to run a specific version, to run without that
site, or to test a release before it's tagged.

## Before you start

- **Serve it; don't open the file.** Opening `index.html` straight from disk
  (`file://`) doesn't work: browsers only run the service worker, which
  provides offline use and the runtimes, on `http://localhost` or HTTPS.
- **Serve the unzipped folder itself.** `index.html` is at the top of the zip,
  so start the server inside the folder you unzipped to.
- **Use the same address every time.** The browser keeps notebooks and
  settings separately for each address, including the port. Notebooks saved
  at `http://localhost:8000` aren't visible at `http://localhost:8001` or on
  the live site. To move them, export from one and import into the other.

## Quick start: one command

Run one of these inside the unzipped folder, then open
**http://localhost:8000/**. Each listens only on your own computer, and stops
with **Ctrl+C**.

| Server | Command | Comes with |
| --- | --- | --- |
| Python 3 (tested) | `python3 -m http.server 8000 --bind 127.0.0.1` | macOS, most Linux. On Windows use `py -m http.server 8000 --bind 127.0.0.1` |
| Node.js | `npx http-server -a 127.0.0.1 -p 8000 -c-1` | Node.js; downloads `http-server` from npm on first use |
| PHP | `php -S 127.0.0.1:8000` | PHP |
| Ruby | `ruby -run -e httpd . -b 127.0.0.1 -p 8000` | Ruby |
| BusyBox | `busybox httpd -f -p 127.0.0.1:8000` | BusyBox (small Linux systems, Termux) |

Python's server is the simplest and lightest choice where it's already
installed. It was checked with the 1.4.0 zip: the service worker starts, and
WebAssembly runtimes are served with the correct `application/wasm` type.
The others are common alternatives that haven't been checked; if a runtime
fails to load with one of them, try Python first.

`--bind 127.0.0.1` (or `-a`/`-b`) keeps the server private to your computer.
Without it, some servers accept connections from your whole network.

## Example: Python on Windows, Linux or macOS

1. Unzip `SciREPL-v<version>-pwa.zip` into a new folder, for example
   `SciREPL-pwa`.
2. Open a terminal in that folder:
   - Windows: open the folder in File Explorer, type `cmd` in the address
     bar and press Enter.
   - macOS/Linux: `cd path/to/SciREPL-pwa`.
3. Start the server: `python3 -m http.server 8000 --bind 127.0.0.1`
   (Windows: `py -m http.server 8000 --bind 127.0.0.1`).
4. Open **http://localhost:8000/** in Chrome, Edge or Firefox.
5. Optional: install it as an app from the browser's address bar or menu
   ("Install SciREPL"). The installed app still needs the server running at
   the same address the first time each version loads; after that it works
   offline.

## Using it from another device (phone or tablet)

Other devices can't use `localhost`, and browsers only run the service worker
over HTTPS for any other address. A plain `http://192.168.x.x:8000` link will
load the page but not work properly. Options:

- **Use the live PWA** on that device instead. This is the simplest choice.
- **Serve over HTTPS** with a server that makes certificates. For example,
  [Caddy](https://caddyserver.com/) can serve the folder with a locally
  trusted certificate: `caddy file-server --root . --listen :8443 --domain <your-machine-name>`.
  Each device must trust Caddy's local certificate authority; see Caddy's
  documentation on its local HTTPS.
- **Android with a USB cable** and USB debugging on: forward the port with
  `adb reverse tcp:8000 tcp:8000`, then open `http://localhost:8000/` in
  Chrome on the phone. The phone then treats it as `localhost`.

Only expose the server on a network you trust, and stop it when you're done.

## Updating to a newer zip

Replace the folder's contents with the new zip, restart the server on the
**same port**, and reload. If the old version still shows, open the app's
**Menu → Reload App**, or press `Ctrl+Shift+R` on a desktop. Your notebooks
stay, because the address is unchanged. Export important notebooks before
switching versions anyway.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| Blank page or "service worker" errors | Opened from `file://`, or from a non-localhost `http://` address |
| Notebooks are missing | Different port or address from last time; each keeps its own storage |
| A language runtime won't start | The server sends the wrong type for `.wasm` files; use Python's server |
| Old version keeps loading | The service worker cached it; use **Reload App** or `Ctrl+Shift+R` |
| "Address already in use" | Another program uses port 8000; pick another port and keep using it |
