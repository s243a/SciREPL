/**
 * reporter.mjs — assertion/reporting helpers and repository paths.
 *
 * Deliberately free of any dependency, including Playwright. `policy.unit.test.mjs`
 * imports from here rather than from harness.mjs so the unit suite can run with
 * only `desktop/electron`'s own dependencies installed — that is what the
 * `shell-policy` CI job does, and it is why that job needs neither a display
 * nor the ~220 MB Electron download.
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';

// path.resolve() strips the trailing separator that fileURLToPath leaves on a
// directory URL. That matters: this path is passed to Electron as the app
// directory argument, and a Windows path ending in a backslash ("D:\...\electron\")
// is a hazard for command-line quoting.
export const ELECTRON_DIR = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
export const REPO_ROOT = path.resolve(ELECTRON_DIR, '..', '..');
export const WWW_ROOT = path.join(REPO_ROOT, 'www');

/** The origin the shell serves the application from. Mirrors protocol.js. */
export const APP_ORIGIN = 'app://scirepl';

/** Matches the reporting style of the repository's existing browser tests. */
export function createReporter(suiteName) {
  const results = [];
  let failed = 0;
  return {
    log(name, passed, detail = '') {
      if (!passed) failed++;
      results.push({ name, passed, detail });
      const mark = passed ? 'PASS' : 'FAIL';
      console.log(`  [${mark}] ${name}${detail ? ': ' + String(detail).trim().slice(0, 400) : ''}`);
    },
    /** Record a check that could not be executed here. Never counted as a pass. */
    skip(name, reason) {
      results.push({ name, passed: null, detail: reason });
      console.log(`  [SKIP] ${name}: ${reason}`);
    },
    summary() {
      const passed = results.filter(r => r.passed === true).length;
      const skipped = results.filter(r => r.passed === null).length;
      console.log(`\n${suiteName}: ${passed} passed, ${failed} failed, ${skipped} skipped`);
      return { suiteName, results, failed, passed, skipped };
    },
    get failed() { return failed; },
  };
}
