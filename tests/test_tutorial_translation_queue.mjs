import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { acquireTranslationSlot, getProcessStartIdentity, TRANSLATION_QUEUE_POLL_INTERVAL_MS } from '../scripts/tutorial_translation_queue.mjs';

let checks = 0;
const fixtures = new Set();
const verify = async (name, fn) => { await fn(); checks++; console.log('PASS ' + name); };
const turn = () => new Promise(resolve => setImmediate(resolve));
const save = (file, value) => writeFileSync(file, JSON.stringify(value) + '\n');
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'scirepl-translation-queue-test-'));
  fixtures.add(root);
  const slotRoot = path.join(root, 'slots'), queueRoot = path.join(root, 'queue');
  mkdirSync(slotRoot);
  return { root, slotRoot, queueRoot };
}
function virtualClock() {
  let time = 1000;
  const sleepers = new Set();
  const clock = {
    now: () => time,
    sleep(ms, signal) {
      return new Promise((resolve, reject) => {
        if (signal?.aborted) { reject(Object.assign(new Error('Cancelled'), { name: 'AbortError' })); return; }
        const waiter = { until: time + ms, resolve: () => { signal?.removeEventListener('abort', cancel); resolve(); } };
        const cancel = () => { sleepers.delete(waiter); signal?.removeEventListener('abort', cancel); reject(Object.assign(new Error('Cancelled'), { name: 'AbortError' })); };
        signal?.addEventListener('abort', cancel, { once: true });
        sleepers.add(waiter);
      });
    },
    async advance(ms) {
      time += ms;
      for (const waiter of [...sleepers]) if (waiter.until <= time) { sleepers.delete(waiter); waiter.resolve(); }
      await turn();
    },
    get sleeping() { return sleepers.size; },
  };
  return clock;
}
function occupy(slotRoot, index, owner = { pid: process.pid, nonce: randomUUID(), started: 'test-fixture' }) {
  const dir = path.join(slotRoot, 'slot-' + index);
  mkdirSync(dir);
  save(path.join(dir, 'owner.json'), owner);
  return { dir, owner, release: () => { assert.deepEqual(JSON.parse(readFileSync(path.join(dir, 'owner.json'), 'utf8')), owner); unlinkSync(path.join(dir, 'owner.json')); rmdirSync(dir); } };
}
const occupiedCount = fixture => readdirSync(fixture.slotRoot).filter(name => /^slot-[01]$/.test(name)).length;
function phaseRecords(fixture) {
  const root = path.join(fixture.queueRoot, 'records');
  if (!existsSync(root)) return [];
  return readdirSync(root).flatMap(hash => readdirSync(path.join(root, hash)).map(nonce => {
    const dir = path.join(root, hash, nonce);
    return { dir, owner: JSON.parse(readFileSync(path.join(dir, 'owner.json'), 'utf8')), events: readdirSync(dir).filter(name => /^\d+\.json$/.test(name)).sort().map(name => JSON.parse(readFileSync(path.join(dir, name), 'utf8'))) };
  }));
}

try {
  await verify('process identity includes boot ID and a Linux start tick', () => {
    assert.match(getProcessStartIdentity(), /^[a-f\d-]{36}:\d+$/);
    assert.equal(getProcessStartIdentity(process.pid), getProcessStartIdentity());
    assert.throws(() => getProcessStartIdentity(-1));
    assert.equal(TRANSLATION_QUEUE_POLL_INTERVAL_MS, 30000);
  });

  await verify('a free lease is legacy-compatible and has durable queued/acquired metadata', async () => {
    const f = fixture(), statuses = [], privatePhase = 'private prompt must not appear in records';
    const lease = await acquireTranslationSlot({ ...f, phaseKey: privatePhase, onStatus: status => statuses.push(status) });
    assert.equal(lease.slot, path.join(f.slotRoot, 'slot-0'));
    const owner = JSON.parse(readFileSync(path.join(lease.slot, 'owner.json'), 'utf8'));
    assert.equal(owner.pid, process.pid); assert.equal(owner.nonce, lease.nonce); assert.equal(owner.startIdentity, getProcessStartIdentity());
    assert.deepEqual(statuses.map(status => status.state), ['queued', 'acquired']);
    assert.equal(statuses.at(-1).queuePosition, 0);
    assert.equal(statuses.at(-1).globalFairness, false);
    const records = phaseRecords(f);
    assert.equal(records.length, 1);
    assert.deepEqual(records[0].events, statuses);
    assert.equal(JSON.stringify(records).includes(privatePhase), false);
    assert.equal(readdirSync(path.join(f.queueRoot, 'tickets')).length, 0);
    lease.release(); lease.release();
    assert.equal(occupiedCount(f), 0);
    await assert.rejects(acquireTranslationSlot({ ...f, phaseKey: 'x', controllerPid: 2147483647 }));
  });

  await verify('live legacy clients can occupy both slots for more than 120 virtual seconds', async () => {
    const f = fixture(), clock = virtualClock(), statuses = [];
    const left = occupy(f.slotRoot, 0), right = occupy(f.slotRoot, 1);
    const bytes = [readFileSync(path.join(left.dir, 'owner.json')), readFileSync(path.join(right.dir, 'owner.json'))];
    let resolved = false;
    const pending = acquireTranslationSlot({ ...f, clock, phaseKey: 'long-wait', onStatus: status => statuses.push(status) }).then(lease => { resolved = true; return lease; });
    await turn();
    for (let i = 0; i < 7; i++) await clock.advance(30000);
    assert.equal(resolved, false);
    assert.equal(statuses.at(-1).elapsedSeconds, 210);
    assert.equal(statuses.at(-1).state, 'queued');
    assert.equal(statuses.at(-1).occupiedSlots, 2);
    assert.equal(statuses.at(-1).blockers.every(blocker => blocker.kind === 'slot-legacy' && blocker.alive === true && blocker.startIdentityMatches === null), true);
    assert.deepEqual(readFileSync(path.join(left.dir, 'owner.json')), bytes[0]);
    assert.deepEqual(readFileSync(path.join(right.dir, 'owner.json')), bytes[1]);
    left.release(); await clock.advance(30000);
    const lease = await pending;
    lease.release(); right.release();
  });

  await verify('cooperating waiters are admitted FIFO and never occupy more than two slots', async () => {
    const f = fixture(), clock = virtualClock();
    const initial = await Promise.all([0, 1].map(i => acquireTranslationSlot({ ...f, clock, phaseKey: 'active-' + i })));
    const order = [], statuses = new Map();
    const pending = [];
    for (let i = 0; i < 4; i++) {
      statuses.set(i, []);
      pending.push(acquireTranslationSlot({ ...f, clock, phaseKey: 'wait-' + i, onStatus: status => statuses.get(i).push(status) }).then(lease => { order.push(i); assert(occupiedCount(f) <= 2); return lease; }));
      await turn();
    }
    assert.deepEqual([...statuses.values()].map(events => events.at(-1).queuePosition), [1, 2, 3, 4]);
    initial[0].release(); await clock.advance(30000);
    assert.deepEqual(order, [0]);
    const first = await pending[0];
    initial[1].release(); await clock.advance(30000);
    assert.deepEqual(order, [0, 1]);
    const second = await pending[1];
    first.release(); second.release(); await clock.advance(30000);
    assert.deepEqual(order, [0, 1, 2, 3]);
    for (const lease of await Promise.all(pending.slice(2))) lease.release();
    assert.equal(occupiedCount(f), 0);
  });

  await verify('real AbortSignal cancellation removes only its own queued ticket and retains durable status', async () => {
    const f = fixture(), clock = virtualClock(), aborter = new AbortController(), statuses = [];
    const a = occupy(f.slotRoot, 0), b = occupy(f.slotRoot, 1);
    const cancelled = acquireTranslationSlot({ ...f, clock, phaseKey: 'cancel me', signal: aborter.signal, onStatus: status => statuses.push(status) });
    const rejection = assert.rejects(cancelled, error => error.name === 'AbortError' && error.code === 'ABORT_ERR');
    await turn();
    const remaining = acquireTranslationSlot({ ...f, clock, phaseKey: 'keep me' });
    await turn();
    assert.equal(readdirSync(path.join(f.queueRoot, 'tickets')).length, 2);
    aborter.abort(); await rejection;
    assert.equal(statuses.at(-1).state, 'cancelled');
    assert.equal(readdirSync(path.join(f.queueRoot, 'tickets')).length, 1);
    assert.equal(occupiedCount(f), 2);
    assert.deepEqual(JSON.parse(readFileSync(path.join(a.dir, 'owner.json'))), a.owner);
    assert.equal(phaseRecords(f).filter(record => record.events.at(-1).state === 'cancelled').length, 1);
    a.release(); await clock.advance(30000);
    (await remaining).release(); b.release();
    const before = phaseRecords(f).length;
    const already = new AbortController(); already.abort();
    await assert.rejects(acquireTranslationSlot({ ...f, phaseKey: 'pre-cancelled', signal: already.signal }), { name: 'AbortError' });
    assert.equal(phaseRecords(f).length, before);
  });

  await verify('aborting after admission never releases a returned lease underneath its worker', async () => {
    const f = fixture(), aborter = new AbortController();
    const lease = await acquireTranslationSlot({ ...f, phaseKey: 'running', signal: aborter.signal });
    aborter.abort(); await turn();
    assert.equal(occupiedCount(f), 1);
    lease.release();
  });

  await verify('cancel during the acquired-status handoff releases only the not-yet-returned owned lease', async () => {
    const f = fixture(), aborter = new AbortController(), statuses = [];
    await assert.rejects(acquireTranslationSlot({ ...f, phaseKey: 'handoff', signal: aborter.signal, onStatus(status) {
      statuses.push(status); if (status.state === 'acquired') aborter.abort();
    } }), { name: 'AbortError' });
    assert.equal(occupiedCount(f), 0);
    assert.equal(statuses.at(-1).state, 'cancelled');
  });

  await verify('stale slots are diagnosed but never reclaimed, including after PID identity mismatch', async () => {
    const f = fixture(), clock = virtualClock(), aborter = new AbortController(), statuses = [];
    const stale = occupy(f.slotRoot, 0, { pid: 2147483647, nonce: randomUUID(), startIdentity: getProcessStartIdentity() });
    const reused = occupy(f.slotRoot, 1, { pid: process.pid, nonce: randomUUID(), startIdentity: getProcessStartIdentity().replace(/:\d+$/, ':0') });
    const pending = acquireTranslationSlot({ ...f, clock, phaseKey: 'stale-slots', signal: aborter.signal, onStatus: status => statuses.push(status) });
    const rejected = assert.rejects(pending, { name: 'AbortError' });
    await turn(); await clock.advance(150000);
    const status = statuses.at(-1);
    assert.equal(status.state, 'blocked');
    assert.deepEqual(status.blockers.map(item => item.kind), ['slot-stale', 'slot-identity-mismatch']);
    assert.deepEqual(status.blockers.map(item => item.startIdentityMatches), [false, false]);
    assert.equal(occupiedCount(f), 2);
    aborter.abort(); await rejected;
    stale.release(); reused.release();
  });

  await verify('a stale earlier ticket blocks FIFO without being removed or allowing a jump', async () => {
    const f = fixture(), clock = virtualClock(), aborter = new AbortController(), statuses = [];
    const tickets = path.join(f.queueRoot, 'tickets'); mkdirSync(tickets, { recursive: true });
    const stale = path.join(tickets, '0000000000000001-' + randomUUID()); mkdirSync(stale);
    const prior = { pid: 2147483647, nonce: randomUUID(), startIdentity: getProcessStartIdentity() }; save(path.join(stale, 'owner.json'), prior);
    const pending = acquireTranslationSlot({ ...f, clock, phaseKey: 'behind-stale', signal: aborter.signal, onStatus: status => statuses.push(status) });
    const rejection = assert.rejects(pending, { name: 'AbortError' });
    await turn(); await clock.advance(180000);
    assert.equal(statuses.at(-1).state, 'blocked');
    assert.equal(statuses.at(-1).queuePosition, 2);
    assert.equal(statuses.at(-1).blockers[0].kind, 'ticket-stale');
    assert.equal(occupiedCount(f), 0);
    aborter.abort(); await rejection;
    assert.deepEqual(readdirSync(tickets), [path.basename(stale)]);
    assert.deepEqual(JSON.parse(readFileSync(path.join(stale, 'owner.json'))), prior);
  });

  await verify('malformed queue tickets and stale sibling mutation locks are explicit no-reclamation holds', async () => {
    for (const kind of ['ticket', 'lock']) {
      const f = fixture(), clock = virtualClock(), aborter = new AbortController(), statuses = [];
      const dir = kind === 'ticket' ? path.join(f.queueRoot, 'tickets', 'unexpected-record') : path.join(f.queueRoot, 'queue.lock');
      mkdirSync(dir, { recursive: true });
      if (kind === 'lock') save(path.join(dir, 'owner.json'), { pid: 2147483647, nonce: randomUUID(), startIdentity: getProcessStartIdentity() });
      const pending = acquireTranslationSlot({ ...f, clock, phaseKey: kind, signal: aborter.signal, onStatus: status => statuses.push(status) });
      const rejection = assert.rejects(pending, { name: 'AbortError' });
      await turn();
      assert.equal(statuses.at(-1).state, 'blocked');
      assert.equal(statuses.at(-1).blockers[0].kind, kind === 'ticket' ? 'ticket-invalid' : 'queue-lock-stale');
      assert.equal(occupiedCount(f), 0);
      aborter.abort(); await rejection;
      assert(existsSync(dir));
    }
  });

  await verify('release rejects changed pid, start identity, nonce, symlink and unexpected files', async () => {
    for (const change of ['pid', 'startIdentity', 'nonce', 'extra-file', 'symlink']) {
      const f = fixture(), lease = await acquireTranslationSlot({ ...f, phaseKey: 'release-' + change });
      const file = path.join(lease.slot, 'owner.json'), original = readFileSync(file), owner = JSON.parse(original);
      if (change === 'pid') owner.pid++;
      if (change === 'startIdentity') owner.startIdentity = owner.startIdentity.replace(/:\d+$/, ':0');
      if (change === 'nonce') owner.nonce = randomUUID();
      if (change === 'extra-file') writeFileSync(path.join(lease.slot, 'keep'), 'untouched');
      else if (change === 'symlink') {
        const { symlinkSync } = await import('node:fs');
        const target = path.join(f.root, 'other-owner.json'); writeFileSync(target, original);
        unlinkSync(file); symlinkSync(target, file);
      } else save(file, owner);
      assert.throws(() => lease.release(), /Refusing/);
      assert(existsSync(lease.slot));
      if (change === 'extra-file') { assert.equal(readFileSync(path.join(lease.slot, 'keep'), 'utf8'), 'untouched'); unlinkSync(path.join(lease.slot, 'keep')); }
      if (change === 'symlink') unlinkSync(file);
      writeFileSync(file, original);
      lease.release();
    }
  });

  await verify('cross-process cooperation holds at two slots and follows registered ticket order', async () => {
    const f = fixture(), children = [], acquired = [];
    const moduleURL = pathToFileURL(path.resolve('scripts/tutorial_translation_queue.mjs')).href;
    const source = `import { acquireTranslationSlot } from ${JSON.stringify(moduleURL)};
      const lease = await acquireTranslationSlot({phaseKey:process.env.QUEUE_TEST_PHASE,slotRoot:process.env.QUEUE_TEST_SLOTS,queueRoot:process.env.QUEUE_TEST_ROOT,pollIntervalMs:10,onStatus:s=>process.send({kind:'status',status:s})});
      process.send({kind:'acquired',sequence:lease.ticketSequence});
      await new Promise(resolve=>process.once('message',resolve)); lease.release(); process.send({kind:'released'}); process.disconnect();`;
    async function child(number) {
      const events = [], listeners = new Set();
      const proc = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { ...process.env, QUEUE_TEST_PHASE: String(number), QUEUE_TEST_SLOTS: f.slotRoot, QUEUE_TEST_ROOT: f.queueRoot } });
      let stderr = ''; proc.stderr.on('data', value => { stderr += value; });
      proc.on('message', event => { events.push(event); if (event.kind === 'acquired') acquired.push(number); for (const notify of listeners) notify(); });
      const exit = new Promise((resolve, reject) => { proc.once('error', reject); proc.once('exit', code => code === 0 ? resolve() : reject(new Error(stderr || 'Queue fixture child failed'))); });
      // Attach now so an unexpected child failure is never an unhandled rejection.
      exit.catch(() => {});
      const waitFor = predicate => new Promise((resolve, reject) => {
        const timer = setTimeout(() => { listeners.delete(check); reject(new Error('Offline child did not reach expected state')); }, 10000);
        function check() { const event = events.find(predicate); if (event) { clearTimeout(timer); listeners.delete(check); resolve(event); } }
        listeners.add(check); check();
      });
      const value = { proc, events, exit, waitFor }; children.push(value); return value;
    }
    try {
      const a = await child(0); await a.waitFor(event => event.kind === 'acquired');
      const b = await child(1); await b.waitFor(event => event.kind === 'acquired');
      const c = await child(2); await c.waitFor(event => event.kind === 'status' && event.status.queuePosition === 1);
      const d = await child(3); await d.waitFor(event => event.kind === 'status' && event.status.queuePosition === 2);
      assert.deepEqual(acquired, [0, 1]); assert.equal(occupiedCount(f), 2);
      a.proc.send('release'); await a.exit; await c.waitFor(event => event.kind === 'acquired');
      assert.deepEqual(acquired, [0, 1, 2]); assert.equal(occupiedCount(f), 2);
      b.proc.send('release'); await b.exit; await d.waitFor(event => event.kind === 'acquired');
      assert.deepEqual(acquired, [0, 1, 2, 3]); assert.equal(occupiedCount(f), 2);
      c.proc.send('release'); d.proc.send('release'); await Promise.all([c.exit, d.exit]);
      assert.equal(occupiedCount(f), 0);
    } finally {
      for (const child of children) if (child.proc.exitCode === null && child.proc.signalCode === null) child.proc.kill('SIGTERM');
      await Promise.allSettled(children.map(child => child.exit));
    }
  });
  console.log(`Tutorial queue: ${checks} offline checks passed; no provider calls, campaigns or shared locks touched.`);
} finally {
  for (const root of fixtures) {
    assert(root.startsWith(path.join(tmpdir(), 'scirepl-translation-queue-test-')));
    rmSync(root, { recursive: true });
  }
}
