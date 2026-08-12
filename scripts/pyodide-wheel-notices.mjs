import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yauzl from 'yauzl';
import { loadComponentManifest, readJson } from './component-manifest.mjs';

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function readZipEntry(zipPath, wanted) {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, autoClose: true }, (openError, zip) => {
      if (openError) return reject(openError);
      let found = false;
      zip.on('error', reject);
      zip.on('end', () => {
        if (!found) reject(new Error(`${path.basename(zipPath)} is missing ${wanted}`));
      });
      zip.on('entry', (entry) => {
        if (entry.fileName !== wanted) return zip.readEntry();
        found = true;
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError) return reject(streamError);
          const chunks = [];
          stream.on('error', reject);
          stream.on('data', (chunk) => chunks.push(chunk));
          stream.on('end', () => resolve(Buffer.concat(chunks)));
        });
      });
      zip.readEntry();
    });
  });
}

/** Validate (or explicitly generate) the exact notices shipped inside wheels. */
export async function verifyPyodideWheelNotices(root, { write = false, vendorDir } = {}) {
  const { manifest, byId } = loadComponentManifest(root);
  const component = byId.get('pyodide-wheels');
  if (!component) throw new Error('pyodide-wheels component is missing');
  const pyodideDir = vendorDir || path.join(root, 'www', 'vendor', 'pyodide');
  const lockPath = path.join(pyodideDir, 'pyodide-lock.json');
  if (!existsSync(lockPath)) throw new Error('bundled Pyodide lock is missing: ' + lockPath);
  const lock = readJson(lockPath);
  const resolvedWheelNames = new Set();
  let noticeCount = 0;

  for (const pkg of component.packages || []) {
    const locked = lock.packages?.[pkg.name.toLowerCase()] || lock.packages?.[pkg.name]
      || Object.values(lock.packages || {}).find((item) =>
        String(item.name).toLowerCase() === pkg.name.toLowerCase());
    if (!locked || locked.version !== pkg.version || !locked.file_name) {
      throw new Error(`${pkg.name} ${pkg.version} does not match bundled pyodide-lock.json`);
    }
    const wheelPath = path.join(pyodideDir, locked.file_name);
    if (!existsSync(wheelPath)) throw new Error(`bundled wheel is missing: ${locked.file_name}`);
    resolvedWheelNames.add(locked.file_name);
    if (!Array.isArray(pkg.wheelNotices) || pkg.wheelNotices.length === 0) {
      throw new Error(`${pkg.name} has no wheelNotices[] mapping`);
    }
    for (const notice of pkg.wheelNotices) {
      const document = manifest.licenseDocuments?.[notice.document];
      if (!document?.path || !document.sha256 || !notice.entry) {
        throw new Error(`${pkg.name} has an incomplete wheel notice mapping`);
      }
      const bytes = await readZipEntry(wheelPath, notice.entry);
      const digest = sha256(bytes);
      if (digest !== document.sha256) {
        throw new Error(`${pkg.name}/${notice.entry} hash changed\n  expected ${document.sha256}\n  actual   ${digest}`);
      }
      const snapshot = path.join(root, document.path);
      if (write) {
        mkdirSync(path.dirname(snapshot), { recursive: true });
        writeFileSync(snapshot, bytes);
      } else if (!existsSync(snapshot) || !readFileSync(snapshot).equals(bytes)) {
        throw new Error(`${document.path} is missing or differs from ${locked.file_name}:${notice.entry}`);
      }
      noticeCount++;
    }
  }

  const bundledWheels = new Set(readdirSync(pyodideDir).filter((name) => name.endsWith('.whl')));
  const unexpected = [...bundledWheels].filter((name) => !resolvedWheelNames.has(name));
  const missing = [...resolvedWheelNames].filter((name) => !bundledWheels.has(name));
  if (unexpected.length || missing.length) {
    throw new Error(`Pyodide wheel inventory mismatch; unexpected=[${unexpected}], missing=[${missing}]`);
  }
  return { packages: resolvedWheelNames.size, notices: noticeCount };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
  const result = await verifyPyodideWheelNotices(root, { write: process.argv.includes('--write') });
  console.log(`[wheel-notices] ${result.packages} packages, ${result.notices} exact notices verified`);
}
