/**
 * Focused browser coverage for verified catalogue workbook import.
 *
 * Assumes the SciREPL dev server is running at SCIREPL_TEST_BASE (8085 by
 * default). The importer is deliberately generic: this suite does not load or
 * exercise any assistant, ToolCore, MCP, or broker feature.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';

const BASE = process.env.SCIREPL_TEST_BASE || 'http://127.0.0.1:8085/';
const sha256 = value => createHash('sha256').update(value, 'utf8').digest('hex');

let browser;
try {
    browser = await chromium.launch({
        headless: true,
        args: ['--disable-dev-shm-usage', '--no-sandbox'],
    });
    const context = await browser.newContext();
    await context.addInitScript(() => {
        localStorage.setItem('scirepl_privacy_accepted', '1');
        localStorage.setItem('scirepl_onboarding_seen', '1');
        localStorage.setItem('scirepl_auto_download', '0');
        // The atomic catalogue path must ignore this ordinary file-import
        // preference and never execute imported code.
        localStorage.setItem('scirepl_auto_execute', '1');
        window.__catalogImportExecuted = 0;
        addEventListener('DOMContentLoaded', () => localStorage.setItem(
            'scirepl_whats_new_seen_version', window.KERNEL_CONFIG.app.version),
        { once: true });
    });

    const importedRequests = [];
    await context.route(/catalog-import-network-sentinel/i, route => {
        importedRequests.push(route.request().url());
        return route.abort();
    });

    const page = await context.newPage();
    await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForFunction(() => window.__SCIREPL_APP_READY === true
        && window.fileIO && window.notebookManager && window._appInternals
        && typeof window.fileIO.importWorkbook === 'function',
    { timeout: 30_000 });

    console.log('1. Invalid, mismatched, and oversized workbooks are rejected before mutation...');
    const rejected = await page.evaluate(async () => {
        const fio = window.fileIO;
        const nm = window.notebookManager;
        const state = () => JSON.stringify({
            activeId: nm.getActiveNotebook()?.id || null,
            notebooks: nm.getNotebooks().map(notebook => ({
                id: notebook.id,
                name: notebook.name,
                catalogId: notebook.catalogId,
                catalogSourceId: notebook.catalogSourceId,
                isActive: notebook.isActive,
                cellCounter: notebook.isActive ? window._cellCounter : notebook.cellCounter,
                cells: (notebook.isActive ? window._cells : notebook.cells).map(cell => ({
                    id: cell.id,
                    code: cell.code,
                    lastOutput: cell.lastOutput || '',
                    lastOutputHtml: cell.lastOutputHtml || '',
                })),
            })),
        });
        const validSrwb = JSON.stringify({
            format: 'srwb',
            format_version: '1.0',
            notebook: { name: 'Valid', cells: [] },
        });
        const cases = [{
            name: 'malformed JSON',
            content: '{',
            options: { format: 'srwb', mode: 'create' },
        }, {
            name: 'format mismatch',
            content: JSON.stringify({ nbformat: 4, metadata: {}, cells: [] }),
            options: { format: 'srwb', mode: 'create' },
        }, {
            name: 'size mismatch',
            content: validSrwb,
            options: { format: 'srwb', mode: 'create', size: 1 },
        }, {
            name: 'hash mismatch',
            content: validSrwb,
            options: { format: 'srwb', mode: 'create', sha256: '0'.repeat(64) },
        }, {
            name: 'oversized payload',
            content: 'x'.repeat(fio.constructor.WORKBOOK_IMPORT_MAX_BYTES + 1),
            options: { format: 'srwb', mode: 'create' },
        }];

        const results = [];
        for (const testCase of cases) {
            const before = state();
            let error = '';
            try {
                await fio.importWorkbook(testCase.content, testCase.options);
            } catch (caught) {
                error = String(caught?.message || caught);
            }
            results.push({
                name: testCase.name,
                error,
                unchanged: before === state(),
            });
        }
        return results;
    });
    assert.deepEqual(rejected.map(result => result.name), [
        'malformed JSON', 'format mismatch', 'size mismatch',
        'hash mismatch', 'oversized payload',
    ]);
    for (const result of rejected) {
        assert(result.error, `${result.name} was unexpectedly accepted`);
        assert.equal(result.unchanged, true, `${result.name} changed notebook state`);
    }

    console.log('2. SRWB import is byte-verified, inert, sanitized, and preserves IDs/outputs...');
    const srwbObject = {
        format: 'srwb',
        format_version: '1.0',
        notebook: {
            name: 'Cálculo 日本語 <img id="catalog-name-xss" src=x onerror="window.__catalogImportExecuted=11">',
            description: 'Verified catalogue fixture',
            kernelLanguage: '<img id="catalog-kernel-xss" src=x>',
            // Serialized content may not grant itself trusted provenance.
            catalogId: 'forged/catalog-id',
            catalogRevision: 999,
            catalogSourceId: 'forged-source',
            catalogRef: 'forged-ref',
            catalogCommit: 'f'.repeat(40),
            catalogPath: 'forged/path.ipynb',
            catalogSha256: 'f'.repeat(64),
            cellCounter: 47,
            cells: [{
                id: 6,
                code: [
                    '# Safe heading',
                    '<img id="catalog-markdown-xss" ',
                    'src="https://example.invalid/catalog-import-network-sentinel-md" ',
                    'onerror="window.__catalogImportExecuted=12">',
                    '<script>window.__catalogImportExecuted=13<\/script>',
                ].join('\n'),
                type: 'markdown',
                language: 'markdown',
                name: 'heading',
                lastOutput: '',
                lastOutputHtml: '',
            }, {
                id: 23,
                code: 'window.__catalogImportExecuted = 14;',
                type: 'code',
                language: 'javascript',
                name: 'calculation',
                lastOutput: 'saved output text',
                lastOutputHtml: [
                    '<section id="catalog-safe-output"><strong>saved formatting</strong>',
                    '<script>window.__catalogImportExecuted=15<\/script>',
                    '<img src="https://example.invalid/catalog-import-network-sentinel-output" ',
                    'onerror="window.__catalogImportExecuted=16">',
                    '</section>',
                ].join(''),
            }],
        },
    };
    const srwb = JSON.stringify(srwbObject);
    const srwbResult = await page.evaluate(async ({ content, digest, size }) => {
        const nm = window.notebookManager;
        nm.setUIMode('tabs');
        let importCellsCalls = 0;
        const originalImportCells = window.importCells;
        window.importCells = function (...args) {
            importCellsCalls++;
            return originalImportCells.apply(this, args);
        };
        try {
            const receipt = await window.fileIO.importWorkbook(content, {
                format: 'srwb', mode: 'create', sha256: digest, size,
            });
            const active = nm.getActiveNotebook();
            const outputCell = window._cells.find(cell => cell.name === 'calculation');
            const outputBody = outputCell?.outputCard?.querySelector('.card-body');
            document.querySelectorAll('[onerror]').forEach(element =>
                element.dispatchEvent(new Event('error')));
            return {
                receipt,
                importCellsCalls,
                activeId: active?.id || null,
                name: active?.name || '',
                kernelLanguage: active?.kernelLanguage || null,
                forgedProvenance: {
                    catalogId: active?.catalogId || null,
                    catalogRevision: active?.catalogRevision ?? null,
                    catalogSourceId: active?.catalogSourceId || null,
                    catalogRef: active?.catalogRef || null,
                    catalogCommit: active?.catalogCommit || null,
                    catalogPath: active?.catalogPath || null,
                    catalogSha256: active?.catalogSha256 || null,
                },
                ids: window._cells.map(cell => cell.id),
                counter: window._cellCounter,
                notebookCounter: active?.cellCounter,
                lastOutput: outputCell?.lastOutput || '',
                lastOutputHtml: outputCell?.lastOutputHtml || '',
                outputText: outputBody?.textContent || '',
                safeFormatting: Boolean(outputBody?.querySelector(
                    '#catalog-safe-output strong')),
                injectedElements: document.querySelectorAll(
                    '#catalog-name-xss,#catalog-kernel-xss,'
                    + '#catalog-markdown-xss[src],#catalog-markdown-xss[onerror],'
                    + '#catalog-safe-output script,#catalog-safe-output [onerror]').length,
                tabText: document.querySelector('.notebook-tab.active .tab-name')?.textContent || '',
                executed: window.__catalogImportExecuted,
            };
        } finally {
            window.importCells = originalImportCells;
        }
    }, { content: srwb, digest: sha256(srwb), size: Buffer.byteLength(srwb, 'utf8') });
    assert.equal(srwbResult.receipt.ok, true);
    assert.equal(srwbResult.receipt.size, Buffer.byteLength(srwb, 'utf8'));
    assert.equal(srwbResult.receipt.sha256, sha256(srwb));
    assert.equal(srwbResult.importCellsCalls, 0, 'Atomic import called the auto-executing path');
    assert.deepEqual(srwbResult.ids, [6, 23]);
    assert.equal(srwbResult.counter, 47);
    assert.equal(srwbResult.notebookCounter, 47);
    assert.equal(srwbResult.kernelLanguage, 'python');
    assert.deepEqual(srwbResult.forgedProvenance, {
        catalogId: null,
        catalogRevision: null,
        catalogSourceId: null,
        catalogRef: null,
        catalogCommit: null,
        catalogPath: null,
        catalogSha256: null,
    });
    assert.equal(srwbResult.lastOutput, 'saved output text');
    assert.match(srwbResult.outputText, /saved formatting/);
    assert.equal(srwbResult.safeFormatting, true);
    assert.doesNotMatch(srwbResult.lastOutputHtml, /script|onerror|network-sentinel/i);
    assert.equal(srwbResult.injectedElements, 0);
    assert.equal(srwbResult.tabText, srwbResult.name);
    assert.equal(srwbResult.executed, 0);
    assert.deepEqual(importedRequests, [], 'Imported SRWB initiated a network request');

    console.log('3. Catalogue provenance, IDs, counters, and sanitized output survive reload...');
    await page.evaluate(() => {
        const active = window.notebookManager.getActiveNotebook();
        active.catalogId = 'official/workbook';
        active.catalogRevision = 7;
        active.catalogSourceId = 'official';
        active.catalogRef = 'v0.1.0';
        active.catalogCommit = '1'.repeat(40);
        active.catalogPath = 'workbooks/es/compute-pi.srwb';
        active.catalogSha256 = '2'.repeat(64);
        window.notebookManager.saveState();
    });
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForFunction(() => window.__SCIREPL_APP_READY === true
        && window.fileIO && window.notebookManager, { timeout: 30_000 });
    const restored = await page.evaluate(() => {
        const active = window.notebookManager.getActiveNotebook();
        const outputCell = window._cells.find(cell => cell.name === 'calculation');
        const outputBody = outputCell?.outputCard?.querySelector('.card-body');
        return {
            ids: window._cells.map(cell => cell.id),
            counter: window._cellCounter,
            notebookCounter: active?.cellCounter,
            lastOutput: outputCell?.lastOutput || '',
            lastOutputHtml: outputCell?.lastOutputHtml || '',
            renderedOutputHtml: outputBody?.innerHTML || '',
            provenance: {
                catalogId: active?.catalogId,
                catalogRevision: active?.catalogRevision,
                catalogSourceId: active?.catalogSourceId,
                catalogRef: active?.catalogRef,
                catalogCommit: active?.catalogCommit,
                catalogPath: active?.catalogPath,
                catalogSha256: active?.catalogSha256,
            },
            injectedElements: document.querySelectorAll(
                '#catalog-name-xss,#catalog-kernel-xss,'
                + '#catalog-markdown-xss[src],#catalog-markdown-xss[onerror],'
                + '#catalog-safe-output script,#catalog-safe-output [onerror]').length,
            executed: window.__catalogImportExecuted,
        };
    });
    assert.deepEqual(restored.ids, [6, 23]);
    assert.equal(restored.counter, 47);
    assert.equal(restored.notebookCounter, 47);
    assert.equal(restored.lastOutput, 'saved output text');
    assert.equal(restored.renderedOutputHtml, restored.lastOutputHtml);
    assert.deepEqual(restored.provenance, {
        catalogId: 'official/workbook',
        catalogRevision: 7,
        catalogSourceId: 'official',
        catalogRef: 'v0.1.0',
        catalogCommit: '1'.repeat(40),
        catalogPath: 'workbooks/es/compute-pi.srwb',
        catalogSha256: '2'.repeat(64),
    });
    assert.equal(restored.injectedElements, 0);
    assert.equal(restored.executed, 0);
    assert.deepEqual(importedRequests, [], 'Restored SRWB initiated a network request');

    console.log('4. IPYNB rich output is sanitized and code is not auto-executed...');
    const ipynb = JSON.stringify({
        nbformat: 4,
        nbformat_minor: 5,
        metadata: {
            kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' },
            language_info: { name: 'python' },
        },
        cells: [{
            cell_type: 'markdown',
            metadata: {},
            source: ['# IPYNB fixture'],
        }, {
            cell_type: 'code',
            execution_count: 1,
            metadata: { scirepl_name: { normalized: true } },
            source: ['%%javascript\n', 'window.__catalogImportExecuted = 21;'],
            outputs: [{
                output_type: 'display_data',
                data: {
                    'text/html': [
                        '<strong id="catalog-ipynb-safe">safe output</strong>',
                        '<script>window.__catalogImportExecuted=22<\/script>',
                        '<img src="https://example.invalid/catalog-import-network-sentinel-ipynb" ',
                        'onerror="window.__catalogImportExecuted=23">',
                    ],
                },
                metadata: {},
            }],
        }],
    });
    const ipynbResult = await page.evaluate(async ({ content, digest, size }) => {
        const receipt = await window.fileIO.importWorkbook(content, {
            format: 'ipynb', mode: 'replace', sha256: digest, size,
        });
        const active = window.notebookManager.getActiveNotebook();
        const codeCell = window._cells[1];
        const body = codeCell?.outputCard?.querySelector('.card-body');
        return {
            receipt,
            name: active?.name,
            language: codeCell?.language,
            code: codeCell?.code,
            cellName: codeCell?.name,
            safeOutput: Boolean(body?.querySelector('#catalog-ipynb-safe')),
            outputHtml: body?.innerHTML || '',
            provenance: [active?.catalogId, active?.catalogSourceId, active?.catalogSha256],
            executed: window.__catalogImportExecuted,
        };
    }, { content: ipynb, digest: sha256(ipynb), size: Buffer.byteLength(ipynb, 'utf8') });
    assert.equal(ipynbResult.receipt.ok, true);
    assert.equal(ipynbResult.name, 'IPYNB fixture');
    assert.equal(ipynbResult.language, 'javascript');
    assert.equal(ipynbResult.code, 'window.__catalogImportExecuted = 21;');
    assert.equal(ipynbResult.cellName, '[object Object]');
    assert.equal(ipynbResult.safeOutput, true);
    assert.doesNotMatch(ipynbResult.outputHtml, /script|onerror|network-sentinel/i);
    assert.deepEqual(ipynbResult.provenance, [null, null, null]);
    assert.equal(ipynbResult.executed, 0);
    assert.deepEqual(importedRequests, [], 'Imported IPYNB initiated a network request');

    console.log('5. A render-time failure restores the complete active notebook...');
    const rollback = await page.evaluate(async () => {
        const nm = window.notebookManager;
        const fio = window.fileIO;
        const app = window._appInternals;
        const summarize = () => {
            const active = nm.getActiveNotebook();
            return {
                activeId: active?.id,
                tabIds: nm.getNotebooks().map(notebook => notebook.id),
                name: active?.name,
                counter: window._cellCounter,
                notebookCounter: active?.cellCounter,
                provenance: [active?.catalogId, active?.catalogSourceId, active?.catalogSha256],
                cells: window._cells.map(cell => ({
                    id: cell.id,
                    code: cell.code,
                    type: cell.type,
                    language: cell.language,
                    name: cell.name,
                    lastOutput: cell.lastOutput,
                    lastOutputHtml: cell.lastOutputHtml,
                    rendered: cell.outputCard?.querySelector('.card-body')?.innerHTML || '',
                })),
            };
        };
        const before = summarize();
        const incoming = JSON.stringify({
            format: 'srwb',
            format_version: '1.0',
            notebook: {
                name: 'Must roll back',
                kernelLanguage: 'python',
                cells: [{ code: 'first', type: 'code', language: 'python' },
                    { code: 'second', type: 'code', language: 'python' }],
            },
        });
        const originalCreateInputCard = app.createInputCard;
        let calls = 0;
        let error = '';
        app.createInputCard = function (...args) {
            calls++;
            if (calls === 2) throw new Error('forced catalogue render failure');
            return originalCreateInputCard.apply(this, args);
        };
        try {
            await fio.importWorkbook(incoming, { format: 'srwb', mode: 'replace' });
        } catch (caught) {
            error = String(caught?.message || caught);
        } finally {
            app.createInputCard = originalCreateInputCard;
        }
        return { before, after: summarize(), error, calls };
    });
    assert.match(rollback.error, /forced catalogue render failure/);
    assert(rollback.calls >= 4, 'Rollback did not re-render the prior notebook');
    assert.deepEqual(rollback.after, rollback.before);

    assert.deepEqual(importedRequests, []);
    console.log('\nVerified catalogue workbook import regression passed');
    await context.close();
} finally {
    if (browser) await browser.close();
}
