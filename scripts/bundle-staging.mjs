import {
  existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

export const RUNTIME_RECEIPT = 'SCIREPL_RUNTIME_PROVENANCE.json';

/**
 * Windows refuses to rename a directory while any process still holds a handle
 * on a file inside it, reporting EPERM/EACCES/EBUSY. On CI that is routinely
 * the virus scanner reading the tens of megabytes of runtime we just wrote, and
 * it clears in well under a second. POSIX has no such restriction, so this only
 * ever bites on Windows.
 *
 * Retrying is the fix rather than falling back to a recursive copy: the swap has
 * to stay atomic. A half-copied directory that already carried its completion
 * receipt would advertise itself as a finished runtime.
 */
const TRANSIENT_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

export async function renameWithRetry(from, to, options = {}) {
  const { attempts = 12, rename = renameSync, delay = (ms) => sleep(ms) } = options;
  for (let attempt = 0; ; attempt++) {
    try {
      rename(from, to);
      return attempt + 1;
    } catch (error) {
      if (attempt >= attempts - 1 || !TRANSIENT_RENAME_CODES.has(error.code)) throw error;
      await delay(Math.min(50 * 2 ** attempt, 500));
    }
  }
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

export function bundleSpecFingerprint(bundleSpec) {
  if (!bundleSpec || typeof bundleSpec !== 'object') {
    throw new Error('bundleSpec is required for a completed runtime bundle');
  }
  return createHash('sha256').update(JSON.stringify(canonical(bundleSpec))).digest('hex');
}

function identity(component) {
  return {
    component: component.id,
    version: String(component.version),
    revision: component.revision || null,
    source: component.sourceUrl,
  };
}

function safeRelative(relative) {
  return typeof relative === 'string' && relative.length > 0
    && !path.isAbsolute(relative)
    && !relative.split(/[\\/]/).includes('..');
}

export function inspectCompletedBundle(dir, component, bundleSpec) {
  const receiptPath = path.join(dir, RUNTIME_RECEIPT);
  if (!existsSync(receiptPath)) return { current: false, reason: 'completion receipt missing' };
  let receipt;
  try {
    receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
  } catch (_) {
    return { current: false, reason: 'completion receipt unreadable' };
  }
  const expected = identity(component);
  for (const key of Object.keys(expected)) {
    if (receipt[key] !== expected[key]) {
      return { current: false, reason: `${key} changed` };
    }
  }
  if (receipt.bundleSpec !== bundleSpecFingerprint(bundleSpec)) {
    return { current: false, reason: 'bundle recipe changed' };
  }
  if (receipt.complete !== true || receipt.receiptVersion !== 2
      || !Array.isArray(receipt.inventory) || receipt.inventory.length === 0) {
    return { current: false, reason: 'completion receipt is not an inventory-bearing v2 receipt' };
  }
  for (const item of receipt.inventory) {
    if (!safeRelative(item.path) || !item.sha256 || !Number.isInteger(item.size) || item.size <= 0) {
      return { current: false, reason: 'completion inventory is malformed' };
    }
    const absolute = path.join(dir, item.path);
    if (!existsSync(absolute) || !statSync(absolute).isFile()) {
      return { current: false, reason: `${item.path} is missing` };
    }
    const size = statSync(absolute).size;
    if (size !== item.size || sha256(absolute) !== item.sha256) {
      return { current: false, reason: `${item.path} does not match its completion receipt` };
    }
  }
  return { current: true, receipt };
}

function inventoryFor(dir, files) {
  const unique = [...new Set(files)].sort();
  if (!unique.length) throw new Error('staged runtime produced no files');
  return unique.map((relative) => {
    if (!safeRelative(relative)) throw new Error(`unsafe staged runtime path: ${relative}`);
    const absolute = path.join(dir, relative);
    if (!existsSync(absolute) || !statSync(absolute).isFile() || statSync(absolute).size <= 0) {
      throw new Error(`staged runtime file is missing or empty: ${relative}`);
    }
    return { path: relative, size: statSync(absolute).size, sha256: sha256(absolute) };
  });
}

/**
 * Build a complete runtime in a sibling staging directory, write the receipt
 * last, then swap the whole directory into place. A failed build leaves the
 * previous complete runtime untouched and can never relabel stale files.
 */
export async function installStagedBundle({ dir, component, bundleSpec, build, validate }) {
  const specFingerprint = bundleSpecFingerprint(bundleSpec);
  const current = inspectCompletedBundle(dir, component, bundleSpec);
  if (current.current) return { reused: true, receipt: current.receipt };

  const stage = `${dir}.scirepl-stage`;
  const backup = `${dir}.scirepl-backup`;
  if (!existsSync(dir) && existsSync(backup)) await renameWithRetry(backup, dir);
  rmSync(stage, { recursive: true, force: true });
  rmSync(backup, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });

  try {
    const details = await build(stage);
    const inventory = inventoryFor(stage, details?.files || []);
    if (validate) await validate(stage, inventory);
    const receipt = {
      receiptVersion: 2,
      complete: true,
      ...identity(component),
      bundleSpec: specFingerprint,
      generatedFrom: 'third-party-components.json',
      ...(details || {}),
      files: inventory.map((item) => item.path),
      inventory,
    };
    // Completion receipt is intentionally the final write in the staging tree.
    writeFileSync(path.join(stage, RUNTIME_RECEIPT), JSON.stringify(receipt, null, 2) + '\n');

    if (existsSync(dir)) await renameWithRetry(dir, backup);
    try {
      await renameWithRetry(stage, dir);
    } catch (error) {
      if (!existsSync(dir) && existsSync(backup)) await renameWithRetry(backup, dir);
      throw error;
    }
    try {
      rmSync(backup, { recursive: true, force: true });
    } catch (error) {
      console.warn(`[fetch-bundles] promoted runtime but could not remove backup ${backup}: ${error.message}`);
    }
    return { reused: false, receipt };
  } catch (error) {
    rmSync(stage, { recursive: true, force: true });
    throw error;
  }
}
