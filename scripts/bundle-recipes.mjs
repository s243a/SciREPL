export const PYODIDE_CORE_FILES = [
  'pyodide.js', 'pyodide.asm.js', 'pyodide.asm.wasm', 'python_stdlib.zip', 'pyodide-lock.json',
];

export const PYODIDE_WANTED_PACKAGES = [
  'numpy', 'sympy', 'micropip', 'pandas', 'narwhals',
];

export function runtimeBundleSpec(language, component, resolved, options = {}) {
  const common = {
    schema: 1,
    language,
    component: component.id,
    version: component.version,
    revision: component.revision || null,
    sources: (resolved.sources || []).map((source) => ({
      type: source.type,
      url: source.url,
      urlTemplate: source.urlTemplate || null,
    })),
    artifacts: (component.artifacts || []).map((artifact) => ({
      path: artifact.path,
      sha256: artifact.sha256 || null,
      size: artifact.size || null,
    })),
  };
  if (language === 'python') {
    return {
      ...common,
      baseUrl: resolved.baseUrl,
      coreFiles: PYODIDE_CORE_FILES,
      wantedPackages: PYODIDE_WANTED_PACKAGES,
      // The exact resolved wheel set is part of the build recipe, not merely a
      // post-fetch check. Updating a transitive wheel or its embedded notice
      // mapping therefore invalidates an otherwise same-version Pyodide bundle
      // and forces a clean staged rebuild.
      packageSet: (options.packages || []).map((pkg) => ({
        name: pkg.name,
        version: pkg.version,
        noticeEntries: (pkg.wheelNotices || []).map((notice) => notice.entry).sort(),
      })).sort((a, b) => a.name.localeCompare(b.name)),
      wheelNoticeSchema: 1,
    };
  }
  if (language === 'r') {
    return {
      ...common,
      listApi: `https://data.jsdelivr.com/v1/packages/npm/webr@${resolved.version}`,
      distBase: `https://cdn.jsdelivr.net/npm/webr@${resolved.version}/dist/`,
      androidDataTransform: 'gunzip-data-and-clear-metadata-gzip-v1',
    };
  }
  return common;
}
