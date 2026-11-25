import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { File } from 'node:buffer';
import { gzipSync } from 'node:zlib';
import vm from 'node:vm';
import test from 'node:test';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const context = vm.createContext({ console, Uint8Array, ArrayBuffer, DataView, TextEncoder, TextDecoder,
    Blob, File, setTimeout, clearTimeout, setImmediate, performance });
context.window = context;
for (const path of ['www/vendor/jszip/jszip.min.js', 'www/vendor/pako/pako_inflate.min.js',
    'www/js/archive_extractors.js', 'www/js/package_archive_validation.js']) vm.runInContext(read(path), context, { filename: path });
const validator = context.PackageArchiveValidation;
const code = expected => error => error.code === expected;
async function zipFile(files, name = 'fixture.zip') {
    const zip = new context.JSZip();
    for (const [path, contents] of Object.entries(files)) zip.file(path, contents);
    return new File([await zip.generateAsync({ type: 'uint8array' })], name);
}
function manifest(fields = {}) { return JSON.stringify({ format_version: '1.0', name: 'Fixture', files: [{ src: 'lib.pl', dest: '/user/fixture/lib.pl' }], ...fields }); }

test('validates a manifest package and overrides archive-supplied internal base routing', async () => {
    const prepared = await validator.prepare(await zipFile({ 'bundle/scirepl.json': manifest({ _baseDir: '../' }), 'bundle/lib.pl': 'fixture(ok).' }));
    assert.equal(prepared.manifest._baseDir, 'bundle/');
    assert.equal(prepared.fileMap.get('bundle/lib.pl'), 'fixture(ok).');
    assert.equal(prepared.name, 'Fixture');
});
test('accepts the actual bundled archive within bounded extraction limits', async () => {
    const bytes = readFileSync(new URL('../www/packages/unifyweaver_scirepl.zip', import.meta.url));
    const prepared = await validator.prepare(new File([bytes], 'unifyweaver_scirepl.zip'));
    assert.equal(prepared.manifest.name, 'UnifyWeaver');
    assert.equal(prepared.fileMap.size, 784, 'all regular files in the current Free bundled archive survive validation');
    assert.ok(prepared.fileMap.has('src/unifyweaver/core/stream_compiler.pl'));
});
test('rejects sanitized traversal, links and duplicate raw ZIP names before loading', async () => {
    await assert.rejects(validator.prepare(await zipFile({ '../escape.pl': 'bad' })), code('ARCHIVE_CORRUPT'));
    const symlink = new context.JSZip();
    symlink.file('link', 'target', { unixPermissions: 0o120777 });
    await assert.rejects(validator.prepare(new File([await symlink.generateAsync({ type: 'uint8array', platform: 'UNIX' })], 'link.zip')), code('ARCHIVE_CORRUPT'));
    const original = await zipFile({ 'safe.pl': 'ok', 'same.pl': 'bad' });
    const bytes = Buffer.from(await original.arrayBuffer());
    // Names have equal lengths; alter only the central directory name to collide.
    const central = bytes.lastIndexOf(Buffer.from('same.pl'));
    bytes.write('safe.pl', central);
    await assert.rejects(validator.prepare(new File([bytes], 'duplicate.zip')), code('ARCHIVE_CORRUPT'));
});
test('rejects CRC damage and malformed notebook/WASM specs before save or import', async () => {
    const bytes = Buffer.from(await (await zipFile({ 'safe.pl': 'ok' })).arrayBuffer());
    const central = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    bytes[central + 16] ^= 1;
    await assert.rejects(validator.prepare(new File([bytes], 'damaged.zip')), code('ARCHIVE_CORRUPT'));
    for (const fields of [{ notebooks: [null] }, { wasm_modules: [null] }, { notebooks: [{ file: '../escape.ipynb' }] },
        { wasm_modules: [{ name: 'constructor', file: 'module.wasm' }] }]) {
        await assert.rejects(validator.prepare(await zipFile({ 'scirepl.json': manifest(fields), 'lib.pl': 'ok' })), code('ARCHIVE_CORRUPT'));
    }
});
test('accepts both exported single-notebook and multi-notebook SRWB packages', async () => {
    for (const contents of [{ format: 'srwb', notebook: { name: 'One', cells: [] } },
        { format: 'srwb', workbook: { notebooks: [{ name: 'One', cells: [] }, { name: 'Two', cells: [] }] } }]) {
        const prepared = await validator.prepare(await zipFile({ 'scirepl.json': manifest({ notebooks: [{ file: 'book.srwb', type: 'srwb' }] }),
            'lib.pl': 'ok', 'book.srwb': JSON.stringify(contents) }));
        assert.equal(prepared.manifest.notebooks[0].file, 'book.srwb');
    }
});
test('rejects unsafe destination roots, path escapes, and Prolog alias injection', async () => {
    for (const dest of ['/nb/123/code', '/local/scirepl_key', '/shared/notebooks/123/code', '/user/../local/key', '/user/a%2fb', "/user/a'b"]) {
        await assert.rejects(validator.prepare(await zipFile({ 'scirepl.json': manifest({ files: [{ src: 'lib.pl', dest }] }), 'lib.pl': 'ok' })), code('ARCHIVE_CORRUPT'));
    }
    for (const search of [{ alias: "x'),halt,(x", dir: '/user/lib' }, { alias: 'safe', dir: "/user/a'b" }, { alias: 'safe', dir: '/tmp/../../private' }]) {
        await assert.rejects(validator.prepare(await zipFile({ 'scirepl.json': manifest({ search_paths: [search] }), 'lib.pl': 'ok' })), code('ARCHIVE_CORRUPT'));
    }
});
test('rejects oversized ZIP declared/actual output and too many entries without mounting', async () => {
    const bytes = Buffer.from(await (await zipFile({ 'safe.pl': 'ok' })).arrayBuffer());
    const central = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    bytes.writeUInt32LE(64 * 1024 * 1024 + 1, central + 24);
    await assert.rejects(validator.prepare(new File([bytes], 'large.zip')), code('ARCHIVE_TOO_LARGE'));
    const countZip = new context.JSZip();
    for (let i = 0; i <= 4096; i++) countZip.file(`file${i}.pl`, '');
    await assert.rejects(validator.prepare(new File([await countZip.generateAsync({ type: 'uint8array' })], 'many.zip')), code('ARCHIVE_TOO_LARGE'));
    await assert.rejects(validator.prepare({ name: 'huge.zip', size: 32 * 1024 * 1024 + 1 }), code('ARCHIVE_TOO_LARGE'));
});
test('validates bounded TAR.GZ and rejects corrupt headers and special entries', async () => {
    const tar = vm.runInContext('new TarWriter()', context);
    tar.addFile('lib.pl', 'fixture(ok).');
    const data = tar.build();
    const prepared = await validator.prepare(new File([gzipSync(data)], 'fixture.tar.gz'));
    assert.equal(prepared.fileMap.get('lib.pl'), 'fixture(ok).');
    const corrupt = data.slice(); corrupt[10] ^= 1;
    await assert.rejects(validator.prepare(new File([gzipSync(corrupt)], 'broken.tgz')), code('ARCHIVE_CORRUPT'));
    const link = vm.runInContext('new TarWriter()', context); link.addFile('link', 'target');
    const linkData = link.build(); linkData[156] = 50; linkData.fill(32, 148, 156);
    const sum = linkData.subarray(0, 512).reduce((a, b) => a + b, 0);
    linkData.set(new TextEncoder().encode(sum.toString(8).padStart(6, '0') + '\0 '), 148);
    await assert.rejects(validator.prepare(new File([gzipSync(linkData)], 'link.tgz')), code('ARCHIVE_CORRUPT'));
});
test('plain archives preserve support files without inventing a manifest', async () => {
    const prepared = await validator.prepare(await zipFile({ 'lib.pl': 'fixture(ok).', 'notes.ipynb': '{"cells":[]}' }));
    assert.equal(prepared.manifest, null);
    assert.equal(prepared.fileMap.size, 2);
});
