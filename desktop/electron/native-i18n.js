/**
 * native-i18n.js — host-owned localization for Electron-native UI.
 *
 * The renderer's catalogue is useful input, but it is not a trust boundary:
 * notebook code runs in the renderer realm and can call the small preload API.
 * Consequently the renderer sends only a locale identifier. The main process
 * reads the matching catalogue from the packaged www/i18n directory, selects a
 * fixed allowlist of plain-text keys, and falls back to English for anything
 * missing or malformed. No translated HTML, path, template, or arbitrary
 * renderer-supplied string crosses into Electron's Menu or dialog APIs.
 */

const fs = require('fs');
const path = require('path');

const BASE_LOCALE = 'en';
const RTL_LOCALES = new Set(['ar']);
const LRI = '\u2066';
const RLI = '\u2067';
const PDI = '\u2069';

// Keep this explicit. A renderer value must never become part of a filesystem
// path merely because a similarly named JSON file happens to exist.
const SUPPORTED_LOCALES = Object.freeze([
  'ar', 'bn', 'de', 'en', 'es', 'fr', 'hi', 'id', 'ja', 'ko', 'pt-BR', 'ru', 'zh',
]);

/**
 * Trusted fallbacks and the canonical key list. These English strings also
 * document the intended meaning for translators. The normal source is the
 * bundled catalogue; keeping fallbacks here means a damaged catalogue cannot
 * leave the native recovery/cache menu blank.
 */
const ENGLISH = Object.freeze({
  'electron.menu.file': 'File',
  'electron.menu.reload': 'Reload',
  'electron.menu.forceReload': 'Force Reload',
  'electron.menu.quit': 'Quit',
  'electron.menu.edit': 'Edit',
  'electron.menu.undo': 'Undo',
  'electron.menu.redo': 'Redo',
  'electron.menu.cut': 'Cut',
  'electron.menu.copy': 'Copy',
  'electron.menu.paste': 'Paste',
  'electron.menu.selectAll': 'Select All',
  'electron.menu.view': 'View',
  'electron.menu.resetZoom': 'Actual Size',
  'electron.menu.zoomIn': 'Zoom In',
  'electron.menu.zoomOut': 'Zoom Out',
  'electron.menu.toggleFullscreen': 'Toggle Full Screen',
  'electron.menu.toggleDevTools': 'Toggle Developer Tools',
  'electron.menu.runtimes': 'Runtimes',
  'electron.menu.downloadedRuntimes': 'Downloaded runtimes…',
  'electron.menu.clearDownloadedRuntimes': 'Clear downloaded runtimes…',
  'electron.menu.openAppData': 'Open application data folder',
  'electron.menu.help': 'Help',
  'electron.menu.about': 'About SciREPL',
  'electron.menu.github': 'SciREPL on GitHub',
  'electron.cache.infoTitle': 'Downloaded runtimes',
  'electron.cache.disabled': 'The runtime cache is disabled.',
  'electron.cache.disabledDetail': 'SCIREPL_RUNTIME_CACHE=0 is set, so downloaded runtimes are not kept in the application data directory.',
  'electron.cache.empty': 'No runtimes have been downloaded yet.',
  'electron.cache.summary': 'Downloaded size: {bytes}. Cached files: {entries}.',
  'electron.cache.locationDetail': 'Language runtimes fetched from the internet (Lua, R) are kept here so they keep working offline.',
  'electron.cache.clearTitle': 'Clear downloaded runtimes',
  'electron.cache.nothingToClear': 'There is nothing to clear.',
  'electron.cache.cancel': 'Cancel',
  'electron.cache.clear': 'Clear',
  'electron.cache.confirm': 'Delete {bytes} of downloaded runtimes?',
  'electron.cache.confirmDetail': 'Lua and R will need to be downloaded again the next time you use them, which requires an internet connection.\n\nYour notebooks and files are not affected.',
  'electron.cache.cleared': 'Cleared {bytes}.',
  'electron.cache.clearedDetail': 'Runtimes already loaded stay available until you restart.',
  'electron.about.title': 'About SciREPL',
  'electron.about.version': 'Version',
  'electron.about.buildProfile': 'Build profile',
  'electron.about.channel': 'Channel',
  'electron.about.commit': 'Commit',
});

const NATIVE_KEYS = Object.freeze(Object.keys(ENGLISH));
const KEY_SET = new Set(NATIVE_KEYS);
const LOCALE_SET = new Set(SUPPORTED_LOCALES);
const REQUIRED_LITERALS = Object.freeze({
  'electron.menu.about': ['SciREPL'],
  'electron.menu.github': ['SciREPL', 'GitHub'],
  'electron.cache.disabledDetail': ['SCIREPL_RUNTIME_CACHE=0'],
  'electron.cache.locationDetail': ['Lua', 'R'],
  'electron.cache.confirmDetail': ['Lua', 'R'],
  'electron.about.title': ['SciREPL'],
});

/** Only accept non-empty, plain strings for native labels and dialog text. */
function isSafeNativeString(value) {
  return typeof value === 'string'
    && value.trim().length > 0
    && !/[<>]/.test(value)
    && !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value);
}

function placeholders(value) {
  return [...String(value).matchAll(/\{([A-Za-z][A-Za-z0-9]*)\}/g)]
    .map((m) => m[1]).sort();
}

function hasExpectedPlaceholders(key, value) {
  return JSON.stringify(placeholders(value)) === JSON.stringify(placeholders(ENGLISH[key]));
}

function hasRequiredLiterals(key, value) {
  return (REQUIRED_LITERALS[key] || []).every((literal) => String(value).includes(literal));
}

/** Read only allowlisted plain-text keys from one fixed, bundled catalogue. */
function loadNativeCatalogue(catalogDir, locale) {
  if (!LOCALE_SET.has(locale)) throw new RangeError(`Unsupported SciREPL locale: ${locale}`);
  let data;
  try {
    data = JSON.parse(fs.readFileSync(path.join(catalogDir, `${locale}.json`), 'utf8'));
  } catch {
    return Object.freeze({});
  }

  const strings = data && data.strings && typeof data.strings === 'object'
    ? data.strings : {};
  const selected = {};
  for (const key of NATIVE_KEYS) {
    const value = strings[key];
    if (isSafeNativeString(value)
        && hasExpectedPlaceholders(key, value)
        && hasRequiredLiterals(key, value)) {
      selected[key] = value;
    }
  }
  return Object.freeze(selected);
}

/** Strict interpolation: unknown placeholders stay visible instead of vanishing. */
function interpolate(template, values = {}) {
  return String(template).replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (match, name) =>
    Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : match);
}

// Native dialogs do not inherit document.dir. Isolate Latin identifiers in an
// RTL translation, and isolate a whole fallback/literal so an English phrase
// cannot render with its word order reversed inside an Arabic dialog.
const LATIN_RUN = /[.\-_/]*[A-Za-z][A-Za-z0-9.\-_/]*(?:(?:\s*,\s*|\s+|[=:+@])[.\-_/]*[A-Za-z0-9][A-Za-z0-9.\-_/]*)*/g;
function isolateLatinRuns(value) {
  if (!value || value.includes(LRI)) return value;
  return value.replace(LATIN_RUN, (run) => LRI + run + PDI);
}

const BIDI_CONTROLS = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;
const RTL_STRONG = /[\u05D0-\u05EA\u05F0-\u05F2\u0620-\u063F\u0641-\u064A\u066E-\u066F\u0671-\u06D3\u06D5\u06EE-\u06EF\u06FA-\u06FC\u0750-\u077F\u08A0-\u08C9]/;

function stripBidiControls(value) {
  return String(value).replace(BIDI_CONTROLS, '');
}

function isolateDynamicValue(value) {
  const clean = stripBidiControls(value);
  for (const char of clean) {
    if (/[A-Za-z]/.test(char)) return LRI + clean + PDI;
    if (RTL_STRONG.test(char)) return RLI + isolateLatinRuns(clean) + PDI;
  }
  return LRI + clean + PDI;
}

/** Interpolate runtime facts without letting them reorder an RTL dialog. */
function interpolateRtl(template, values = {}) {
  const isolated = [];
  let prepared = stripBidiControls(template).replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g,
    (match, name) => {
      if (!Object.prototype.hasOwnProperty.call(values, name)) return match;
      const index = isolated.push(isolateDynamicValue(values[name])) - 1;
      return `\uE000${index}\uE001`;
    });
  prepared = isolateLatinRuns(prepared);
  return prepared.replace(/\uE000(\d+)\uE001/g, (_match, index) => isolated[Number(index)]);
}

function interpolateNativeLtr(template, values = {}) {
  return stripBidiControls(template).replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g,
    (match, name) => Object.prototype.hasOwnProperty.call(values, name)
      ? stripBidiControls(values[name]) : match);
}

function isolateLiteral(value, locale) {
  const string = String(value);
  return RTL_LOCALES.has(locale) ? LRI + string + PDI : string;
}

function createNativeI18n({ catalogDir }) {
  if (!catalogDir) throw new TypeError('createNativeI18n requires catalogDir');
  const cache = new Map();
  let current = BASE_LOCALE;

  function catalogue(locale) {
    if (!cache.has(locale)) cache.set(locale, loadNativeCatalogue(catalogDir, locale));
    return cache.get(locale);
  }

  // Prime English once. A missing/incomplete file still has the trusted
  // in-module fallbacks above.
  catalogue(BASE_LOCALE);

  return Object.freeze({
    supports(locale) {
      return typeof locale === 'string' && LOCALE_SET.has(locale);
    },

    setLocale(locale) {
      if (typeof locale !== 'string' || !LOCALE_SET.has(locale)) {
        throw new RangeError(`Unsupported SciREPL locale: ${String(locale)}`);
      }
      catalogue(locale);
      current = locale;
      return current;
    },

    get locale() {
      return current;
    },

    t(key, values) {
      if (!KEY_SET.has(key)) throw new RangeError(`Unknown native translation key: ${key}`);
      const localized = catalogue(current)[key];
      const base = catalogue(BASE_LOCALE)[key];
      const template = localized || base || ENGLISH[key];
      if (!RTL_LOCALES.has(current)) return interpolateNativeLtr(template, values);
      return localized
        ? interpolateRtl(template, values)
        : isolateLiteral(interpolateNativeLtr(template, values), current);
    },

    literal(value) {
      return isolateLiteral(value, current);
    },
  });
}

module.exports = {
  BASE_LOCALE,
  SUPPORTED_LOCALES,
  NATIVE_KEYS,
  ENGLISH,
  REQUIRED_LITERALS,
  isSafeNativeString,
  hasExpectedPlaceholders,
  hasRequiredLiterals,
  loadNativeCatalogue,
  interpolate,
  interpolateRtl,
  interpolateNativeLtr,
  isolateLatinRuns,
  isolateDynamicValue,
  stripBidiControls,
  isolateLiteral,
  createNativeI18n,
};
