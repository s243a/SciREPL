/** Pure parsing and lossless reconciliation for immutable shell-history pins. */
import { createHash } from 'node:crypto';

const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = message => { throw new Error(`Invalid SW shell history: ${message}`); };
const hashPattern = /^[a-f0-9]{64}$/;
export const commitPattern = /^[a-f0-9]{40}$/;

export function versionNumber(version) {
    if (typeof version !== 'string' || !/^v(?:0|[1-9][0-9]*)$/.test(version)) fail('version must be a canonical vN string');
    const number = Number(version.slice(1));
    if (!Number.isSafeInteger(number)) fail('version exceeds the safe integer range');
    return number;
}

const exactKeys = (value, allowed, label) => {
    if (!record(value) || Object.keys(value).some(key => !allowed.includes(key))) fail(`${label} has an invalid shape or unknown field`);
};

function legacyLock(value) {
    exactKeys(value, ['reserved', 'history'], 'legacy lock');
    if (!Array.isArray(value.reserved) || !record(value.history)) fail('reserved/history are required');
    const reserved = value.reserved.map(version => { versionNumber(version); return version; });
    if (new Set(reserved).size !== reserved.length) fail('reserved IDs must be unique');
    const history = Object.create(null);
    for (const [version, digest] of Object.entries(value.history)) {
        versionNumber(version);
        if (typeof digest !== 'string' || !hashPattern.test(digest)) fail(`bad digest for ${version}`);
        if (reserved.includes(version)) fail(`${version} cannot be both reserved and recorded`);
        history[version] = digest;
    }
    return { reserved, history };
}

export const canonicalJSON = value => JSON.stringify(value, null, 2) + '\n';
export const sha256 = value => createHash('sha256').update(value).digest('hex');

export function validateShellHistory(value) {
    exactKeys(value, ['reserved', 'history', 'archivedForks'], 'lock');
    const lock = legacyLock({ reserved: value.reserved, history: value.history });
    if (own(value, 'archivedForks')) {
        if (!record(value.archivedForks)) fail('archivedForks must be an object');
        lock.archivedForks = Object.create(null);
        for (const [commit, proof] of Object.entries(value.archivedForks)) {
            if (!commitPattern.test(commit)) fail('archived source must be a full lowercase commit SHA');
            exactKeys(proof, ['sourceLockSha256', 'lock'], 'archive proof');
            if (typeof proof.sourceLockSha256 !== 'string' || !hashPattern.test(proof.sourceLockSha256)) fail('bad archive source digest');
            const archived = legacyLock(proof.lock);
            if (sha256(canonicalJSON(archived)) !== proof.sourceLockSha256) fail(`archived source digest mismatch for ${commit}`);
            lock.archivedForks[commit] = { sourceLockSha256: proof.sourceLockSha256, lock: archived };
        }
    }
    return lock;
}

export function parseShellHistory(raw, { requireCanonical = false } = {}) {
    let value;
    try { value = JSON.parse(raw); } catch { fail('malformed JSON'); }
    const lock = validateShellHistory(value);
    if (requireCanonical && canonicalJSON(lock) !== raw) fail('source JSON is not in canonical two-space/LF form');
    return lock;
}

export function usedShellVersions(lock) {
    const valid = validateShellHistory(lock);
    const used = [...valid.reserved, ...Object.keys(valid.history)];
    for (const proof of Object.values(valid.archivedForks || {})) {
        used.push(...proof.lock.reserved, ...Object.keys(proof.lock.history));
    }
    return used;
}

export function reconcileShellHistories(canonicalInput, featureInput, { featureCommit } = {}) {
    if (!commitPattern.test(featureCommit || '')) fail('feature source must be a full commit SHA');
    const canonical = validateShellHistory(canonicalInput);
    const feature = validateShellHistory(featureInput);
    const result = { reserved: [...new Set([...canonical.reserved, ...feature.reserved])], history: { ...canonical.history } };
    const conflicts = [];
    for (const [version, digest] of Object.entries(feature.history)) {
        if (result.reserved.includes(version)) fail(`cannot reconcile a reserved/recorded collision for ${version}`);
        if (own(result.history, version) && result.history[version] !== digest) conflicts.push(version);
        else result.history[version] = digest;
    }
    for (const version of result.reserved) {
        if (own(result.history, version)) fail(`cannot reconcile a recorded/reserved collision for ${version}`);
    }
    const proofs = Object.create(null);
    const addProof = (commit, proof) => {
        if (own(proofs, commit) && canonicalJSON(proofs[commit]) !== canonicalJSON(proof)) fail(`conflicting archive proofs for ${commit}`);
        proofs[commit] = proof;
    };
    for (const source of [canonical, feature]) {
        for (const [commit, proof] of Object.entries(source.archivedForks || {})) addProof(commit, proof);
    }
    if (conflicts.length) {
        // The captured format is intentionally a complete legacy lock. Never
        // silently strip a future source's own proof metadata to fit it here.
        if (own(feature, 'archivedForks')) fail('a colliding source with archive metadata requires a newer full-source proof format');
        addProof(featureCommit, { sourceLockSha256: sha256(canonicalJSON(feature)), lock: feature });
    }
    if (Object.keys(proofs).length || own(canonical, 'archivedForks') || own(feature, 'archivedForks')) result.archivedForks = proofs;
    return { lock: validateShellHistory(result), conflicts };
}
