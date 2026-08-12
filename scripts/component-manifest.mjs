import { readFileSync } from 'node:fs';
import path from 'node:path';

export function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function loadComponentManifest(root) {
  const manifest = readJson(path.join(root, 'third-party-components.json'));
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.components)) {
    throw new Error('third-party-components.json must use schemaVersion 1 and contain components[]');
  }

  const byId = new Map();
  for (const component of manifest.components) {
    if (!component.id || byId.has(component.id)) {
      throw new Error(`missing or duplicate component id: ${component.id || '<empty>'}`);
    }
    byId.set(component.id, component);
    for (const licence of component.licenseDocuments || []) {
      if (!manifest.licenseDocuments?.[licence]) {
        throw new Error(`${component.id} references unknown licence document '${licence}'`);
      }
    }
    for (const pkg of component.packages || []) {
      for (const notice of pkg.wheelNotices || []) {
        if (!notice.entry || !manifest.licenseDocuments?.[notice.document]) {
          throw new Error(`${component.id}/${pkg.name} has an invalid wheel notice mapping`);
        }
      }
    }
  }

  for (const [language, componentId] of Object.entries(manifest.runtimeComponents || {})) {
    if (!byId.has(componentId)) {
      throw new Error(`runtimeComponents.${language} references unknown component '${componentId}'`);
    }
  }
  return { manifest, byId };
}

export function componentVersion(component, pkg) {
  if (component.versionFrom === 'package.json') return String(pkg.version);
  return String(component.version || 'unversioned');
}

export function expandRuntimeTemplate(value, component, pkg) {
  if (typeof value !== 'string') return value;
  const fields = {
    version: componentVersion(component, pkg),
    versionTag: component.versionTag || componentVersion(component, pkg),
    versionSelector: component.runtime?.versionSelector || componentVersion(component, pkg),
  };
  return value.replace(/\{(version|versionTag|versionSelector)\}/g, (_all, key) => fields[key]);
}

export function resolvedRuntime(component, pkg) {
  const runtime = component.runtime || {};
  return {
    version: componentVersion(component, pkg),
    versionTag: component.versionTag || undefined,
    versionSelector: runtime.versionSelector || undefined,
    underlyingVersion: component.underlyingVersion || undefined,
    baseUrl: runtime.baseUrl ? expandRuntimeTemplate(runtime.baseUrl, component, pkg) : undefined,
    overrideUrlTemplate: runtime.overrideUrlTemplate || undefined,
    versionMetadata: runtime.versionMetadata || undefined,
    sources: (runtime.sources || []).map((source) => ({
      ...source,
      urlTemplate: source.url,
      url: expandRuntimeTemplate(source.url, component, pkg),
    })),
  };
}

export function deliveryLabel(component, profile) {
  const delivery = component.delivery || {};
  switch (delivery.kind) {
    case 'first-party': return 'SciREPL application';
    case 'bundled': return 'Bundled with SciREPL';
    case 'embedded': return `Embedded in ${delivery.via || 'another component'}`;
    case 'downloaded': return `Downloaded on demand${delivery.when ? ` (${delivery.when})` : ''}`;
    case 'platform': return `${delivery.platform}-specific bundle`;
    case 'runtime': {
      const language = delivery.language;
      if (!(profile.enabled || []).includes(language)) return `Not enabled in this build (${language})`;
      return (profile.bundle || []).includes(language)
        ? `Bundled for offline use (${language})`
        : `Downloaded on first use (${language})`;
    }
    default: return 'Delivery not classified';
  }
}
