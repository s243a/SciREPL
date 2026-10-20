// Cooperating tutorial workers share a FIFO queue, then use the existing two
// slot-N/owner.json leases. Legacy clients bypass this queue: this is NOT global
// fairness. No dead process, reused PID, malformed owner or sibling lock is ever
// reclaimed here. A controller must investigate those records separately.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const TRANSLATION_QUEUE_POLL_INTERVAL_MS = 30000;
export const TRANSLATION_SLOT_ROOT = path.join(tmpdir(), 'scirepl-example-gemini-slots');
const UUID = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
const IDENTITY = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}:\d+$/i;
const TICKET = /^(\d{16})-([a-f\d-]{36})$/i;
const digest = value => createHash('sha256').update(value).digest('hex');
const save = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
const abortError = () => Object.assign(new Error('Translation slot wait cancelled'), { name: 'AbortError', code: 'ABORT_ERR' });
const assertActive = signal => { if (signal?.aborted) throw abortError(); };

// Linux start time is boot-relative, not wall-clock time; boot ID disambiguates
// the same PID/start tick after a reboot. Refuse dispatch if it cannot be read.
export function getProcessStartIdentity(pid = process.pid) {
  assert(Number.isSafeInteger(pid) && pid > 0, 'Invalid process ID');
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  const end = stat.lastIndexOf(')');
  assert(end > 0, 'Unreadable process identity');
  const started = stat.slice(end + 2).trim().split(/\s+/)[19];
  const boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  const identity = boot + ':' + started;
  assert(IDENTITY.test(identity), 'Unreadable process identity');
  return identity;
}

function realSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortError()); return; }
    const finish = () => { signal?.removeEventListener('abort', cancel); resolve(); };
    const timer = setTimeout(finish, ms);
    const cancel = () => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); reject(abortError()); };
    signal?.addEventListener('abort', cancel, { once: true });
  });
}

function existingDirectory(dir) {
  const stat = lstatSync(dir);
  assert(stat.isDirectory() && !stat.isSymbolicLink(), 'Refusing a non-directory queue entry');
}

function readOwner(dir) {
  existingDirectory(dir);
  const file = path.join(dir, 'owner.json');
  assert(lstatSync(file).isFile() && !lstatSync(file).isSymbolicLink(), 'Refusing a non-regular ownership record');
  const owner = JSON.parse(readFileSync(file, 'utf8'));
  assert(owner && typeof owner === 'object' && !Array.isArray(owner), 'Invalid ownership record');
  return owner;
}

function validOwner(owner) {
  return Number.isSafeInteger(owner.pid) && owner.pid > 0 && UUID.test(owner.nonce) && IDENTITY.test(owner.startIdentity);
}

function ownershipDiagnostic(dir, kind, { legacy = false } = {}) {
  let owner;
  try { owner = readOwner(dir); } catch { return { kind: kind + '-invalid', pid: null, alive: null, startIdentityMatches: null }; }
  const pid = Number.isSafeInteger(owner.pid) && owner.pid > 0 ? owner.pid : null;
  let alive = null, startIdentityMatches = null;
  if (pid !== null) {
    try { process.kill(pid, 0); alive = true; }
    catch (error) { if (error.code === 'ESRCH') alive = false; else if (error.code === 'EPERM') alive = true; }
    if (alive === false) startIdentityMatches = false;
    else if (alive === true && IDENTITY.test(owner.startIdentity || '')) {
      try { startIdentityMatches = getProcessStartIdentity(pid) === owner.startIdentity; } catch { /* Unknown is not permission to steal. */ }
    }
  }
  const valid = validOwner(owner);
  const old = legacy && pid !== null && !Object.hasOwn(owner, 'startIdentity');
  const suffix = alive === false ? '-stale' : startIdentityMatches === false ? '-identity-mismatch' : !valid && !old ? '-invalid' : old ? '-legacy' : startIdentityMatches !== true ? '-unverifiable' : '-occupied';
  return { kind: kind + suffix, pid, alive, startIdentityMatches };
}

function tryOwnedDirectory(dir, owner) {
  try { mkdirSync(dir, { mode: 0o700 }); }
  catch (error) { if (error.code === 'EEXIST') return null; throw error; }
  // An interrupted/incomplete write remains visible and must be investigated;
  // another worker will never infer that an empty directory is safe to steal.
  save(path.join(dir, 'owner.json'), owner);
  let released = false;
  return () => {
    if (released) return;
    const actual = readOwner(dir);
    assert.equal(actual.pid, owner.pid, 'Refusing to release another process\'s queue entry');
    assert.equal(actual.startIdentity, owner.startIdentity, 'Refusing to release a replaced process identity');
    assert.equal(actual.nonce, owner.nonce, 'Refusing to release a replaced queue entry');
    assert.equal(getProcessStartIdentity(owner.pid), owner.startIdentity, 'Refusing release after process identity changed');
    assert.deepEqual(readdirSync(dir).sort(), ['owner.json'], 'Refusing to remove unexpected queue-entry files');
    unlinkSync(path.join(dir, 'owner.json'));
    rmdirSync(dir);
    released = true;
  };
}

function inspectSlots(slotRoot) {
  const occupied = [], available = [];
  for (let i = 0; i < 2; i++) {
    const slot = path.join(slotRoot, 'slot-' + i);
    try { lstatSync(slot); occupied.push(ownershipDiagnostic(slot, 'slot', { legacy: true })); }
    catch (error) { if (error.code === 'ENOENT') available.push(slot); else throw error; }
  }
  return { occupied, available };
}

function inspectTickets(ticketsRoot) {
  return readdirSync(ticketsRoot).sort().map(name => {
    const match = TICKET.exec(name);
    const dir = path.join(ticketsRoot, name);
    const diagnostic = ownershipDiagnostic(dir, 'ticket');
    if (!match || !UUID.test(match[2])) diagnostic.kind = 'ticket-invalid';
    return { name, sequence: match ? Number(match[1]) : null, diagnostic };
  });
}

function isBlocked(diagnostic) {
  return !['slot-occupied', 'slot-legacy', 'ticket-occupied', 'queue-lock-occupied'].includes(diagnostic.kind);
}

/**
 * Wait indefinitely for a legacy-compatible slot. FIFO is registration order
 * among cooperating tutorial workers only. `signal` cancels the wait/admission,
 * not a lease already returned to a running worker. `clock` is { now(), sleep(ms,
 * signal) }, injectable for offline tests. `onStatus` receives metadata only.
 * Durable per-phase events live under queueRoot/records/<phaseHash>/<nonce>/.
 */
export async function acquireTranslationSlot({
  phaseKey,
  controllerPid = process.pid,
  signal,
  onStatus = () => {},
  slotRoot = TRANSLATION_SLOT_ROOT,
  queueRoot = path.join(slotRoot, 'tutorial-waiters'),
  clock = { now: Date.now, sleep: realSleep },
  pollIntervalMs = TRANSLATION_QUEUE_POLL_INTERVAL_MS,
} = {}) {
  assert(typeof phaseKey === 'string' && phaseKey.length > 0 && phaseKey.length <= 4096, 'A bounded phase key is required');
  assert(Number.isSafeInteger(controllerPid) && controllerPid > 0, 'Invalid controller PID');
  assert.equal(controllerPid, process.pid, 'Queue ownership must belong to the acquiring controller process');
  assert(typeof slotRoot === 'string' && path.isAbsolute(slotRoot) && path.normalize(slotRoot) !== path.parse(slotRoot).root, 'An explicit non-root slot directory is required');
  assert(typeof queueRoot === 'string' && path.isAbsolute(queueRoot) && path.normalize(queueRoot) !== path.parse(queueRoot).root && path.normalize(queueRoot) !== path.normalize(slotRoot), 'A separate non-root queue directory is required');
  assert(typeof clock.now === 'function' && typeof clock.sleep === 'function', 'Invalid queue clock');
  assert(Number.isSafeInteger(pollIntervalMs) && pollIntervalMs > 0, 'Invalid queue polling interval');
  assert(typeof onStatus === 'function', 'Invalid status observer');
  assertActive(signal);
  const startIdentity = getProcessStartIdentity(controllerPid), nonce = randomUUID();
  const phaseHash = digest(phaseKey), startedAt = clock.now();
  assert(Number.isFinite(startedAt), 'Invalid queue clock time');
  const owner = { pid: controllerPid, startIdentity, nonce, phaseHash };
  const ticketsRoot = path.join(queueRoot, 'tickets'), mutationLock = path.join(queueRoot, 'queue.lock');
  const recordDir = path.join(queueRoot, 'records', phaseHash, nonce);
  for (const dir of [slotRoot, queueRoot, ticketsRoot, recordDir]) { mkdirSync(dir, { recursive: true, mode: 0o700 }); existingDirectory(dir); }
  save(path.join(recordDir, 'owner.json'), owner);
  let eventSequence = 0, ticketSequence = null, ticketName = null, releaseTicket = null, leaseRelease = null, returned = false;
  let lastSnapshot = { queuePosition: null, occupiedSlots: 0, blockers: [] };
  async function emit(state, snapshot = lastSnapshot) {
    lastSnapshot = snapshot;
    const now = clock.now();
    assert(Number.isFinite(now) && now >= startedAt, 'Queue clock must be monotonic');
    const status = { state, phaseHash, queuePosition: snapshot.queuePosition, elapsedSeconds: Math.floor((now - startedAt) / 1000), occupiedSlots: snapshot.occupiedSlots,
      blockers: snapshot.blockers, ticketSequence, pollIntervalSeconds: pollIntervalMs / 1000, cooperativeFifo: true, globalFairness: false };
    save(path.join(recordDir, String(++eventSequence).padStart(10, '0') + '.json'), status);
    await onStatus(status);
  }
  async function wait() { assertActive(signal); await clock.sleep(pollIntervalMs, signal); assertActive(signal); }
  try {
    // Preserve that the phase entered the queue even if a slot is immediately
    // free. Neither this event nor its filename contains the raw phase key.
    await emit('queued');
    for (;;) {
      assertActive(signal);
      const unlock = tryOwnedDirectory(mutationLock, owner);
      if (!unlock) {
        const slots = inspectSlots(slotRoot), lock = ownershipDiagnostic(mutationLock, 'queue-lock');
        await emit(isBlocked(lock) ? 'blocked' : 'queued', { queuePosition: null, occupiedSlots: slots.occupied.length, blockers: [lock, ...slots.occupied] });
        await wait(); continue;
      }
      let snapshot, blocked = false;
      try {
        assertActive(signal);
        let tickets = inspectTickets(ticketsRoot);
        if (!ticketName) {
          const invalid = tickets.filter(item => item.sequence === null || !Number.isSafeInteger(item.sequence));
          if (invalid.length) {
            const slots = inspectSlots(slotRoot);
            snapshot = { queuePosition: null, occupiedSlots: slots.occupied.length, blockers: invalid.map(item => item.diagnostic).concat(slots.occupied) };
            blocked = true;
          } else {
            ticketSequence = Math.max(0, ...tickets.map(item => item.sequence)) + 1;
            assert(Number.isSafeInteger(ticketSequence) && ticketSequence < 1e16, 'Queue ticket sequence exhausted');
            ticketName = String(ticketSequence).padStart(16, '0') + '-' + nonce;
            releaseTicket = tryOwnedDirectory(path.join(ticketsRoot, ticketName), owner);
            assert(releaseTicket, 'Queue ticket unexpectedly exists');
            tickets = inspectTickets(ticketsRoot);
          }
        }
        if (ticketName) {
          const index = tickets.findIndex(item => item.name === ticketName);
          assert(index >= 0, 'Owned queue ticket disappeared; refusing dispatch');
          const own = tickets[index].diagnostic;
          assert.equal(own.kind, 'ticket-occupied', 'Owned queue ticket changed; refusing dispatch');
          const actualOwner = readOwner(path.join(ticketsRoot, ticketName));
          assert.equal(actualOwner.nonce, nonce, 'Owned queue ticket was replaced; refusing dispatch');
          assert.equal(actualOwner.pid, controllerPid, 'Owned queue ticket process changed; refusing dispatch');
          assert.equal(actualOwner.startIdentity, startIdentity, 'Owned queue ticket identity changed; refusing dispatch');
          const slots = inspectSlots(slotRoot), earlier = tickets.slice(0, index).map(item => item.diagnostic);
          snapshot = { queuePosition: index + 1, occupiedSlots: slots.occupied.length, blockers: [...earlier, ...slots.occupied] };
          blocked = earlier.some(isBlocked) || (!slots.available.length && slots.occupied.some(isBlocked));
          if (index === 0) {
            for (const slot of slots.available) {
              assertActive(signal);
              leaseRelease = tryOwnedDirectory(slot, { ...owner, started: new Date().toISOString() });
              if (!leaseRelease) continue; // A legacy client can race us.
              assertActive(signal);
              releaseTicket(); releaseTicket = null;
              snapshot = { queuePosition: 0, occupiedSlots: inspectSlots(slotRoot).occupied.length, blockers: [] };
              const release = leaseRelease;
              // A returned lease owns its own lifetime. No abort handler can
              // release it from underneath a still-running model process.
              const lease = { slot, nonce, startIdentity, phaseHash, recordDir, ticketSequence, release };
              unlock();
              await emit('acquired', snapshot);
              assertActive(signal);
              returned = true;
              return lease;
            }
          }
        }
      } finally { unlock(); }
      await emit(blocked ? 'blocked' : 'queued', snapshot);
      await wait();
    }
  } catch (error) {
    if (signal?.aborted || error.name === 'AbortError') {
      if (leaseRelease && !returned) leaseRelease();
      if (releaseTicket) { releaseTicket(); releaseTicket = null; }
      await emit('cancelled');
      throw abortError();
    }
    throw error;
  } finally {
    if (!returned) {
      if (leaseRelease) leaseRelease();
      if (releaseTicket) releaseTicket();
    }
  }
}
