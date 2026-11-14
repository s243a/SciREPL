// Offline safety/metadata gates for manual and release-labelled PR builds.
// These tests do not dispatch Actions or create/sign/upload any release.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { artifactLabel } from '../scripts/release-artifact-label.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const release = readFileSync(path.join(ROOT, '.github/workflows/build-release.yml'), 'utf8');
const ci = readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8');
let checks = 0;
const verify = (name, run) => { run(); checks++; console.log(`PASS ${name}`); };
function job(source, name) {
  const lines = source.split('\n'), start = lines.indexOf(`  ${name}:`);
  assert.ok(start >= 0, `Missing job ${name}`);
  const next = lines.findIndex((line, index) => index > start && /^  [\w-]+:$/.test(line));
  return lines.slice(start, next < 0 ? undefined : next).join('\n');
}
function step(source, name) {
  const lines = source.split('\n'), start = lines.indexOf(`      - name: ${name}`);
  assert.ok(start >= 0, `Missing step ${name}`);
  const next = lines.findIndex((line, index) => index > start && /^      - /.test(line));
  return lines.slice(start, next < 0 ? undefined : next).join('\n');
}
function allowed(source, eventName, refType, { action = 'synchronize', releaseLabel = true, label = '' } = {}) {
  const condition = source.match(/^    if: (.+)$/m)?.[1];
  assert.ok(condition, 'An explicit safety condition is required');
  const expression = condition.replace('github.event.pull_request.labels.*.name', 'github.event.pull_request.labels.map(x => x.name)');
  return runInNewContext(expression, {
    github: { event_name: eventName, ref_type: refType, event: {
      action, label: { name: label }, pull_request: { labels: releaseLabel ? [{ name: 'release' }] : [] },
    } }, contains: (values, value) => values.includes(value),
  });
}
const pkg = { version: '1.5.0' }, sha = 'f'.repeat(40);

verify('candidate filenames use exact version/SHA, never arbitrary branch names', () => {
  for (const event of ['pull_request', 'workflow_dispatch']) {
    assert.equal(artifactLabel(pkg, { GITHUB_EVENT_NAME: event, GITHUB_REF_TYPE: 'branch', GITHUB_REF_NAME: 'feat/a/b;echo unsafe', GITHUB_SHA: sha }), 'v1.5.0-candidate-ffffffffffff');
  }
  assert.equal(artifactLabel(pkg, { GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: 'v1.5.0', GITHUB_SHA: sha }), 'v1.5.0-candidate-ffffffffffff');
  assert.equal(artifactLabel(pkg, { GITHUB_EVENT_NAME: 'push', GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: 'v1.5.0' }), 'v1.5.0');
  assert.throws(() => artifactLabel(pkg, { GITHUB_EVENT_NAME: 'push', GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: 'v1.4.0' }), /does not match/);
  assert.throws(() => artifactLabel(pkg, { GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_SHA: '' }), /exact/);
  assert.throws(() => artifactLabel(pkg, { GITHUB_EVENT_NAME: 'push', GITHUB_REF_TYPE: 'branch', GITHUB_SHA: sha }), /Unsupported/);
});

verify('manual candidates cannot publish even when dispatched on a tag', () => {
  assert.match(release, /^  workflow_dispatch:$/m);
  const publish = job(release, 'publish');
  for (const event of ['push', 'pull_request', 'workflow_dispatch']) for (const ref of ['tag', 'branch']) {
    assert.equal(allowed(publish, event, ref), event === 'push' && ref === 'tag', `${event}/${ref}`);
  }
  assert.match(publish, /^    needs: build$/m);
  assert.match(publish, /^      contents: write$/m);
  assert.equal((release.match(/contents: write/g) || []).length, 1, 'Only the guarded publication job can write repository contents');
  assert.match(release, /^permissions:\n  contents: read$/m);
  assert.doesNotMatch(job(release, 'build'), /action-gh-release|deploy-pages|git (?:tag|push)/);
  assert.match(publish, /Verify downloaded asset hashes[\s\S]*sha256sum -c dist\/SHA256SUMS\.txt[\s\S]*Create Release/);
});

verify('the tagged/manual build still requires browser and packaged Windows gates', () => {
  const build = job(release, 'build'), windows = job(release, 'windows-portable');
  assert.match(build, /^    needs:\n      - test\n      - windows-portable$/m);
  assert.match(windows, /^    needs: test$/m);
  assert.match(windows, /npm run package:windows[\s\S]*node desktop\/electron\/test\/run-all\.mjs packaged[\s\S]*actions\/upload-artifact@/);
  assert.doesNotMatch(step(windows, 'Verify the packaged application'), /continue-on-error|always\(|\|\|/);
  assert.match(job(release, 'test'), /npm run test:tutorial-links/);
  assert.match(job(release, 'test'), /node tests\/test_android_candidate\.mjs && node tests\/test_candidate_workflow\.mjs/);
});

verify('Android validation gates every upload and the pushed tag gains a Play AAB', () => {
  const build = job(release, 'build');
  assert.match(build, /\.\/gradlew assembleRelease bundleRelease/);
  assert.match(build, /test ! -e android\/release-signing\.properties/);
  for (const key of ['STORE_FILE', 'STORE_PASSWORD', 'KEY_ALIAS', 'KEY_PASSWORD']) assert.match(build, new RegExp(`SCIREPL_RELEASE_${key}: ''`));
  const validate = step(build, 'Validate unsigned Free Android artifacts');
  assert.match(validate, /--aab android\/app\/build\/outputs\/bundle\/release\/app-release\.aab/);
  assert.match(validate, /--apk android\/app\/build\/outputs\/apk\/release\/app-release-unsigned\.apk/);
  assert.doesNotMatch(validate, /continue-on-error|always\(|\|\||^        if:/m);
  assert.ok(build.indexOf('Validate unsigned Free Android artifacts') < build.indexOf('Upload tested unsigned assets'));
  const upload = step(build, 'Upload tested unsigned assets');
  assert.match(upload, /if-no-files-found: error/);
  assert.doesNotMatch(upload, /continue-on-error|always\(|^        if:/m);
  assert.match(job(release, 'publish'), /dist\/SciREPL-\$\{\{ github\.ref_name \}\}-play-unsigned\.aab/);
  assert.match(job(release, 'publish'), /fail_on_unmatched_files: true/);
});

verify('prepared version-specific notes are required, hashed and used as the release body', () => {
  const build = job(release, 'build'), publish = job(release, 'publish');
  const staging = step(build, 'Stage prepared GitHub release notes');
  const hash = step(build, 'Hash the candidate assets');
  assert.match(staging, /docs\/releases\/\$\{release_version\}-github-notes\.txt/);
  assert.match(staging, /test -s/);
  assert.doesNotMatch(staging, /continue-on-error|always\(|\|\||^        if:/m);
  assert.ok(build.indexOf('Stage prepared GitHub release notes') < build.indexOf('Upload tested unsigned assets'));
  assert.match(hash, /dist\/RELEASE_NOTES\.md/);
  assert.match(publish, /^          body_path: dist\/RELEASE_NOTES\.md$/m);
  assert.match(publish, /^            dist\/RELEASE_NOTES\.md$/m, 'The notes named by SHA256SUMS are also a release asset');
  assert.doesNotMatch(publish, /^          body: \|$/m);

  const fixture = mkdtempSync(path.join(tmpdir(), 'scirepl-candidate-notes-'));
  const script = staging.match(/^        run: \|\n([\s\S]*)$/m)?.[1].split('\n').map(line => line.startsWith('          ') ? line.slice(10) : line).join('\n');
  const command = source => spawnSync('bash', ['-e', '-o', 'pipefail', '-c', source], {
    cwd: fixture, encoding: 'utf8', timeout: 10_000,
    env: { ...process.env, PATH: `${path.dirname(process.execPath)}:${process.env.PATH}` },
  });
  try {
    writeFileSync(path.join(fixture, 'package.json'), JSON.stringify(pkg));
    mkdirSync(path.join(fixture, 'dist'));
    mkdirSync(path.join(fixture, 'docs/releases'), { recursive: true });
    const destination = path.join(fixture, 'dist/RELEASE_NOTES.md');
    assert.notEqual(command(script).status, 0, 'Missing prepared notes must fail the build');
    assert.equal(existsSync(destination), false);
    writeFileSync(path.join(fixture, 'docs/releases/1.4.0-github-notes.txt'), 'Wrong version');
    assert.notEqual(command(script).status, 0, 'Never inherit previous-version notes');
    const notes = '# SciREPL Free 1.5.0\nPrepared candidate notes.\n';
    writeFileSync(path.join(fixture, 'docs/releases/1.5.0-github-notes.txt'), notes);
    assert.equal(command(script).status, 0);
    assert.equal(readFileSync(destination, 'utf8'), notes);
    for (const extension of ['aab', 'apk', 'zip']) writeFileSync(path.join(fixture, `dist/fixture.${extension}`), extension);
    const hashCommand = hash.match(/^        run: (.+)$/m)?.[1];
    assert.equal(command(hashCommand).status, 0);
    assert.equal(command('sha256sum -c dist/SHA256SUMS.txt').status, 0);
    writeFileSync(destination, 'Changed notes');
    assert.notEqual(command('sha256sum -c dist/SHA256SUMS.txt').status, 0, 'Downloaded-note tampering fails the publication hash gate');
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

verify('platform PR packaging is opt-in, and label events cannot replace core results', () => {
  assert.match(ci, /^    types: \[opened, synchronize, reopened\]$/m);
  for (const name of ['windows-candidate', 'android-candidate']) {
    const source = job(ci, name);
    assert.equal(allowed(source, 'pull_request', 'branch'), true);
    assert.equal(allowed(source, 'pull_request', 'branch', { releaseLabel: false }), false);
    assert.equal(allowed(source, 'push', 'branch'), false);
    assert.equal(allowed(source, 'workflow_dispatch', 'branch'), false);
    assert.match(source, /^    needs: \[test, test-runtimes, test-ui, pwa-release\]$/m);
    assert.match(source, /^      contents: read$/m);
    assert.doesNotMatch(source, /action-gh-release|deploy-pages|git (?:tag|push)|jarsigner|apksigner sign|npx playwright install/);
  }
  for (const name of ['test', 'test-runtimes', 'test-ui', 'pwa-release']) {
    assert.doesNotMatch(job(ci, name), /^    if:/m, `${name} must run normally, not overwrite a prior failure with a label-based skip`);
  }
});

verify('release-labelled PR assets cannot skip actual Windows package or AAB checks', () => {
  const windows = job(ci, 'windows-candidate'), android = job(ci, 'android-candidate');
  assert.match(windows, /npm run package:windows[\s\S]*node desktop\/electron\/test\/run-all\.mjs packaged[\s\S]*Upload tested Windows candidate/);
  assert.doesNotMatch(step(windows, 'Verify the actual packaged Windows application'), /continue-on-error|always\(|\|\|/);
  assert.match(step(windows, 'Upload tested Windows candidate'), /if-no-files-found: error/);
  assert.match(android, /\.\/gradlew assembleRelease bundleRelease/);
  assert.match(android, /test ! -e android\/release-signing\.properties/);
  const validate = step(android, 'Validate unsigned Free Android candidate');
  assert.match(validate, /--aab[^\n]+app-release\.aab/);
  assert.match(validate, /--apk[^\n]+app-release-unsigned\.apk/);
  assert.match(validate, /dist\/ANDROID_VALIDATION\.json/);
  assert.doesNotMatch(validate, /continue-on-error|always\(|\|\||^        if:/m);
  assert.ok(android.indexOf('Validate unsigned Free Android candidate') < android.indexOf('Upload validated unsigned Android candidate'));
  assert.doesNotMatch(step(android, 'Upload validated unsigned Android candidate'), /continue-on-error|always\(|^        if:/m);
});

console.log(`Candidate workflow: ${checks} offline boundary groups passed.`);
