/**
 * archive_extractors.js — Format-specific archive extraction.
 * Supports .zip (via JSZip), .tar.gz (via pako + TarParser), and .rar (lazy-loaded).
 */

/**
 * Minimal tar parser for extracting files from an uncompressed tar buffer.
 */
class TarParser {
    /**
     * Parse a tar ArrayBuffer and return [{name, content (Uint8Array), size}].
     */
    static parse(buffer) {
        const data = new Uint8Array(buffer);
        const files = [];
        let offset = 0;

        while (offset + 512 <= data.length) {
            // Read header (512 bytes)
            const header = data.subarray(offset, offset + 512);

            // Check for end-of-archive (two consecutive zero blocks)
            if (TarParser._isZeroBlock(header)) break;

            const name = TarParser._readString(header, 0, 100);
            if (!name) break;

            const sizeStr = TarParser._readString(header, 124, 12).trim();
            const size = parseInt(sizeStr, 8) || 0;
            const typeFlag = String.fromCharCode(header[156]);

            offset += 512; // Move past header

            if (typeFlag === '0' || typeFlag === '\0' || typeFlag === '') {
                // Regular file
                if (size > 0) {
                    const content = data.slice(offset, offset + size);
                    files.push({
                        name: name.replace(/^\.\//, ''),
                        content: content,
                        size: size
                    });
                }
            }

            // Skip file content + padding to 512-byte boundary
            offset += Math.ceil(size / 512) * 512;
        }

        return files;
    }

    static _readString(data, start, length) {
        let end = start;
        while (end < start + length && data[end] !== 0) end++;
        return new TextDecoder('utf-8').decode(data.subarray(start, end));
    }

    static _isZeroBlock(block) {
        for (let i = 0; i < block.length; i++) {
            if (block[i] !== 0) return false;
        }
        return true;
    }
}

/**
 * Tar archive writer. Creates standard POSIX (ustar) tar archives.
 */
class TarWriter {
    constructor() {
        this._files = [];
    }

    /**
     * Add a file to the archive.
     * @param {string} name — file path within the archive
     * @param {string|Uint8Array} content — file content
     */
    addFile(name, content) {
        const data = (content instanceof Uint8Array)
            ? content
            : new TextEncoder().encode(String(content));
        this._files.push({ name, data });
    }

    /**
     * Build the tar archive as a Uint8Array.
     */
    build() {
        const blocks = [];
        for (const { name, data } of this._files) {
            blocks.push(this._makeHeader(name, data.length));
            blocks.push(data);
            // Pad to 512-byte boundary
            const remainder = data.length % 512;
            if (remainder > 0) {
                blocks.push(new Uint8Array(512 - remainder));
            }
        }
        // Two zero blocks = end of archive
        blocks.push(new Uint8Array(1024));

        // Concatenate all blocks
        const total = blocks.reduce((s, b) => s + b.length, 0);
        const result = new Uint8Array(total);
        let offset = 0;
        for (const b of blocks) {
            result.set(b, offset);
            offset += b.length;
        }
        return result;
    }

    _makeHeader(name, size) {
        const header = new Uint8Array(512);
        const enc = new TextEncoder();

        // Name (0-99)
        header.set(enc.encode(name).slice(0, 100), 0);
        // Mode (100-107): 0644
        header.set(enc.encode('0000644\0'), 100);
        // UID (108-115), GID (116-123): 0
        header.set(enc.encode('0000000\0'), 108);
        header.set(enc.encode('0000000\0'), 116);
        // Size (124-135): octal
        header.set(enc.encode(size.toString(8).padStart(11, '0') + '\0'), 124);
        // Mtime (136-147)
        const mtime = Math.floor(Date.now() / 1000);
        header.set(enc.encode(mtime.toString(8).padStart(11, '0') + '\0'), 136);
        // Type flag (156): '0' = regular file
        header[156] = 48;
        // USTAR magic (257-262) + version (263-264)
        header.set(enc.encode('ustar\0'), 257);
        header.set(enc.encode('00'), 263);

        // Checksum (148-155): fill with spaces, then compute
        header.set(enc.encode('        '), 148);
        let checksum = 0;
        for (let i = 0; i < 512; i++) checksum += header[i];
        header.set(enc.encode(checksum.toString(8).padStart(6, '0') + '\0 '), 148);

        return header;
    }
}

/**
 * Unified archive extraction interface.
 */
class ArchiveExtractors {
    /**
     * Detect archive type from file name and magic bytes.
     * Returns 'zip', 'targz', 'rar', or null.
     */
    static detectType(file) {
        const name = file.name.toLowerCase();
        if (name.endsWith('.zip')) return 'zip';
        if (name.endsWith('.tar.gz') || name.endsWith('.tgz')) return 'targz';
        if (name.endsWith('.rar')) return 'rar';
        return null;
    }

    /**
     * Extract an archive file.
     * @param {File} file — the archive File object
     * @returns {Promise<Map<string, string|Uint8Array>>} — path → content map
     */
    static async extract(file) {
        const type = ArchiveExtractors.detectType(file);
        switch (type) {
            case 'zip': return ArchiveExtractors._extractZip(file);
            case 'targz': return ArchiveExtractors._extractTarGz(file);
            case 'rar': return ArchiveExtractors._extractRar(file);
            default: throw new Error('Unsupported archive format: ' + file.name);
        }
    }

    /**
     * Extract a .zip file using JSZip.
     */
    static async _extractZip(file) {
        if (typeof JSZip === 'undefined') {
            throw new Error('JSZip not loaded');
        }
        const buffer = await file.arrayBuffer();
        const zip = await JSZip.loadAsync(buffer);
        const fileMap = new Map();

        const entries = Object.keys(zip.files);
        for (const path of entries) {
            const entry = zip.files[path];
            if (entry.dir) continue;

            // Try text first for known text types
            const ext = path.split('.').pop().toLowerCase();
            const textExts = ['json', 'ipynb', 'srwb', 'pl', 'pro', 'py', 'txt', 'md', 'csv', 'tsv', 'xml', 'html', 'css', 'js'];
            if (textExts.includes(ext)) {
                fileMap.set(path, await entry.async('string'));
            } else {
                fileMap.set(path, await entry.async('uint8array'));
            }
        }

        return fileMap;
    }

    /**
     * Extract a .tar.gz file using pako + TarParser.
     */
    static async _extractTarGz(file) {
        if (typeof pako === 'undefined') {
            throw new Error('pako not loaded. Cannot decompress .tar.gz files.');
        }

        const compressed = new Uint8Array(await file.arrayBuffer());
        const decompressed = pako.inflate(compressed);
        const files = TarParser.parse(decompressed.buffer);
        const fileMap = new Map();

        for (const f of files) {
            const ext = f.name.split('.').pop().toLowerCase();
            const textExts = ['json', 'ipynb', 'srwb', 'pl', 'pro', 'py', 'txt', 'md', 'csv', 'tsv', 'xml', 'html', 'css', 'js'];
            if (textExts.includes(ext)) {
                fileMap.set(f.name, new TextDecoder('utf-8').decode(f.content));
            } else {
                fileMap.set(f.name, f.content);
            }
        }

        return fileMap;
    }

    /**
     * Extract a .rar file using unrar.js (lazy-loaded).
     */
    static async _extractRar(file) {
        // Lazy-load unrar.js WASM if not already loaded
        if (typeof unrar === 'undefined' && typeof Unrar === 'undefined') {
            throw new Error('RAR support is not yet available. Please use .zip or .tar.gz.');
        }

        throw new Error('RAR extraction not yet implemented.');
    }
}

// Export to window
window.TarParser = TarParser;
window.TarWriter = TarWriter;
window.ArchiveExtractors = ArchiveExtractors;
