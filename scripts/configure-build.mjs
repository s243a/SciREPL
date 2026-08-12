#!/usr/bin/env node
/**
 * configure-build.mjs — generate www/js/kernel_config.js from build-profiles.json.
 *
 * Picks a profile (BUILD_PROFILE env var, or first CLI arg, or the file's
 * "default"), then emits the runtime config the app reads at load time:
 *   window.KERNEL_CONFIG = { app, profile, languages: { <lang>: {enabled, runtime, timeoutMs, sources} } }
 *
 * `enabled`/timeouts come from the chosen profile; component versions and
 * sources come from third-party-components.json. fetch-bundles.mjs acts on a
 * profile's `bundle` list after this configuration step.
 *
 * Usage:
 *   node scripts/configure-build.mjs            # uses default profile
 *   node scripts/configure-build.mjs mini       # explicit profile
 *   BUILD_PROFILE=light node scripts/configure-build.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadComponentManifest, resolvedRuntime } from './component-manifest.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const PROFILES_PATH = join(ROOT, 'build-profiles.json');
const PACKAGE_PATH = join(ROOT, 'package.json');
const OUTPUT_PATH = join(ROOT, 'www', 'js', 'kernel_config.js');

function fail(msg) {
  console.error('[configure-build] ' + msg);
  process.exit(1);
}

const spec = JSON.parse(readFileSync(PROFILES_PATH, 'utf8'));
const pkg = JSON.parse(readFileSync(PACKAGE_PATH, 'utf8'));
const { manifest: components, byId: componentsById } = loadComponentManifest(ROOT);
const profileName = process.env.BUILD_PROFILE || process.argv[2] || spec.default;

const profile = spec.profiles && spec.profiles[profileName];
if (!profile) {
  fail(`unknown profile '${profileName}'. Known: ${Object.keys(spec.profiles || {}).join(', ')}`);
}

const enabledSet = new Set(profile.enabled || []);
const bundleSet = new Set(profile.bundle || []);

// Build the languages map: every known language, with enabled set by the profile.
const langs = {};
for (const [name, meta] of Object.entries(spec.languages)) {
  const expectedComponent = components.runtimeComponents?.[name];
  const componentId = meta.component || expectedComponent;
  if (meta.component && expectedComponent && meta.component !== expectedComponent) {
    fail(`language '${name}' maps to '${meta.component}' in build-profiles.json but ` +
      `third-party-components.json maps it to '${expectedComponent}'`);
  }
  const component = componentId ? componentsById.get(componentId) : null;
  if (componentId && !component) fail(`language '${name}' references unknown component '${componentId}'`);
  const resolved = component ? resolvedRuntime(component, pkg) : { sources: [] };
  const entry = {
    enabled: enabledSet.has(name),
    runtime: meta.runtime || 'cdn',
    timeoutMs: meta.timeoutMs || 0,
    sources: [...resolved.sources, ...(meta.sources || [])],
  };
  if (component) {
    entry.component = component.id;
    entry.version = resolved.version;
    if (resolved.versionTag) entry.versionTag = resolved.versionTag;
    if (resolved.versionSelector) entry.versionSelector = resolved.versionSelector;
    if (resolved.underlyingVersion) entry.underlyingVersion = resolved.underlyingVersion;
    if (resolved.baseUrl) entry.baseUrl = resolved.baseUrl;
    if (resolved.overrideUrlTemplate) entry.overrideUrlTemplate = resolved.overrideUrlTemplate;
    if (resolved.versionMetadata) entry.versionMetadata = resolved.versionMetadata;
  }
  // If this profile bundles the language, prepend a local source and mark it
  // preferred so the runtime tries the bundled copy first (offline-capable,
  // CDN as fallback). The asset is fetched by scripts/fetch-bundles.mjs.
  if (bundleSet.has(name) && meta.localUrl) {
    entry.sources.unshift({ type: 'local', url: meta.localUrl });
    entry.preferLocal = true;
  }
  langs[name] = entry;
}

// Warn about anything the profile references that we don't know about.
for (const name of enabledSet) {
  if (!spec.languages[name]) fail(`profile '${profileName}' enables unknown language '${name}'`);
}

// Browser UI, Capacitor and Electron all consume this generated metadata. The
// package version is therefore the single release-version source rather than
// being copied into each modal and release URL by hand.
const appVersion = String(pkg.version || '0.0.0');
const releaseChannel = String(pkg.releaseChannel || 'development');
if (!['development', 'release'].includes(releaseChannel)) {
  fail(`package.json releaseChannel must be 'development' or 'release', got '${releaseChannel}'`);
}
const config = {
  app: {
    name: components.app.name,
    version: appVersion,
    releaseChannel,
    // The releases index remains valid while a draft tag is being prepared and
    // if a platform build briefly gets ahead of the public GitHub release.
    releaseUrl: components.app.releasesUrl,
    repository: components.app.repository,
    releasesUrl: components.app.releasesUrl,
  },
  profile: profileName,
  components: Object.fromEntries(components.components.map((component) => {
    const resolved = resolvedRuntime(component, pkg);
    return [component.id, {
      version: resolved.version,
      licenseExpression: component.licenseExpression,
      sourceUrl: component.sourceUrl,
      delivery: component.delivery,
      sources: resolved.sources,
    }];
  })),
  languages: langs,
};

const banner =
`/**
 * kernel_config.js — AUTO-GENERATED by scripts/configure-build.mjs.
 *
 * Do NOT edit by hand. Edit build-profiles.json or third-party-components.json and re-run:
 *   node scripts/configure-build.mjs [profile]
 *   BUILD_PROFILE=mini node scripts/configure-build.mjs
 *
 * Generated for profile: ${profileName}
 *
 * The runtime (KernelManager.loadKernelSource) reads each language's
 * timeoutMs + sources to load its CDN runtime with a per-attempt timeout and
 * mirror fallbacks; \`enabled\` gates which languages the app exposes.
 * Per-kernel override: localStorage['scirepl_<lang>_source'] = a URL (tried
 * first) or 'local' (prefer a bundled source, when one exists).
 */
`;

const body = 'window.KERNEL_CONFIG = ' + JSON.stringify(config, null, 2) + ';\n';
writeFileSync(OUTPUT_PATH, banner + body);

const bundled = bundleSet.size ? ` (bundled offline: ${[...bundleSet].join(', ')} — run scripts/fetch-bundles.mjs to fetch)` : '';
console.log(`[configure-build] wrote ${OUTPUT_PATH} for profile '${profileName}'`);
console.log(`[configure-build] enabled: ${[...enabledSet].join(', ')}${bundled}`);
