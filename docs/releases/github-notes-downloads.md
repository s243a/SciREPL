## Downloads

- **Android:** install from Google Play once this version reaches Production; Play keeps it updated.
- **Android APK (signed):** `SciREPL-v{version}.apk`, added after the release is signed. If you installed from Google Play, keep updating through Play: Play and this APK may be signed with different keys, and Android won't install one over the other.
- **Android build inputs (unsigned):** `SciREPL-v{version}-unsigned.apk` and `SciREPL-v{version}-play-unsigned.aab`, for signing with your own key. The APK is already zip-aligned: `apksigner sign --ks your.keystore --ks-key-alias your-alias --out SciREPL-v{version}-self-signed.apk SciREPL-v{version}-unsigned.apk`
- **PWA (zip):** `SciREPL-v{version}-pwa.zip`, this exact version as a web app. Unzip it and serve the folder, for example with `python3 -m http.server 8000 --bind 127.0.0.1`, then open http://localhost:8000/. Opening `index.html` from disk (`file://`) doesn't work. [How to serve the PWA](https://github.com/s243a/SciREPL/blob/main/docs/SERVE_PWA.md), including other servers and phones.
- **PWA (live):** [https://s243a.github.io/SciREPL/](https://s243a.github.io/SciREPL/). Install it from your browser; no app store needed. It always runs the newest tagged version, which can be a pre-release newer than this one.
- **Windows portable (unsigned, x64):** `SciREPL-v{version}-windows-x64-portable.zip`. Extract it to a local folder and run **SciREPL.exe**; there's no installer. Because it's unsigned, Windows SmartScreen shows "Windows protected your PC" on first run: choose **More info → Run anyway**. App data lives under `%APPDATA%\SciREPL-Free-Electron`.
- **Checksums:** `SHA256SUMS.txt` lists the SHA-256 of each file built by CI.

If you already use the PWA and see an old version, open **Menu → Reload App**, or press `Ctrl+Shift+R` on a desktop.
