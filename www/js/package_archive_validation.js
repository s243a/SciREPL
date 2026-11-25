/* Bounded, non-executing validation of archives retained for offline remount. */
(() => {
    'use strict';
    const LIMITS = Object.freeze({ archiveBytes: 32 * 1024 * 1024, expandedBytes: 64 * 1024 * 1024, entries: 4096 });
    const textExtensions = new Set(['json', 'ipynb', 'srwb', 'pl', 'pro', 'py', 'txt', 'md', 'csv', 'tsv', 'xml', 'html', 'css', 'js']);
    const failure = code => Object.assign(new Error(code), { code });
    const invalid = () => { throw failure('ARCHIVE_CORRUPT'); };
    const large = () => { throw failure('ARCHIVE_TOO_LARGE'); };
    const utf8 = new TextDecoder('utf-8', { fatal: true });
    const crcTable = Uint32Array.from({ length: 256 }, (_, byte) => {
        let value = byte;
        for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
        return value >>> 0;
    });
    const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

    function relative(path, directory = false) {
        if (typeof path !== 'string' || !path || path.length > 1024 || /[\\:%'"\x00-\x1f\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069]/.test(path) || path.startsWith('/')) invalid();
        const value = directory && path.endsWith('/') ? path.slice(0, -1) : path;
        if (!value || value.split('/').some(part => !part || part === '.' || part === '..')) invalid();
        return path;
    }
    function destination(path, directory = false) {
        if (typeof path !== 'string' || !/^\/(?:user|shared|tmp|education)\//.test(path)) invalid();
        relative(path.slice(1), directory);
        // SharedVFS has delegated notebook/localStorage mounts. Never replay into them.
        if (/^\/shared\/notebooks(?:\/|$)/.test(path)) invalid();
        return path;
    }
    function add(map, name, bytes) {
        relative(name);
        if (map.has(name)) invalid();
        const ext = name.split('.').pop().toLowerCase();
        map.set(name, textExtensions.has(ext) ? utf8.decode(bytes) : bytes);
    }
    async function zipFiles(bytes) {
        if (!window.JSZip) invalid();
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        let end = -1;
        for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset--) {
            if (view.getUint32(offset, true) === 0x06054b50 && offset + 22 + view.getUint16(offset + 20, true) === bytes.length) { end = offset; break; }
        }
        if (end < 0 || view.getUint16(end + 4, true) || view.getUint16(end + 6, true)) invalid();
        const count = view.getUint16(end + 10, true);
        const start = view.getUint32(end + 16, true);
        const length = view.getUint32(end + 12, true);
        if (!count || count === 65535 || count !== view.getUint16(end + 8, true) || start + length !== end) invalid();
        if (count > LIMITS.entries) large();
        const entries = [];
        const names = new Set();
        let offset = start;
        let expanded = 0;
        for (let index = 0; index < count; index++) {
            if (offset + 46 > end || view.getUint32(offset, true) !== 0x02014b50) invalid();
            const flags = view.getUint16(offset + 8, true);
            const method = view.getUint16(offset + 10, true);
            const size = view.getUint32(offset + 24, true);
            const nameLength = view.getUint16(offset + 28, true);
            const extraLength = view.getUint16(offset + 30, true);
            const commentLength = view.getUint16(offset + 32, true);
            const unixType = (view.getUint32(offset + 38, true) >>> 16) & 0xf000;
            const next = offset + 46 + nameLength + extraLength + commentLength;
            if (next > end || flags & 1 || ![0, 8].includes(method) || size === 0xffffffff) invalid();
            const name = utf8.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
            const directory = name.endsWith('/');
            relative(name, directory);
            if (![0, directory ? 0x4000 : 0x8000].includes(unixType) || (directory && size)) invalid();
            if (names.has(name.normalize('NFC'))) invalid();
            names.add(name.normalize('NFC'));
            expanded += size;
            if (expanded > LIMITS.expandedBytes) large();
            entries.push({ name, size, directory, crc: view.getUint32(offset + 16, true) }); offset = next;
        }
        if (offset !== end) invalid();
        const zip = await window.JSZip.loadAsync(bytes);
        const map = new Map();
        let actualTotal = 0;
        for (const entry of entries) {
            const file = zip.files[entry.name];
            if (!file || (file.unsafeOriginalName && file.unsafeOriginalName !== entry.name) || Boolean(file.dir) !== entry.directory) invalid();
            if (entry.directory) continue;
            const chunks = [];
            let actual = 0;
            let crc = 0xffffffff;
            await new Promise((resolve, reject) => {
                const stream = file.internalStream('uint8array');
                stream.on('data', chunk => {
                    actual += chunk.length; actualTotal += chunk.length;
                    if (actual > entry.size || actualTotal > LIMITS.expandedBytes) {
                        stream.pause(); reject(failure('ARCHIVE_TOO_LARGE')); return;
                    }
                    for (const byte of chunk) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
                    chunks.push(chunk);
                }).on('error', reject).on('end', resolve).resume();
            });
            if (actual !== entry.size || ((crc ^ 0xffffffff) >>> 0) !== entry.crc) invalid();
            const content = new Uint8Array(actual);
            let cursor = 0;
            for (const chunk of chunks) { content.set(chunk, cursor); cursor += chunk.length; }
            add(map, entry.name, content);
        }
        return map;
    }
    function tarFiles(bytes) {
        if (!window.pako?.Inflate) invalid();
        const chunks = [];
        let expanded = 0;
        const inflate = new window.pako.Inflate({ chunkSize: 65536 });
        inflate.onData = chunk => { expanded += chunk.length; if (expanded > LIMITS.expandedBytes) large(); chunks.push(chunk); };
        inflate.push(bytes, true);
        if (inflate.err || !inflate.ended) invalid();
        const tar = new Uint8Array(expanded);
        let cursor = 0;
        for (const chunk of chunks) { tar.set(chunk, cursor); cursor += chunk.length; }
        const map = new Map();
        const names = new Set();
        const text = (offset, size) => { const value = tar.subarray(offset, offset + size); const nul = value.indexOf(0); return utf8.decode(nul < 0 ? value : value.subarray(0, nul)); };
        let offset = 0;
        let count = 0;
        let terminated = false;
        while (offset + 512 <= tar.length) {
            const header = tar.subarray(offset, offset + 512);
            if (header.every(byte => byte === 0)) { terminated = tar.subarray(offset).every(byte => byte === 0); break; }
            if (++count > LIMITS.entries) large();
            const octal = (at, size) => { const raw = text(offset + at, size).trim(); if (!/^[0-7]+$/.test(raw)) invalid(); return parseInt(raw, 8); };
            const checksum = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
            if (checksum !== octal(148, 8)) invalid();
            const size = octal(124, 12);
            const prefix = text(offset + 345, 155);
            const name = (prefix ? prefix + '/' : '') + text(offset, 100);
            const type = header[156];
            const directory = type === 53;
            if (![0, 48, 53].includes(type) || (directory && size)) invalid(); // no links, devices, PAX or scripts to process
            relative(name, directory);
            if (names.has(name.normalize('NFC'))) invalid();
            names.add(name.normalize('NFC'));
            offset += 512;
            if (size > LIMITS.expandedBytes || offset + size > tar.length) invalid();
            if (!directory) add(map, name, tar.slice(offset, offset + size));
            offset += Math.ceil(size / 512) * 512;
        }
        if (!terminated || !map.size) invalid();
        return map;
    }
    function validateManifest(map) {
        const manifests = [...map.keys()].filter(path => path === 'scirepl.json' || /^[^/]+\/scirepl\.json$/.test(path));
        if (manifests.length > 1) invalid();
        if (!manifests.length) return null;
        const path = manifests[0];
        const raw = map.get(path);
        if (typeof raw !== 'string' || raw.length > 1024 * 1024) invalid();
        const manifest = JSON.parse(raw);
        if (!object(manifest) || !['1.0', '2.0'].includes(manifest.format_version)) invalid();
        if (manifest.name != null && (typeof manifest.name !== 'string' || manifest.name.length > 160)) invalid();
        const base = path.includes('/') ? path.slice(0, path.indexOf('/') + 1) : '';
        for (const key of ['files', 'search_paths', 'notebooks', 'wasm_modules']) {
            if (manifest[key] != null && (!Array.isArray(manifest[key]) || manifest[key].length > LIMITS.entries)) invalid();
        }
        for (const file of manifest.files || []) {
            if (!object(file) || !['prolog', 'shared', 'all'].includes(file.target || 'prolog')) invalid();
            relative(file.src, true); destination(file.dest, file.src.endsWith('/'));
            if (file.src.endsWith('/')) {
                // Older shipped manifests list empty optional directories.
                // A validated directory mapping with no members is a no-op.
                if (!file.dest.endsWith('/')) invalid();
            } else if (!map.has(base + file.src) || file.dest.endsWith('/')) invalid();
        }
        for (const search of manifest.search_paths || []) {
            if (!object(search) || typeof search.alias !== 'string' || !/^[a-z][A-Za-z0-9_]{0,79}$/.test(search.alias)) invalid();
            destination(search.dir);
        }
        for (const notebook of manifest.notebooks || []) {
            if (!object(notebook)) invalid();
            relative(notebook.file);
            const content = map.get(base + notebook.file);
            if (typeof content !== 'string' || !/\.(?:srwb|ipynb)$/i.test(notebook.file)) invalid();
            const parsed = JSON.parse(content);
            const single = parsed?.format === 'srwb' && object(parsed.notebook) && Array.isArray(parsed.notebook.cells);
            const multiple = parsed?.format === 'srwb' && object(parsed.workbook) && Array.isArray(parsed.workbook.notebooks)
                && parsed.workbook.notebooks.every(notebook => object(notebook) && Array.isArray(notebook.cells));
            if (!object(parsed) || !(Array.isArray(parsed.cells) || single || multiple)) invalid();
        }
        for (const mod of manifest.wasm_modules || []) {
            if (!object(mod) || typeof mod.name !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(mod.name)
                || ['constructor', 'prototype'].includes(mod.name)) invalid();
            relative(mod.file);
            if (!map.has(base + mod.file)) invalid();
            if (mod.js_wrapper != null) { relative(mod.js_wrapper); if (!map.has(base + mod.js_wrapper)) invalid(); }
        }
        // Never accept the private loader routing field from archive JSON.
        manifest._baseDir = base;
        return manifest;
    }
    class PackageArchiveValidation {
        static LIMITS = LIMITS;
        static async prepare(file) {
            try {
                if (!file || typeof file.name !== 'string' || !Number.isSafeInteger(file.size) || file.size <= 0) invalid();
                relative(file.name);
                if (file.name.includes('/') || !/\.(?:zip|tar\.gz|tgz)$/i.test(file.name)) invalid();
                if (file.size > LIMITS.archiveBytes) large();
                const bytes = new Uint8Array(await file.arrayBuffer());
                if (bytes.length !== file.size) invalid();
                const map = /\.zip$/i.test(file.name) ? await zipFiles(bytes) : tarFiles(bytes);
                const manifest = validateManifest(map);
                return { bytes, fileMap: map, manifest, filename: file.name, name: manifest?.name || file.name };
            } catch (error) {
                if (error?.code === 'ARCHIVE_TOO_LARGE' || error?.code === 'ARCHIVE_CORRUPT') throw error;
                throw failure('ARCHIVE_CORRUPT');
            }
        }
    }
    window.PackageArchiveValidation = PackageArchiveValidation;
})();
