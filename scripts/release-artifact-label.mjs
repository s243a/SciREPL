#!/usr/bin/env node
// Branch names never become filenames or shell source. A manual/PR build is a
// candidate, even if someone manually selects a tag in the Actions UI.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export function artifactLabel(pkg, env = process.env) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pkg.version || '')) throw new Error('Invalid artifact version');
  if (env.GITHUB_EVENT_NAME === 'push' && env.GITHUB_REF_TYPE === 'tag') {
    if (env.GITHUB_REF_NAME !== `v${pkg.version}`) throw new Error('Release tag does not match package.json');
    return env.GITHUB_REF_NAME;
  }
  if (!['pull_request', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME)) throw new Error('Unsupported candidate event');
  if (!/^[a-f0-9]{40}$/i.test(env.GITHUB_SHA || '')) throw new Error('Candidate needs an exact 40-character commit');
  return `v${pkg.version}-candidate-${env.GITHUB_SHA.slice(0, 12)}`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  console.log(artifactLabel(pkg));
}
