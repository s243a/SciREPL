/**
 * check-sw-shell.mjs — a changed app-shell asset must bump CACHE_VERSION.
 *
 *   node scripts/check-sw-shell.mjs           # verify (CI)
 *   node scripts/check-sw-shell.mjs --write   # record the current state
 *
 * The service worker keys its cache on CACHE_VERSION. If an app-shell file
 * changes but the version does not, browsers never see a new worker (the sw.js
 * bytes are unchanged), so clients keep serving the old asset — a silent
 * staleness bug. And within one version, a same-name cache is where a partial
 * install could otherwise mix old and new files.
 *
 * This records a hash of every APP_SHELL file against the version that shipped
 * it. If the hash changes while the version does not, the build fails: bump
 * CACHE_VERSION (and re-run with --write) whenever a shell asset changes.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const WWW = path.join(ROOT, 'www');
const SW = path.join(WWW, 'sw.js');
const LOCK = path.join(WWW, 'sw-shell.lock.json');

const sw = readFileSync(SW, 'utf8');

const versionMatch = sw.match(/const CACHE_VERSION = '([^']+)'/);
if (!versionMatch) {
    console.error('[sw] could not find CACHE_VERSION in sw.js');
    process.exit(2);
}
const version = versionMatch[1];

// Pull the APP_SHELL entries (quoted './...' paths in the array literal).
const shellBlock = sw.match(/const APP_SHELL = \[([\s\S]*?)\];/);
if (!shellBlock) {
    console.error('[sw] could not find APP_SHELL in sw.js');
    process.exit(2);
}
const shell = [...shellBlock[1].matchAll(/'(\.\/[^']+)'/g)].map((m) => m[1]).sort();

const hash = createHash('sha256');
hash.update(`v=${shell.length}\n`);
const missing = [];
for (const rel of shell) {
    const file = path.join(WWW, rel.replace(/^\.\//, ''));
    if (!existsSync(file)) { missing.push(rel); continue; }
    hash.update(rel + '\0');
    hash.update(readFileSync(file));
    hash.update('\0');
}
if (missing.length) {
    console.error('[sw] APP_SHELL lists files that do not exist:', missing.join(', '));
    process.exit(1);
}
const digest = hash.digest('hex');

if (process.argv.includes('--write')) {
    writeFileSync(LOCK, JSON.stringify({ version, shellHash: digest }, null, 2) + '\n');
    console.log(`[sw] recorded shell hash for ${version} (${shell.length} files).`);
    process.exit(0);
}

let lock = null;
try { lock = JSON.parse(readFileSync(LOCK, 'utf8')); } catch { /* missing */ }

if (!lock) {
    console.error('[sw] www/sw-shell.lock.json is missing. Run: node scripts/check-sw-shell.mjs --write');
    process.exit(1);
}

if (lock.shellHash === digest) {
    // Assets unchanged since the lock. Version may legitimately differ (a bump
    // with no asset change), so that alone is fine.
    console.log(`[sw] app shell unchanged since ${lock.version}; current ${version}. OK.`);
    process.exit(0);
}

// Assets changed. The version MUST have changed too, and the lock re-written.
if (lock.version === version) {
    console.error('[sw] an app-shell asset changed but CACHE_VERSION is still ' +
        `'${version}'.\n` +
        '     Bump CACHE_VERSION in www/sw.js, then run:\n' +
        '       node scripts/check-sw-shell.mjs --write\n' +
        '     Without a new version, browsers keep serving the old asset.');
    process.exit(1);
}

console.error('[sw] app-shell assets changed and CACHE_VERSION moved to ' +
    `'${version}', but the lock still records '${lock.version}'.\n` +
    '     Run: node scripts/check-sw-shell.mjs --write');
process.exit(1);
