/* Node-only fork reconciliation/guard tests; all writes stay in temp fixtures. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { canonicalJSON, parseShellHistory, reconcileShellHistories, sha256, usedShellVersions } from '../scripts/lib/sw-shell-history.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const digest = digit => digit.repeat(64);
const commit = digit => digit.repeat(40);
const legacy = (history = {}, reserved = []) => ({ reserved, history });
const proof = lock => ({ sourceLockSha256: sha256(canonicalJSON(lock)), lock });
const result = (command, args, cwd) => {
    try { return { status: 0, output: execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }; }
    catch (error) { return { status: error.status ?? 1, output: String(error.stdout || '') + String(error.stderr || '') }; }
};

function fixture() {
    const dir = mkdtempSync(path.join(tmpdir(), 'sw-reconciliation-'));
    mkdirSync(path.join(dir, 'scripts/lib'), { recursive: true });
    mkdirSync(path.join(dir, 'www'), { recursive: true });
    for (const file of ['scripts/check-sw-shell.mjs', 'scripts/reconcile-sw-shell-history.mjs', 'scripts/lib/sw-shell-history.mjs']) {
        copyFileSync(path.join(ROOT, file), path.join(dir, file));
    }
    const lock = path.join(dir, 'www/sw-shell.lock.json');
    const writeLock = value => writeFileSync(lock, canonicalJSON(value));
    const shell = (version, content) => {
        writeFileSync(path.join(dir, 'www/sw.js'), `const CACHE_VERSION = '${version}';\nconst APP_SHELL = ['./index.html'];\n`);
        writeFileSync(path.join(dir, 'www/index.html'), content);
    };
    const guard = (...args) => result(process.execPath, [path.join(dir, 'scripts/check-sw-shell.mjs'), ...args], dir);
    const reconcile = (...args) => result(process.execPath, [path.join(dir, 'scripts/reconcile-sw-shell-history.mjs'), ...args], dir);
    const git = (...args) => {
        const out = result('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'user.name=SW fixture',
            '-c', 'user.email=sw-fixture@example.invalid', ...args], dir);
        assert.equal(out.status, 0, out.output);
        return out.output.trim();
    };
    const snapshot = message => { git('add', '.'); git('commit', '-qm', message); return git('rev-parse', 'HEAD'); };
    const close = () => rmSync(dir, { recursive: true, force: true });
    return { dir, lock, writeLock, shell, guard, reconcile, git, snapshot, close };
}

function branchFixture() {
    const f = fixture();
    f.git('init', '-q');
    // The raw no-commit merge below also requires a committer identity. Keep it
    // inside this disposable repository, never in the developer's global config.
    f.git('config', '--local', 'user.name', 'SW fixture');
    f.git('config', '--local', 'user.email', 'sw-fixture@example.invalid');
    f.writeLock(legacy());
    f.shell('v245', 'base');
    assert.equal(f.guard('--write').status, 0);
    const base = f.snapshot('base history');
    f.git('checkout', '-qb', 'feature');
    for (const version of ['v246', 'v247', 'v253']) {
        f.shell(version, `feature ${version}`);
        assert.equal(f.guard('--write').status, 0);
    }
    const feature = f.snapshot('feature history');
    const featureRaw = readFileSync(f.lock, 'utf8');
    f.git('checkout', '-qb', 'canonical', base);
    for (const version of ['v246', 'v247']) {
        f.shell(version, `canonical ${version}`);
        assert.equal(f.guard('--write').status, 0);
    }
    const canonical = f.snapshot('canonical history');
    const canonicalRaw = readFileSync(f.lock, 'utf8');
    f.git('checkout', '--detach', feature);
    const args = ['--canonical', canonical, '--feature', feature];
    return { ...f, feature, canonical, featureRaw, canonicalRaw, args };
}

test('canonical pins and full conflicting feature proof are preserved without reassigning a source pin', () => {
    const canonical = legacy({ v245: digest('a'), v246: digest('b'), v247: digest('c') }, ['v129']);
    const feature = legacy({ v245: digest('a'), v246: digest('d'), v247: digest('e'), v253: digest('f') }, ['v129']);
    const merged = reconcileShellHistories(canonical, feature, { featureCommit: commit('1') });
    assert.deepEqual(merged.conflicts, ['v246', 'v247']);
    for (const [version, hash] of Object.entries(canonical.history)) assert.equal(merged.lock.history[version], hash);
    assert.equal(merged.lock.history.v253, digest('f'));
    assert.equal(canonicalJSON(merged.lock.archivedForks[commit('1')].lock), canonicalJSON(feature));
    assert.equal(merged.lock.archivedForks[commit('1')].sourceLockSha256, sha256(canonicalJSON(feature)));
    assert.deepEqual(parseShellHistory(canonicalJSON(merged.lock)), merged.lock);
    assert.equal(canonicalJSON(canonical), canonicalJSON(legacy({ v245: digest('a'), v246: digest('b'), v247: digest('c') }, ['v129'])));
    assert.throws(() => parseShellHistory(JSON.stringify(feature), { requireCanonical: true }), /canonical/);
});

test('invalid proof shapes, conflicting source proofs and reserved/recorded collisions fail closed', () => {
    const archive = legacy({ v10: digest('a') });
    const source = legacy({ v20: digest('b') });
    const malformed = [
        { ...source, archivedForks: [] },
        { ...source, archivedForks: { short: proof(archive) } },
        { ...source, archivedForks: { [commit('1')]: { ...proof(archive), unknown: true } } },
        { ...source, archivedForks: { [commit('1')]: { sourceLockSha256: digest('0'), lock: archive } } },
        { ...source, unknown: true },
        legacy({ v01: digest('a') }),
        legacy({ v9007199254740992: digest('a') }),
        legacy({ v20: 'bad hash' }),
        legacy({ v20: digest('a') }, ['v20']),
    ];
    for (const value of malformed) assert.throws(() => parseShellHistory(canonicalJSON(value)), /Invalid SW shell history/);
    const other = legacy({ v10: digest('c') });
    assert.throws(() => reconcileShellHistories({ ...source, archivedForks: { [commit('1')]: proof(archive) } },
        { ...legacy({ v30: digest('d') }), archivedForks: { [commit('1')]: proof(other) } },
        { featureCommit: commit('2') }), /conflicting archive proofs/);
    assert.throws(() => reconcileShellHistories(legacy({}, ['v20']), source, { featureCommit: commit('2') }), /reserved\/recorded/);
});

test('CLI is read-only by default, writes only in its pinned merge, and cannot erase a later integration pin', () => {
    const f = branchFixture();
    try {
        const before = readFileSync(f.lock, 'utf8');
        const dry = f.reconcile(...f.args);
        assert.equal(dry.status, 0, dry.output);
        assert.deepEqual(JSON.parse(dry.output).conflicts, ['v246', 'v247']);
        assert.equal(readFileSync(f.lock, 'utf8'), before);
        const absentMerge = f.reconcile(...f.args, '--write');
        assert.equal(absentMerge.status, 1);
        assert.match(absentMerge.output, /active merge/);
        assert.equal(readFileSync(f.lock, 'utf8'), before);
        assert.equal(f.reconcile('--canonical', 'HEAD', '--feature', f.feature).status, 1);
        assert.equal(f.reconcile('--canonical', commit('0'), '--feature', f.feature).status, 1);

        const merging = result('git', ['-c', 'core.hooksPath=/dev/null', 'merge', '--no-commit', '--no-ff', f.canonical], f.dir);
        assert.equal(merging.status, 1, 'the fixture must create real unmerged index stages: ' + merging.output);
        const pristineConflict = readFileSync(f.lock, 'utf8');
        assert.match(pristineConflict, /<<<<<<< /);
        const mergeHeadPath = path.resolve(f.dir, f.git('rev-parse', '--git-path', 'MERGE_HEAD'));
        const singleMergeHead = readFileSync(mergeHeadPath, 'utf8');
        writeFileSync(mergeHeadPath, singleMergeHead + f.feature + '\n');
        const octopusRefused = f.reconcile(...f.args, '--write');
        assert.equal(octopusRefused.status, 1);
        assert.match(octopusRefused.output, /exactly one canonical source SHA/);
        assert.equal(readFileSync(f.lock, 'utf8'), pristineConflict);
        writeFileSync(mergeHeadPath, singleMergeHead);
        const manuallyExtended = pristineConflict.replace('  "history": {', '  "history": {\n    "v999": "' + digest('9') + '",');
        assert.notEqual(manuallyExtended, pristineConflict);
        writeFileSync(f.lock, manuallyExtended);
        const manualRefused = f.reconcile(...f.args, '--write');
        assert.equal(manualRefused.status, 1);
        assert.match(manualRefused.output, /exact unmodified pinned two-parent Git conflict/);
        assert.equal(readFileSync(f.lock, 'utf8'), manuallyExtended, 'manually-added data must not be erased with conflict markers');
        writeFileSync(f.lock, pristineConflict);
        const wrongParents = f.reconcile('--canonical', f.feature, '--feature', f.canonical, '--write');
        assert.equal(wrongParents.status, 1);
        assert.match(wrongParents.output, /HEAD must equal/);
        const written = f.reconcile(...f.args, '--write');
        assert.equal(written.status, 0, written.output);
        const merged = parseShellHistory(readFileSync(f.lock, 'utf8'));
        const canonical = parseShellHistory(f.canonicalRaw);
        for (const [version, hash] of Object.entries(canonical.history)) assert.equal(merged.history[version], hash);
        assert.equal(canonicalJSON(merged.archivedForks[f.feature].lock), f.featureRaw);
        assert.equal(merged.archivedForks[f.feature].sourceLockSha256, sha256(f.featureRaw));
        assert.equal(f.reconcile(...f.args, '--write').status, 0, 'identical generated lock is an idempotent no-op');

        f.shell('v254', 'merged shell');
        assert.equal(f.guard('--write').status, 0);
        assert.equal(f.guard().status, 0);
        const appended = readFileSync(f.lock, 'utf8');
        const after = parseShellHistory(appended);
        assert.deepEqual(after.archivedForks, merged.archivedForks, 'ordinary appends preserve every source proof');
        assert.equal(after.history.v246, canonical.history.v246);
        assert.equal(after.history.v247, canonical.history.v247);
        const refused = f.reconcile(...f.args, '--write');
        assert.equal(refused.status, 1);
        assert.match(refused.output, /do not erase an appended integration pin/);
        assert.equal(readFileSync(f.lock, 'utf8'), appended);
    } finally { f.close(); }
});

test('guard validates archives before same-version no-op and never repairs malformed metadata silently', () => {
    const f = fixture();
    try {
        f.writeLock({ ...legacy(), archivedForks: { [commit('1')]: proof(legacy({ v200: digest('a') })) } });
        f.shell('v254', 'valid shell');
        assert.equal(f.guard('--write').status, 0);
        const valid = readFileSync(f.lock, 'utf8');
        assert.equal(f.guard('--write').status, 0);
        assert.equal(readFileSync(f.lock, 'utf8'), valid);
        const tampered = JSON.parse(valid);
        tampered.archivedForks[commit('1')].lock.history.v200 = digest('b');
        const unknown = JSON.parse(valid); unknown.archivedForks[commit('1')].unknown = 'must not disappear';
        const duplicatePin = valid.replace('  "history": {', '  "history": {\n    "v254": "' + digest('0') + '",');
        const duplicateProof = valid.replace('  "archivedForks": {', '  "archivedForks": {\n    "' + commit('1') + '": {},');
        for (const invalid of [canonicalJSON(tampered), canonicalJSON(unknown), duplicatePin, duplicateProof, '{broken json']) {
            writeFileSync(f.lock, invalid);
            assert.equal(f.guard().status, 1);
            assert.equal(f.guard('--write').status, 1);
            assert.equal(readFileSync(f.lock, 'utf8'), invalid);
        }
        writeFileSync(f.lock, valid);
        f.shell('v255', 'changed shell');
        assert.equal(f.guard('--write').status, 0);
        assert.deepEqual(parseShellHistory(readFileSync(f.lock, 'utf8')).archivedForks,
            parseShellHistory(valid).archivedForks);
    } finally { f.close(); }
});

test('archived-only recorded and reserved versions contribute to the monotonic floor', () => {
    const f = fixture();
    try {
        const source = legacy({ v1000: digest('a') }, ['v1001']);
        const lock = { ...legacy(), archivedForks: { [commit('1')]: proof(source) } };
        assert.equal(Math.max(...usedShellVersions(lock).map(version => Number(version.slice(1)))), 1001);
        f.writeLock(lock); f.shell('v300', 'below archived floor');
        assert.equal(f.guard('--write').status, 1);
        assert.equal(f.guard().status, 1);
        f.shell('v1002', 'above archived floor');
        assert.equal(f.guard('--write').status, 0);
        assert.equal(f.guard().status, 0);
    } finally { f.close(); }
});
