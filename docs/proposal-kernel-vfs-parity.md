# Proposal: SharedVFS Parity Across All Kernels

## Problem

Bash is the only kernel with transparent SharedVFS access. When bash
code reads `/shared/data.txt` or `/tmp/output.csv`, it "just works"
because brush-wasm has native wasm-bindgen callbacks that delegate
filesystem calls to `window.sharedVFS`. Other kernels either have
partial access or none:

| Kernel  | NotebookVFS (`nb.*`) | SharedVFS (`/shared/`, `/tmp/`) | Sync pattern |
|---------|---------------------|--------------------------------|--------------|
| Bash    | via `/nb/` paths    | native (wasm-bindgen)          | none needed  |
| Python  | via sharedfs.py     | `sharedfs.read_text()` + sync  | pre/post     |
| R       | `nb_read()`         | `sharedfs_read()` + sync       | pre/post     |
| Prolog  | `nb_read/3`         | Emscripten FS + event sync     | event-driven |
| Lua     | `nb.read()`         | **NONE**                       | **none**     |
| JS      | direct JS access    | direct JS access               | none needed  |

Lua is the most isolated — it can read/write notebook cells but cannot
access `/shared/`, `/tmp/`, or any files written by other kernels.
This breaks cross-kernel workflows where Python writes data that Lua
needs to process.

## What Bash Gets Right

Brush-wasm's approach is ideal: filesystem calls are intercepted at the
native level and delegated to SharedVFS transparently. Generated code
doesn't need to know it's running in a browser — `cat /shared/file.txt`
works identically to the CLI.

This can't be ported directly to Fengari (Lua) because Fengari is a
pure JavaScript Lua VM without a filesystem interception layer. But
we can approximate it with the same pattern Python and R use: **explicit
bridge functions installed during kernel init**.

## Proposed Changes

### 1. Add SharedVFS bridge to Lua kernel (`sharedfs` table)

Install a `sharedfs` table in `_installNotebookVFS()` (or a new
`_installSharedVFS()` method), following the exact pattern of `nb`:

```lua
-- Read/write shared filesystem
sharedfs.read(path)           -- returns string or nil
sharedfs.write(path, content) -- returns boolean
sharedfs.exists(path)         -- returns boolean
sharedfs.list(path)           -- returns JSON string of entries
sharedfs.mkdir(path)          -- returns boolean
sharedfs.remove(path)         -- returns boolean
```

Implementation: push JS functions via `lua_pushjsfunction` that call
`window.sharedVFS.readFile()`, `window.sharedVFS.writeFile()`, etc.
This is ~60 lines of JavaScript, following the existing `nb` pattern.

### 2. Bridge `io.lines()` and `io.open()` to SharedVFS

Fengari's `io` library is minimal. Override `io.lines(path)` and
`io.open(path, mode)` to check SharedVFS when a path starts with
`/shared/`, `/tmp/`, `/nb/`, or `/education/`:

```lua
-- Currently: io.lines("facts.txt") → error (no filesystem)
-- Proposed: io.lines("/shared/facts.txt") → reads from SharedVFS
-- Proposed: io.lines() with no args → still fails (no stdin)
```

This is the closest analogue to brush-wasm's transparent interception.
Generated code using `input(file("/shared/facts.txt"))` would work
without modification.

### 3. Generalize the Python sync pattern to a shared module

Python and R both implement sync logic independently. Extract the
pattern into a reusable `kernel_vfs_sync.js` module:

```javascript
// Before execution: copy SharedVFS → kernel's local FS
function syncToKernel(kernelFS, paths) { ... }

// After execution: copy kernel's local FS → SharedVFS
function syncFromKernel(kernelFS, paths) { ... }
```

This wouldn't help Lua (Fengari has no local FS to sync) but would
reduce duplication between Python and R kernels and make it easier
to add future Emscripten-based kernels.

### 4. Update generated code to use the right I/O mode

The UnifyWeaver compiler now supports `input(Mode)` for Lua:

```prolog
% In sciREPL notebook:
compile_recursive(ancestor/2, [target(lua), input(vfs(family_tree))], Code).
% → generates: local cell_data = nb.read("family_tree", ".output")

compile_recursive(ancestor/2, [target(lua), input(embedded)], Code).
% → generates: add_fact("alice", "bob") ... (no I/O)

compile_recursive(ancestor/2, [target(lua), input(file("/shared/facts.txt"))], Code).
% → generates: for line in io.lines("/shared/facts.txt") do ...
%   (requires proposal #2 above to work in-browser)
```

The `input(vfs(...))` mode works today with the existing `nb.read()`
bridge. The `input(embedded)` mode needs no I/O at all. Only
`input(file(...))` requires the `io.lines()` override from proposal #2.

## Priority Order

1. **SharedVFS table for Lua** (high) — unblocks cross-kernel file
   sharing, ~60 lines JS
2. **`io.lines()` override** (medium) — enables `input(file(...))` in
   generated code, ~40 lines JS
3. **Kernel sync module** (low) — reduces duplication, helps future
   kernels, ~100 lines JS

## Relationship to Input Source Design

This proposal is the sciREPL-side complement to the `input_source.pl`
compiler module (see `docs/design/INPUT_SOURCE_DESIGN.md`). The
compiler generates code using the right I/O mode; this proposal
ensures the runtime environment supports those modes.

| Input mode        | Compiler generates         | Runtime requires           |
|-------------------|---------------------------|----------------------------|
| `input(stdin)`    | `io.lines()`              | stdin (CLI only)           |
| `input(embedded)` | `add_fact(...)` calls     | nothing (no I/O)           |
| `input(file(P))` | `io.lines(path)`          | proposal #2 (`io.lines` override) |
| `input(vfs(C))`  | `nb.read(cell, prop)`     | existing `nb` table        |
| `input(function)` | function API              | nothing (no I/O)           |

## Why Bash Didn't Have This Problem

Brush-wasm compiles the entire bash shell (builtins, pipes, redirects)
to WebAssembly via Rust. The Rust code includes wasm-bindgen hooks
that intercept every `open()`, `read()`, `write()`, `stat()` call
at the POSIX level and delegate to `window.sharedVFS.vfs_*()` methods.

This is fundamentally different from how other WASM runtimes work:
- **Pyodide** (Python) and **webR** (R) use Emscripten, which has its
  own in-memory filesystem that is separate from SharedVFS. They need
  explicit sync.
- **swipl-wasm** (Prolog) also uses Emscripten and has a custom
  `prolog_vfs.js` bridge.
- **Fengari** (Lua) is a pure JavaScript interpreter — no WASM, no
  Emscripten, no filesystem layer at all. It needs explicit bridges
  for every I/O operation.

Bash's approach is the gold standard but requires compiling the entire
language runtime to WASM with filesystem hooks. The bridge approach
(explicit functions like `nb.read()` and `sharedfs.read()`) is the
practical alternative for runtimes that don't have native VFS support.
