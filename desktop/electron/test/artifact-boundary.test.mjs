/**
 * artifact-boundary.test.mjs — the spike must contain only Free material.
 *
 * The brief is explicit that this Phase 0 shell may not carry Pro content, Pro
 * feature flags, entitlement logic or commerce code. That is easy to state and
 * easy to violate accidentally later (a profile default flipped, a bundled
 * runtime added), so it is asserted here rather than left to review.
 *
 * The Free/Pro difference in this repository is concrete and checkable:
 * build-profiles.json defines a `pro` profile whose only distinction is that it
 * bundles the R/webR runtime offline (~50 MB) instead of loading it from a CDN.
 * So "is this a Free artifact?" reduces to: the configured profile is not `pro`,
 * and no offline R runtime is present in the tree the shell serves.
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { launchShell, createReporter, waitForAppReady, REPO_ROOT, WWW_ROOT } from './harness.mjs';

/** Recursively total a directory's size, or 0 if it does not exist. */
function dirSize(dir) {
  if (!existsSync(dir)) return 0;
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    total += entry.isDirectory() ? dirSize(p) : statSync(p).size;
  }
  return total;
}

export default async function run() {
  const r = createReporter('artifact-boundary');

  /* ---------------- static checks on the served tree ---------------- */

  const profiles = JSON.parse(readFileSync(path.join(REPO_ROOT, 'build-profiles.json'), 'utf8'));
  const configured = readFileSync(path.join(WWW_ROOT, 'js', 'kernel_config.js'), 'utf8');
  const profileMatch = configured.match(/["']?profile["']?\s*:\s*["']([^"']+)["']/);
  const activeProfile = profileMatch ? profileMatch[1] : null;

  r.log('a build profile is configured', activeProfile !== null, String(activeProfile));
  r.log('the configured profile is not the Pro profile',
    activeProfile !== 'pro', String(activeProfile));
  r.log('the configured profile is one of the Free profiles',
    ['mini', 'light', 'full'].includes(activeProfile), String(activeProfile));

  // The Pro differentiator: R bundled offline.
  const webrDir = path.join(WWW_ROOT, 'vendor', 'webr');
  const webrBytes = dirSize(webrDir);
  r.log('no offline R/webR runtime is bundled (that is the Pro profile)',
    webrBytes === 0, webrBytes ? `${(webrBytes / 1e6).toFixed(1)} MB present` : 'absent');

  const proBundled = (profiles.profiles?.pro?.bundle) || [];
  r.log('build-profiles.json still describes Pro as the R-bundling profile',
    proBundled.includes('r'), JSON.stringify(proBundled));

  /* ---------------- no entitlement/commerce code in the shell ---------------- */

  // Scan the shell's *source*, not its tests. `test/` is excluded because this
  // very file necessarily contains the forbidden patterns as literals in order
  // to search for them, and would otherwise match itself.
  const shellDir = path.join(REPO_ROOT, 'desktop', 'electron');
  const shellFiles = [];
  (function walk(dir) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === 'test') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(js|mjs|cjs)$/.test(e.name)) shellFiles.push(p);
    }
  })(shellDir);

  r.log('shell source files were found to scan', shellFiles.length >= 4,
    shellFiles.map(f => path.basename(f)).join(', '));

  // Look for an *implemented* entitlement check, not a mention in a comment.
  const forbidden = [
    { re: /StoreContext\s*\.\s*GetAppLicenseAsync\s*\(/, what: 'Microsoft Store licence call' },
    { re: /\bisPro\s*[:=]\s*(true|1)\b/, what: 'hardcoded isPro flag' },
    { re: /requestPurchase|InAppPurchase|purchaseAppAsync/, what: 'commerce API call' },
  ];
  for (const { re, what } of forbidden) {
    const hits = shellFiles.filter((f) => {
      const src = readFileSync(f, 'utf8');
      // Strip comments so documenting the future seam is allowed.
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      return re.test(code);
    });
    r.log(`the shell source implements no ${what}`, hits.length === 0,
      hits.map(f => path.relative(REPO_ROOT, f)).join(', '));
  }

  /* ---------------- runtime checks ---------------- */

  const shell = await launchShell();
  try {
    await waitForAppReady(shell.page);

    const dist = await shell.page.evaluate(() => window.sciREPLPlatform.getDistributionInfo());
    r.log('the running shell reports the Free edition', dist.edition === 'free', JSON.stringify(dist));
    r.log('the running shell reports no Store entitlement', dist.store === null);
    r.log('the running shell reports a Free profile', dist.profile !== 'pro', dist.profile);

    // R must still be *available* in Free — via CDN, not bundled.
    const rSource = await shell.page.evaluate(() => {
      const cfg = window.KERNEL_CONFIG || { languages: {} };
      const r = cfg.languages.r || {};
      return { enabled: !!r.enabled, runtime: r.runtime, localUrl: r.localUrl || null };
    });
    r.log('R is enabled in Free', rSource.enabled === true, JSON.stringify(rSource));
    r.log('R is configured as a CDN runtime in Free, not a bundled one',
      rSource.runtime === 'cdn', JSON.stringify(rSource));
  } finally {
    await shell.close();
  }

  return r.summary();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().then(s => process.exit(s.failed > 0 ? 1 : 0));
}
