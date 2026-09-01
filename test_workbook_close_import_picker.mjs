// Regression coverage for closing the final workbook and Android cloud-file
// picker MIME fallbacks.
import { chromium } from 'playwright';

const TIMEOUT = 180_000;
const APP_URL = process.env.SCIREPL_TEST_BASE || 'http://localhost:8085/';

(async () => {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 320, height: 640 } });
    let passed = true;
    let count = 0;
    const check = (name, ok, detail = '') => {
        count++;
        if (!ok) passed = false;
        console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ': ' + detail : ''}`);
    };

    await context.addInitScript(() => {
        // Exercise the native-only picker augmentation in an ordinary browser.
        window.Capacitor = { getPlatform: () => 'android' };
        localStorage.setItem('scirepl_privacy_accepted', '1');
        localStorage.setItem('scirepl_onboarding_seen', '1');
        addEventListener('DOMContentLoaded', () => {
            const version = window.KERNEL_CONFIG?.app?.version;
            if (version) localStorage.setItem('scirepl_whats_new_seen_version', version);
        }, { once: true });
    });

    const page = await context.newPage();
    const ready = async (target = page) => {
        await target.waitForFunction(() => window.__SCIREPL_APP_READY === true,
            null, { timeout: TIMEOUT });
        await target.waitForFunction(async () => {
            if (window.i18n?.init) await window.i18n.init();
            return document.getElementById('status-badge')?.className === 'ready';
        }, null, { timeout: TIMEOUT });
    };

    try {
        await page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
        await ready();

        console.log('1. Android picker accepts generic Dropbox MIME labels');
        const picker = await page.evaluate(() => ({
            file: document.getElementById('file-input')?.accept || '',
            package: document.getElementById('package-input')?.accept || ''
        }));
        check('ordinary import admits application/octet-stream on Android',
            picker.file.split(',').includes('application/octet-stream'), picker.file);
        check('package import admits application/octet-stream on Android',
            picker.package.split(',').includes('application/octet-stream'), picker.package);
        check('the original extension allowlist is retained',
            picker.file.includes('.srwb') && picker.file.includes('.ipynb'));

        const routing = await page.evaluate(async () => {
            const seen = [];
            window.fileIO.importSrwb = text => seen.push(['srwb', JSON.parse(text).format]);
            window.fileIO.importIpynb = text => seen.push(['ipynb', JSON.parse(text).nbformat]);
            window.fileIO.importPython = text => seen.push(['python', text]);
            window.fileIO._importToSharedVFS = file => seen.push(['vfs', file.name]);

            window.fileIO.handleFileUpload(new File([
                JSON.stringify({ format: 'srwb', format_version: '1.0', notebook: { cells: [] } })
            ], 'DROPBOX.SRWB', { type: 'application/octet-stream' }));
            window.fileIO.handleFileUpload(new File([
                JSON.stringify({ nbformat: 4, cells: [] })
            ], 'NOTEBOOK.IPYNB', { type: 'application/octet-stream' }));
            window.fileIO.handleFileUpload(new File(['print(1)'], 'SCRIPT.PY', {
                type: 'application/octet-stream'
            }));
            window.fileIO.handleFileUpload(new File([new Uint8Array([0, 1, 2])], 'DATA.BIN', {
                type: 'application/octet-stream'
            }));

            await new Promise(resolve => setTimeout(resolve, 50));
            return seen;
        });
        check('uppercase generic-MIME .SRWB routes to workbook import',
            routing.some(row => row[0] === 'srwb' && row[1] === 'srwb'), JSON.stringify(routing));
        check('uppercase generic-MIME .IPYNB routes to notebook import',
            routing.some(row => row[0] === 'ipynb' && row[1] === 4), JSON.stringify(routing));
        check('uppercase source extensions route case-insensitively',
            routing.some(row => row[0] === 'python' && row[1] === 'print(1)'), JSON.stringify(routing));
        check('intentional arbitrary-binary VFS import remains available',
            routing.some(row => row[0] === 'vfs' && row[1] === 'DATA.BIN'), JSON.stringify(routing));

        console.log('2. Older singleton state still migrates without data loss');
        const upgradeState = await page.evaluate(() => {
            const sm = window.sessionManager;
            const oldNotebook = window.notebookManager.getActiveNotebook().toJSON();
            oldNotebook.cells = [];
            oldNotebook.cellCounter = 0;
            return {
                ...sm.session,
                notebooks: [oldNotebook],
                activeNotebookId: oldNotebook.id,
                cells: [{
                code: 'LEGACY_UPGRADE_SENTINEL', type: 'markdown', language: 'python', name: ''
                }],
                cellCounter: 1
            };
        });
        // Seed from a same-origin page without SciREPL unload handlers, exactly
        // like storage left behind by an older installed release.
        await page.goto(new URL('/upgrade-fixture', APP_URL).href,
            { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
        await page.evaluate(state => localStorage.setItem(
            'scirepl_session_v2', JSON.stringify(state)), upgradeState);
        await page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
        await ready();
        const migrated = await page.evaluate(() => window._cells.map(cell => cell.code));
        check('legacy cells outrank an old stale empty notebook snapshot during upgrade',
            migrated.join('|') === 'LEGACY_UPGRADE_SENTINEL', JSON.stringify(migrated));

        const oldMultiState = await page.evaluate(() => {
            const base = window.notebookManager.getActiveNotebook().toJSON();
            const populated = {
                ...base,
                id: 'legacy-populated',
                name: 'Legacy populated',
                autoNameNumber: null,
                cellCounter: 1,
                cells: [{
                    id: 1, code: 'INACTIVE_NOTEBOOK_SENTINEL', type: 'markdown',
                    language: 'python', name: '', lastOutput: '', lastOutputHtml: ''
                }]
            };
            const empty = {
                ...base,
                id: 'legacy-empty-active',
                name: 'Legacy empty',
                autoNameNumber: null,
                cellCounter: 0,
                cells: []
            };
            return {
                ...window.sessionManager.session,
                notebooks: [populated, empty],
                activeNotebookId: empty.id,
                notebookStateVersion: 0,
                cells: [{
                    code: 'WRONG_LEGACY_FALLBACK', type: 'markdown',
                    language: 'python', name: ''
                }],
                cellCounter: 1
            };
        });
        await page.goto(new URL('/upgrade-multi-fixture', APP_URL).href,
            { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
        await page.evaluate(state => localStorage.setItem(
            'scirepl_session_v2', JSON.stringify(state)), oldMultiState);
        await page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
        await ready();
        const oldMulti = await page.evaluate(async () => {
            const nm = window.notebookManager;
            const startsEmpty = nm.getActiveNotebook()?.id === 'legacy-empty-active'
                && window._cells.length === 0;
            nm.switchTo('legacy-populated');
            const result = {
                startsEmpty,
                cells: window._cells.map(cell => cell.code),
                rendered: nm.getActiveNotebook()?.replContainer
                    ?.querySelectorAll('.card-input').length || 0
            };
            nm.switchTo('legacy-empty-active');
            await nm.closeNotebook('legacy-populated');
            return result;
        });
        check('an old multi-notebook session renders inactive content when active is empty',
            oldMulti.startsEmpty
                && oldMulti.cells.join('|') === 'INACTIVE_NOTEBOOK_SENTINEL'
                && oldMulti.rendered === 1,
            JSON.stringify(oldMulti));

        console.log('3. Closing the only workbook produces a fresh blank notebook');
        const seeded = await page.evaluate(async () => {
            const nm = window.notebookManager;
            const active = nm.getActiveNotebook();
            active.name = 'Dropbox fixture';
            active.autoNameNumber = null;
            active.catalogId = 'fixture-catalog';
            active.catalogRevision = 17;
            active.catalogSourceId = 'fixture-source';
            active.catalogRef = 'v17';
            active.catalogCommit = 'abc123';
            active.catalogPath = 'workbooks/fixture.srwb';
            active.catalogSha256 = 'deadbeef';
            const marker = document.createElement('article');
            marker.id = 'closed-workbook-marker';
            marker.className = 'cell-card';
            active.replContainer.appendChild(marker);
            window._cells = [{
                id: 7, code: 'OLD_WORKBOOK_SENTINEL', type: 'code', language: 'python',
                name: 'old', inputCard: marker, outputCard: null
            }];
            window._cellCounter = 7;
            nm.saveState();
            const saved = await window.sharedVFS.saveToIndexedDB();
            const diskFiles = await window.vfsStore.loadSharedFiles();
            return {
                id: active.id,
                stored: window.sessionManager.session.cells[0]?.code,
                saved,
                diskPaths: diskFiles.map(file => file.path)
            };
        });
        check('fixture includes a stale-compatible legacy snapshot',
            seeded.stored === 'OLD_WORKBOOK_SENTINEL' && seeded.saved
                && seeded.diskPaths.some(path => path.includes('Dropbox fixture')),
            JSON.stringify(seeded));

        await page.evaluate(() => {
            window.__nativeCloseConfirms = 0;
            window.confirm = () => { window.__nativeCloseConfirms++; return true; };
        });
        await page.click('#menu-btn');
        const closeHit = await page.evaluate(() => {
            const button = document.getElementById('btn-close-notebook');
            button.scrollIntoView({ block: 'center' });
            const box = button.getBoundingClientRect();
            const at = document.elementFromPoint(box.left + box.width / 2,
                box.top + box.height / 2);
            return {
                complete: box.left >= 0 && box.right <= innerWidth
                    && box.top >= 0 && box.bottom <= innerHeight,
                hit: at === button || button.contains(at),
                text: button.textContent.trim()
            };
        });
        check('Close notebook is a complete, hittable 320px menu action',
            closeHit.complete && closeHit.hit && closeHit.text.length > 1, JSON.stringify(closeHit));
        await page.click('#btn-close-notebook');

        await page.waitForSelector('#close-final-notebook-modal:not(.hidden)');
        const warning = await page.evaluate(() => ({
            body: document.getElementById('close-final-notebook-body')?.textContent || '',
            name: window.notebookManager.getActiveNotebook()?.name,
            nativeConfirms: window.__nativeCloseConfirms,
            settingDefault: localStorage.getItem('scirepl_explain_close_final_workbook')
        }));
        check('the first final-workbook close explains removal and exporting',
            warning.body.includes(warning.name) && /export/i.test(warning.body)
                && warning.nativeConfirms === 0 && warning.settingDefault === null,
            JSON.stringify(warning));
        const backResult = await page.evaluate(() => {
            const back = window.SciReplAndroidBack;
            return (back?.dismissTopmostUi || back?.dismissTopmost)?.call(back);
        });
        await page.waitForFunction(() => document.getElementById(
            'close-final-notebook-modal')?.classList.contains('hidden'));
        check('Android Back cancels the explanation and leaves the workbook open',
            backResult === 'modal'
                && await page.evaluate(oldId => !!window.notebookManager.getNotebook(oldId), seeded.id),
            String(backResult));

        await page.waitForFunction(() => !document.getElementById('btn-close-notebook')?.disabled);
        await page.click('#btn-close-notebook');
        await page.waitForSelector('#close-final-notebook-modal:not(.hidden)');
        await page.check('#close-final-notebook-dont-show');
        await page.click('#close-final-notebook-confirm');
        await page.waitForFunction(oldId => !window.notebookManager.getNotebook(oldId), seeded.id);
        await page.waitForFunction(() => !document.getElementById('btn-close-notebook')?.disabled);

        const closed = await page.evaluate((oldId) => {
            const nm = window.notebookManager;
            const active = nm.getActiveNotebook();
            const stored = window.sessionManager.session;
            let sharedNames = [];
            try { sharedNames = window.sharedVFS?.listDir('/shared/notebooks') || []; } catch (_) { }
            return {
                count: nm.getNotebooks().length,
                oldGone: !nm.getNotebook(oldId),
                newId: active?.id,
                cells: active?.cells.length,
                globalCells: window._cells.length,
                counter: window._cellCounter,
                autoNameNumber: active?.autoNameNumber,
                provenance: [active?.catalogId, active?.catalogRevision, active?.catalogSourceId,
                    active?.catalogRef, active?.catalogCommit, active?.catalogPath,
                    active?.catalogSha256],
                oldCardGone: !document.getElementById('closed-workbook-marker'),
                legacyCells: stored.cells.length,
                storedCells: stored.notebooks[0]?.cells?.length,
                activeStored: stored.activeNotebookId === active?.id,
                oldSharedGone: !sharedNames.some(name => name.includes('Dropbox_fixture')),
                explanationSuppressed: localStorage.getItem(
                    'scirepl_explain_close_final_workbook') === '0',
                selectorControls: document.querySelectorAll(
                    '#notebook-selector-container button, #notebook-selector-container select').length
            };
        }, seeded.id);
        check('exactly one new active notebook replaces the closed one',
            closed.count === 1 && closed.oldGone && closed.newId !== seeded.id, JSON.stringify(closed));
        check('replacement is a pristine Notebook 1',
            closed.cells === 0 && closed.globalCells === 0 && closed.counter === 0
                && closed.autoNameNumber === 1 && closed.provenance.every(value => value == null),
            JSON.stringify(closed));
        check('old DOM and synchronized workbook are removed',
            closed.oldCardGone && closed.oldSharedGone, JSON.stringify(closed));
        check('both notebook and legacy persistence are blank and aligned',
            closed.legacyCells === 0 && closed.storedCells === 0 && closed.activeStored,
            JSON.stringify(closed));
        check('Don’t show again suppresses only the explanatory warning',
            closed.explanationSuppressed, JSON.stringify(closed));
        check('singleton selector remains out of the crowded phone header',
            closed.selectorControls === 0, JSON.stringify(closed));

        // Open a second page without unloading the first. This is the closest
        // browser equivalent of an immediate Android process restart: no
        // beforeunload flush is available to repair stale IndexedDB data.
        const restartedPage = await context.newPage();
        await restartedPage.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
        await ready(restartedPage);
        const durableClose = await restartedPage.evaluate(async () => {
            const diskFiles = await window.vfsStore.loadSharedFiles();
            let memoryFiles = [];
            try { memoryFiles = window.sharedVFS.listDir('/shared/notebooks'); } catch (_) { }
            return {
                diskPaths: diskFiles.map(file => file.path),
                memoryFiles
            };
        });
        check('hard restart cannot restore the closed synchronized workbook',
            !durableClose.diskPaths.some(path => path.includes('Dropbox_fixture'))
                && !durableClose.memoryFiles.some(name => name.includes('Dropbox_fixture')),
            JSON.stringify(durableClose));
        await restartedPage.close();

        await page.click('#menu-btn');
        await page.click('#btn-settings');
        const warningSetting = await page.evaluate(async () => {
            const checkbox = document.getElementById('setting-explain-close-final');
            const initial = checkbox.checked;
            checkbox.click();
            const restored = checkbox.checked
                && localStorage.getItem('scirepl_explain_close_final_workbook') === '1';
            checkbox.click();
            return { initial, restored, final: checkbox.checked };
        });
        check('Settings can turn the explanation back on',
            !warningSetting.initial && warningSetting.restored && !warningSetting.final,
            JSON.stringify(warningSetting));
        await page.click('#settings-modal .modal-close');

        console.log('4. Reload cannot resurrect the closed workbook');
        await page.reload({ waitUntil: 'domcontentloaded', timeout: TIMEOUT });
        await ready();
        let restored = await page.evaluate(() => ({
            count: window.notebookManager.getNotebooks().length,
            id: window.notebookManager.getActiveNotebook()?.id,
            cells: window._cells.map(cell => cell.code),
            legacy: window.sessionManager.session.cells.map(cell => cell.code)
        }));
        check('blank replacement survives reload without old content',
            restored.count === 1 && restored.id === closed.newId
                && restored.cells.length === 0 && restored.legacy.length === 0,
            JSON.stringify(restored));

        // Add content through the real composer. This specifically proves that
        // ordinary singleton autosave keeps the authoritative notebook state
        // aligned after Close, rather than relying on a direct manager save.
        await page.click('#cell-type-toggle');
        await page.fill('#code-input', 'NEW_WORKBOOK_SENTINEL');
        await page.click('#run-btn');
        await page.waitForFunction(() => window._cells.some(
            cell => cell.code === 'NEW_WORKBOOK_SENTINEL' && cell.type === 'markdown'));
        await page.reload({ waitUntil: 'domcontentloaded', timeout: TIMEOUT });
        await ready();
        restored = await page.evaluate(() => ({
            cells: window._cells.map(cell => cell.code),
            legacy: window.sessionManager.session.cells.map(cell => cell.code)
        }));
        check('new replacement content, not old content, returns after reload',
            restored.cells.join('|') === 'NEW_WORKBOOK_SENTINEL'
                && restored.legacy.join('|') === 'NEW_WORKBOOK_SENTINEL',
            JSON.stringify(restored));

        console.log('5. Cancel and multi-notebook behavior remain safe');
        const cancelled = await page.evaluate(() => {
            const nm = window.notebookManager;
            const before = JSON.stringify({
                notebooks: nm.getNotebooks().map(nb => nb.toJSON()),
                active: nm.getActiveNotebook()?.id,
                session: window.sessionManager.session
            });
            let confirms = 0;
            window.confirm = () => { confirms++; return false; };
            document.getElementById('menu-btn').click();
            document.getElementById('btn-close-notebook').click();
            const after = JSON.stringify({
                notebooks: nm.getNotebooks().map(nb => nb.toJSON()),
                active: nm.getActiveNotebook()?.id,
                session: window.sessionManager.session
            });
            return {
                unchanged: before === after,
                confirms,
                explanationHidden: document.getElementById(
                    'close-final-notebook-modal').classList.contains('hidden')
            };
        });
        check('suppressed explanations still leave a final confirmation',
            cancelled.unchanged && cancelled.confirms === 1 && cancelled.explanationHidden,
            JSON.stringify(cancelled));

        const multiple = await page.evaluate(async () => {
            const nm = window.notebookManager;
            const original = nm.getActiveNotebook();
            const second = nm.createNotebook({ name: 'Second' });
            nm.switchTo(second.id);
            nm.saveState();
            await window.sharedVFS.saveToIndexedDB();
            const closedOk = await nm.closeNotebook(second.id);
            const diskFiles = await window.vfsStore.loadSharedFiles();
            return {
                closedOk,
                count: nm.getNotebooks().length,
                originalKept: nm.getActiveNotebook()?.id === original.id,
                secondGone: !nm.getNotebook(second.id),
                secondDiskGone: !diskFiles.some(file => file.path.includes('/Second_'))
            };
        });
        check('closing one of two keeps the existing notebook without a third',
            multiple.closedOk && multiple.count === 1
                && multiple.originalKept && multiple.secondGone && multiple.secondDiskGone,
            JSON.stringify(multiple));

        console.log('6. Failed destructive flushes retain deletion tombstones');
        const exerciseFailedFlush = async (sourcePage, name, failureMode) => {
            const prepared = await sourcePage.evaluate(async ({ name, failureMode }) => {
                const nm = window.notebookManager;
                const active = nm.getActiveNotebook();
                active.name = name;
                active.autoNameNumber = null;
                const binaryPath = `/shared/data/${name}.bin`;
                window.sharedVFS.mkdirTree('/shared/data');
                window.sharedVFS.writeFile(binaryPath,
                    new Uint8Array(400_000).fill(37), 'test');
                window._cells = [{
                    id: 1, code: `${name}_SENTINEL`, type: 'markdown', language: 'python',
                    name: '', inputCard: null, outputCard: null
                }];
                window._cellCounter = 1;
                nm.saveState();
                await window.sharedVFS.saveToIndexedDB();
                const beforeDisk = await window.vfsStore.loadSharedFiles();
                const oldPath = beforeDisk.find(file =>
                    file.path.startsWith('/shared/notebooks/') && file.path.includes(name))?.path || '';
                const realSave = window.sharedVFS.saveToIndexedDB;
                window.sharedVFS.saveToIndexedDB = failureMode === 'false'
                    ? async () => false
                    : async () => { throw new Error('forced IndexedDB rejection'); };
                let closedOk = false;
                try {
                    closedOk = await nm.closeNotebook(active.id);
                } finally {
                    window.sharedVFS.saveToIndexedDB = realSave;
                }
                const diskAfterFailure = await window.vfsStore.loadSharedFiles();
                return {
                    closedOk,
                    oldPath,
                    binaryPath,
                    diskStillHasOld: diskAfterFailure.some(file => file.path === oldPath),
                    tombstones: [...(window.sessionManager.session.sharedVFSDeletedPaths || [])],
                    hasFallback: Boolean(window.sessionManager.session.sharedVFS)
                };
            }, { name, failureMode });

            const recoveredPage = await context.newPage();
            await recoveredPage.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
            await ready(recoveredPage);
            const recovered = await recoveredPage.evaluate(async ({ oldPath, binaryPath }) => {
                const diskFiles = await window.vfsStore.loadSharedFiles();
                const binaryDisk = diskFiles.find(file => file.path === binaryPath);
                return {
                    diskHasOld: diskFiles.some(file => file.path === oldPath),
                    memoryHasOld: window.sharedVFS.exists(oldPath),
                    binaryDiskSize: binaryDisk?.size || 0,
                    binaryMemorySize: window.sharedVFS.stat(binaryPath)?.size || 0,
                    tombstones: [...(window.sessionManager.session.sharedVFSDeletedPaths || [])],
                    hasFallback: Boolean(window.sessionManager.session.sharedVFS)
                };
            }, { oldPath: prepared.oldPath, binaryPath: prepared.binaryPath });
            return { prepared, recovered, recoveredPage };
        };

        const falseFlush = await exerciseFailedFlush(page, 'FALLBACK_FALSE', 'false');
        check('a false IndexedDB result cannot resurrect the closed workbook',
            falseFlush.prepared.closedOk && falseFlush.prepared.diskStillHasOld
                && falseFlush.prepared.hasFallback
                && falseFlush.prepared.tombstones.includes(falseFlush.prepared.oldPath)
                && !falseFlush.recovered.diskHasOld && !falseFlush.recovered.memoryHasOld
                && falseFlush.recovered.binaryDiskSize === 400_000
                && falseFlush.recovered.binaryMemorySize === 400_000
                && falseFlush.recovered.tombstones.length === 0
                && !falseFlush.recovered.hasFallback,
            JSON.stringify({ prepared: falseFlush.prepared, recovered: falseFlush.recovered }));

        const rejectedFlush = await exerciseFailedFlush(
            falseFlush.recoveredPage, 'FALLBACK_REJECT', 'reject');
        check('a rejected IndexedDB write cannot resurrect the closed workbook',
            rejectedFlush.prepared.closedOk && rejectedFlush.prepared.diskStillHasOld
                && rejectedFlush.prepared.hasFallback
                && rejectedFlush.prepared.tombstones.includes(rejectedFlush.prepared.oldPath)
                && !rejectedFlush.recovered.diskHasOld && !rejectedFlush.recovered.memoryHasOld
                && rejectedFlush.recovered.binaryDiskSize === 400_000
                && rejectedFlush.recovered.binaryMemorySize === 400_000
                && rejectedFlush.recovered.tombstones.length === 0
                && !rejectedFlush.recovered.hasFallback,
            JSON.stringify({ prepared: rejectedFlush.prepared, recovered: rejectedFlush.recovered }));
        await rejectedFlush.recoveredPage.close();
        await falseFlush.recoveredPage.close();
    } catch (error) {
        passed = false;
        console.error(error);
    } finally {
        await context.close();
        await browser.close();
    }

    console.log(`\n${passed ? 'PASS' : 'FAIL'}: ${count} workbook close/import-picker checks`);
    process.exit(passed ? 0 : 1);
})();
