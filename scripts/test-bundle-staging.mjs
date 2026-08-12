#!/usr/bin/env node
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { inspectCompletedBundle, installStagedBundle } from './bundle-staging.mjs';

const root = mkdtempSync(path.join(tmpdir(), 'scirepl-bundle-staging-'));
const dir = path.join(root, 'runtime');
const v1 = { id: 'runtime', version: '1.0.0', revision: 'one', sourceUrl: 'https://example.test/v1' };
const v2 = { id: 'runtime', version: '2.0.0', revision: 'two', sourceUrl: 'https://example.test/v2' };
const recipeA = { files: ['runtime.js'], transform: 'none-v1' };
const recipeB = { files: ['runtime.js', 'helper.wasm'], transform: 'none-v1' };
let passed = 0;
function assert(condition, message) { if (!condition) throw new Error(message); passed++; }

try {
  const first = await installStagedBundle({
    dir, component: v1, bundleSpec: recipeA,
    build: async (stage) => {
      writeFileSync(path.join(stage, 'runtime.js'), 'version one');
      return { files: ['runtime.js'] };
    },
  });
  assert(!first.reused, 'first install is built');
  assert(inspectCompletedBundle(dir, v1, recipeA).current, 'v1 receipt and inventory validate');

  const reused = await installStagedBundle({
    dir, component: v1, bundleSpec: recipeA,
    build: async () => { throw new Error('current bundle should not rebuild'); },
  });
  assert(reused.reused, 'matching completed bundle is reused');

  let failed = null;
  try {
    await installStagedBundle({
      dir, component: v2, bundleSpec: recipeA,
      build: async (stage) => {
        writeFileSync(path.join(stage, 'runtime.js'), 'partial version two');
        throw new Error('network interrupted');
      },
    });
  } catch (error) { failed = error; }
  assert(failed && /interrupted/.test(failed.message), 'failed replacement is visible');
  assert(readFileSync(path.join(dir, 'runtime.js'), 'utf8') === 'version one',
    'failed replacement preserves prior complete bundle');
  assert(inspectCompletedBundle(dir, v1, recipeA).current, 'failed replacement cannot relabel prior bundle');
  assert(!inspectCompletedBundle(dir, v2, recipeA).current, 'old bundle is not current for bumped version');

  assert(!inspectCompletedBundle(dir, v1, recipeB).current,
    'same component identity with a changed recipe is stale');
  let rebuiltForRecipe = false;
  await installStagedBundle({
    dir, component: v1, bundleSpec: recipeB,
    build: async (stage) => {
      rebuiltForRecipe = true;
      writeFileSync(path.join(stage, 'runtime.js'), 'version one rebuilt');
      writeFileSync(path.join(stage, 'helper.wasm'), 'helper');
      return { files: ['runtime.js', 'helper.wasm'] };
    },
  });
  assert(rebuiltForRecipe && inspectCompletedBundle(dir, v1, recipeB).current,
    'changed recipe rebuilds and receipts its full new inventory');

  await installStagedBundle({
    dir, component: v2, bundleSpec: recipeA,
    build: async (stage) => {
      writeFileSync(path.join(stage, 'runtime.js'), 'version two');
      return { files: ['runtime.js'] };
    },
  });
  assert(readFileSync(path.join(dir, 'runtime.js'), 'utf8') === 'version two',
    'successful replacement atomically promotes the new runtime');
  assert(inspectCompletedBundle(dir, v2, recipeA).current, 'new completion receipt validates');

  writeFileSync(path.join(dir, 'runtime.js'), 'tampered');
  assert(!inspectCompletedBundle(dir, v2, recipeA).current, 'inventory hash detects stale or tampered files');
  console.log(`bundle staging: ${passed} assertions passed`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
