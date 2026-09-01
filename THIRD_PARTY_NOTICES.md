# Open Source Attributions

This file is generated from `third-party-components.json`. Do not edit it by hand.

**Inventory scope:** Direct browser libraries, language runtimes, named bundled Pyodide wheels, major command suites embedded in brush, and platform containers distributed by SciREPL Free. User-installed Python, R, Prolog, or other packages are not shipped-component entries and retain their own licences. This is not yet a complete crate-by-crate or Android transitive SBOM.

**Resolved build:** SciREPL 1.3.2, profile `full`, 24 components.

Versions below are the exact pinned defaults. A user-configured runtime version or source override can intentionally load a different upstream artifact.

## SciREPL

- **Version:** 1.3.2
- **Delivery:** SciREPL application
- **Licence:** MIT
- **Source:** https://github.com/s243a/SciREPL
- **Provenance:** First-party project
- **Copyright:** Copyright (c) 2026 UnifyWeaver Project

The application itself. Third-party components below retain their own licences.

## Plotly.js basic distribution

- **Version:** 2.35.2
- **Delivery:** Bundled with SciREPL
- **Licence:** MIT
- **Source:** https://github.com/plotly/plotly.js/tree/v2.35.2
- **Provenance:** Upstream release distribution
- **Copyright:** Copyright (c) 2012-2024 Plotly, Inc.

The generated third-party licence sidecar referenced by plotly-basic.min.js is bundled alongside it.

## KaTeX

- **Version:** 0.16.11
- **Delivery:** Bundled with SciREPL
- **Licence:** MIT
- **Source:** https://github.com/KaTeX/KaTeX/tree/v0.16.11
- **Provenance:** Upstream release distribution
- **Copyright:** Copyright (c) 2013-2020 Khan Academy and other contributors

## marked

- **Version:** 15.0.7
- **Delivery:** Bundled with SciREPL
- **Licence:** MIT AND BSD-3-Clause
- **Source:** https://github.com/markedjs/marked/tree/v15.0.7
- **Provenance:** Upstream release distribution
- **Copyright:** Copyright (c) 2018+ MarkedJS; Copyright (c) 2011-2018 Christopher Jeffrey; Markdown portions Copyright (c) 2004 John Gruber

## highlight.js

- **Version:** 11.11.1
- **Delivery:** Bundled with SciREPL
- **Licence:** BSD-3-Clause
- **Source:** https://github.com/highlightjs/highlight.js/tree/11.11.1
- **Provenance:** Upstream release distribution
- **Copyright:** Copyright (c) 2006, Ivan Sagalaev

## JSZip

- **Version:** 3.10.1
- **Delivery:** Bundled with SciREPL
- **Licence:** MIT OR GPL-3.0-or-later (distributed under MIT)
- **Source:** https://github.com/Stuk/jszip/tree/v3.10.1
- **Provenance:** Upstream release distribution, selected under its MIT option
- **Copyright:** Copyright (c) 2009-2016 Stuart Knightley

## pako

- **Version:** 2.1.0
- **Delivery:** Bundled with SciREPL
- **Licence:** MIT AND Zlib
- **Source:** https://github.com/nodeca/pako/tree/2.1.0
- **Provenance:** Upstream release distribution
- **Copyright:** Copyright (c) 2014-2017 Vitaly Puzrin and Andrei Tuputcyn; zlib portions retain their upstream notices

## brush shell

- **Version:** 0.3.0-163-g409b2cc
- **Delivery:** Bundled with SciREPL
- **Licence:** MIT
- **Source:** https://github.com/s243a/brush/tree/409b2cce4c2957499cdab783b705b70f62708ef7
- **Provenance:** SciREPL fork revision; WASM build includes project-specific shell/builtin changes
- **Copyright:** Copyright (c) 2024 reuben olinsky and contributors

**Pinned runtime sources:**
- vendor/brush/brush_wasm.js

## uutils coreutils command crates

- **Version:** 0.6.0
- **Delivery:** Embedded in brush
- **Licence:** MIT
- **Source:** https://github.com/uutils/coreutils
- **Provenance:** Modification status not independently recorded
- **Copyright:** Copyright uutils contributors

Selected command crates are compiled into SciREPL's brush WASM build.

## uutils findutils

- **Version:** 0.8.0
- **Delivery:** Embedded in brush
- **Licence:** MIT
- **Source:** https://github.com/uutils/findutils
- **Provenance:** Modification status not independently recorded
- **Copyright:** Copyright Google Inc. and contributors

## ripgrep grep crates

- **Version:** grep-matcher 0.1.8; grep-regex 0.1.14; grep-searcher 0.1.16
- **Delivery:** Embedded in brush
- **Licence:** MIT OR Unlicense (distributed under MIT)
- **Source:** https://github.com/BurntSushi/ripgrep
- **Provenance:** Modification status not independently recorded
- **Copyright:** Copyright Andrew Gallant and contributors

The grep implementation uses ripgrep's library crates; SciREPL does not ship the standalone ripgrep executable.

## TypR

- **Version:** 0.5.6-39-g670fc38
- **Delivery:** Bundled with SciREPL
- **Licence:** Apache-2.0
- **Source:** https://github.com/s243a/typr/tree/670fc38402d80e2a01ee1789870c8731e0c014f8
- **Provenance:** SciREPL fork revision; includes variadic typing and standard-library changes
- **Copyright:** Copyright TypR contributors

SciREPL uses the linked fork, including variadic standard-library typing changes.

**Pinned runtime sources:**
- vendor/typr/typr_wasm.js

## Fengari / Lua 5.3 VM

- **Version:** 0.1.4
- **Delivery:** Downloaded on first use (lua)
- **Licence:** MIT
- **Source:** https://github.com/fengari-lua/fengari-web/tree/v0.1.4
- **Provenance:** Upstream CDN release
- **Copyright:** Copyright (c) 2017 Benoit Giannangeli; Copyright (c) 2017-2018 Daurnimator

**Pinned runtime sources:**
- https://cdn.jsdelivr.net/npm/fengari-web@0.1.4/dist/fengari-web.js
- https://unpkg.com/fengari-web@0.1.4/dist/fengari-web.js

## Scittle

- **Version:** 0.6.22
- **Delivery:** Bundled for offline use (clojurescript)
- **Licence:** EPL-1.0 AND Apache-2.0
- **Source:** https://github.com/babashka/scittle/tree/v0.6.22
- **Provenance:** Upstream CDN release
- **Copyright:** Copyright Scittle and SCI contributors; bundled Google Closure Library portions Copyright 2009 The Closure Library Authors

The compiled distribution includes Google Closure Library code carrying an Apache-2.0 SPDX notice in the shipped header.

**Pinned runtime sources:**
- https://cdn.jsdelivr.net/npm/scittle@0.6.22/dist/scittle.js
- https://unpkg.com/scittle@0.6.22/dist/scittle.js

## npm-swipl-wasm / SWI-Prolog

- **Version:** 3.8.2 (SWI-Prolog 9.3.8)
- **Delivery:** Bundled for offline use (prolog)
- **Licence:** BSD-2-Clause AND Zlib AND BSD-3-Clause
- **Source:** https://github.com/SWI-Prolog/npm-swipl-wasm/tree/v3.8.2
- **Provenance:** Exact upstream v3.8.2 bundle
- **Copyright:** Copyright SWI-Prolog and npm-swipl-wasm contributors; zlib Copyright 1995-2024 Jean-loup Gailly and Mark Adler; PCRE2 copyright the University of Cambridge and PCRE2 contributors

This stays on the package's 3.x API. The similarly named current 8.x package line is not a drop-in upgrade. The v3.8.2 build recipe compiles zlib 1.3.1 and PCRE2 10.44 into the delivered runtime, so their licences are reproduced here. Individual SWI add-on packages can carry additional licences.

**Pinned runtime sources:**
- https://SWI-Prolog.github.io/npm-swipl-wasm/{versionSelector}/dynamic-import.js

| Package | Version | Licence | Source |
|---|---:|---|---|
| zlib | 1.3.1 | Zlib | https://github.com/madler/zlib/tree/v1.3.1 |
| PCRE2 | 10.44 | BSD-3-Clause | https://github.com/PCRE2Project/pcre2/tree/pcre2-10.44 |

## Pyodide

- **Version:** 0.27.4 (CPython 3.12.7; Emscripten 3.1.58)
- **Delivery:** Bundled for offline use (python)
- **Licence:** MPL-2.0
- **Source:** https://github.com/pyodide/pyodide/tree/0.27.4
- **Provenance:** Exact upstream Pyodide release assets
- **Copyright:** Copyright Pyodide contributors

**Pinned runtime sources:**
- https://cdn.jsdelivr.net/pyodide/v0.27.4/full/pyodide.js
- https://unpkg.com/pyodide@0.27.4/pyodide.js

## CPython (inside Pyodide)

- **Version:** 3.12.7
- **Delivery:** Bundled for offline use (python)
- **Licence:** Python-2.0
- **Source:** https://github.com/python/cpython/tree/v3.12.7
- **Provenance:** Modification status not independently recorded
- **Copyright:** Copyright Python Software Foundation and contributors
- **Upstream licence:** https://docs.python.org/3.12/license.html

SciREPL records CPython's upstream licence text. Additional notices carried inside the Pyodide distribution remain governed by their upstream terms.

## Bundled Pyodide wheels

- **Version:** numpy 2.0.2; sympy 1.13.3; mpmath 1.3.0; micropip 0.8.0; pandas 2.2.3; narwhals 1.24.1; packaging 24.2; python-dateutil 2.9.0.post0; pytz 2024.1; six 1.16.0
- **Delivery:** Bundled for offline use (python)
- **Licence:** Multiple (BSD/MIT/MPL/Apache); see upstream wheel metadata
- **Source:** https://github.com/pyodide/pyodide/tree/0.27.4/packages
- **Provenance:** Modification status not independently recorded
- **Copyright:** Copyright the respective package authors and contributors

Resolved from Pyodide 0.27.4's lock. The Python kernel preloads numpy, sympy, and micropip; pandas and narwhals plus the listed transitive wheels are bundled for catalog workbooks and offline dependency resolution.

| Package | Version | Licence | Source |
|---|---:|---|---|
| numpy | 2.0.2 | BSD-3-Clause | https://github.com/numpy/numpy/tree/v2.0.2 |
| sympy | 1.13.3 | BSD-3-Clause | https://github.com/sympy/sympy/tree/1.13.3 |
| mpmath | 1.3.0 | BSD-3-Clause | https://github.com/mpmath/mpmath/tree/1.3.0 |
| micropip | 0.8.0 | MPL-2.0 | https://github.com/pyodide/micropip/tree/0.8.0 |
| pandas | 2.2.3 | BSD-3-Clause | https://github.com/pandas-dev/pandas/tree/v2.2.3 |
| narwhals | 1.24.1 | MIT | https://github.com/narwhals-dev/narwhals/tree/v1.24.1 |
| packaging | 24.2 | Apache-2.0 OR BSD-2-Clause | https://github.com/pypa/packaging/tree/24.2 |
| python-dateutil | 2.9.0.post0 | Apache-2.0 OR BSD-3-Clause | https://github.com/dateutil/dateutil/tree/2.9.0.post0 |
| pytz | 2024.1 | MIT | https://github.com/stub42/pytz/tree/release_2024.1 |
| six | 1.16.0 | MIT | https://github.com/benjaminp/six/tree/1.16.0 |

## webR JavaScript and support code

- **Version:** 0.5.4
- **Delivery:** Downloaded on first use (r)
- **Licence:** MIT
- **Source:** https://github.com/r-wasm/webr/tree/v0.5.4
- **Provenance:** Upstream webR v0.5.4 support files; when bundled, SciREPL gunzips .data.gz payloads, removes those gzip wrappers, and sets the matching .js.metadata gzip flag to false so Android WebView can serve them. Executable contents are otherwise unchanged.
- **Copyright:** Copyright webR contributors

This entry covers webR's JavaScript/support layer only. The distributed R/WebAssembly binaries are listed separately because webR's own licence file applies GPLv3 to those binaries. The deterministic Android packaging transform is implemented by scripts/fetch-bundles.mjs and declared in scripts/bundle-recipes.mjs.

**Pinned runtime sources:**
- https://webr.r-wasm.org/v0.5.4/webr.mjs
- https://cdn.jsdelivr.net/npm/webr@0.5.4/dist/webr.mjs

## webR binary distribution / R runtime

- **Version:** webR 0.5.4 (R 4.5.1)
- **Delivery:** Downloaded on first use (r)
- **Licence:** GPL-3.0-only (distributed webR binaries); R is GPL-2.0-or-later
- **Source:** https://github.com/r-wasm/webr/tree/v0.5.4
- **Provenance:** The Free build downloads upstream files without transforming them. Builds that bundle R deterministically gunzip .data.gz containers and clear their matching metadata gzip flag for Android WebView; the decompressed executable data is not otherwise changed.
- **Copyright:** Copyright R Core Team, webR contributors, and included-software copyright holders
- **Corresponding source:** https://github.com/r-wasm/webr/tree/v0.5.4
- **Upstream source:** https://cran.r-project.org/src/base/R-4/R-4.5.1.tar.gz
- **Upstream licence:** https://github.com/r-wasm/webr/blob/v0.5.4/LICENSE.md

SciREPL Free downloads this runtime on first R use; it is not embedded in the Free APK. The runtime executes locally after download. Pro builds reproduce the transform with scripts/fetch-bundles.mjs; corresponding upstream sources and the exact build recipe are linked and recorded here.

## docx

- **Version:** 9.6.0
- **Delivery:** Downloaded on demand (first DOCX export)
- **Licence:** MIT
- **Source:** https://github.com/dolanmiu/docx/tree/9.6.0
- **Provenance:** Exact upstream CDN release
- **Copyright:** Copyright (c) 2016 Dolan and contributors

**Pinned runtime sources:**
- https://cdn.jsdelivr.net/npm/docx@9.6.0/dist/index.iife.js
- https://unpkg.com/docx@9.6.0/dist/index.iife.js

## Capacitor and official plugins

- **Version:** core/android 8.0.2; app 8.1.1; browser/share 8.0.1; filesystem 8.1.2
- **Delivery:** Android-specific bundle
- **Licence:** MIT
- **Source:** https://github.com/ionic-team/capacitor
- **Provenance:** Modification status not independently recorded
- **Copyright:** Copyright (c) 2017-present Drifty Co. and contributors

| Package | Version | Licence | Source |
|---|---:|---|---|
| @capacitor/android | 8.0.2 | MIT | https://github.com/ionic-team/capacitor/tree/8.0.2 |
| @capacitor/app | 8.1.1 | MIT | https://github.com/ionic-team/capacitor-plugins/tree/%40capacitor/app%408.1.1/app |
| @capacitor/core | 8.0.2 | MIT | https://github.com/ionic-team/capacitor/tree/8.0.2 |
| @capacitor/browser | 8.0.1 | MIT | https://github.com/ionic-team/capacitor-plugins/tree/%40capacitor/browser%408.0.1/browser |
| @capacitor/filesystem | 8.1.2 | MIT | https://github.com/ionic-team/capacitor-plugins/tree/%40capacitor/filesystem%408.1.2/filesystem |
| @capacitor/share | 8.0.1 | MIT | https://github.com/ionic-team/capacitor-plugins/tree/%40capacitor/share%408.0.1/share |

## @capgo/capacitor-pdf-generator

- **Version:** 8.0.19
- **Delivery:** Android-specific bundle
- **Licence:** MPL-2.0
- **Source:** https://github.com/Cap-go/capacitor-pdf-generator
- **Provenance:** Modification status not independently recorded
- **Copyright:** Copyright Cap-go contributors

## Electron

- **Version:** 43.3.0
- **Delivery:** Electron desktop-specific bundle
- **Licence:** MIT
- **Source:** https://github.com/electron/electron/tree/v43.3.0
- **Provenance:** Modification status not independently recorded
- **Copyright:** Copyright (c) Electron contributors; Chromium third-party notices ship with Electron builds

Electron distributions also include Chromium's generated LICENSES.chromium.html.

# Included licence texts

The recorded licence texts and notices used by the offline in-app page are stored here:

- **Apache-2.0:** [`third_party/licenses/Apache-2.0.txt`](third_party/licenses/Apache-2.0.txt) — https://www.apache.org/licenses/LICENSE-2.0.txt
- **BSD-2-Clause:** [`third_party/licenses/BSD-2-Clause.txt`](third_party/licenses/BSD-2-Clause.txt) — https://spdx.org/licenses/BSD-2-Clause.html
- **BSD-3-Clause:** [`third_party/licenses/BSD-3-Clause.txt`](third_party/licenses/BSD-3-Clause.txt) — https://spdx.org/licenses/BSD-3-Clause.html
- **EPL-1.0:** [`third_party/licenses/EPL-1.0.txt`](third_party/licenses/EPL-1.0.txt) — https://www.eclipse.org/legal/epl-v10.html
- **GPL-3.0-only:** [`third_party/licenses/GPL-3.0-only.txt`](third_party/licenses/GPL-3.0-only.txt) — https://www.gnu.org/licenses/gpl-3.0.txt
- **GPL-2.0-only:** [`third_party/licenses/GPL-2.0-only.txt`](third_party/licenses/GPL-2.0-only.txt) — https://www.gnu.org/licenses/old-licenses/gpl-2.0.txt
- **MIT:** [`third_party/licenses/MIT.txt`](third_party/licenses/MIT.txt) — https://spdx.org/licenses/MIT.html
- **MPL-2.0:** [`third_party/licenses/MPL-2.0.txt`](third_party/licenses/MPL-2.0.txt) — https://www.mozilla.org/MPL/2.0/
- **Unlicense:** [`third_party/licenses/Unlicense.txt`](third_party/licenses/Unlicense.txt) — https://unlicense.org/
- **Python-2.0:** [`third_party/licenses/CPython-3.12.7.txt`](third_party/licenses/CPython-3.12.7.txt) — https://docs.python.org/3.12/license.html
- **wheel-micropip-LICENSE:** [`third_party/licenses/pyodide-wheels/micropip-LICENSE.txt`](third_party/licenses/pyodide-wheels/micropip-LICENSE.txt)
- **wheel-mpmath-LICENSE:** [`third_party/licenses/pyodide-wheels/mpmath-LICENSE.txt`](third_party/licenses/pyodide-wheels/mpmath-LICENSE.txt)
- **wheel-narwhals-LICENSE:** [`third_party/licenses/pyodide-wheels/narwhals-LICENSE.md`](third_party/licenses/pyodide-wheels/narwhals-LICENSE.md)
- **wheel-numpy-LICENSE:** [`third_party/licenses/pyodide-wheels/numpy-LICENSE.txt`](third_party/licenses/pyodide-wheels/numpy-LICENSE.txt)
- **wheel-numpy-random-c-api-LICENSE:** [`third_party/licenses/pyodide-wheels/numpy-random-c-api-LICENSE.txt`](third_party/licenses/pyodide-wheels/numpy-random-c-api-LICENSE.txt)
- **wheel-numpy-ma-LICENSE:** [`third_party/licenses/pyodide-wheels/numpy-ma-LICENSE.txt`](third_party/licenses/pyodide-wheels/numpy-ma-LICENSE.txt)
- **wheel-numpy-random-LICENSE:** [`third_party/licenses/pyodide-wheels/numpy-random-LICENSE.md`](third_party/licenses/pyodide-wheels/numpy-random-LICENSE.md)
- **wheel-packaging-LICENSE:** [`third_party/licenses/pyodide-wheels/packaging-LICENSE.txt`](third_party/licenses/pyodide-wheels/packaging-LICENSE.txt)
- **wheel-packaging-APACHE:** [`third_party/licenses/pyodide-wheels/packaging-LICENSE.APACHE.txt`](third_party/licenses/pyodide-wheels/packaging-LICENSE.APACHE.txt)
- **wheel-packaging-BSD:** [`third_party/licenses/pyodide-wheels/packaging-LICENSE.BSD.txt`](third_party/licenses/pyodide-wheels/packaging-LICENSE.BSD.txt)
- **wheel-pandas-LICENSE:** [`third_party/licenses/pyodide-wheels/pandas-LICENSE.txt`](third_party/licenses/pyodide-wheels/pandas-LICENSE.txt)
- **wheel-python-dateutil-LICENSE:** [`third_party/licenses/pyodide-wheels/python-dateutil-LICENSE.txt`](third_party/licenses/pyodide-wheels/python-dateutil-LICENSE.txt)
- **wheel-pytz-LICENSE:** [`third_party/licenses/pyodide-wheels/pytz-LICENSE.txt`](third_party/licenses/pyodide-wheels/pytz-LICENSE.txt)
- **wheel-six-LICENSE:** [`third_party/licenses/pyodide-wheels/six-LICENSE.txt`](third_party/licenses/pyodide-wheels/six-LICENSE.txt)
- **wheel-sympy-AUTHORS:** [`third_party/licenses/pyodide-wheels/sympy-AUTHORS.txt`](third_party/licenses/pyodide-wheels/sympy-AUTHORS.txt)
- **wheel-sympy-LICENSE:** [`third_party/licenses/pyodide-wheels/sympy-LICENSE.txt`](third_party/licenses/pyodide-wheels/sympy-LICENSE.txt)
- **wheel-sympy-latex-LICENSE:** [`third_party/licenses/pyodide-wheels/sympy-latex-LICENSE.txt`](third_party/licenses/pyodide-wheels/sympy-latex-LICENSE.txt)
- **Plotly-basic-third-party-notices:** [`www/vendor/plotly/plotly-basic.min.js.LICENSE.txt`](www/vendor/plotly/plotly-basic.min.js.LICENSE.txt) — https://cdn.jsdelivr.net/npm/plotly.js@2.35.2/dist/plotly-basic.min.js.LICENSE.txt
- **webR-0.5.4:** [`third_party/licenses/webR-0.5.4-LICENSE.md`](third_party/licenses/webR-0.5.4-LICENSE.md) — https://github.com/r-wasm/webr/blob/v0.5.4/LICENSE.md
- **Zlib:** [`third_party/licenses/Zlib.txt`](third_party/licenses/Zlib.txt) — https://spdx.org/licenses/Zlib.html

The generated `www/open-source-licenses.html` embeds these texts so they remain readable offline.
