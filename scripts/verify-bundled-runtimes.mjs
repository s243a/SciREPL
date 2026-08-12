#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectCompletedBundle } from './bundle-staging.mjs';
import { loadComponentManifest, readJson, resolvedRuntime } from './component-manifest.mjs';
import { runtimeBundleSpec } from './bundle-recipes.mjs';
import { verifyPyodideWheelNotices } from './pyodide-wheel-notices.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const profiles = readJson(path.join(ROOT, 'build-profiles.json'));
const packageSpec = readJson(path.join(ROOT, 'package.json'));
const profileName = process.env.BUILD_PROFILE || process.argv[2] || profiles.default;
const profile = profiles.profiles?.[profileName];
if (!profile) throw new Error(`unknown build profile '${profileName}'`);
const { byId } = loadComponentManifest(ROOT);
let checked = 0;

function digest(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

for (const language of profile.bundle || []) {
  const languageSpec = profiles.languages?.[language];
  const component = byId.get(languageSpec?.component);
  if (!component || !languageSpec?.localUrl) {
    throw new Error(`bundled ${language} lacks component/localUrl metadata`);
  }
  const dir = path.join(ROOT, 'www', path.dirname(languageSpec.localUrl));
  const options = language === 'python'
    ? { packages: byId.get('pyodide-wheels')?.packages || [] }
    : {};
  const state = inspectCompletedBundle(
    dir, component,
    runtimeBundleSpec(language, component, resolvedRuntime(component, packageSpec), options));
  if (!state.current) throw new Error(`${language} bundle is incomplete/stale: ${state.reason}`);
  for (const artifact of component.artifacts || []) {
    const absolute = path.join(ROOT, artifact.path);
    if (!existsSync(absolute)) throw new Error(`${language} artifact is missing: ${artifact.path}`);
    if (artifact.size && readFileSync(absolute).length !== artifact.size) {
      throw new Error(`${language} artifact size changed: ${artifact.path}`);
    }
    if (artifact.sha256 && digest(absolute) !== artifact.sha256) {
      throw new Error(`${language} artifact hash changed: ${artifact.path}`);
    }
  }
  checked++;
}

if ((profile.bundle || []).includes('python')) {
  const wheelResult = await verifyPyodideWheelNotices(ROOT);
  console.log(`[verify-bundles] Pyodide wheels: ${wheelResult.packages} packages, ${wheelResult.notices} exact notices`);
}
console.log(`[verify-bundles] profile '${profileName}': ${checked} completed runtime bundles verified`);
