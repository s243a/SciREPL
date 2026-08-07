/**
 * run-all.mjs — run the Electron shell's test suites.
 *
 *   node desktop/electron/test/run-all.mjs            # everything
 *   node desktop/electron/test/run-all.mjs --unit     # no Electron binary, no display
 *   node desktop/electron/test/run-all.mjs security persistence
 *
 * `--unit` selects only the suites that are pure Node, which is what a
 * cross-platform CI job can run without a display or a downloaded Electron
 * build. Everything else needs a real shell.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RESULTS_DIR = fileURLToPath(new URL('./results', import.meta.url));

/** `unit: true` means it needs neither a display nor the Electron binary. */
const SUITES = [
  { name: 'policy-unit', file: './policy.unit.test.mjs', unit: true },
  { name: 'shell-launch', file: './shell-launch.test.mjs', unit: false },
  { name: 'security', file: './security.test.mjs', unit: false },
  { name: 'artifact-boundary', file: './artifact-boundary.test.mjs', unit: false },
  { name: 'download', file: './download.test.mjs', unit: false },
  { name: 'persistence', file: './persistence.test.mjs', unit: false },
  { name: 'kernels', file: './kernels.test.mjs', unit: false },
  { name: 'offline', file: './offline.test.mjs', unit: false },
  // Not in the default set: it needs a built package, which most runs do not
  // have. Select it explicitly (`run-all.mjs packaged`) or via --packaged.
  { name: 'packaged', file: './packaged.test.mjs', unit: false, optIn: true },
];

const argv = process.argv.slice(2);
const unitOnly = argv.includes('--unit');
const withPackaged = argv.includes('--packaged');
const named = argv.filter(a => !a.startsWith('--'));

const selected = SUITES.filter(s => {
  if (named.length) return named.includes(s.name);
  if (unitOnly) return s.unit;
  // Opt-in suites need something the default run does not have (the `packaged`
  // suite needs a built package), so they are never part of a bare run.
  if (s.optIn) return withPackaged;
  return true;
});

if (selected.length === 0) {
  console.error(`No suites matched. Available: ${SUITES.map(s => s.name).join(', ')}`);
  process.exit(2);
}

const summaries = [];
let totalFailed = 0;

/**
 * If the shell cannot be launched at all, every Electron-dependent suite will
 * fail the same way after its own 120s launch timeout. That is ~12 minutes of
 * identical output that buries the one message worth reading, so the first
 * launch failure stops the rest from being attempted.
 */
let launchFailure = null;
const isLaunchFailure = (err) => String(err && err.message).includes('Failed to launch the Electron shell');

for (const suite of selected) {
  console.log(`\n=== ${suite.name} ===`);

  if (launchFailure && !suite.unit) {
    console.log('  [SKIP] not attempted — the shell failed to launch in an earlier suite.');
    summaries.push({ suiteName: suite.name, failed: 0, passed: 0, skipped: 1, notAttempted: true });
    continue;
  }

  try {
    const mod = await import(suite.file);
    const summary = await mod.default();
    summaries.push(summary);
    totalFailed += summary.failed;
  } catch (err) {
    console.log(`  [FAIL] suite crashed: ${err && err.stack ? err.stack : err}`);
    summaries.push({ suiteName: suite.name, failed: 1, passed: 0, skipped: 0, crashed: String(err) });
    totalFailed += 1;
    if (isLaunchFailure(err)) {
      launchFailure = err;
      console.log(
        '\n  The Electron shell could not be launched. Remaining shell suites will be\n' +
        '  skipped rather than repeating this failure. Run the diagnostic for the\n' +
        "  main process's own output:\n" +
        '    node desktop/electron/test/smoke.mjs'
      );
    }
  }
}

console.log('\n================ summary ================');
for (const s of summaries) {
  console.log(`  ${String(s.suiteName).padEnd(20)} ${s.passed} passed, ${s.failed} failed, ${s.skipped || 0} skipped`);
}
console.log(`  ${'TOTAL'.padEnd(20)} ${totalFailed} failed`);

mkdirSync(RESULTS_DIR, { recursive: true });
writeFileSync(
  path.join(RESULTS_DIR, 'summary.json'),
  JSON.stringify({ generatedAt: new Date().toISOString(), platform: process.platform, summaries }, null, 2)
);

process.exit(totalFailed > 0 ? 1 : 0);
