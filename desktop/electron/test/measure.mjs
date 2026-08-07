/**
 * measure.mjs — startup, memory and size measurements for the feasibility report.
 *
 * This is a measurement tool, not a pass/fail test, so it is not part of
 * run-all.mjs. Run it explicitly:
 *
 *   node desktop/electron/test/measure.mjs
 *   node desktop/electron/test/measure.mjs --with-python
 *
 * Numbers are written to test/results/measurements.json. They are specific to
 * the machine that produced them — quote them with the platform attached.
 */

import { existsSync, readdirSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchShell, waitForAppReady, WWW_ROOT, ELECTRON_DIR, REPO_ROOT } from './harness.mjs';
import { runKernel, KERNEL_CASES } from './probes/kernels.mjs';

const RESULTS_DIR = fileURLToPath(new URL('./results', import.meta.url));

function dirSize(dir) {
  if (!existsSync(dir)) return 0;
  let total = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    total += e.isDirectory() ? dirSize(p) : statSync(p).size;
  }
  return total;
}

const mb = (bytes) => Number((bytes / 1e6).toFixed(1));

const withPython = process.argv.includes('--with-python');

/* ---------------- static sizes ---------------- */

const sizes = {
  wwwTotalMB: mb(dirSize(WWW_ROOT)),
  wwwVendorMB: mb(dirSize(path.join(WWW_ROOT, 'vendor'))),
  electronRuntimeMB: mb(dirSize(path.join(ELECTRON_DIR, 'node_modules', 'electron', 'dist'))),
  shellSourceKB: Number((dirSize(path.join(REPO_ROOT, 'desktop', 'electron')) -
    dirSize(path.join(REPO_ROOT, 'desktop', 'electron', 'node_modules'))) / 1e3).toFixed(1),
  perVendor: {},
};
const vendorDir = path.join(WWW_ROOT, 'vendor');
if (existsSync(vendorDir)) {
  for (const e of readdirSync(vendorDir, { withFileTypes: true })) {
    if (e.isDirectory()) sizes.perVendor[e.name] = mb(dirSize(path.join(vendorDir, e.name)));
  }
}

console.log('--- sizes ---');
console.log(`  prepared www/            ${sizes.wwwTotalMB} MB (vendor: ${sizes.wwwVendorMB} MB)`);
console.log(`  Electron runtime (dist)  ${sizes.electronRuntimeMB} MB  [this platform only]`);
console.log(`  shell source             ${sizes.shellSourceKB} kB`);
for (const [k, v] of Object.entries(sizes.perVendor)) console.log(`    vendor/${k.padEnd(12)} ${v} MB`);

/* ---------------- runtime measurements ---------------- */

const t0 = Date.now();
const shell = await launchShell();
const launchMs = Date.now() - t0;

await waitForAppReady(shell.page);
const readyMs = Date.now() - t0;

const nav = await shell.page.evaluate(() => {
  const n = performance.getEntriesByType('navigation')[0];
  if (!n) return null;
  return {
    domContentLoadedMs: Math.round(n.domContentLoadedEventEnd),
    loadEventMs: Math.round(n.loadEventEnd),
    responseEndMs: Math.round(n.responseEnd),
  };
});

/** Aggregate Electron's own per-process metrics. */
async function metrics(label) {
  const raw = await shell.electronApp.evaluate(({ app }) => app.getAppMetrics());
  const byType = {};
  let totalKB = 0;
  for (const m of raw) {
    const kb = (m.memory && m.memory.workingSetSize) || 0;
    byType[m.type] = (byType[m.type] || 0) + kb;
    totalKB += kb;
  }
  const out = {
    label,
    processCount: raw.length,
    totalMB: Number((totalKB / 1024).toFixed(1)),
    byTypeMB: Object.fromEntries(Object.entries(byType).map(([k, v]) => [k, Number((v / 1024).toFixed(1))])),
  };
  console.log(`  ${label.padEnd(22)} ${out.totalMB} MB across ${out.processCount} processes  ${JSON.stringify(out.byTypeMB)}`);
  return out;
}

console.log('\n--- startup ---');
console.log(`  process launch -> first window   ${launchMs} ms`);
console.log(`  process launch -> app ready      ${readyMs} ms`);
if (nav) console.log(`  DOMContentLoaded (in page)       ${nav.domContentLoadedMs} ms`);

console.log('\n--- memory ---');
const memIdle = await metrics('idle (app loaded)');

const kernelMem = [];
if (withPython) {
  const python = KERNEL_CASES.find(k => k.lang === 'python');
  const res = await runKernel(shell.page, python);
  console.log(`  python init ${res.initMs} ms, exec ${res.execMs} ms`);
  kernelMem.push({ kernel: 'python', ...res, metrics: await metrics('after Pyodide') });
} else {
  console.log('  (pass --with-python to measure memory with a WASM kernel loaded)');
}

await shell.close();

mkdirSync(RESULTS_DIR, { recursive: true });
const report = {
  generatedAt: new Date().toISOString(),
  platform: `${process.platform}-${process.arch}`,
  note: 'Measured on the machine named above. Windows figures must be re-measured on Windows.',
  sizes,
  startup: { launchToFirstWindowMs: launchMs, launchToAppReadyMs: readyMs, navigation: nav },
  memory: { idle: memIdle, kernels: kernelMem },
};
writeFileSync(path.join(RESULTS_DIR, 'measurements.json'), JSON.stringify(report, null, 2));
console.log(`\nwritten to ${path.join(RESULTS_DIR, 'measurements.json')}`);
process.exit(0);
