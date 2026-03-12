# Proposal: Notebook Virtual Filesystem (`/nb/`)

## Motivation

SciREPL already has a SharedVFS (`/shared/`) for cross-kernel file exchange. But sharing data between cells currently requires writing to an intermediate file. The notebook itself — its cells, their code, output, and metadata — is structured data sitting in localStorage as JSON, yet it's invisible to kernels.

This proposal introduces a **Notebook VFS** that mounts the current notebook as a filesystem at `/nb/`, letting any kernel read from and write to cells directly. Combined with named cells and relative addressing, this creates a Unix-like interface over the notebook structure — similar to how `/proc/` exposes kernel data in Linux.

## Design

### Cell as a directory

Each cell appears as a directory under `/nb/`. The directory is identified by its `In[N]` label (matching the UI) or by a user-assigned **name**. Dot-prefixed entries expose cell properties, following Unix hidden-file convention while also mimicking object-oriented property access:

```
/nb/
├── In[1]/              # first cell (unnamed)
│   ├── .code           # source code (read/write)
│   ├── .output         # last execution result (read-only initially)
│   ├── .language       # python, lua, bash, etc.
│   ├── .type           # code | markdown
│   └── .name           # empty string (unnamed)
├── In[2]/
│   └── ...
├── raw_data/           # named cell (alias for In[3])
│   ├── .code
│   ├── .output
│   ├── .language
│   ├── .type
│   └── .name           # "raw_data"
└── In[4]/
    └── ...
```

**Bare path** (no dot-property): returns a **cell object reference** — a handle that kernels can use programmatically rather than just reading text.

### Addressing schemes

| Path | Meaning |
|------|---------|
| `/nb/In[3]/.code` | Cell 3's source code |
| `/nb/raw_data/.output` | Named cell "raw_data"'s output |
| `/nb/./.code` | Current cell's code (self-reference) |
| `/nb/./+1/.language` | Next cell's language |
| `/nb/./-2/.output` | Output of the cell 2 above |
| `/nb/` | List all cells (like `ls`) |
| `/nb/In[3]` | Cell 3 object reference |

### The `cd` convention

Kernels that support a working directory concept (Bash, potentially others) can `cd` into a cell:

```bash
cd /nb/raw_data
cat .code           # reads raw_data's code
cat .output         # reads raw_data's output
cat .language       # → "python"

cd /nb/.            # cd to current cell
cat ../+1/.code     # next cell's code (relative)

cd /nb/In[1]
cat .code           # first cell's code
```

When inside `/nb/<cell>/`, `.` refers to that cell, and relative addressing (`+N`, `-N`) is relative to it.

### Named cells

Users can name cells via:
1. **UI** — a small editable label above each cell (click to set/edit name)
2. **Filesystem** — `echo "my_name" > /nb/In[3]/.name`
3. **API** — `window._cells[2].name = "my_name"` (from JS kernel or internal code)

Constraints:
- Names must be unique within a notebook
- Names must be valid path components (no `/`, no `.` prefix, no `In[N]` pattern)
- Named cells are addressable by both name and `In[N]` index
- The `.name` property returns the name if set, empty string otherwise

### `.output` semantics

`.output` is not always plain text. It represents the cell's last execution result and can be:

| Type | `.output` returns |
|------|-------------------|
| Text (print/stdout) | Plain text string |
| Expression result | String representation |
| Plotly chart | JSON (plot spec) |
| Image | Binary data or data URL |
| Table/DataFrame | CSV or JSON |
| Application reference | URI or object descriptor (future) |

Reading `.output` returns the text/string form by default. Future extensions could support typed access (e.g., `.output.json`, `.output.png`).

### Read/write semantics

| Property | Read | Write |
|----------|------|-------|
| `.code` | Returns source code as text | Replaces cell's source code |
| `.output` | Returns last execution output | Read-only (set by execution) |
| `.language` | Returns language string | Changes cell's language |
| `.type` | Returns "code" or "markdown" | Changes cell type |
| `.name` | Returns name or "" | Sets cell name |

Writing to `.code` updates the cell in the notebook but does **not** auto-execute. The user or a script must explicitly run the cell.

### Creating and deleting cells

```bash
# Create a new cell at the end
mkdir /nb/new_cell_name
echo "python" > /nb/new_cell_name/.language
echo "print('hello')" > /nb/new_cell_name/.code

# Insert after a specific cell (future)
mkdir /nb/In[3]/+1/new_cell

# Delete a cell
rm -r /nb/In[5]
```

## Unified filesystem tree

The Notebook VFS fits into the broader SciREPL filesystem:

```
/                         # root
├── shared/               # SharedVFS (cross-kernel files)
│   ├── data/
│   ├── lib/
│   ├── notebooks/        # auto-synced .srwb files
│   └── ...
├── nb/                   # current notebook cells (this proposal)
│   ├── In[1]/
│   ├── In[2]/
│   └── ...
├── workbook/             # all notebooks (future)
│   ├── Notebook 1/
│   │   ├── In[1]/
│   │   └── ...
│   └── Physics Notes/
│       └── ...
├── local/                # localStorage / IndexedDB (future)
│   └── ...
└── tmp/                  # temporary files
```

The key insight: **workbooks are JSON in localStorage**. The `/nb/` mount is a structured view over that JSON, and `/local/` would expose the raw storage. This is analogous to how Linux exposes kernel internals via `/proc/` and `/sys/`.

## Implementation plan

### Phase 1: Core mount + Bash integration
1. **NotebookVFS class** (`www/js/notebook_vfs.js`)
   - Implements `readFile(path)`, `writeFile(path, content)`, `listDir(path)`, `stat(path)`
   - Resolves addressing: `In[N]`, named cells, relative (`./+1`)
   - Registered as a mount point in SharedVFS or as a parallel VFS
2. **Cell name property** — add `name` field to cell objects, persist in session/notebook JSON
3. **Cell name UI** — small editable label above each cell
4. **Bash kernel bridge** — intercept `/nb/` paths in brush-wasm, delegate to NotebookVFS

### Phase 2: Cross-kernel support
5. **Python bridge** — expose `/nb/` paths via `open()` override or helper functions
6. **Lua bridge** — expose via `io.open()` or helper table
7. **R bridge** — `nb_read()` / `nb_write()` helpers
8. **Prolog bridge** — `nb_read/2`, `nb_write/2` predicates, or consult from `/nb/` paths

### Phase 3: Extended features
9. **Cell object references** — bare path returns a handle usable in JS/Python
10. **Typed output access** — `.output.json`, `.output.csv`, `.output.png`
11. **`/workbook/` mount** — cross-notebook cell access
12. **`/local/` mount** — raw localStorage/IndexedDB access
13. **Cell creation/deletion** via `mkdir`/`rm`
14. **Watch/subscribe** — notify when a cell's output changes (reactive pipelines)

## Relationship to existing systems

- **SharedVFS** already syncs notebooks to `/shared/notebooks/` as `.srwb` files. The `/nb/` mount provides live, cell-level access rather than whole-notebook file snapshots.
- **Session persistence** stores cells in localStorage/IndexedDB. The `/nb/` mount reads from `window._cells` (in-memory), so it's always current.
- **Cell IDs** are currently numeric counters (`window._cellCounter`). The `In[N]` label maps to the cell's display position (1-indexed), not its internal ID, to match what users see in the UI.

## Resolved design decisions

1. **`In[N]` numbering** — `N` is the cell's **display position** (1-indexed). This matches the UI and is intuitive for interactive use. For stable references, use **named cells**. An `id[key]` scheme using internal IDs could be added later but is not needed in Phase 1 since named cells solve the stability problem.
2. **Output capture** — Output currently goes to DOM cards. We will also capture it as structured data in the cell object so `.output` reads work programmatically.
3. **Concurrency** — Writes are synchronous and take effect immediately in the data model; UI updates batch.
4. **Security** — Controlled via settings. See Security section below.
5. **Cross-notebook access** — Supported via `/workbook/` mount. UI refreshes on notebook switch to reflect any changes made by other notebooks.

## Security

Cell access to the Notebook VFS is governed by settings (Menu → Settings or a dedicated Notebook VFS section):

| Setting | Default | Description |
|---------|---------|-------------|
| **Cross-notebook read** | off | Allow cells to read from other notebooks via `/workbook/` |
| **Cross-notebook write** | off | Allow cells to modify cells in other notebooks |
| **Programmatic execution** | off | Allow cells to trigger execution of other cells (e.g., writing to `.run` or calling an execute API) |
| **Same-notebook write** | on | Allow cells to modify other cells' `.code` in the current notebook |
| **Allow JavaScript** | on | Enable the JavaScript kernel. When disabled, JS cells cannot run. See note below. |

**JavaScript and the security boundary:** The JS kernel runs in the same context as the app, so it inherently has full access to `window._cells`, `window.notebookManager`, etc. The VFS security layer is enforced at the **NotebookVFS bridge** level — it cannot prevent a JS cell from bypassing the VFS and accessing internals directly. For this reason, the **Allow JavaScript** toggle lets users disable JS entirely when running untrusted workbooks. Sandboxed kernels (Python/Pyodide, Lua/Fengari, R/webR) go through bridges where enforcement is possible.

**Future: Sandboxed JavaScript kernel.** A restricted JS variant could run inside a Web Worker or sandboxed iframe, communicating with the app only through a message-passing bridge (like the other kernels). This would allow JS execution under the same security model. The sandboxed variant would:
- Have no access to `window`, `document`, or app internals
- Access `/nb/` and `/shared/` only through the VFS bridge (subject to security settings)
- Trade off DOM access and direct Plotly calls for security parity with other kernels
- Coexist with the full JS kernel as a separate language option (e.g., "JavaScript (sandboxed)")
