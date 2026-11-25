/** Resolve an active two-parent history merge without losing either pin set. */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, lstatSync, mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { canonicalJSON, commitPattern, parseShellHistory, reconcileShellHistories } from './lib/sw-shell-history.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const REL = 'www/sw-shell.lock.json';
const FILE = path.join(ROOT, REL);
const git = args => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd();

function isPristineConflict(current, stages) {
    const base = stages.find(match => match && match[3] === '1');
    const ours = stages.find(match => match && match[3] === '2');
    const theirs = stages.find(match => match && match[3] === '3');
    if (stages.length !== 3 || !base || !ours || !theirs) return false;
    const oursLabels = [...current.matchAll(/^<<<<<<< (.+)$/gm)].map(match => match[1]);
    const theirsLabels = [...current.matchAll(/^>>>>>>> (.+)$/gm)].map(match => match[1]);
    if (!oursLabels.length || !theirsLabels.length || oursLabels.some(label => label !== oursLabels[0])
        || theirsLabels.some(label => label !== theirsLabels[0])) return false;
    const temporary = mkdtempSync(path.join(tmpdir(), 'sw-shell-merge-proof-'));
    try {
        const files = ['ours.json', 'base.json', 'theirs.json'].map(name => path.join(temporary, name));
        for (const [index, stage] of [ours, base, theirs].entries()) {
            const bytes = execFileSync('git', ['cat-file', 'blob', stage[2]], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
            writeFileSync(files[index], bytes);
        }
        let expected;
        try {
            execFileSync('git', ['-c', 'merge.conflictStyle=merge', 'merge-file', '-p',
                '-L', oursLabels[0], '-L', 'base', '-L', theirsLabels[0], ...files],
            { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
            return false; // The pinned stages must really produce a text conflict.
        } catch (error) {
            if (!Number.isInteger(error.status) || error.status < 1 || error.status > 127 || typeof error.stdout !== 'string') throw error;
            expected = error.stdout;
        }
        return expected === current;
    } finally { rmSync(temporary, { recursive: true, force: true }); }
}

try {
    const args = process.argv.slice(2);
    const options = { write: false };
    for (let i = 0; i < args.length; i++) {
        const name = args[i];
        if (name === '--write') { if (options.write) throw Error('Duplicate --write'); options.write = true; }
        else if (name === '--canonical' || name === '--feature') {
            const key = name.slice(2);
            if (options[key] || !commitPattern.test(args[i + 1] || '')) throw Error(`${name} requires one full lowercase commit SHA`);
            options[key] = args[++i];
        } else throw Error(`Unknown argument: ${name}`);
    }
    if (!options.canonical || !options.feature || options.canonical === options.feature) throw Error('Supply distinct --canonical and --feature full commit SHAs');
    const source = commit => {
        if (git(['rev-parse', '--verify', `${commit}^{commit}`]) !== commit) throw Error('Source is not the exact requested commit');
        // Keep the final newline: it is part of the archived source digest.
        const raw = execFileSync('git', ['show', `${commit}:${REL}`], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        return { raw, lock: parseShellHistory(raw, { requireCanonical: true }) };
    };
    const canonical = source(options.canonical), feature = source(options.feature);
    const result = reconcileShellHistories(canonical.lock, feature.lock, { featureCommit: options.feature });
    const generated = canonicalJSON(result.lock);
    if (options.write) {
        if (git(['rev-parse', '--verify', 'HEAD']) !== options.feature) throw Error('Refusing write: HEAD must equal the exact feature source');
        let merging;
        try { merging = readFileSync(path.resolve(ROOT, git(['rev-parse', '--git-path', 'MERGE_HEAD'])), 'utf8'); }
        catch { throw Error('Refusing write: an active merge is required'); }
        const singleHead = /^([a-f0-9]{40})\n?$/.exec(merging);
        if (!singleHead || singleHead[1] !== options.canonical) {
            throw Error('Refusing write: MERGE_HEAD must contain exactly one canonical source SHA');
        }
        if (!lstatSync(FILE).isFile() || lstatSync(FILE).isSymbolicLink()) throw Error('Refusing write: the lock must be an existing regular file');
        const current = readFileSync(FILE, 'utf8');
        if (current !== generated && current !== canonical.raw && current !== feature.raw) {
            let valid = false;
            try { parseShellHistory(current); valid = true; } catch { /* only pinned Git conflict stages may replace invalid JSON */ }
            if (valid) throw Error('Refusing write: working lock contains additional or different data; do not erase an appended integration pin');
            const stages = git(['ls-files', '--unmerged', '--', REL]).split('\n').filter(Boolean)
                .map(line => /^(100644|100755) ([a-f0-9]{40}) ([123])\twww\/sw-shell\.lock\.json$/.exec(line));
            const ours = stages.find(match => match && match[3] === '2');
            const theirs = stages.find(match => match && match[3] === '3');
            const markers = /^<<<<<<< /m.test(current) && /^=======$/m.test(current) && /^>>>>>>> /m.test(current);
            if (!markers || !ours || !theirs || stages.some(match => !match)
                || ours[2] !== git(['rev-parse', `${options.feature}:${REL}`])
                || theirs[2] !== git(['rev-parse', `${options.canonical}:${REL}`])
                || !isPristineConflict(current, stages)) {
                throw Error('Refusing write: malformed lock is not the exact unmodified pinned two-parent Git conflict');
            }
        }
        if (current !== generated) writeFileSync(FILE, generated);
    }
    console.log(JSON.stringify({ mode: options.write ? 'write' : 'dry-run', canonical: options.canonical, feature: options.feature,
        conflicts: result.conflicts, canonicalPins: Object.keys(canonical.lock.history).length,
        combinedPins: Object.keys(result.lock.history).length, archivedSources: Object.keys(result.lock.archivedForks || {}) }, null, 2));
} catch (error) {
    console.error(`[sw-reconcile] ${error.message.split('\n')[0]}`);
    process.exit(1);
}
