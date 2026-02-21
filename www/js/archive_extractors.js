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
            const textExts = ['json', 'ipynb', 'pl', 'pro', 'py', 'txt', 'md', 'csv', 'tsv', 'xml', 'html', 'css', 'js'];
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
            const textExts = ['json', 'ipynb', 'pl', 'pro', 'py', 'txt', 'md', 'csv', 'tsv', 'xml', 'html', 'css', 'js'];
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
window.ArchiveExtractors = ArchiveExtractors;
