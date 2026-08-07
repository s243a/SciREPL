/**
 * electron-stub.cjs — minimal stand-in for the `electron` module.
 *
 * policy.unit.test.mjs exercises the shell's pure decision functions
 * (resolveRequestPath, isAllowedExternal, isAppUrl, buildCsp, assertNullary)
 * without launching Electron, so those modules' top-level `require('electron')`
 * needs something with the right shape. Nothing here is ever invoked by the
 * functions under test; any call is a bug in the test, so the members throw
 * loudly rather than silently returning undefined.
 */

function unavailable(name) {
  return new Proxy(function () {}, {
    apply() {
      throw new Error(`electron.${name} was called from a unit test; it is not available outside Electron`);
    },
    get(_t, prop) {
      if (prop === 'then') return undefined; // don't look like a thenable
      throw new Error(`electron.${name}.${String(prop)} was accessed from a unit test`);
    },
  });
}

module.exports = {
  app: unavailable('app'),
  shell: unavailable('shell'),
  protocol: unavailable('protocol'),
  net: unavailable('net'),
  ipcMain: unavailable('ipcMain'),
  session: unavailable('session'),
  BrowserWindow: unavailable('BrowserWindow'),
  contextBridge: unavailable('contextBridge'),
  ipcRenderer: unavailable('ipcRenderer'),
};
