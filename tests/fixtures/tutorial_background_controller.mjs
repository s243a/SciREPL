// Offline controller double. No provider calls, translation imports or applies.
import { writeFileSync, renameSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2), campaign = args[args.indexOf('--campaign') + 1];
mkdirSync(campaign);
const stat = readFileSync(`/proc/${process.pid}/stat`, 'utf8');
const startIdentity = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() + ':'
  + stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19];
const status = state => {
  const destination = path.join(campaign, 'controller-status.json');
  const temporary = destination + '.tmp';
  writeFileSync(temporary, JSON.stringify({ schema: 1, state, updatedAt: new Date().toISOString(), counts: { planned: 1, completed: state === 'completed' ? 1 : 0, held: 0 },
    phases: state === 'running' ? [{ state: 'running', worker: { pid: process.pid, startIdentity } }] : [] }));
  renameSync(temporary, destination);
};
process.stdout.write('PRIVATE_FIXTURE_OUTPUT_NOT_FOR_STATUS\n');
status('queued');
const keepalive = setInterval(() => {}, 1000);
const running = setTimeout(() => status('running'), 700);
let finishing;
if (!campaign.endsWith('-hang')) finishing = setTimeout(() => { status('completed'); clearInterval(keepalive); process.exit(campaign.endsWith('-held') ? 1 : 0); }, 1600);
process.on('SIGTERM', () => { clearTimeout(running); clearTimeout(finishing); clearInterval(keepalive); status('cancelled'); process.exit(143); });
