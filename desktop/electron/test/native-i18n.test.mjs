/** Pure tests for the Electron host's catalogue boundary and native menu. */

import { createRequire } from 'node:module';
import Module from 'node:module';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReporter, ELECTRON_DIR, WWW_ROOT } from './reporter.mjs';

const originalResolve = Module._resolveFilename;
const STUB = fileURLToPath(new URL('./fixtures/electron-stub.cjs', import.meta.url));
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return STUB;
  return originalResolve.call(this, request, ...rest);
};

const require = createRequire(import.meta.url);
const native = require(path.join(ELECTRON_DIR, 'native-i18n.js'));
const menu = require(path.join(ELECTRON_DIR, 'menu.js'));

function writeCatalogue(dir, locale, strings) {
  writeFileSync(path.join(dir, `${locale}.json`), JSON.stringify({ strings }));
}

export default async function run() {
  const r = createReporter('native-i18n');
  const dir = mkdtempSync(path.join(tmpdir(), 'scirepl-native-i18n-'));

  try {
    // This is a release gate, not a fallback test: every locale offered in the
    // renderer must also cover the Electron-native surface before publishing.
    const manifestLocales = JSON.parse(
      readFileSync(path.join(WWW_ROOT, 'i18n', 'manifest.json'), 'utf8')
    ).locales.map((entry) => entry.code).sort();
    r.log('the host locale allowlist matches the renderer manifest',
      JSON.stringify([...native.SUPPORTED_LOCALES].sort()) === JSON.stringify(manifestLocales),
      `${native.SUPPORTED_LOCALES.join(', ')} / ${manifestLocales.join(', ')}`);
    for (const locale of native.SUPPORTED_LOCALES) {
      const source = JSON.parse(
        readFileSync(path.join(WWW_ROOT, 'i18n', `${locale}.json`), 'utf8')
      ).strings || {};
      const invalid = native.NATIVE_KEYS.filter((key) =>
        !native.isSafeNativeString(source[key])
          || !native.hasExpectedPlaceholders(key, source[key])
          || !native.hasRequiredLiterals(key, source[key]));
      r.log(`the shipped ${locale} catalogue covers every safe native key`,
        invalid.length === 0, invalid.join(', '));
    }

    writeCatalogue(dir, 'en', native.ENGLISH);
    const french = Object.fromEntries(
      Object.entries(native.ENGLISH).map(([key, value]) => [key, `fr:${value}`])
    );
    // These two entries model translation mistakes. Both must fall back to the
    // trusted English value rather than reaching Electron's native APIs.
    french['electron.menu.github'] = '<img src=x onerror=evil()> SciREPL';
    french['electron.cache.summary'] = 'Taille : {wrong}';
    french['electron.cache.disabledDetail'] = 'Le cache est désactivé.';
    writeCatalogue(dir, 'fr', french);
    const arabic = Object.fromEntries(
      Object.entries(native.ENGLISH).map(([key, value]) => [key, `عربي: ${value}`])
    );
    writeCatalogue(dir, 'ar', arabic);

    const i18n = native.createNativeI18n({ catalogDir: dir });
    r.log('English fallback covers every native key',
      native.NATIVE_KEYS.length === Object.keys(native.ENGLISH).length
        && native.NATIVE_KEYS.every((key) => native.ENGLISH[key]));
    r.log('the host supports the fixed shipped locale allowlist',
      i18n.supports('fr') && i18n.supports('pt-BR') && !i18n.supports('../../fr'));

    i18n.setLocale('fr');
    r.log('a safe bundled translation is selected host-side',
      i18n.t('electron.menu.file') === 'fr:File', i18n.t('electron.menu.file'));
    r.log('markup in a catalogue cannot reach a native label',
      i18n.t('electron.menu.github') === native.ENGLISH['electron.menu.github'],
      i18n.t('electron.menu.github'));
    r.log('a translation with the wrong placeholders falls back safely',
      i18n.t('electron.cache.summary', { bytes: '2 MB', entries: 4 })
        === 'Downloaded size: 2 MB. Cached files: 4.');
    r.log('a translation that changes a required identifier falls back safely',
      i18n.t('electron.cache.disabledDetail')
        === native.ENGLISH['electron.cache.disabledDetail']);

    let rejected = false;
    try { i18n.setLocale('../fr'); } catch { rejected = true; }
    r.log('an unbundled locale id is rejected before filesystem access', rejected === true);

    rejected = false;
    try { i18n.t('renderer.supplied.key'); } catch { rejected = true; }
    r.log('renderer-supplied translation keys are not accepted', rejected === true);

    i18n.setLocale('ar');
    r.log('Latin product names are directionally isolated in RTL native text',
      i18n.t('electron.menu.github').includes('\u2066SciREPL on GitHub\u2069'),
      JSON.stringify(i18n.t('electron.menu.github')));
    const nativeConfirm = i18n.t('electron.cache.confirm', { bytes: '2 MB\u202E' });
    r.log('interpolated native-dialog values are isolated and cannot inject bidi overrides',
      nativeConfirm.includes('\u20662 MB\u2069') && !nativeConfirm.includes('\u202E'),
      JSON.stringify(nativeConfirm));
    r.log('host-owned paths and versions can be isolated as whole RTL literals',
      i18n.literal('/literal/runtime-cache') === '\u2066/literal/runtime-cache\u2069');
    i18n.setLocale('fr');

    const dialogs = [];
    let cleared = 0;
    const fakeDialog = {
      async showMessageBox(_win, options) {
        dialogs.push(options);
        return { response: options.type === 'warning' ? 1 : 0 };
      },
    };
    const fakeCache = {
      dir: '/literal/runtime-cache',
      async size() { return { bytes: 2_400_000, entries: 4 }; },
      async clear() { cleared += 1; },
    };
    const template = menu.createMenuTemplate({
      getCache: () => fakeCache,
      getBuildInfo: () => ({ profile: 'full', channel: 'preview', commit: 'abcdef123456789' }),
      getWindow: () => ({ id: 'window' }),
      appVersion: '1.2.3',
      t: (key, values) => i18n.t(key, values),
      getLocale: () => i18n.locale,
      literal: (value) => i18n.literal(value),
      dialog: fakeDialog,
      shell: { openPath() {}, openExternal() {} },
      app: { getPath: () => '/literal/user-data' },
    });

    r.log('top-level native menu labels use the active locale',
      template[0].label === '&fr:File' && template[4].label === '&fr:Help',
      template.map((x) => x.label).join(' | '));
    r.log('Electron role labels use the active app locale, not the OS locale',
      template[0].submenu[0].label === 'fr:Reload'
        && template[1].submenu[3].label === 'fr:Cut');

    await template[3].submenu[0].click(); // cache info
    await template[3].submenu[1].click(); // clear confirmation + result
    await template[4].submenu[0].click(); // about
    r.log('cache and About dialogs use the active locale',
      dialogs.length === 4
        && dialogs.every((d) => d.title.startsWith('fr:')),
      dialogs.map((d) => d.title).join(' | '));
    r.log('the destructive cache action remains confirmed before clearing',
      dialogs[1].type === 'warning' && cleared === 1);
    r.log('runtime paths and product/runtime names remain literal',
      dialogs[0].detail.endsWith('/literal/runtime-cache')
        && dialogs[3].message === 'SciREPL'
        && /Electron .*Chromium/.test(dialogs[3].detail));
  } finally {
    rmSync(dir, { recursive: true, force: true });
    Module._resolveFilename = originalResolve;
  }

  return r.summary();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().then(s => process.exit(s.failed > 0 ? 1 : 0));
}
