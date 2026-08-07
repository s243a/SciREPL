/**
 * paths.js — where the shell finds its content, in either layout.
 *
 * The shell runs in two quite different shapes and it must not guess which:
 *
 *   development   desktop/electron/main.js sits inside the repository, and the
 *                 prepared application tree is <repo>/www.
 *   packaged      main.js is inside resources/app.asar, so `__dirname` no longer
 *                 has a repository above it. The application tree is shipped
 *                 alongside as resources/www, deliberately OUTSIDE the asar
 *                 archive — `net.fetch(file://…)` in protocol.js reads real
 *                 files and does not go through Electron's asar layer, and the
 *                 kernel runtimes are large enough that packing them would only
 *                 slow startup.
 *
 * Getting this wrong is silent: the window opens and every asset 404s. So the
 * resolvers are pure functions, exported and unit-tested rather than inlined
 * into main.js where they could only be checked by launching the app.
 */

const path = require('path');

/**
 * Resolve the prepared `www/` tree.
 *
 * @param {object} layout
 * @param {boolean} layout.isPackaged   `app.isPackaged`
 * @param {string}  layout.resourcesPath `process.resourcesPath` (packaged only)
 * @param {string}  layout.moduleDir    directory containing main.js
 * @param {object}  [layout.env]        environment, for the SCIREPL_WWW override
 * @returns {string} absolute path
 */
function resolveWwwRoot({ isPackaged, resourcesPath, moduleDir, env = {} }) {
  // An explicit override always wins — the tests use it to point the shell at a
  // fixture tree, and it is the documented way to run against a different build.
  if (env.SCIREPL_WWW) return path.resolve(env.SCIREPL_WWW);

  if (isPackaged) return path.join(resourcesPath, 'www');

  // Development: <repo>/desktop/electron/main.js -> <repo>/www
  return path.join(path.resolve(moduleDir, '..', '..'), 'www');
}

/**
 * Resolve `build-info.json`, written by the packaging script.
 *
 * It exists only in packaged builds. In development the same facts are read
 * from the repository (package.json, kernel_config.js), so a missing file here
 * is normal and must not be treated as an error.
 */
function resolveBuildInfoPath({ isPackaged, resourcesPath, moduleDir }) {
  if (isPackaged) return path.join(resourcesPath, 'build-info.json');
  return path.join(moduleDir, 'build-info.json');
}

/** Repository root — meaningful only in development. */
function resolveRepoRoot({ isPackaged, moduleDir }) {
  return isPackaged ? null : path.resolve(moduleDir, '..', '..');
}

module.exports = { resolveWwwRoot, resolveBuildInfoPath, resolveRepoRoot };
