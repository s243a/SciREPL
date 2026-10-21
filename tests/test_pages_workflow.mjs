// Exercise the real Pages preparation/selection shell with offline Git fixtures.
// No browser, downloads, provider requests, runtime edits or live deployments.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workflow = readFileSync(path.join(ROOT, '.github/workflows/deploy-pages.yml'), 'utf8');
const ci = readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8');
let checks = 0;
const verify = (name, fn) => { fn(); checks++; console.log(`PASS ${name}`); };

function step(name) {
  const start = workflow.indexOf(`      - name: ${name}\n`);
  assert.ok(start >= 0, `Missing workflow step: ${name}`);
  const next = workflow.indexOf('\n      - ', start + 1);
  const source = workflow.slice(start, next < 0 ? undefined : next);
  const block = source.match(/^        run: \|\n((?:(?:          .*|)\n)+)/m);
  return {
    source,
    run: block ? block[1].split('\n').map(line => line.startsWith('          ')
      ? line.slice(10) : line).join('\n')
      : source.match(/^        run: (.+)$/m)?.[1],
  };
}

const prepare = step('Validate and keep public-page updates on the latest stable Free release');
const locate = step('Locate the test suites for this ref');
const pwa = step('Run PWA offline catalog tests');
const upload = step('Upload tested Pages artifact');

function command(program, args, cwd, env = {}) {
  return spawnSync(program, args, { cwd, encoding: 'utf8',
    env: { ...process.env, ...env }, timeout: 15_000, maxBuffer: 1024 * 1024 });
}
function git(args, cwd) {
  const result = command('git', ['-c', 'user.name=Offline Pages Fixture',
    '-c', 'user.email=offline-pages-fixture@example.invalid', '-c', 'commit.gpgSign=false',
    '-c', 'core.hooksPath=/dev/null', ...args], cwd);
  assert.equal(result.status, 0, `Fixture Git ${args[0]} failed: ${result.stderr}`);
  return result.stdout.trim();
}
function put(repo, file, text) {
  const destination = path.join(repo, file);
  mkdirSync(path.dirname(destination), { recursive: true });
  writeFileSync(destination, text);
}

function fixture({ pwaLayout = 'tests', cellLayout = 'tests', failingPwa = false } = {}, test) {
  const temporary = mkdtempSync(path.join(tmpdir(), 'scirepl-pages-workflow-'));
  const repo = path.join(temporary, 'repo');
  const runner = path.join(temporary, 'runner');
  const envFile = path.join(temporary, 'github-env');
  mkdirSync(repo); mkdirSync(runner); writeFileSync(envFile, '');
  const stablePwa = `process.stdout.write('stable-pwa-${pwaLayout}\\n');\n${failingPwa ? 'process.exitCode = 23;\n' : ''}`;
  const mainPwa = "throw new Error('new-main-runtime-regression-must-not-run-on-stable');\n";
  try {
    git(['init', '-b', 'main'], repo);
    put(repo, 'www/js/runtime.js', 'stable-runtime-bytes\n');
    put(repo, 'www/help/index.html', 'stable-help\n');
    put(repo, 'www/pro/index.html', 'stable-pro\n');
    put(repo, 'scripts/prepare-public-pages-sw.mjs', 'stable-helper\n');
    put(repo, `${cellLayout === 'root' ? '' : 'tests/'}test_cell_ops.mjs`, 'stable-cell-ops\n');
    if (pwaLayout === 'tests' || pwaLayout === 'both') put(repo, 'tests/test_pwa_release.mjs', stablePwa);
    if (pwaLayout === 'root' || pwaLayout === 'both') put(repo, 'test_pwa_release.mjs',
      pwaLayout === 'both' ? "throw new Error('prefer-tests-suite');\n" : stablePwa);
    git(['add', '.'], repo); git(['commit', '-m', 'Stable fixture'], repo);
    const stableCommit = git(['rev-parse', 'HEAD'], repo);
    git(['tag', 'v1.4.0'], repo);
    put(repo, 'www/js/runtime.js', 'new-main-runtime-must-not-publish\n');
    put(repo, 'www/help/index.html', 'new-public-help\n');
    put(repo, 'www/pro/index.html', 'new-public-pro\n');
    put(repo, 'tests/test_help_site.mjs', 'new-help-suite\n');
    put(repo, 'tests/test_pwa_release.mjs', mainPwa);
    put(repo, 'scripts/prepare-public-pages-sw.mjs', 'new-public-sw-helper\n');
    git(['add', '.'], repo); git(['commit', '-m', 'Newer main fixture'], repo);
    // A newer prerelease is not a stable publication base.
    git(['tag', 'v9.0.0-beta.1'], repo);
    const env = { RUNNER_TEMP: runner, GITHUB_ENV: envFile };
    const runPrepare = () => command('bash', ['-c', prepare.run], repo, env);
    const runLocate = () => command('bash', ['-c', locate.run], repo, env);
    const selectedEnv = () => Object.fromEntries(readFileSync(envFile, 'utf8').trim()
      .split('\n').filter(Boolean).map(line => line.split('=')));
    test({ repo, stablePwa, mainPwa, stableCommit, env, runPrepare, runLocate,
      selectedEnv, runPwa: () => command(process.execPath, [
        path.join(selectedEnv().PWA_TEST_DIR, 'test_pwa_release.mjs'),
      ], repo) });
  } finally {
    // Only the exact disposable directory created above is removed.
    rmSync(temporary, { recursive: true, force: true });
  }
}

verify('main publication keeps its stable-tag boundary and fresh Help/helper overlay', () => {
  assert.match(prepare.source, /^        if: github\.ref == 'refs\/heads\/main'$/m);
  assert.match(prepare.run, /git checkout --detach "\$\{stable_tag\}"/);
  assert.doesNotMatch(prepare.run, /cp[^\n]*test_pwa_release\.mjs/);
  assert.match(prepare.run, /cp "\$\{pages_overlay\}\/test_help_site\.mjs" tests\/test_help_site\.mjs/);
  assert.match(prepare.run, /cp "\$\{pages_overlay\}\/scripts\/prepare-public-pages-sw\.mjs" scripts\/prepare-public-pages-sw\.mjs/);
});

verify('publication-validation changes trigger main Pages publication', () => {
  const paths = workflow.match(/^    paths:\n((?:      - [^\n]+\n)+)/m)?.[1] || '';
  for (const required of ['www/help/**', 'www/pro/**', '.github/workflows/deploy-pages.yml',
    'scripts/prepare-public-pages-sw.mjs', 'tests/test_help_site.mjs']) {
    assert.ok(paths.includes(`      - '${required}'\n`), `Missing Pages push path: ${required}`);
  }
});

verify('PWA failures block the upload; main CI keeps its own newer runtime suite', () => {
  assert.equal(pwa.run, 'node "$PWA_TEST_DIR/test_pwa_release.mjs"');
  assert.doesNotMatch(pwa.source, /continue-on-error|\|\||skipp?ed/i);
  assert.match(upload.source, /path: www/);
  assert.doesNotMatch(upload.source, /if:.*always\(/);
  assert.match(workflow, /  deploy:\n    needs: test\n/);
  assert.match(ci, /name: Pages workflow — stable runtime and matching PWA validation\n        run: node tests\/test_pages_workflow\.mjs/);
  assert.match(ci, /name: PWA offline\/release regression\n        run: node tests\/test_pwa_release\.mjs/);
});

for (const options of [
  { pwaLayout: 'tests', cellLayout: 'tests' },
  { pwaLayout: 'root', cellLayout: 'root' },
  { pwaLayout: 'root', cellLayout: 'tests' },
  { pwaLayout: 'both', cellLayout: 'tests' },
]) verify(`real overlay shell preserves stable PWA bytes (${options.pwaLayout}; ordinary ${options.cellLayout})`, () => {
  fixture(options, f => {
    const result = f.runPrepare();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(git(['rev-parse', 'HEAD'], f.repo), f.stableCommit);
    assert.equal(readFileSync(path.join(f.repo, 'www/js/runtime.js'), 'utf8'), 'stable-runtime-bytes\n');
    assert.equal(readFileSync(path.join(f.repo, 'www/help/index.html'), 'utf8'), 'new-public-help\n');
    assert.equal(readFileSync(path.join(f.repo, 'www/pro/index.html'), 'utf8'), 'new-public-pro\n');
    assert.equal(readFileSync(path.join(f.repo, 'tests/test_help_site.mjs'), 'utf8'), 'new-help-suite\n');
    assert.equal(readFileSync(path.join(f.repo, 'scripts/prepare-public-pages-sw.mjs'), 'utf8'), 'new-public-sw-helper\n');
    const selected = f.runLocate();
    assert.equal(selected.status, 0, selected.stderr);
    assert.equal(f.selectedEnv().PWA_TEST_DIR, options.pwaLayout === 'root' ? '.' : 'tests');
    assert.equal(f.selectedEnv().PAGES_TEST_DIR, 'tests');
    const pwaFile = path.join(f.repo, f.selectedEnv().PWA_TEST_DIR, 'test_pwa_release.mjs');
    assert.equal(readFileSync(pwaFile, 'utf8'), f.stablePwa);
    assert.notEqual(readFileSync(pwaFile, 'utf8'), f.mainPwa);
    const executed = f.runPwa();
    assert.equal(executed.status, 0, executed.stderr);
    assert.match(executed.stdout, /stable-pwa-/);
  });
});

verify('the selected tag path locates and runs its own PWA suite without overlay', () => {
  fixture({ pwaLayout: 'root', cellLayout: 'tests' }, f => {
    git(['checkout', '--detach', 'v1.4.0'], f.repo);
    assert.equal(f.runLocate().status, 0);
    assert.equal(f.selectedEnv().PWA_TEST_DIR, '.');
    assert.equal(f.runPwa().status, 0);
  });
});

verify('a missing stable PWA suite fails clearly instead of inheriting main or skipping', () => {
  fixture({ pwaLayout: 'absent' }, f => {
    assert.equal(f.runPrepare().status, 0);
    const result = f.runLocate();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Required PWA release suite is missing from the selected ref/);
    assert.equal(f.selectedEnv().PWA_TEST_DIR, undefined);
  });
});

verify('a failing selected stable PWA suite remains a hard failure', () => {
  fixture({ failingPwa: true }, f => {
    assert.equal(f.runPrepare().status, 0);
    assert.equal(f.runLocate().status, 0);
    assert.equal(f.runPwa().status, 23);
  });
});

console.log(`Pages workflow: ${checks} offline regression groups passed.`);
