/**
 * msix-manifest.unit.test.mjs — the Store-pilot manifest decisions.
 *
 * Pure Node: no Electron binary, no display, no Windows SDK.
 */

import { createReporter } from './reporter.mjs';
import {
  storeVersion, resolveIdentity, buildManifest, xmlEscape,
  PLACEHOLDER_IDENTITY, CAPABILITIES, LOGO_ASSETS,
} from '../packaging/msix-manifest.mjs';

function throws(fn) {
  try { fn(); return false; } catch { return true; }
}

const REAL_ENV = {
  SCIREPL_MSIX_IDENTITY_NAME: '12345Example.SciREPL',
  SCIREPL_MSIX_PUBLISHER: 'CN=00000000-1111-2222-3333-444444444444',
  SCIREPL_MSIX_PUBLISHER_DISPLAY_NAME: 'Example Publisher',
};

export default async function run() {
  const r = createReporter('msix-manifest');

  r.log('semver maps to a Store version with revision 0', storeVersion('1.5.0') === '1.5.0.0');
  r.log('whitespace around the version is tolerated', storeVersion(' 2.10.3 ') === '2.10.3.0');
  r.log('pre-release suffix is rejected, not dropped', throws(() => storeVersion('1.6.0-rc.1')));
  r.log('two-part version is rejected', throws(() => storeVersion('1.6')));
  r.log('part above 65535 is rejected', throws(() => storeVersion('1.65536.0')));
  r.log('0.0.0 is rejected', throws(() => storeVersion('0.0.0')));

  const local = resolveIdentity({});
  r.log('no identity variables gives the marked placeholder', local.placeholder === true && local.name === PLACEHOLDER_IDENTITY.name);
  const real = resolveIdentity(REAL_ENV);
  r.log('a full Partner Center identity is used as given', real.placeholder === false && real.name === REAL_ENV.SCIREPL_MSIX_IDENTITY_NAME);
  r.log('a partial identity is an error', throws(() => resolveIdentity({ SCIREPL_MSIX_IDENTITY_NAME: 'A.B' })));
  r.log('publisher must be a distinguished name', throws(() => resolveIdentity({ ...REAL_ENV, SCIREPL_MSIX_PUBLISHER: 'Example' })));
  r.log('invalid package name is rejected', throws(() => resolveIdentity({ ...REAL_ENV, SCIREPL_MSIX_IDENTITY_NAME: 'bad name!' })));
  r.log('a placeholder value passed explicitly is still flagged',
    resolveIdentity({ ...REAL_ENV, SCIREPL_MSIX_PUBLISHER: PLACEHOLDER_IDENTITY.publisher }).placeholder === true);

  r.log('XML escaping covers all five entities', xmlEscape(`<a & "b" 'c'>`) === '&lt;a &amp; &quot;b&quot; &apos;c&apos;&gt;');

  const xml = buildManifest({ identity: real, version: storeVersion('1.5.0') });
  r.log('manifest carries the identity and Store version',
    xml.includes(`Name="${REAL_ENV.SCIREPL_MSIX_IDENTITY_NAME}"`) && xml.includes('Version="1.5.0.0"'));
  r.log('manifest is a full-trust desktop entry point',
    xml.includes('EntryPoint="Windows.FullTrustApplication"') && xml.includes('Executable="SciREPL.exe"') && xml.includes('Name="Windows.Desktop"'));
  const declared = [...xml.matchAll(/Capability Name="([^"]+)"/g)].map((m) => m[1]);
  r.log('only runFullTrust is declared', declared.length === 1 && declared[0] === 'runFullTrust' && CAPABILITIES.length === 1);
  r.log('every referenced logo is a known asset',
    [...xml.matchAll(/Assets\\([A-Za-z0-9x]+\.png)/g)].every((m) => LOGO_ASSETS.some((a) => a.file === m[1])));
  r.log('publisher display name is escaped',
    buildManifest({ identity: { ...real, publisherDisplayName: 'A & B' }, version: '1.0.0.0' }).includes('A &amp; B'));
  r.log('a non-Store version is refused', throws(() => buildManifest({ identity: real, version: '1.5.0.3' })));
  r.log('a non-x64 architecture is refused', throws(() => buildManifest({ identity: real, version: '1.5.0.0', arch: 'arm64' })));

  return r.summary();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().then((s) => process.exit(s.failed > 0 ? 1 : 0));
}
