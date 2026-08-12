#!/usr/bin/env node
/** Verify that release metadata has one authoritative version: package.json. */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const readJson = (name) => JSON.parse(readFileSync(path.join(ROOT, name), 'utf8'));
const pkg = readJson('package.json');
const lock = readJson('package-lock.json');
const manifest = readJson('third-party-components.json');
const highlightSandbox = { window: {} };
vm.runInNewContext(
  readFileSync(path.join(ROOT, 'www/js/release_highlights.js'), 'utf8'),
  highlightSandbox,
  { filename: 'www/js/release_highlights.js' },
);
const highlights = highlightSandbox.window.SCIREPL_RELEASE_HIGHLIGHTS;

function fail(message) {
  console.error('[release-version] ' + message);
  process.exit(1);
}

if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(String(pkg.version))) {
  fail('package.json version is not a supported semantic version: ' + pkg.version);
}
if (!Number.isInteger(pkg.android?.versionCode) || pkg.android.versionCode < 1) {
  fail('package.json android.versionCode must be a positive integer');
}
if (!['development', 'release'].includes(pkg.releaseChannel)) {
  fail("package.json releaseChannel must be 'development' or 'release'");
}
if (lock.version !== pkg.version || lock.packages?.['']?.version !== pkg.version) {
  fail('package-lock.json root version does not match package.json ' + pkg.version);
}
const appComponent = manifest.components?.find((component) => component.id === 'scirepl');
if (appComponent?.versionFrom !== 'package.json') {
  fail('the scirepl component must resolve its version from package.json');
}
if (!highlights || !Array.isArray(highlights.unreleased)) {
  fail('www/js/release_highlights.js must define an unreleased highlight list');
}

// Published notes are history, not a scratch area for the next release.
const frozen110 = [
  'whatsNew.highlightLanguages',
  'whatsNew.highlightOffline',
  'whatsNew.highlightDesktop',
];
if (JSON.stringify(Array.from(highlights['1.1.0'] || [])) !== JSON.stringify(frozen110)) {
  fail('the frozen SciREPL 1.1.0 highlight history changed');
}

if (pkg.releaseChannel === 'development') {
  if (highlights.unreleased.length === 0) {
    fail('development channel has no unreleased highlights to show');
  }
} else {
  if (!Array.isArray(highlights[pkg.version]) || highlights[pkg.version].length === 0) {
    fail(`release channel needs frozen highlights for ${pkg.version}`);
  }
  if (highlights.unreleased.length !== 0) {
    fail('release channel requires the unreleased highlight list to be empty');
  }
}

const explicit = process.argv.find((arg) => arg.startsWith('--tag='))?.slice('--tag='.length);
const envTag = process.env.GITHUB_REF_TYPE === 'tag'
  ? process.env.GITHUB_REF_NAME
  : process.env.GITHUB_REF?.replace(/^refs\/tags\//, '') !== process.env.GITHUB_REF
    ? process.env.GITHUB_REF.replace(/^refs\/tags\//, '')
    : '';
const tag = explicit || envTag;
if (tag && tag !== 'v' + pkg.version) {
  fail('release tag ' + tag + ' does not match package.json v' + pkg.version);
}
if (tag && pkg.releaseChannel !== 'release') {
  fail('tagged builds require package.json releaseChannel to be release');
}

console.log('[release-version] SciREPL ' + pkg.version + ', Android versionCode '
  + pkg.android.versionCode + ', ' + pkg.releaseChannel + ' channel'
  + (tag ? ', tag ' + tag : '') + ' — OK');
