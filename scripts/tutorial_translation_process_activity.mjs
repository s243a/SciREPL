// Read-only Linux process counters. Never read command lines or environments.
import { readFileSync } from 'node:fs';

export function readWorkerActivity(worker) {
  if (!Number.isSafeInteger(worker?.pid) || worker.pid < 2 || typeof worker?.startIdentity !== 'string') return { alive: null };
  const root = `/proc/${worker.pid}`;
  try {
    const parse = () => { const raw = readFileSync(root + '/stat', 'utf8'); return raw.slice(raw.lastIndexOf(')') + 2).trim().split(/\s+/); };
    const boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(), before = parse();
    if (`${boot}:${before[19]}` !== worker.startIdentity || before[0] === 'Z') return { alive: false };
    let ioOperations = null;
    try {
      const io = Object.fromEntries(readFileSync(root + '/io', 'utf8').trim().split('\n').map(line => line.split(':').map(x => x.trim())));
      ioOperations = Number(io.syscr) + Number(io.syscw);
    } catch { /* Activity counters can be unreadable while identity is known. */ }
    const after = parse();
    if (before[19] !== after[19] || after[0] === 'Z') return { alive: null };
    return { alive: true, cpuTicks: Number(after[11]) + Number(after[12]), ioOperations };
  } catch (error) { return { alive: ['ENOENT', 'ESRCH'].includes(error.code) ? false : null }; }
}
