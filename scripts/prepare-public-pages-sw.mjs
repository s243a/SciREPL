#!/usr/bin/env node

// Public documentation can be published over the latest stable Free release.
// Older stable service workers bypass /pro/ but treat a new /help/ route as an
// app-shell request, which can leave documentation stale. Patch only that
// routing rule in the prepared Pages artifact. Give that byte-distinct worker
// its own derived cache version: stable workers deliberately delete their own
// cache during install, so reusing (for example) v208 could disturb a live v208
// client while this compatibility worker installs.

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const currentRule = /(?:const PUBLIC_PAGE_ROOTS\s*=\s*\[[^\]]*['"]help['"][^\]]*\]|const isPublicPageRequest\s*=\s*\[['"]pro['"],\s*['"]help['"]\])/s;
const oldRule = [
  '  if (isScopedAppRequest && url.pathname.startsWith(`${appScopePath}pro/`)) {',
  '    return;',
  '  }',
].join('\n');

const patchedRule = [
  "  const isPublicPageRequest = ['pro', 'help'].some(",
  '    (root) => scopedAppPath === root || scopedAppPath.startsWith(`${root}/`),',
  '  );',
  '  if (isScopedAppRequest && isPublicPageRequest) {',
  '    return;',
  '  }',
].join('\n');

export function preparePublicPagesServiceWorker(source, label = 'service worker') {
  if (currentRule.test(source)) return { changed: false, source };

  const occurrences = source.split(oldRule).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `Expected one legacy /pro/ public-page rule in ${label}; found ${occurrences}. `
        + 'Update this compatibility patch for the selected stable tag.',
    );
  }

  const versionMatches = [...source.matchAll(/const CACHE_VERSION = '([^']+)';/g)];
  if (versionMatches.length !== 1) {
    throw new Error(`Expected one CACHE_VERSION in ${label}; found ${versionMatches.length}.`);
  }
  const stableVersion = versionMatches[0][1];
  const pagesVersion = `${stableVersion}-pages-help1`;
  const preparedSource = source
    .replace(oldRule, patchedRule)
    .replace(
      `const CACHE_VERSION = '${stableVersion}';`,
      `const CACHE_VERSION = '${pagesVersion}';`,
    );

  return { changed: true, source: preparedSource };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const swPath = path.resolve(process.argv[2] || 'www/sw.js');
  const source = await readFile(swPath, 'utf8');
  const prepared = preparePublicPagesServiceWorker(source, swPath);
  if (prepared.changed) await writeFile(swPath, prepared.source);
  console.log(prepared.changed
    ? `[pages-sw] added /help/ bypass to ${swPath}`
    : `[pages-sw] ${swPath} already bypasses /help/`);
}
