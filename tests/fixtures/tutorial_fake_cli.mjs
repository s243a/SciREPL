#!/usr/bin/env node
// Offline lifecycle fixture. A successful synthetic draft is possible, but every
// synthetic review fails: this never calls a provider or applies accepted data.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const RUNNER_VERSION = '0.0.1';
const args = process.argv.slice(2);
const model = args[args.indexOf('--model') + 1];
if (args.includes('--version')) {
  process.stdout.write(RUNNER_VERSION + '\n');
} else if (['controller-test-runner-update', 'controller-test-drift'].includes(model)) {
  const prompt = args[args.indexOf('-p') + 1];
  if (prompt.includes('BEGIN UNTRUSTED DRAFT')) {
    process.stdout.write(JSON.stringify({ status: 'ERROR', response: 'Offline review intentionally fails.' }));
  } else {
    const request = JSON.parse(prompt.split('BEGIN UNTRUSTED SOURCE REQUEST\n')[1].split('\nEND UNTRUSTED SOURCE REQUEST')[0]);
    if (model === 'controller-test-runner-update') {
      const ownFile = fileURLToPath(import.meta.url);
      if (!ownFile.includes('/scirepl-tutorial-controller-fixture-')) throw new Error('Fixture cannot mutate the real runner source');
      writeFileSync(ownFile, readFileSync(ownFile, 'utf8').replace("const RUNNER_VERSION = '0.0.1'", "const RUNNER_VERSION = '0.0.2'"));
    } else {
      if (!request.fixtureDriftFile?.includes('/scirepl-tutorial-controller-')) throw new Error('Fixture mutation must stay isolated');
      writeFileSync(request.fixtureDriftFile, readFileSync(request.fixtureDriftFile, 'utf8') + '\n');
    }
    process.stdout.write(JSON.stringify({ status: 'SUCCESS', response: JSON.stringify({ translations: Object.fromEntries(request.fields.map(field => [field.id, field.text])) }) }));
  }
} else if (model === 'controller-test-timeout') {
  process.stderr.write('Warning: print mode timed out after the configured limit.\n');
  process.stdout.write(JSON.stringify({ status: 'SUCCESS', response: '{"translations":', duration_seconds: 0, usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } }));
} else if (model === 'controller-test-hang') {
  process.stdout.write('untrusted fixture prose ✓\n');
  process.stderr.write('untrusted fixture diagnostic\n');
  const timer = setInterval(() => {}, 1000);
  process.on('SIGTERM', () => { clearInterval(timer); process.exit(0); });
} else if (model === 'controller-test-output-cap') {
  process.stdout.write('x'.repeat(4 * 1024 * 1024 + 1));
  const timer = setInterval(() => {}, 1000);
  process.on('SIGTERM', () => { clearInterval(timer); process.exit(0); });
} else {
  process.stderr.write('Offline fixture rejects unexpected test mode.\n'); process.exitCode = 2;
}
