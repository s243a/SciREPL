/**
 * msix-manifest.mjs — pure helpers for the Store-pilot MSIX package.
 *
 * Kept free of file-system and Windows-tool access so the decisions that are
 * easy to get subtly wrong (the Store version format, identity placeholders,
 * XML escaping, the capability list) are unit-tested on any OS. The Windows-only
 * packing step lives in build-msix.mjs.
 */

/**
 * Identity used when the owner has not supplied the Partner Center values.
 * A package built with any of these can be installed locally for testing but
 * must never be uploaded; build-msix.mjs labels the file `-local-test`.
 */
export const PLACEHOLDER_IDENTITY = Object.freeze({
  name: 'SciREPL.FreePilot.LocalTest',
  publisher: 'CN=SciREPL Local Test',
  publisherDisplayName: 'SciREPL (local test build)',
});

/**
 * Store version from a semver app version.
 *
 * MSIX versions are Major.Minor.Build.Revision with each part 0–65535. The
 * fourth part is reserved for the Store and must be 0 in a submitted package,
 * so the three semver parts map directly and the revision is always 0.
 * Pre-release or build suffixes are rejected rather than silently dropped:
 * two different builds would otherwise share one package version and the
 * second would not install as an update.
 */
export function storeVersion(appVersion) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(appVersion).trim());
  if (!match) {
    throw new Error(`App version "${appVersion}" is not plain Major.Minor.Patch; MSIX needs a numeric version.`);
  }
  const parts = match.slice(1, 4).map(Number);
  if (parts.some((n) => n > 65535)) {
    throw new Error(`App version "${appVersion}" has a part above 65535, which MSIX cannot represent.`);
  }
  if (parts[0] === 0 && parts[1] === 0 && parts[2] === 0) {
    throw new Error('App version 0.0.0 is not a releasable package version.');
  }
  return `${parts.join('.')}.0`;
}

/**
 * Resolve the package identity from the environment.
 *
 * All three values come from Partner Center (Product identity page) once the
 * owner has reserved the name. They are supplied together or not at all: a
 * half-configured identity is an error, not a silent mix with placeholders.
 */
export function resolveIdentity(env = {}) {
  const supplied = {
    name: env.SCIREPL_MSIX_IDENTITY_NAME,
    publisher: env.SCIREPL_MSIX_PUBLISHER,
    publisherDisplayName: env.SCIREPL_MSIX_PUBLISHER_DISPLAY_NAME,
  };
  const given = Object.values(supplied).filter((v) => v !== undefined && v !== '');
  if (given.length === 0) return { ...PLACEHOLDER_IDENTITY, placeholder: true };
  if (given.length !== 3) {
    throw new Error(
      'Set all of SCIREPL_MSIX_IDENTITY_NAME, SCIREPL_MSIX_PUBLISHER and ' +
      'SCIREPL_MSIX_PUBLISHER_DISPLAY_NAME (from Partner Center), or none of them for a local test build.'
    );
  }
  // Package name: 3–50 characters, letters, digits, '.' and '-'.
  if (!/^[A-Za-z0-9.-]{3,50}$/.test(supplied.name)) {
    throw new Error(`SCIREPL_MSIX_IDENTITY_NAME "${supplied.name}" is not a valid package name.`);
  }
  // Publisher is a distinguished name, as Partner Center shows it (CN=…).
  if (!/^CN=/.test(supplied.publisher)) {
    throw new Error('SCIREPL_MSIX_PUBLISHER must be the full distinguished name from Partner Center, starting "CN=".');
  }
  const placeholder = Object.entries(PLACEHOLDER_IDENTITY).some(([k, v]) => supplied[k] === v);
  return { ...supplied, placeholder };
}

export function xmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Logo files the manifest references, with their pixel sizes. */
export const LOGO_ASSETS = Object.freeze([
  { file: 'StoreLogo.png', size: 50 },
  { file: 'Square44x44Logo.png', size: 44 },
  { file: 'Square150x150Logo.png', size: 150 },
]);

/**
 * The only capability declared. runFullTrust is what every packaged Win32 /
 * Electron app needs to start its own executable; it is a restricted capability
 * the Store accepts for desktop apps. Network access needs no capability for a
 * full-trust process. Add nothing here without a reviewed reason.
 */
export const CAPABILITIES = Object.freeze(['runFullTrust']);

/**
 * AppxManifest.xml for the Free Electron pilot.
 *
 * @param {object} o
 * @param {{name:string,publisher:string,publisherDisplayName:string}} o.identity
 * @param {string} o.version          Store version, from storeVersion()
 * @param {string} [o.arch]           'x64' (only x64 is piloted)
 * @param {string} [o.displayName]
 * @param {string} [o.description]
 * @param {string[]} [o.languages]    manifest resource languages; these become
 *                                    the Store listing languages
 */
export function buildManifest({
  identity,
  version,
  arch = 'x64',
  displayName = 'SciREPL',
  description = 'Run code and work with scientific notebooks on your PC.',
  languages = ['en-us'],
}) {
  if (arch !== 'x64') throw new Error(`Only x64 is piloted; got ${arch}.`);
  if (!/^\d+\.\d+\.\d+\.0$/.test(version)) throw new Error(`Version "${version}" must come from storeVersion().`);
  if (!languages.length) throw new Error('At least one manifest language is required.');
  const e = xmlEscape;
  return `<?xml version="1.0" encoding="utf-8"?>
<Package
  xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10"
  xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10"
  xmlns:rescap="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities"
  IgnorableNamespaces="uap rescap">
  <Identity Name="${e(identity.name)}" Publisher="${e(identity.publisher)}" Version="${e(version)}" ProcessorArchitecture="${e(arch)}" />
  <Properties>
    <DisplayName>${e(displayName)}</DisplayName>
    <PublisherDisplayName>${e(identity.publisherDisplayName)}</PublisherDisplayName>
    <Logo>Assets\\StoreLogo.png</Logo>
  </Properties>
  <Dependencies>
    <TargetDeviceFamily Name="Windows.Desktop" MinVersion="10.0.17763.0" MaxVersionTested="10.0.22621.0" />
  </Dependencies>
  <Resources>
${languages.map((l) => `    <Resource Language="${e(l)}" />`).join('\n')}
  </Resources>
  <Applications>
    <Application Id="SciREPL" Executable="SciREPL.exe" EntryPoint="Windows.FullTrustApplication">
      <uap:VisualElements
        DisplayName="${e(displayName)}"
        Description="${e(description)}"
        BackgroundColor="transparent"
        Square150x150Logo="Assets\\Square150x150Logo.png"
        Square44x44Logo="Assets\\Square44x44Logo.png" />
    </Application>
  </Applications>
  <Capabilities>
${CAPABILITIES.map((c) => `    <rescap:Capability Name="${e(c)}" />`).join('\n')}
  </Capabilities>
</Package>
`;
}
