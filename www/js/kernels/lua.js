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
            if (window.kernelManager) {
                window.kernelManager.updateProgress('Downloading Fengari Lua runtime…');
            }
            await new Promise((resolve, reject) => {
                const script = document.createElement('script');
                script.src = 'https://cdn.jsdelivr.net/npm/fengari-web@0.1.4/dist/fengari-web.js';
                script.onload = resolve;
                script.onerror = () => reject(new Error('Failed to load Fengari from CDN'));
                document.head.appendChild(script);
            });
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
