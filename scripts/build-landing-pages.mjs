// Builds the Pro guide pages under www/pro/guides/ from their configs.
// Run with --check to verify the committed pages without changing them.
//
//   scripts/landing-pages/<slug>.json   page content (all copy lives here)
//   scripts/landing-pages/template.mjs  renderer
//   www/pro/guides/assets/              shared CSS and images (served as-is)
//   www/pro/guides/<slug>/index.html    generated page
//
// The pages live under /pro/ because the PWA service worker leaves pro/ and
// help/ to the network; anywhere else under /SciREPL/ is served cache-first.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderPage } from './landing-pages/template.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pagesDir = path.join(root, 'scripts/landing-pages');
const outDir = path.join(root, 'www/pro/guides');
const assetsDir = path.join(outDir, 'assets');
const check = process.argv.includes('--check');

const REQUIRED = ['slug', 'siteBase', 'brandHref', 'title', 'metaDescription', 'ogImage', 'eyebrow',
  'h1', 'lede', 'fineprint', 'chips', 'hero', 'play', 'sections', 'closing', 'footer'];

function validate(page, file) {
  const errors = [];
  for (const key of REQUIRED) if (page[key] === undefined) errors.push(`missing "${key}"`);
  if (page.title && page.title.length > 60) errors.push(`title is ${page.title.length} chars (keep ≤60 so search results do not truncate it)`);
  if (page.metaDescription && (page.metaDescription.length < 70 || page.metaDescription.length > 160)) {
    errors.push(`metaDescription is ${page.metaDescription.length} chars (aim for 70–160)`);
  }
  if (page.slug && !/^[a-z0-9-]+$/.test(page.slug)) errors.push('slug must be lowercase letters, digits and hyphens');
  if (page.slug === 'assets') errors.push('slug "assets" is reserved');
  if (page.siteBase && !page.siteBase.endsWith('/')) errors.push('siteBase must end with "/"');
  const images = [page.hero, ...(page.sections || []).flatMap((s) => (s.items || []).map((i) => i.image).filter(Boolean))];
  for (const img of images.filter(Boolean)) {
    if (!img.alt) errors.push(`image ${img.src} has no alt text`);
    if (!existsSync(path.join(assetsDir, img.src))) errors.push(`image not found: www/pro/guides/assets/${img.src}`);
  }
  if (page.ogImage && !existsSync(path.join(assetsDir, page.ogImage))) errors.push(`ogImage not found: www/pro/guides/assets/${page.ogImage}`);
  const ids = (page.sections || []).map((s) => s.id);
  if (new Set(ids).size !== ids.length) errors.push('duplicate section ids');
  if (errors.length) throw new Error(`${file}:\n  - ${errors.join('\n  - ')}`);
}

const outputs = [];
for (const file of readdirSync(pagesDir).filter((f) => f.endsWith('.json')).sort()) {
  const page = JSON.parse(readFileSync(path.join(pagesDir, file), 'utf8'));
  validate(page, file);
  outputs.push([path.join(outDir, page.slug, 'index.html'), renderPage(page)]);
}

if (check) {
  const stale = outputs.filter(([file, html]) => !existsSync(file) || readFileSync(file, 'utf8') !== html);
  if (stale.length) {
    console.error('Guide pages are out of date; run: node scripts/build-landing-pages.mjs');
    for (const [file] of stale) console.error(`  ${path.relative(root, file)}`);
    process.exit(1);
  }
  console.log(`Guide pages are up to date (${outputs.length}).`);
} else {
  for (const [file, html] of outputs) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, html);
    console.log(`wrote ${path.relative(root, file)}`);
  }
}
