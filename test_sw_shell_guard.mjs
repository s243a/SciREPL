// Node test: the service-worker shell-version guard cannot be bypassed.
//
//   node test_sw_shell_guard.mjs
//
// Runs scripts/check-sw-shell.mjs against a throwaway copy of www/ so it can
// mutate assets, sw.js and the lock without touching the real tree.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, cpSync, writeFileSync, readFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
let failures = 0;
const check = (name, ok, detail = '') => {
    if (!ok) failures++;
    console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ': ' + detail : ''}`);
};

// A sandbox that mirrors the repo layout the script expects (scripts/ + www/).
const sandbox = mkdtempSync(path.join(tmpdir(), 'sw-guard-'));
cpSync(path.join(ROOT, 'scripts'), path.join(sandbox, 'scripts'), { recursive: true });
cpSync(path.join(ROOT, 'www'), path.join(sandbox, 'www'), { recursive: true });
const SCRIPT = path.join(sandbox, 'scripts', 'check-sw-shell.mjs');
const SW = path.join(sandbox, 'www', 'sw.js');
const INDEX = path.join(sandbox, 'www', 'index.html');

const run = (args = []) => {
    try {
        const out = execFileSync('node', [SCRIPT, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        return { code: 0, out };
    } catch (e) {
        return { code: e.status ?? 1, out: (e.stdout || '') + (e.stderr || '') };
    }
};
const bumpVersion = (v) => writeFileSync(SW,
    readFileSync(SW, 'utf8').replace(/const CACHE_VERSION = '[^']+'/, `const CACHE_VERSION = '${v}'`));

try {
    // Baseline: the committed lock verifies clean.
    check('the committed lock verifies', run().code === 0);

    // Bypass 1: change an app-shell asset without bumping — check fails, and
    // --write REFUSES to overwrite the current version's hash.
    appendFileSync(INDEX, '\n<!-- mutate -->\n');
    check('changing an asset without a version bump fails the check', run().code === 1);
    check('--write refuses to overwrite the current version', run(['--write']).code === 1);

    // Bumping the version and appending is the sanctioned path.
    bumpVersion('v900');
    check('bumping the version lets --write append', run(['--write']).code === 0);
    check('after appending, the check passes', run().code === 0);

    // Bypass 2: change the WORKER LOGIC without a bump — still caught, because
    // sw.js content is part of the hash.
    appendFileSync(SW, '\n// worker logic change\n');
    check('changing sw.js logic without a bump fails the check', run().code === 1);
    check('--write still refuses under the same version', run(['--write']).code === 1);

    // Immutability: an existing version can never be reassigned a different hash,
    // even by hand-editing back to a used version string.
    bumpVersion('v134');   // an already-recorded version
    check('reusing a recorded version with different content fails', run().code === 1);
    check('--write will not rewrite a recorded version', run(['--write']).code === 1);

    // Rollback to a previously-DEPLOYED id that predates the history (v129, the
    // released version) must be rejected by both check and --write — the exact
    // bypass Sol reproduced, where --write appended v129 and CI then passed.
    bumpVersion('v129');
    check('rolling the worker back to a released id (v129) fails the check',
        run().code === 1);
    check('--write refuses to append a reserved/rolled-back id', run(['--write']).code === 1);

    // Any id at or below the monotonic floor is refused, recorded or not.
    bumpVersion('v100');
    check('a version below the floor is refused', run().code === 1 && run(['--write']).code === 1);
} finally {
    rmSync(sandbox, { recursive: true, force: true });
}

console.log(`\n${failures === 0 ? 'PASS: SW shell-guard tests passed!' : `FAIL: ${failures} check(s) failed`}`);
process.exit(failures > 0 ? 1 : 0);
