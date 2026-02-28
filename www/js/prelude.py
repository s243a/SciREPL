# prelude.py — Loaded into Pyodide at startup.
# Pre-imports and bridge functions for the Sci REPL.

import numpy as np
import json
import js  # Pyodide's JS interop module

# ---- Convenient math imports at top level ----
from math import e, inf, nan
pi = np.pi

# ---- SymPy (loaded first — its plot will be overridden by ours) ----
_SYMPY_AVAILABLE = False
try:
    from sympy import *
    _SYMPY_AVAILABLE = True
except Exception:
    pass

def _is_sympy(obj):
    if not _SYMPY_AVAILABLE:
        return False
    from sympy import Basic
    return isinstance(obj, Basic)

def _is_sympy_list(obj):
    """Check if obj is a list/tuple of SymPy expressions"""
    if not _SYMPY_AVAILABLE:
        return False
    if not isinstance(obj, (list, tuple)):
        return False
    if len(obj) == 0:
        return False
    from sympy import Basic
    return all(isinstance(item, Basic) for item in obj)

def _sympy_to_latex(obj):
    from sympy import latex as _sl
    return _sl(obj)

def _sympy_list_to_latex(obj):
    """Convert a list/tuple of SymPy expressions to LaTeX"""
    from sympy import latex as _sl
    items = [_sl(item) for item in obj]
    # Render as a LaTeX array
    return r'\begin{bmatrix}' + r' \\ '.join(items) + r'\end{bmatrix}'

# ---- Plotting bridge (defined AFTER SymPy to override its plot) ----

def plot(x, y=None, *, title="", xlabel="", ylabel="",
         label="", type="scatter", mode="lines", **kwargs):
    """Plot data using Plotly.js via the bridge.

    Usage:
        x = np.linspace(0, 2*pi, 100)
        plot(x, np.sin(x), title="Sine wave")
    """
    if y is None:
        y_data = x
        x_data = list(range(len(y_data)))
    else:
        x_data = x
        y_data = y

    if hasattr(x_data, 'tolist'):
        x_data = x_data.tolist()
    if hasattr(y_data, 'tolist'):
        y_data = y_data.tolist()

    payload = {
        "x": x_data,
        "y": y_data,
        "title": title,
        "xlabel": xlabel,
        "ylabel": ylabel,
        "name": label,
        "type": type,
        "mode": mode,
    }
    js.renderPlot(json.dumps(payload))


def mplot(traces, *, title="", xlabel="", ylabel="", layout=None):
    """Plot multiple traces at once."""
    processed = []
    for t in traces:
        trace = dict(t)
        for key in ("x", "y"):
            if key in trace and hasattr(trace[key], 'tolist'):
                trace[key] = trace[key].tolist()
        if "type" not in trace:
            trace["type"] = "scatter"
        if "mode" not in trace:
            trace["mode"] = "lines"
        processed.append(trace)

    payload = {
        "traces": processed,
        "title": title,
        "xlabel": xlabel,
        "ylabel": ylabel,
        "layout": layout or {},
    }
    js.renderPlot(json.dumps(payload))


def table(data, headers=None):
    """Render a table in the output."""
    if hasattr(data, 'tolist'):
        rows = data.tolist()
    elif isinstance(data, list) and len(data) > 0 and not isinstance(data[0], list):
        rows = [data]
    else:
        rows = data

    payload = {"rows": rows}
    if headers is not None:
        payload["headers"] = list(headers)
    js.renderTable(json.dumps(payload))


def latex(expr):
    """Render a LaTeX string in the output."""
    js.renderLatex(str(expr))

# ---- WASM FFI bridge ----

def wasm_call(module_name, func_name, args=None):
    """Call a function in a loaded WASM module via JSON FFI.

    Usage:
        result = wasm_call('linalg', 'matrix_multiply', {'a': [[1,2],[3,4]], 'b': [[5,6],[7,8]]})
    """
    mods = js.window.wasmModules
    if not mods or not hasattr(mods, module_name):
        raise RuntimeError(f"WASM module '{module_name}' not loaded")
    mod = getattr(mods, module_name)
    if not mod.call:
        raise RuntimeError(f"WASM module '{module_name}' does not support JSON FFI")
    from pyodide.ffi import to_js
    result = mod.call(func_name, to_js(args or {}))
    if result is None:
        return None
    # mod.call() returns a parsed JS object (JsProxy); convert to Python dict
    if hasattr(result, 'to_py'):
        return result.to_py()
    return json.loads(json.dumps(result))


# ---- Package installation via micropip ----

import micropip as _micropip

async def pip_install(*packages):
    """Install packages from PyPI using micropip.

    Usage:
        await pip_install('requests')
        await pip_install('requests', 'beautifulsoup4')
    """
    for pkg in packages:
        print(f"Installing {pkg}...")
        try:
            await _micropip.install(pkg)
            print(f"  Installed {pkg}")
        except Exception as e:
            print(f"  Failed to install {pkg}: {e}")


# ---- Matplotlib inline backend ----

def _setup_matplotlib_hook():
    """Monkey-patch plt.show() to render figures as inline PNG images."""
    import matplotlib
    matplotlib.use('agg')
    import matplotlib.pyplot as plt

    def _inline_show(*args, **kwargs):
        import io, base64
        figs = [plt.figure(i) for i in plt.get_fignums()]
        for fig in figs:
            buf = io.BytesIO()
            fig.savefig(buf, format='png', dpi=100, bbox_inches='tight',
                        facecolor='#0d1117', edgecolor='none')
            buf.seek(0)
            data_url = 'data:image/png;base64,' + base64.b64encode(buf.read()).decode()
            js.renderImage(data_url)
            buf.close()
        plt.close('all')

    plt.show = _inline_show


print("✓ Sci REPL ready" + (" (with SymPy)" if _SYMPY_AVAILABLE else " (NumPy only)"))
