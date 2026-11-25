/** Prepared archives render/import notebooks, never execute their cells. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
function harness(preference = '1') {
    const storage = new Map([['scirepl_auto_execute', preference], ['scirepl_auto_switch_workbook', '1']]);
    const calls = { storageWrites: [], execute: [], importCells: [], created: [], saved: 0, warnings: [], alerts: [] };
    const element = () => ({ style: {}, remove() {}, querySelector() { return null; } });
    const window = {
        ToolCore: {},
        addEventListener() {},
        t: key => key,
        _cells: [], _cellCounter: 0,
        AIPromptPlacement: { hydrateCell: cell => ({ ...cell }), hydrateCells: cells => cells.map(cell => ({ ...cell })) },
        _appInternals: {
            createInputCard: element, createOutputCard: element, renderMarkdown: text => text,
            executeCell: (...args) => calls.execute.push(args),
        },
        kernelManager: {
            getKernel() { return null; },
            execute: (...args) => calls.execute.push(args),
        },
        importCells: (...args) => calls.importCells.push(args),
    };
    const context = vm.createContext({ window, document: { addEventListener() {} },
        localStorage: {
            getItem: key => storage.get(key) ?? null,
            setItem(key, value) { calls.storageWrites.push([key, value]); storage.set(key, String(value)); },
            removeItem(key) { calls.storageWrites.push([key]); storage.delete(key); },
        },
        alert: message => calls.alerts.push(message),
        console: { error: (...args) => calls.warnings.push(args), warn: (...args) => calls.warnings.push(args), log() {} },
        TextEncoder, TextDecoder, Uint8Array, performance,
    });
    vm.runInContext(read('www/js/file_io.js').replace(/^window\.fileIO = new FileIO\(\);$/m, ''), context);
    vm.runInContext(read('www/js/notebook_manager.js').replace(/^window\.notebookManager = new NotebookManager\(\);$/m, ''), context);
    const file = vm.runInContext('Object.create(FileIO.prototype)', context);
    const manager = vm.runInContext('Object.create(NotebookManager.prototype)', context);
    manager.createNotebook = options => {
        const notebook = { ...options, id: `fixture-${calls.created.length}`, cells: [] };
        calls.created.push(notebook); return notebook;
    };
    manager.switchTo = id => { manager.activeId = id; };
    manager.getActiveNotebook = () => calls.created.find(notebook => notebook.id === manager.activeId);
    manager.saveState = () => { calls.saved++; };
    window.fileIO = file; window.notebookManager = manager;
    vm.runInContext(read('www/js/package_loader.js'), context);
    return { window, loader: window.packageLoader, calls, storage };
}
const srwb = JSON.stringify({ format: 'srwb', notebook: { name: 'Prepared SRWB',
    cells: [{ type: 'code', language: 'javascript', code: 'globalThis.preparedArchiveExecuted = true;' }] } });
const ipynb = JSON.stringify({ nbformat: 4, cells: [{ cell_type: 'code', source: 'globalThis.preparedArchiveExecuted = true;' }] });

for (const preference of ['1', '0']) {
    for (const type of ['srwb', 'ipynb']) {
        test(`prepared manifest ${type} notebook cannot execute cells with auto-execute preference ${preference}`, async () => {
            const { loader, calls, storage, window } = harness(preference);
            const filename = `example.${type}`;
            await loader.loadPrepared({ filename: 'fixture.zip', fileMap: new Map([[filename, type === 'srwb' ? srwb : ipynb]]),
                manifest: { format_version: '1.0', name: 'Fixture', notebooks: [{ file: filename, type }] } });
            assert.equal(calls.created.length, 1, 'notebook imported');
            assert.equal(calls.created[0].cells.length, 1, 'cell rendered');
            assert.equal(calls.created[0].cells[0].code, 'globalThis.preparedArchiveExecuted = true;');
            assert.deepEqual(calls.execute, []);
            assert.deepEqual(calls.importCells, [], 'does not enter preference-controlled import-and-run API');
            assert.equal(window.preparedArchiveExecuted, undefined);
            assert.equal(storage.get('scirepl_auto_execute'), preference);
            assert.deepEqual(calls.storageWrites, [], 'does not temporarily mutate the global execution preference');
            assert.deepEqual(calls.alerts, []);
            assert.deepEqual(calls.warnings, []);
        });
    }
}
test('plain prepared notebook archive renders without preference-controlled execution', async () => {
    const { loader, calls, storage } = harness('1');
    await loader.loadPrepared({ filename: 'plain.zip', manifest: null, fileMap: new Map([['example.ipynb', ipynb]]) });
    assert.equal(calls.created.length, 1);
    assert.equal(calls.created[0].cells.length, 1);
    assert.deepEqual(calls.execute, []);
    assert.deepEqual(calls.importCells, []);
    assert.equal(storage.get('scirepl_auto_execute'), '1');
    assert.deepEqual(calls.storageWrites, []);
    assert.deepEqual(calls.alerts, []);
    assert.deepEqual(calls.warnings, []);
});
test('restoring prepared notebooks never reimports notebooks or executes cells', async () => {
    const { loader, calls } = harness('1');
    await loader.remountPrepared({ filename: 'fixture.zip', fileMap: new Map([['example.srwb', srwb]]),
        manifest: { format_version: '1.0', name: 'Fixture', notebooks: [{ file: 'example.srwb', type: 'srwb' }] } });
    assert.deepEqual(calls.created, []);
    assert.deepEqual(calls.execute, []);
    assert.deepEqual(calls.importCells, []);
    assert.deepEqual(calls.storageWrites, []);
});
