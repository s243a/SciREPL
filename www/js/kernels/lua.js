/**
 * kernels/lua.js — Lua kernel using Fengari (pure JS Lua VM).
 * Loads fengari-web from CDN (~200KB), provides persistent Lua state.
 */

class LuaKernel {
    constructor() {
        this._ready = false;
        this._L = null;
        this._lua = null;
        this._lauxlib = null;
    }

    static displayName = 'Lua';

    async init() {
        if (this._ready) return;

        // Load fengari-web from CDN if not already present
        if (!window.fengari) {
            const km = window.kernelManager;
            if (km) {
                km.updateProgress('Downloading Fengari Lua runtime…');
            }
            const primary = 'https://cdn.jsdelivr.net/npm/fengari-web@0.1.4/dist/fengari-web.js';
            if (km && km.loadKernelSource) {
                await km.loadKernelSource('lua', primary, (url) => km._loadScript(url));
            } else {
                await new Promise((resolve, reject) => {
                    const script = document.createElement('script');
                    script.src = primary;
                    script.onload = resolve;
                    script.onerror = () => reject(new Error('Failed to load Fengari from CDN'));
                    document.head.appendChild(script);
                });
            }
        }

        if (window.kernelManager) {
            window.kernelManager.updateProgress('Initializing Lua…');
        }

        const f = window.fengari;
        this._lua = f.lua;
        this._lauxlib = f.lauxlib;
        this._lualib = f.lualib;
        this._fengari = f;

        // Create a fresh Lua state
        this._L = this._lauxlib.luaL_newstate();
        this._lualib.luaL_openlibs(this._L);

        // Override print() to capture output
        this._installPrint();

        // Install nb table for NotebookVFS access
        this._installNotebookVFS();

        // Install sharedfs table for SharedVFS access
        this._installSharedVFS();

        // Override io.lines()/io.open() to support SharedVFS paths
        this._installIOOverrides();

        // Stub out CLI functions that don't work in browser
        const stubCode = `
            os.exit = function() end
            arg = arg or {}
            io.stderr = io.stderr or { write = function(self, ...) end }
        `;
        this._lauxlib.luaL_dostring(this._L, this._fengari.to_luastring(stubCode));

        this._ready = true;

        if (window.kernelManager) {
            window.kernelManager.hideDownloadModal();
        }
    }

    /**
     * Install a custom print() that writes to this._output.
     */
    _installPrint() {
        const L = this._L;
        const lua = this._lua;
        const lauxlib = this._lauxlib;
        const f = this._fengari;
        const self = this;

        lua.lua_pushjsfunction(L, function(L) {
            const nargs = lua.lua_gettop(L);
            const parts = [];
            for (let i = 1; i <= nargs; i++) {
                lauxlib.luaL_tolstring(L, i);
                parts.push(f.to_jsstring(lua.lua_tostring(L, -1)));
                lua.lua_pop(L, 1);
            }
            self._output += parts.join('\t') + '\n';
            return 0;
        });
        lua.lua_setglobal(L, f.to_luastring('print'));

        // Provide io.write (Fengari may not have the io library)
        lua.lua_getglobal(L, f.to_luastring('io'));
        if (lua.lua_type(L, -1) !== lua.LUA_TTABLE) {
            lua.lua_pop(L, 1);
            lua.lua_newtable(L);
            lua.lua_setglobal(L, f.to_luastring('io'));
            lua.lua_getglobal(L, f.to_luastring('io'));
        }
        lua.lua_pushjsfunction(L, function(L) {
            const nargs = lua.lua_gettop(L);
            for (let i = 1; i <= nargs; i++) {
                lauxlib.luaL_tolstring(L, i);
                self._output += f.to_jsstring(lua.lua_tostring(L, -1));
                lua.lua_pop(L, 1);
            }
            return 0;
        });
        lua.lua_setfield(L, -2, f.to_luastring('write'));
        lua.lua_pop(L, 1);
    }

    /**
     * Install the nb table for NotebookVFS access.
     * nb.read(cell, prop), nb.write(cell, prop, value), nb.list()
     */
    _installNotebookVFS() {
        const L = this._L;
        const lua = this._lua;
        const f = this._fengari;

        lua.lua_newtable(L);

        // nb.read(cell, prop) → string
        lua.lua_pushjsfunction(L, function(L) {
            const nbvfs = window.notebookVFS;
            if (!nbvfs) { lua.lua_pushnil(L); return 1; }
            const cell = f.to_jsstring(lua.lua_tostring(L, 1));
            const prop = lua.lua_gettop(L) >= 2 ? f.to_jsstring(lua.lua_tostring(L, 2)) : null;
            const path = prop ? `/nb/${cell}/${prop}` : `/nb/${cell}`;
            const result = nbvfs.readFile(path);
            if (result === null) { lua.lua_pushnil(L); return 1; }
            lua.lua_pushstring(L, f.to_luastring(String(result)));
            return 1;
        });
        lua.lua_setfield(L, -2, f.to_luastring('read'));

        // nb.write(cell, prop, value) → boolean
        lua.lua_pushjsfunction(L, function(L) {
            const nbvfs = window.notebookVFS;
            if (!nbvfs) { lua.lua_pushboolean(L, false); return 1; }
            const cell = f.to_jsstring(lua.lua_tostring(L, 1));
            const prop = f.to_jsstring(lua.lua_tostring(L, 2));
            const value = f.to_jsstring(lua.lua_tostring(L, 3));
            const path = `/nb/${cell}/${prop}`;
            const ok = nbvfs.writeFile(path, value);
            lua.lua_pushboolean(L, !!ok);
            return 1;
        });
        lua.lua_setfield(L, -2, f.to_luastring('write'));

        // nb.list() → JSON string of cells
        lua.lua_pushjsfunction(L, function(L) {
            const nbvfs = window.notebookVFS;
            if (!nbvfs) { lua.lua_pushnil(L); return 1; }
            const result = nbvfs.readFile('/nb');
            lua.lua_pushstring(L, f.to_luastring(String(result)));
            return 1;
        });
        lua.lua_setfield(L, -2, f.to_luastring('list'));

        // nb.name(cell, new_name) — set cell name (shorthand)
        lua.lua_pushjsfunction(L, function(L) {
            const nbvfs = window.notebookVFS;
            if (!nbvfs) { lua.lua_pushboolean(L, false); return 1; }
            const cell = f.to_jsstring(lua.lua_tostring(L, 1));
            const name = f.to_jsstring(lua.lua_tostring(L, 2));
            const ok = nbvfs.writeFile(`/nb/${cell}/.name`, name);
            lua.lua_pushboolean(L, !!ok);
            return 1;
        });
        lua.lua_setfield(L, -2, f.to_luastring('name'));

        lua.lua_setglobal(L, f.to_luastring('nb'));
    }

    /**
     * Install the sharedfs table for SharedVFS access.
     * sharedfs.read(path), sharedfs.write(path, content), sharedfs.exists(path),
     * sharedfs.list(path), sharedfs.mkdir(path), sharedfs.remove(path)
     */
    _installSharedVFS() {
        const L = this._L;
        const lua = this._lua;
        const f = this._fengari;

        lua.lua_newtable(L);

        // sharedfs.read(path) → string or nil
        lua.lua_pushjsfunction(L, function(L) {
            const vfs = window.sharedVFS;
            if (!vfs) { lua.lua_pushnil(L); return 1; }
            const path = f.to_jsstring(lua.lua_tostring(L, 1));
            const result = vfs.readFile(path, 'utf8');
            if (result === null || result === undefined) {
                lua.lua_pushnil(L);
            } else {
                lua.lua_pushstring(L, f.to_luastring(String(result)));
            }
            return 1;
        });
        lua.lua_setfield(L, -2, f.to_luastring('read'));

        // sharedfs.write(path, content) → boolean
        lua.lua_pushjsfunction(L, function(L) {
            const vfs = window.sharedVFS;
            if (!vfs) { lua.lua_pushboolean(L, false); return 1; }
            const path = f.to_jsstring(lua.lua_tostring(L, 1));
            const content = f.to_jsstring(lua.lua_tostring(L, 2));
            try {
                vfs.writeFile(path, content, 'lua');
                lua.lua_pushboolean(L, true);
            } catch (e) {
                lua.lua_pushboolean(L, false);
            }
            return 1;
        });
        lua.lua_setfield(L, -2, f.to_luastring('write'));

        // sharedfs.exists(path) → boolean
        lua.lua_pushjsfunction(L, function(L) {
            const vfs = window.sharedVFS;
            if (!vfs) { lua.lua_pushboolean(L, false); return 1; }
            const path = f.to_jsstring(lua.lua_tostring(L, 1));
            lua.lua_pushboolean(L, !!vfs.exists(path));
            return 1;
        });
        lua.lua_setfield(L, -2, f.to_luastring('exists'));

        // sharedfs.list(path) → JSON string of entries
        lua.lua_pushjsfunction(L, function(L) {
            const vfs = window.sharedVFS;
            if (!vfs) { lua.lua_pushnil(L); return 1; }
            const path = lua.lua_gettop(L) >= 1
                ? f.to_jsstring(lua.lua_tostring(L, 1))
                : '/shared';
            const result = vfs.vfs_list_dir(path);
            if (result === null || result === undefined) {
                lua.lua_pushnil(L);
            } else {
                lua.lua_pushstring(L, f.to_luastring(String(result)));
            }
            return 1;
        });
        lua.lua_setfield(L, -2, f.to_luastring('list'));

        // sharedfs.mkdir(path) → boolean
        lua.lua_pushjsfunction(L, function(L) {
            const vfs = window.sharedVFS;
            if (!vfs) { lua.lua_pushboolean(L, false); return 1; }
            const path = f.to_jsstring(lua.lua_tostring(L, 1));
            try {
                vfs.mkdir(path);
                lua.lua_pushboolean(L, true);
            } catch (e) {
                lua.lua_pushboolean(L, false);
            }
            return 1;
        });
        lua.lua_setfield(L, -2, f.to_luastring('mkdir'));

        // sharedfs.remove(path) → boolean
        lua.lua_pushjsfunction(L, function(L) {
            const vfs = window.sharedVFS;
            if (!vfs) { lua.lua_pushboolean(L, false); return 1; }
            const path = f.to_jsstring(lua.lua_tostring(L, 1));
            try {
                const ok = vfs.vfs_remove(path);
                lua.lua_pushboolean(L, !!ok);
            } catch (e) {
                lua.lua_pushboolean(L, false);
            }
            return 1;
        });
        lua.lua_setfield(L, -2, f.to_luastring('remove'));

        lua.lua_setglobal(L, f.to_luastring('sharedfs'));
    }

    /**
     * Override io.lines() and io.open() to support SharedVFS paths.
     * Paths starting with /shared/, /tmp/, /nb/, /education/ are routed
     * through SharedVFS instead of the (non-existent) local filesystem.
     */
    _installIOOverrides() {
        const L = this._L;
        const lua = this._lua;
        const lauxlib = this._lauxlib;
        const f = this._fengari;

        // Ensure io table exists
        lua.lua_getglobal(L, f.to_luastring('io'));
        if (lua.lua_type(L, -1) !== lua.LUA_TTABLE) {
            lua.lua_pop(L, 1);
            lua.lua_newtable(L);
            lua.lua_setglobal(L, f.to_luastring('io'));
            lua.lua_getglobal(L, f.to_luastring('io'));
        }

        const vfsPrefixes = ['/shared/', '/tmp/', '/nb/', '/education/'];

        // io.lines(path) → iterator over lines from SharedVFS
        lua.lua_pushjsfunction(L, function(L) {
            if (lua.lua_gettop(L) < 1 || lua.lua_type(L, 1) !== lua.LUA_TSTRING) {
                return lauxlib.luaL_error(L, f.to_luastring('io.lines: path argument required'));
            }
            const path = f.to_jsstring(lua.lua_tostring(L, 1));
            const isVfs = vfsPrefixes.some(p => path.startsWith(p));
            if (!isVfs) {
                return lauxlib.luaL_error(L, f.to_luastring('io.lines: only SharedVFS paths supported (/shared/, /tmp/, /nb/, /education/)'));
            }
            const vfs = window.sharedVFS;
            if (!vfs) {
                return lauxlib.luaL_error(L, f.to_luastring('io.lines: SharedVFS not available'));
            }
            const content = vfs.readFile(path, 'utf8');
            if (content === null || content === undefined) {
                return lauxlib.luaL_error(L, f.to_luastring(`io.lines: file not found: ${path}`));
            }
            const lines = String(content).split('\n');
            let idx = 0;
            // Push iterator function
            lua.lua_pushjsfunction(L, function(L) {
                if (idx >= lines.length) {
                    lua.lua_pushnil(L);
                    return 1;
                }
                lua.lua_pushstring(L, f.to_luastring(lines[idx]));
                idx++;
                return 1;
            });
            return 1;
        });
        lua.lua_setfield(L, -2, f.to_luastring('lines'));

        // io.open(path, mode) → file handle table (simplified)
        lua.lua_pushjsfunction(L, function(L) {
            if (lua.lua_gettop(L) < 1 || lua.lua_type(L, 1) !== lua.LUA_TSTRING) {
                lua.lua_pushnil(L);
                lua.lua_pushstring(L, f.to_luastring('io.open: path required'));
                return 2;
            }
            const path = f.to_jsstring(lua.lua_tostring(L, 1));
            const mode = lua.lua_gettop(L) >= 2
                ? f.to_jsstring(lua.lua_tostring(L, 2))
                : 'r';
            const isVfs = vfsPrefixes.some(p => path.startsWith(p));
            if (!isVfs) {
                lua.lua_pushnil(L);
                lua.lua_pushstring(L, f.to_luastring('io.open: only SharedVFS paths supported'));
                return 2;
            }
            const vfs = window.sharedVFS;
            if (!vfs) {
                lua.lua_pushnil(L);
                lua.lua_pushstring(L, f.to_luastring('io.open: SharedVFS not available'));
                return 2;
            }

            if (mode.startsWith('r')) {
                const content = vfs.readFile(path, 'utf8');
                if (content === null || content === undefined) {
                    lua.lua_pushnil(L);
                    lua.lua_pushstring(L, f.to_luastring(`No such file: ${path}`));
                    return 2;
                }
                const lines = String(content).split('\n');
                let lineIdx = 0;

                // Return a file handle table with read() and lines() and close()
                lua.lua_newtable(L);

                lua.lua_pushjsfunction(L, function(L) {
                    if (lineIdx >= lines.length) { lua.lua_pushnil(L); return 1; }
                    lua.lua_pushstring(L, f.to_luastring(lines[lineIdx]));
                    lineIdx++;
                    return 1;
                });
                lua.lua_setfield(L, -2, f.to_luastring('read'));

                lua.lua_pushjsfunction(L, function(L) {
                    let lIdx = 0;
                    lua.lua_pushjsfunction(L, function(L) {
                        if (lIdx >= lines.length) { lua.lua_pushnil(L); return 1; }
                        lua.lua_pushstring(L, f.to_luastring(lines[lIdx]));
                        lIdx++;
                        return 1;
                    });
                    return 1;
                });
                lua.lua_setfield(L, -2, f.to_luastring('lines'));

                lua.lua_pushjsfunction(L, function() { return 0; });
                lua.lua_setfield(L, -2, f.to_luastring('close'));

                return 1;
            } else if (mode.startsWith('w')) {
                // Write mode: collect writes, flush on close
                const chunks = [];

                lua.lua_newtable(L);

                lua.lua_pushjsfunction(L, function(L) {
                    const text = f.to_jsstring(lua.lua_tostring(L, 1));
                    chunks.push(text);
                    return 0;
                });
                lua.lua_setfield(L, -2, f.to_luastring('write'));

                lua.lua_pushjsfunction(L, function() {
                    vfs.writeFile(path, chunks.join(''), 'lua');
                    return 0;
                });
                lua.lua_setfield(L, -2, f.to_luastring('close'));

                return 1;
            }

            lua.lua_pushnil(L);
            lua.lua_pushstring(L, f.to_luastring(`io.open: unsupported mode: ${mode}`));
            return 2;
        });
        lua.lua_setfield(L, -2, f.to_luastring('open'));

        lua.lua_pop(L, 1); // pop io table
    }

    isReady() {
        return this._ready;
    }

    getName() {
        return 'Lua (Fengari)';
    }

    getLanguage() {
        return 'lua';
    }

    async execute(code) {
        if (!this._ready) {
            throw new Error('Lua kernel not initialized');
        }

        const trimmed = code.trim();
        if (!trimmed) {
            return { stdout: '', result: null, error: null };
        }

        const L = this._L;
        const lua = this._lua;
        const lauxlib = this._lauxlib;
        const f = this._fengari;

        this._output = '';

        // Try as "return <expr>" first for auto-display (like Lua REPL)
        let hasReturn = false;
        const returnCode = f.to_luastring('return ' + trimmed);
        if (lauxlib.luaL_loadstring(L, returnCode) === 0) {
            hasReturn = true;
        } else {
            lua.lua_pop(L, 1); // pop error from failed load
        }

        if (!hasReturn) {
            // Load as statement block
            const stmtCode = f.to_luastring(trimmed);
            if (lauxlib.luaL_loadstring(L, stmtCode) !== 0) {
                const err = f.to_jsstring(lua.lua_tostring(L, -1));
                lua.lua_pop(L, 1);
                return { stdout: this._output, result: null, error: err };
            }
        }

        // Execute: 0 args, LUA_MULTRET (-1) results
        const LUA_MULTRET = lua.LUA_MULTRET !== undefined ? lua.LUA_MULTRET : -1;
        if (lua.lua_pcall(L, 0, LUA_MULTRET, 0) !== 0) {
            const err = f.to_jsstring(lua.lua_tostring(L, -1));
            lua.lua_pop(L, 1);
            return { stdout: this._output, result: null, error: err };
        }

        // Collect return values from stack
        const nresults = lua.lua_gettop(L);
        let formattedResult = null;

        if (hasReturn && nresults > 0) {
            const parts = [];
            for (let i = 1; i <= nresults; i++) {
                parts.push(this._stackValueToString(i));
            }
            lua.lua_settop(L, 0); // clear stack
            const text = parts.join('\t');
            if (text !== 'nil' || nresults > 1) {
                formattedResult = { type: 'text', content: text };
            }
        } else {
            lua.lua_settop(L, 0);
        }

        return { stdout: this._output, result: formattedResult, error: null };
    }

    /**
     * Convert a Lua stack value at index to a JS string for display.
     */
    _stackValueToString(idx) {
        const L = this._L;
        const lua = this._lua;
        const lauxlib = this._lauxlib;
        const f = this._fengari;

        const t = lua.lua_type(L, idx);
        switch (t) {
            case lua.LUA_TNIL:
                return 'nil';
            case lua.LUA_TBOOLEAN:
                return lua.lua_toboolean(L, idx) ? 'true' : 'false';
            case lua.LUA_TNUMBER:
                return String(lua.lua_tonumberx(L, idx));
            case lua.LUA_TSTRING:
                return f.to_jsstring(lua.lua_tostring(L, idx));
            default: {
                // Use tostring() for tables, functions, userdata, etc.
                lauxlib.luaL_tolstring(L, idx);
                const s = f.to_jsstring(lua.lua_tostring(L, -1));
                lua.lua_pop(L, 1);
                return s;
            }
        }
    }

    getMemoryUsage() {
        return 0; // Fengari uses JS heap, no separate WASM allocation
    }

    destroy() {
        // Don't call lua_close — fengari states are GC'd by JS
        this._L = null;
        this._lua = null;
        this._lauxlib = null;
        this._lualib = null;
        this._fengari = null;
        this._ready = false;
    }
}

// Register with kernel manager
if (window.kernelManager) {
    window.kernelManager.register('lua', LuaKernel);
}
