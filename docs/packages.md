# SciREPL Package System v2

The package system lets you bundle notebooks, data files, Python modules, Prolog knowledge bases, and pre-compiled WASM libraries into a single `.zip` archive that any SciREPL user can install with one click.

## Quick Start

### Installing a Package

**From the catalog:** Menu > Browse Packages > Install

**From a file:** Menu > Import Package > select a `.zip` file

### Creating a Minimal Package

1. Create a folder with your files:

```
my-package/
  scirepl.json
  demo.ipynb
  data/dataset.csv
```

2. Write `scirepl.json`:

```json
{
  "format_version": "2.0",
  "name": "My Package",
  "version": "1.0.0",
  "description": "A demo package",
  "notebooks": [
    { "file": "demo.ipynb", "name": "Demo Notebook" }
  ],
  "files": [
    { "src": "data/dataset.csv", "dest": "/shared/data/dataset.csv", "target": "shared" }
  ]
}
```

3. Zip it: `cd my-package && zip -r ../my-package.zip .`

4. Import in SciREPL via Menu > Import Package.

Your notebook can now read the data from any kernel:

```python
# Python
import sharedfs
csv_text = sharedfs.read_text('/shared/data/dataset.csv')
```

```bash
# Bash
cat /shared/data/dataset.csv
```

---

## Manifest Reference (`scirepl.json`)

Every package archive should contain a `scirepl.json` at the root (or inside one top-level folder). The manifest controls what gets installed and where.

### Top-Level Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `format_version` | `"1.0"` or `"2.0"` | Yes | Manifest format. Use `"2.0"` for target routing and binary support. |
| `name` | string | No | Display name shown during install. |
| `version` | string | No | Semantic version (informational). |
| `description` | string | No | Short description. |
| `notebooks` | array | No | Notebook files to load (see below). |
| `files` | array | No | Files to mount into the virtual filesystem (see below). |
| `search_paths` | array | No | Prolog library search paths (see below). |
| `wasm_modules` | array | No | Pre-compiled WASM libraries (see below). |

### `notebooks[]`

```json
{ "file": "demo.ipynb", "name": "Demo", "description": "Optional", "kernel": "python" }
```

| Field | Required | Description |
|-------|----------|-------------|
| `file` | Yes | Path to `.ipynb` inside the archive. |
| `name` | No | Display name for the notebook tab. |
| `description` | No | Tooltip or catalog description. |
| `kernel` | No | Default kernel: `"python"`, `"prolog"`, or `"bash"`. |

### `files[]`

```json
{ "src": "data/file.csv", "dest": "/shared/data/file.csv", "target": "shared" }
```

| Field | Required | Description |
|-------|----------|-------------|
| `src` | Yes | Path inside the archive. Trailing `/` means a directory (all contents are included recursively). |
| `dest` | Yes | Destination path in the virtual filesystem. |
| `target` | No | Where to mount: `"shared"` (SharedVFS), `"prolog"` (Prolog VFS), `"all"` (both). Default: `"prolog"` for v1.0 compat. |
| `binary` | No | `true` to preserve as raw bytes (Uint8Array). Auto-detected for `.wasm`, `.png`, `.jpg`, `.gif`, `.bin`, `.dat`, etc. |

### `search_paths[]`

```json
{ "alias": "mylib", "dir": "/shared/lib/prolog/mylib" }
```

Adds a Prolog library search path so `use_module(library(mylib/foo))` resolves to your package's files.

### `wasm_modules[]`

```json
{
  "name": "linalg",
  "file": "wasm/linalg.wasm",
  "exports": ["matrix_multiply", "svd"],
  "ffi": "json",
  "js_wrapper": "wasm/linalg_imports.js"
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Module name, accessible as `window.wasmModules[name]`. |
| `file` | Yes | Path to `.wasm` binary in the archive. |
| `exports` | No | Exported function names (informational). |
| `ffi` | No | `"json"` enables the JSON FFI calling convention. |
| `js_wrapper` | No | JS file that returns an imports object for `WebAssembly.instantiate()`. |

---

## SharedVFS Directory Conventions

The SharedVFS is an in-memory filesystem accessible to all kernels (Python, Bash, Prolog). Files placed under `/shared/` are visible everywhere.

```
/shared/
  lib/            # Libraries
    python/       # Python modules (auto-added to sys.path)
    prolog/       # Prolog source files
    wasm/         # WASM binaries
  bin/            # Executable WASM binaries
  data/           # Shared datasets (CSV, JSON, etc.)
  config/         # Configuration files
/tmp/             # Temporary files (also shared)
```

### How Each Kernel Accesses SharedVFS

| Kernel | Access Method |
|--------|---------------|
| **Bash** | Direct filesystem access. `cat /shared/data/file.csv` just works. |
| **Python** | Via the `sharedfs` module (see below). |
| **Prolog** | Files with `target: "prolog"` are mounted in Prolog's VFS. Shared paths are synced after execution. |

---

## Python `sharedfs` Module

The `sharedfs` module is automatically available in every Python cell. It provides read/write access to the SharedVFS.

### Functions

```python
import sharedfs

# Read / Write text
text = sharedfs.read_text('/shared/data/greeting.txt')
sharedfs.write_text('/shared/data/output.txt', 'Hello from Python')

# Read / Write binary
data = sharedfs.read_bytes('/shared/data/image.png')
sharedfs.write_bytes('/shared/data/copy.png', data)

# Check existence
if sharedfs.exists('/shared/data/greeting.txt'):
    print('File found!')

# List directory contents
entries = sharedfs.listdir('/shared/data')
# Returns: [{'name': 'file.csv', 'size': 123, 'is_dir': False}, ...]

# Create directory
sharedfs.mkdir('/shared/data/subdir')

# Get file metadata
info = sharedfs.stat('/shared/data/file.csv')
# Returns: {'size': 123, 'is_dir': False, 'modified': 1234567890}

# Remove a file
sharedfs.remove('/shared/data/temp.txt')
```

### Cross-Kernel File Sharing

Write in one kernel, read in another:

```python
# Python writes
import sharedfs
sharedfs.write_text('/shared/data/result.csv', 'x,y\n1,2\n3,4')
```

```bash
# Bash reads
cat /shared/data/result.csv
# Output: x,y
#         1,2
#         3,4
```

```bash
# Bash writes
echo "Hello from Bash" > /shared/data/message.txt
```

```python
# Python reads
import sharedfs
print(sharedfs.read_text('/shared/data/message.txt'))
# Output: Hello from Bash
```

### Python Module Imports from Packages

Packages can provide Python modules by placing `.py` files at `/shared/lib/python/`. These are automatically importable:

**In your package:**
```json
{
  "files": [
    { "src": "python/mymodule.py", "dest": "/shared/lib/python/mymodule.py", "target": "shared" }
  ]
}
```

**In a notebook cell:**
```python
import mymodule
mymodule.my_function()
```

---

## Packaging Rust Libraries as WASM

You can compile Rust libraries to WASM and distribute them as SciREPL packages, making them callable from Python and Prolog.

### Step 1: Create a Rust Library

```bash
cargo init --lib my-wasm-lib
cd my-wasm-lib
```

Add to `Cargo.toml`:
```toml
[lib]
crate-type = ["cdylib"]

[profile.release]
opt-level = "s"
lto = true
```

### Step 2: Implement the JSON FFI Convention

The JSON FFI convention uses three exported functions:

- `alloc(len) -> ptr` — allocate `len` bytes, return pointer
- `dealloc(ptr, len)` — free allocated memory
- `call(func_name_ptr, args_json_ptr) -> result_json_ptr` — dispatch a function call

Both input and output strings are null-terminated UTF-8.

**Example `src/lib.rs`:**

```rust
use std::ffi::{CStr, CString};
use std::os::raw::c_char;

#[no_mangle]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    let mut buf = Vec::with_capacity(len);
    let ptr = buf.as_mut_ptr();
    std::mem::forget(buf);
    ptr
}

#[no_mangle]
pub extern "C" fn dealloc(ptr: *mut u8, len: usize) {
    unsafe {
        drop(Vec::from_raw_parts(ptr, 0, len));
    }
}

#[no_mangle]
pub extern "C" fn call(func_ptr: *const c_char, args_ptr: *const c_char) -> *mut c_char {
    let func_name = unsafe { CStr::from_ptr(func_ptr) }.to_str().unwrap_or("");
    let args_json = unsafe { CStr::from_ptr(args_ptr) }.to_str().unwrap_or("{}");

    let result = match func_name {
        "add" => {
            // Parse {"a": N, "b": M} and return {"result": N+M}
            let v: serde_json::Value = serde_json::from_str(args_json).unwrap_or_default();
            let a = v["a"].as_f64().unwrap_or(0.0);
            let b = v["b"].as_f64().unwrap_or(0.0);
            format!(r#"{{"result":{}}}"#, a + b)
        }
        _ => format!(r#"{{"error":"unknown function: {}"}}"#, func_name),
    };

    CString::new(result).unwrap().into_raw()
}
```

Add `serde_json` to dependencies:
```toml
[dependencies]
serde_json = "1"
```

### Step 3: Compile to WASM

```bash
# Install the WASM target if you haven't already
rustup target add wasm32-unknown-unknown

# Build
cargo build --release --target wasm32-unknown-unknown

# The .wasm file is at:
# target/wasm32-unknown-unknown/release/my_wasm_lib.wasm
```

Optionally strip the binary:
```bash
wasm-strip target/wasm32-unknown-unknown/release/my_wasm_lib.wasm
```

### Step 4: Package It

```
my-package/
  scirepl.json
  wasm/my_lib.wasm
  demo.ipynb
```

```json
{
  "format_version": "2.0",
  "name": "My WASM Library",
  "version": "1.0.0",
  "description": "A Rust library compiled to WASM",
  "wasm_modules": [
    {
      "name": "my_lib",
      "file": "wasm/my_lib.wasm",
      "exports": ["add"],
      "ffi": "json"
    }
  ],
  "notebooks": [
    { "file": "demo.ipynb", "name": "Demo" }
  ]
}
```

### Step 5: Call from Python or Prolog

**Python:**
```python
result = wasm_call('my_lib', 'add', {'a': 40, 'b': 2})
print(result)  # {'result': 42}
```

**Prolog:**
```prolog
wasm_call(my_lib, add, '{"a": 40, "b": 2}').
% → {"result": 42}
```

### WASM Modules Without JSON FFI

If your WASM module doesn't follow the JSON FFI convention, omit `"ffi": "json"` from the manifest. The module's raw WebAssembly exports are accessible via `window.wasmModules[name].exports`.

For modules that need a custom imports object (e.g., WASI-like imports), provide a `js_wrapper` file that returns the imports:

```javascript
// my_imports.js — must be a single expression that evaluates to an object
({
  env: {
    log: function(ptr, len) { /* ... */ }
  }
})
```

---

## Exporting Packages

Menu > Export Package creates a `.zip` containing:

- All open notebooks as `.ipynb` files
- Prolog VFS files (with `target: "prolog"`)
- SharedVFS files from `/shared/data/`, `/shared/lib/`, `/shared/config/`, `/shared/bin/` (with `target: "shared"`)
- A v2.0 `scirepl.json` manifest

This means you can build a package entirely within SciREPL:
1. Create notebooks, write code, add data files
2. Export as package
3. Share the `.zip` — anyone can install it

---

## Backward Compatibility

Packages with `format_version: "1.0"` continue to work. Files without a `target` field default to `target: "prolog"`, preserving the original behavior where all files were mounted to the Prolog VFS.

---

## Package Catalog

The built-in catalog (Menu > Browse Packages) lists curated packages with one-click install. Catalog entries include metadata about which kernels a package uses.

To add packages to the catalog, edit `www/js/package_catalog.js`:

```javascript
{
    name: 'My Package',
    description: 'Description here',
    version: 'v1.0.0',
    url: 'https://github.com/user/repo/releases/download/v1.0.0/package.zip',
    size: '~500 KB',
    kernels: ['python', 'prolog'],
}
```

---

## File Reference

| File | Purpose |
|------|---------|
| `www/js/package_loader.js` | Core package loading, manifest parsing, target routing, WASM module loading |
| `www/js/package_catalog.js` | Browse Packages UI and one-click install |
| `www/js/shared_vfs.js` | SharedVFS — in-memory filesystem shared across all kernels |
| `www/js/sharedfs.py` | Python bridge to SharedVFS (`import sharedfs`) |
| `www/js/kernels/python.js` | Python kernel — loads sharedfs, syncs `/shared/lib/python/` |
| `www/js/kernels/prolog.js` | Prolog kernel — SharedVFS sync, `wasm_call/3` |
| `www/js/prelude.py` | Python prelude — `wasm_call()` helper |
| `www/js/file_io.js` | Import/export UI, v2.0 package export |
| `test_pkg_v2.mjs` | Playwright test suite (15 tests) |
