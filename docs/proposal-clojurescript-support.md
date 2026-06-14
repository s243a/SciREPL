# Proposal: ClojureScript support

Status: draft / design
Scope: **cross-repo.** ClojureScript support spans two layers in two repos —
a **SciREPL kernel** (run ClojureScript in the app; this repo) and a
**UnifyWeaver target** (compile Prolog → ClojureScript; the main UnifyWeaver
repo). This is a general feature, **not** a Pro-only one.

## 1. Two layers — keep them separate

The single most important distinction (and an easy one to conflate):

| Layer | What it is | Repo | Inheritance? |
|-------|-----------|------|--------------|
| **Kernel** | a *runtime* that executes code in the app (`init/isReady/execute/...`) | **SciREPL** (this repo) | only if 2+ runtimes |
| **Target** | a *compiler* that emits code from Prolog | **UnifyWeaver** | yes — variant of `clojure_target` |

They are partners across layers, not parent/child: **the Scittle kernel
*runs* the output of `clojurescript_target`.** A kernel never "inherits from"
a target.

## 2. Kernel layer (SciREPL) — start here

Add a `clojurescript` kernel alongside the existing Python/Prolog/Bash/JS/R/
Lua/TypR kernels. The runtime choice:

- **Scittle / SCI** (borkdude's Small Clojure Interpreter) — JS-loadable, no
  build step, offline, small footprint. The direct analog of **Fengari for
  Lua**: `init()` loads Scittle, `execute(code)` evals a form. **Recommended
  for v1.** Covers a large Clojure subset; purpose-built for browser embed.
- **Self-hosted ClojureScript** (`cljs.js` bootstrap, as Klipse / replumb
  use) — the real in-browser CLJS *compiler*, fuller semantics, but multi-MB
  and more complex to embed. **Defer** unless Scittle's interpreter subset
  proves limiting.

### Kernel implementation (v1, Scittle)
Implements the standard kernel contract (see existing `www/js/kernels/lua.js`
as the closest template): `init()`, `isReady()`, `getName()`,
`getLanguage()`, `execute(code)`, `getMemoryUsage()`, `destroy()`, static
`displayName`; registered via
`window.kernelManager.register('clojurescript', ClojureScriptKernel)`.

Integration points (the known drift spots — update all):
- `FileIO.LANGUAGE_META` (single source of truth) + `IPYNB_KERNELSPEC` /
  `IPYNB_LANGUAGE_INFO` maps in `file_io.js`
- the hardcoded `#lang-selector` `<option>` list in `index.html`
- the `<script src="js/kernels/clojurescript.js">` tag in `index.html`
- `sw.js` `APP_SHELL` precache (bundle the Scittle runtime + the kernel) and
  bump `CACHE_VERSION`
- a `lang-clojurescript` / `clojurescript-active` color in `style.css`

Bundle Scittle locally (like the brush/typr vendor assets) so the kernel
works offline, rather than a CDN dependency.

### Optional kernel-layer inheritance (later)
*If* a second runtime (self-hosted CLJS) is added, factor a base
`ClojureScriptKernel` (JS-level) and have Scittle + self-hosted variants
override just the runtime-load/eval bit. Not needed for v1 — there's nothing
to share with until the second runtime exists.

## 3. Target layer (UnifyWeaver) — later phase

UnifyWeaver already has `clojure_target.pl` (JVM Clojure), plus
`wam_clojure_target` / `wam_clojure_lowered_emitter`. ClojureScript should be
a **variant of `clojure_target`**, following the exact pattern the Python
family uses — each variant does `use_module(python_target)` and overrides
only the defaults that differ (e.g. `python_cython_target`,
`python_codon_target`, `python_numba_target`, `python_mypyc_target` all
inherit `python_target`). So:

```
clojurescript_target  :  clojure_target   ::   python_cython_target  :  python_target
```

`clojurescript_target.pl` does `use_module(clojure_target)` and overrides the
JVM→JS differences:
- **interop** — `js/console.log`, `.-prop`, `js-obj`, `(js/…)` instead of
  Java interop
- **namespace / deps** — `ns` + `:require`, and a `shadow-cljs.edn` (or an
  inline `<script>` payload) instead of `deps.edn`
- **primitives** — no threads / agents / `future`; account for `clojure.core`
  gaps in CLJS
- **build artifact** — JS bundle instead of a JVM jar

The override surface is small — most of `clojure_target`'s codegen is shared.

Eventually both Clojure (JVM) and ClojureScript ship as targets; the JVM one
already exists, so this phase is really just adding the CLJS variant.

## 4. Why both layers pay off together

The JVM `clojure_target` output can't run in a browser — but a
**ClojureScript** target's output *can* run in the **Scittle kernel**. So the
two layers close the loop: a **`prolog-generates-clojurescript`** workbook
where UnifyWeaver compiles Prolog → CLJS and the CLJS kernel executes it
in-app — the same story as the existing `prolog-generates-r` /
`prolog-generates-typr` workbooks. The kernel is what makes the target
*demonstrable* in SciREPL.

## 5. Phased plan

1. **Kernel (SciREPL, this repo):** `clojurescript` kernel backed by Scittle
   + all integration points above. Ships "ClojureScript runs in the app."
2. **Target (UnifyWeaver):** `clojurescript_target.pl` ← `clojure_target.pl`
   with the override list in §3.
3. **Tie-together (both):** a `prolog-generates-clojurescript` workbook;
   add it to the package catalog / UnifyWeaver package.

## 6. Open questions

- Which Clojure subset does Scittle/SCI cover, and is it enough for the
  intended demos? (Determines whether self-hosted CLJS is needed sooner.)
- REPL semantics in a notebook cell: namespace/`def` persistence across
  cells — does Scittle keep a single eval context per kernel instance?
- Bundle size of Scittle vs the precache budget.
- Naming: language id `clojurescript` vs `cljs`; selector abbrev (e.g. `CLJS`).
