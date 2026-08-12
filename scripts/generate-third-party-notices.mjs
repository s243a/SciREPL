#!/usr/bin/env node
/**
 * Generate the human-readable notices from third-party-components.json.
 *
 * The JSON manifest is the reviewable source of truth. The generated HTML is
 * deliberately self-contained so Help can open it without a network
 * connection; THIRD_PARTY_NOTICES.md is the repository/release companion.
 */
import {
  existsSync, readFileSync, readdirSync, writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  componentVersion, deliveryLabel, loadComponentManifest, readJson,
} from './component-manifest.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const WWW = path.join(ROOT, 'www');
const OUT_HTML = path.join(WWW, 'open-source-licenses.html');
const OUT_MD = path.join(ROOT, 'THIRD_PARTY_NOTICES.md');
const CHECK = process.argv.includes('--check');
const profileArg = process.argv.find((arg) => arg.startsWith('--profile='));

function fail(message) {
  throw new Error(message);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function slug(value) {
  return String(value).replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
}

function fileText(relativePath) {
  return readFileSync(path.join(ROOT, relativePath), 'utf8').replace(/\r\n/g, '\n').trimEnd();
}

const pkg = readJson(path.join(ROOT, 'package.json'));
const profiles = readJson(path.join(ROOT, 'build-profiles.json'));
const profileName = profileArg?.slice('--profile='.length)
  || process.env.BUILD_PROFILE
  || profiles.default;
const profile = profiles.profiles?.[profileName];
if (!profile) fail('unknown build profile: ' + profileName);

const { manifest, byId } = loadComponentManifest(ROOT);

const lockCache = new Map();
function lockedPackageVersion(lockRelativePath, packageName) {
  if (!lockCache.has(lockRelativePath)) {
    lockCache.set(lockRelativePath, readJson(path.join(ROOT, lockRelativePath)));
  }
  return lockCache.get(lockRelativePath).packages?.['node_modules/' + packageName]?.version;
}

function verifyInventory() {
  for (const component of manifest.components) {
    if (!component.name || !component.licenseExpression || !component.sourceUrl) {
      fail(component.id + ' must declare name, licenseExpression and sourceUrl');
    }
    if (!component.delivery?.kind) fail(component.id + ' must declare delivery.kind');
    const metadata = component.runtime?.versionMetadata;
    if (metadata) {
      if (!/^https:\/\//.test(metadata.url || '')) {
        fail(component.id + ' versionMetadata.url must be HTTPS');
      }
      if (!['dist-tag-latest', 'highest-stable-compatible-major'].includes(metadata.strategy)) {
        fail(component.id + ' has unsupported versionMetadata.strategy');
      }
      if (metadata.strategy === 'highest-stable-compatible-major'
          && (!Number.isInteger(metadata.compatibleMajor) || metadata.compatibleMajor < 0)) {
        fail(component.id + ' must declare an integer compatibleMajor');
      }
    }
    for (const child of component.packages || []) {
      if (!child.name || !child.version || !child.licenseExpression || !child.sourceUrl) {
        fail(component.id + ' has an incomplete packages[] entry');
      }
      if (child.packageName) {
        const lockPath = component.packageLock || 'package-lock.json';
        const locked = lockedPackageVersion(lockPath, child.packageName);
        if (locked !== child.version) {
          fail(component.id + '/' + child.packageName + ' records ' + child.version
            + ' but ' + lockPath + ' resolves ' + String(locked));
        }
      }
      for (const notice of child.wheelNotices || []) {
        if (!notice.entry || !manifest.licenseDocuments?.[notice.document]) {
          fail(component.id + '/' + child.name + ' has an invalid wheel notice mapping');
        }
      }
    }
    if (component.packageName) {
      const lockPath = component.packageLock || 'package-lock.json';
      const locked = lockedPackageVersion(lockPath, component.packageName);
      if (locked !== component.version) {
        fail(component.id + ' records ' + component.version + ' but ' + lockPath
          + ' resolves ' + String(locked));
      }
    }
    for (const artifact of component.artifacts || []) {
      const absolute = path.join(ROOT, artifact.path);
      if (!existsSync(absolute)) {
        if (artifact.optionalGenerated) continue;
        fail(component.id + ' artifact is missing: ' + artifact.path);
      }
      const bytes = readFileSync(absolute);
      const digest = createHash('sha256').update(bytes).digest('hex');
      if (artifact.sha256 && digest !== artifact.sha256) {
        fail(component.id + ' artifact hash changed: ' + artifact.path
          + '\n  expected ' + artifact.sha256 + '\n  actual   ' + digest);
      }
      if (artifact.size && bytes.length !== artifact.size) {
        fail(component.id + ' artifact size changed: ' + artifact.path);
      }
    }
  }

  const mappedRoots = new Set(manifest.components.flatMap((c) => c.vendorRoots || []));
  const vendorRoots = readdirSync(path.join(WWW, 'vendor'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  const unmapped = vendorRoots.filter((entry) => !mappedRoots.has(entry));
  if (unmapped.length) {
    fail('unmapped top-level www/vendor directories: ' + unmapped.join(', ')
      + '. Add each to a component vendorRoots[] entry.');
  }

  for (const [id, document] of Object.entries(manifest.licenseDocuments)) {
    const absolute = path.join(ROOT, document.path);
    if (!existsSync(absolute)) fail('missing licence text ' + id + ': ' + document.path);
    if (document.sha256) {
      const digest = createHash('sha256').update(readFileSync(absolute)).digest('hex');
      if (digest !== document.sha256) fail('licence text hash changed ' + id + ': ' + document.path);
    }
  }

  for (const [language, componentId] of Object.entries(manifest.runtimeComponents)) {
    if (profiles.languages?.[language]?.component !== componentId) {
      fail('build-profiles.json and runtimeComponents disagree for ' + language);
    }
    if (!byId.get(componentId)?.runtime?.sources?.length) {
      fail(componentId + ' is a runtime component without runtime.sources');
    }
  }

  // The privacy wording is deliberately static trusted HTML. Until those
  // catalogues support a safe {version} substitution, require every copy to
  // name the exact manifest version so a docx upgrade cannot create legal drift.
  const docxVersion = byId.get('docx')?.version;
  const docxReferences = [
    path.join(WWW, 'index.html'),
    path.join(WWW, 'privacy.html'),
    ...readdirSync(path.join(WWW, 'i18n'))
      .filter((name) => /^privacy\.[\w-]+\.json$/.test(name))
      .map((name) => path.join(WWW, 'i18n', name)),
  ];
  for (const file of docxReferences) {
    if (!readFileSync(file, 'utf8').includes('docx@' + docxVersion)) {
      fail(path.relative(ROOT, file) + ' does not name manifest docx@' + docxVersion);
    }
  }
}

verifyInventory();

function componentMeta(component) {
  const version = componentVersion(component, pkg);
  const provenance = component.provenance
    ? (component.provenance.modified ? 'Modified/forked build' : 'Upstream/unmodified')
    : (component.delivery?.kind === 'first-party'
        ? 'First-party project'
        : 'Modification status not independently recorded');
  return {
    version,
    delivery: deliveryLabel(component, profile),
    provenance,
    provenanceBasis: component.provenance?.basis || '',
  };
}

function externalLink(label, url) {
  if (!url) return '';
  return '<a href="' + escapeHtml(url) + '" target="_blank" rel="noopener noreferrer">'
    + escapeHtml(label) + '</a>';
}

function componentHtml(component) {
  const meta = componentMeta(component);
  const licenceLinks = (component.licenseDocuments || []).map((id) =>
    '<a href="#license-' + slug(id) + '">' + escapeHtml(id) + '</a>').join(', ');
  const sourceLinks = [
    externalLink('source', component.sourceUrl),
    externalLink('upstream', component.upstreamUrl),
    externalLink('corresponding source', component.correspondingSourceUrl),
    externalLink('R upstream source', component.upstreamSourceUrl),
    externalLink('upstream licence', component.licenseUrl),
  ].filter(Boolean).join(' · ');
  const packages = (component.packages || []).length
    ? [
        '<div class="package-table" role="region" aria-label="Included package versions"><table>',
        '<thead><tr><th>Package</th><th>Version</th><th>Licence</th><th>Source</th></tr></thead><tbody>',
        ...component.packages.map((item) =>
          '<tr><td>' + escapeHtml(item.name) + '</td><td><code>' + escapeHtml(item.version)
          + '</code></td><td>' + escapeHtml(item.licenseExpression)
          + ((item.wheelNotices || []).length ? '<br><small>'
            + item.wheelNotices.map((notice) => '<a href="#license-' + slug(notice.document)
              + '">' + escapeHtml(notice.document) + '</a>').join(', ') + '</small>' : '')
          + '</td><td>'
          + externalLink('source', item.sourceUrl) + '</td></tr>'),
        '</tbody></table></div>',
      ].join('\n')
    : '';
  const artifacts = (component.artifacts || []).length
    ? '<details><summary>Recorded artifacts</summary><ul>'
      + component.artifacts.map((item) =>
        '<li><code>' + escapeHtml(item.path) + '</code>'
        + (item.sha256 ? '<br><small>SHA-256 ' + escapeHtml(item.sha256) + '</small>' : '')
        + (item.resolvedAt ? '<br><small>Verified ' + escapeHtml(item.resolvedAt) + '</small>' : '')
        + '</li>').join('') + '</ul></details>'
    : '';
  const runtimeSources = (component.runtime?.sources || []).length
    ? '<details><summary>Pinned runtime sources and mirrors</summary><ul>'
      + component.runtime.sources.map((item) => '<li><code>'
        + escapeHtml(item.url.replaceAll('{version}', meta.version)
          .replaceAll('{versionTag}', component.versionTag || meta.version))
        + '</code></li>').join('') + '</ul></details>'
    : '';
  return [
    '<article class="component" id="component-' + slug(component.id) + '">',
    '<h2>' + escapeHtml(component.name) + '</h2>',
    '<p class="badges"><span>' + escapeHtml(meta.delivery) + '</span><span>'
      + escapeHtml(meta.provenance) + '</span></p>',
    '<dl>',
    '<dt>Version</dt><dd><code>' + escapeHtml(meta.version) + '</code>'
      + (component.underlyingVersion ? ' <small>(' + escapeHtml(component.underlyingVersion) + ')</small>' : '')
      + '</dd>',
    '<dt>Licence</dt><dd>' + escapeHtml(component.licenseExpression)
      + (component.distributedUnder ? ' (SciREPL uses the ' + escapeHtml(component.distributedUnder) + ' option)' : '')
      + (licenceLinks ? '<br>' + licenceLinks : '') + '</dd>',
    '<dt>Copyright</dt><dd>' + escapeHtml(component.copyright || 'See upstream source') + '</dd>',
    '<dt>Provenance</dt><dd>' + escapeHtml(meta.provenanceBasis || meta.provenance) + '</dd>',
    '<dt>Links</dt><dd>' + sourceLinks + '</dd>',
    '</dl>',
    component.notes ? '<p>' + escapeHtml(component.notes) + '</p>' : '',
    packages,
    runtimeSources,
    artifacts,
    '</article>',
  ].filter(Boolean).join('\n');
}

function licenceHtml(id, document) {
  return [
    '<details class="licence" id="license-' + slug(id) + '">',
    '<summary>' + escapeHtml(id) + '</summary>',
    document.url ? '<p>' + externalLink('Canonical licence page', document.url) + '</p>' : '',
    '<pre>' + escapeHtml(fileText(document.path)) + '</pre>',
    '</details>',
  ].filter(Boolean).join('\n');
}

const componentsHtml = manifest.components.map(componentHtml).join('\n');
const licencesHtml = Object.entries(manifest.licenseDocuments).map(([id, doc]) =>
  licenceHtml(id, doc)).join('\n');
const html = [
  '<!doctype html>',
  '<html lang="en"><head><meta charset="utf-8">',
  '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">',
  '<meta name="color-scheme" content="dark light">',
  '<title>Open-source licences · ' + escapeHtml(manifest.app.name) + '</title>',
  '<style>',
  ':root{color-scheme:dark;--bg:#111827;--panel:#1f2937;--text:#f3f4f6;--muted:#cbd5e1;--line:#475569;--accent:#7dd3fc}',
  '*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.55 system-ui,sans-serif}',
  'main{width:min(960px,100%);margin:auto;padding:calc(18px + env(safe-area-inset-top)) 16px 48px}',
  'a{color:var(--accent)}.back{display:inline-block;margin-bottom:18px}.scope{padding:14px;border:1px solid var(--line);border-radius:10px;background:#172033}',
  '.component{margin:16px 0;padding:16px;border:1px solid var(--line);border-radius:12px;background:var(--panel)}',
  'h1,h2{line-height:1.25}h2{font-size:1.15rem}dl{display:grid;grid-template-columns:minmax(90px,130px) 1fr;gap:5px 12px}dt{font-weight:700}dd{margin:0;min-width:0}',
  '.badges{display:flex;flex-wrap:wrap;gap:7px}.badges span{padding:3px 8px;border:1px solid var(--line);border-radius:999px;color:var(--muted);font-size:.8rem}',
  'code,pre{font-family:ui-monospace,SFMono-Regular,Consolas,monospace}pre{max-height:34rem;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;padding:12px;background:#0b1020;border-radius:8px}',
  'details{margin-top:10px}summary{cursor:pointer;font-weight:700}.licence{scroll-margin-top:12px;padding:12px;border-top:1px solid var(--line)}',
  '.package-table{overflow:auto}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:7px;border-bottom:1px solid var(--line);vertical-align:top}',
  '@media(max-width:520px){dl{grid-template-columns:1fr}dt{margin-top:7px}.component{padding:12px}}',
  '</style></head><body><main>',
  '<a class="back" href="./index.html">← Back to SciREPL</a>',
  '<h1>Open-source licences</h1>',
  '<p>Build profile: <strong>' + escapeHtml(profileName) + '</strong> · SciREPL '
    + escapeHtml(pkg.version) + ' · ' + manifest.components.length + ' components</p>',
  '<p class="scope"><strong>Inventory scope.</strong> ' + escapeHtml(manifest.scope)
    + ' Delivery labels describe the SciREPL Free <code>' + escapeHtml(profileName)
    + '</code> build. “Downloaded” components execute locally after retrieval. '
    + 'The versions shown are the exact pinned defaults; an explicit version or source override in Languages can load a different upstream artifact.</p>',
  componentsHtml,
  '<h1>Recorded licence texts and notices</h1>',
  '<p>Copyright notices appear with each component above. Canonical upstream links are provided where they are declared in the component manifest.</p>',
  licencesHtml,
  '</main></body></html>',
].join('\n') + '\n';

function componentMarkdown(component) {
  const meta = componentMeta(component);
  const lines = [
    '## ' + component.name,
    '',
    '- **Version:** ' + meta.version + (component.underlyingVersion ? ' (' + component.underlyingVersion + ')' : ''),
    '- **Delivery:** ' + meta.delivery,
    '- **Licence:** ' + component.licenseExpression
      + (component.distributedUnder ? ' (distributed under ' + component.distributedUnder + ')' : ''),
    '- **Source:** ' + component.sourceUrl,
    '- **Provenance:** ' + (meta.provenanceBasis || meta.provenance),
    '- **Copyright:** ' + (component.copyright || 'See upstream source'),
  ];
  if (component.correspondingSourceUrl) lines.push('- **Corresponding source:** ' + component.correspondingSourceUrl);
  if (component.upstreamSourceUrl) lines.push('- **Upstream source:** ' + component.upstreamSourceUrl);
  if (component.licenseUrl) lines.push('- **Upstream licence:** ' + component.licenseUrl);
  if (component.notes) lines.push('', component.notes);
  if (component.runtime?.sources?.length) {
    lines.push('', '**Pinned runtime sources:**');
    for (const source of component.runtime.sources) {
      lines.push('- ' + source.url.replaceAll('{version}', meta.version)
        .replaceAll('{versionTag}', component.versionTag || meta.version));
    }
  }
  if (component.packages?.length) {
    lines.push('', '| Package | Version | Licence | Source |', '|---|---:|---|---|');
    for (const item of component.packages) {
      lines.push('| ' + item.name + ' | ' + item.version + ' | ' + item.licenseExpression
        + ' | ' + item.sourceUrl + ' |');
    }
  }
  lines.push('');
  return lines.join('\n');
}

const tick = String.fromCharCode(96);
const markdown = [
  '# Open Source Attributions',
  '',
  'This file is generated from ' + tick + 'third-party-components.json' + tick + '. Do not edit it by hand.',
  '',
  '**Inventory scope:** ' + manifest.scope,
  '',
  '**Resolved build:** SciREPL ' + pkg.version + ', profile ' + tick + profileName + tick
    + ', ' + manifest.components.length + ' components.',
  '',
  'Versions below are the exact pinned defaults. A user-configured runtime version or source override can intentionally load a different upstream artifact.',
  '',
  ...manifest.components.map(componentMarkdown),
  '# Included licence texts',
  '',
  'The recorded licence texts and notices used by the offline in-app page are stored here:',
  '',
  ...Object.entries(manifest.licenseDocuments).map(([id, doc]) =>
    '- **' + id + ':** [' + tick + doc.path + tick + '](' + doc.path + ')'
      + (doc.url ? ' — ' + doc.url : '')),
  '',
  'The generated ' + tick + 'www/open-source-licenses.html' + tick
    + ' embeds these texts so they remain readable offline.',
  '',
].join('\n');

function writeOrCheck(file, expected) {
  if (CHECK) {
    const actual = existsSync(file) ? readFileSync(file, 'utf8') : '';
    if (actual !== expected) {
      fail(path.relative(ROOT, file) + ' is stale; run npm run licenses:generate');
    }
    return;
  }
  writeFileSync(file, expected);
  console.log('[licenses] wrote ' + path.relative(ROOT, file));
}

writeOrCheck(OUT_HTML, html);
writeOrCheck(OUT_MD, markdown);
console.log('[licenses] ' + manifest.components.length + ' components; profile ' + profileName
  + (CHECK ? '; generated files are current' : ''));
