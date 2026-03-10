/**
 * Playwright test: Export Workbooks & Packages modal
 * Tests modal open/close, section visibility toggling, and export dispatch.
 */
import { chromium } from 'playwright';

const BASE = 'http://localhost:8085';

(async () => {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();

    const logs = [];
    page.on('console', msg => logs.push(`[${msg.type()}] ${msg.text()}`));

    console.log('1. Loading SciREPL...');
    await page.goto(BASE, { waitUntil: 'networkidle', timeout: 30000 });

    // Wait for app to initialize
    await page.waitForFunction(() => window.notebookManager && window.fileIO, { timeout: 15000 });
    console.log('   App initialized.');

    // 2. Open menu and click Export Workbooks & Packages
    console.log('2. Opening Export Workbooks & Packages modal...');
    await page.click('#menu-btn');
    await page.waitForSelector('#menu-modal:not(.hidden)', { timeout: 5000 });
    await page.click('#btn-export-workbook');
    await page.waitForSelector('#export-workbook-modal:not(.hidden)', { timeout: 5000 });
    console.log('   Modal opened.');

    // 3. Verify default state: srwb selected, scope visible, kernel/archive hidden
    console.log('3. Verifying default modal state...');
    const defaultState = await page.evaluate(() => {
        const modal = document.getElementById('export-workbook-modal');
        const format = modal.querySelector('input[name="wb-export-format"]:checked').value;
        const scope = modal.querySelector('input[name="wb-export-scope"]:checked').value;
        const scopeHidden = document.getElementById('wb-scope-section').classList.contains('hidden');
        const kernelHidden = document.getElementById('wb-kernel-section').classList.contains('hidden');
        const archiveHidden = document.getElementById('wb-archive-section').classList.contains('hidden');
        return { format, scope, scopeHidden, kernelHidden, archiveHidden };
    });
    console.log(`   Format: ${defaultState.format}, Scope: ${defaultState.scope}`);
    console.log(`   Scope hidden: ${defaultState.scopeHidden}, Kernel hidden: ${defaultState.kernelHidden}, Archive hidden: ${defaultState.archiveHidden}`);
    if (defaultState.format !== 'srwb') throw new Error('Default format should be srwb');
    if (defaultState.scope !== 'current') throw new Error('Default scope should be current');
    if (defaultState.scopeHidden) throw new Error('Scope section should be visible for srwb');
    if (!defaultState.kernelHidden) throw new Error('Kernel section should be hidden for srwb');
    if (!defaultState.archiveHidden) throw new Error('Archive section should be hidden for srwb');

    // 4. Switch to ipynb — kernel should show, archive should stay hidden
    console.log('4. Switching to ipynb format...');
    await page.click('input[name="wb-export-format"][value="ipynb"]');
    const ipynbState = await page.evaluate(() => {
        const scopeHidden = document.getElementById('wb-scope-section').classList.contains('hidden');
        const kernelHidden = document.getElementById('wb-kernel-section').classList.contains('hidden');
        const archiveHidden = document.getElementById('wb-archive-section').classList.contains('hidden');
        return { scopeHidden, kernelHidden, archiveHidden };
    });
    console.log(`   Scope hidden: ${ipynbState.scopeHidden}, Kernel hidden: ${ipynbState.kernelHidden}, Archive hidden: ${ipynbState.archiveHidden}`);
    if (ipynbState.scopeHidden) throw new Error('Scope should be visible for ipynb');
    if (ipynbState.kernelHidden) throw new Error('Kernel should be visible for ipynb');
    if (!ipynbState.archiveHidden) throw new Error('Archive should be hidden for ipynb');

    // 5. Switch to package — scope should hide, archive should show, kernel should hide
    console.log('5. Switching to package format...');
    await page.click('input[name="wb-export-format"][value="package"]');
    const pkgState = await page.evaluate(() => {
        const scopeHidden = document.getElementById('wb-scope-section').classList.contains('hidden');
        const kernelHidden = document.getElementById('wb-kernel-section').classList.contains('hidden');
        const archiveHidden = document.getElementById('wb-archive-section').classList.contains('hidden');
        return { scopeHidden, kernelHidden, archiveHidden };
    });
    console.log(`   Scope hidden: ${pkgState.scopeHidden}, Kernel hidden: ${pkgState.kernelHidden}, Archive hidden: ${pkgState.archiveHidden}`);
    if (!pkgState.scopeHidden) throw new Error('Scope should be hidden for package');
    if (!pkgState.kernelHidden) throw new Error('Kernel should be hidden for package');
    if (pkgState.archiveHidden) throw new Error('Archive should be visible for package');

    // 6. Close modal via backdrop click
    console.log('6. Testing modal close (backdrop click)...');
    await page.click('#export-workbook-modal', { position: { x: 5, y: 5 } });
    const closed = await page.evaluate(() =>
        document.getElementById('export-workbook-modal').classList.contains('hidden')
    );
    if (!closed) throw new Error('Modal should close on backdrop click');
    console.log('   Modal closed.');

    // 7. Re-open and close via X button
    console.log('7. Testing modal close (X button)...');
    await page.click('#menu-btn');
    await page.waitForSelector('#menu-modal:not(.hidden)', { timeout: 5000 });
    await page.click('#btn-export-workbook');
    await page.waitForSelector('#export-workbook-modal:not(.hidden)', { timeout: 5000 });
    await page.click('#export-workbook-modal .modal-close');
    const closed2 = await page.evaluate(() =>
        document.getElementById('export-workbook-modal').classList.contains('hidden')
    );
    if (!closed2) throw new Error('Modal should close on X click');
    console.log('   Modal closed via X.');

    // 8. Test .srwb export (current tab) — intercept download
    console.log('8. Testing .srwb export (current tab)...');
    await page.click('#menu-btn');
    await page.waitForSelector('#menu-modal:not(.hidden)', { timeout: 5000 });
    await page.click('#btn-export-workbook');
    await page.waitForSelector('#export-workbook-modal:not(.hidden)', { timeout: 5000 });
    // Make sure srwb is selected
    await page.click('input[name="wb-export-format"][value="srwb"]');
    await page.click('input[name="wb-export-scope"][value="current"]');

    // Intercept download
    const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 10000 }),
        page.click('#btn-do-export-workbook')
    ]);
    const filename = download.suggestedFilename();
    console.log(`   Downloaded: ${filename}`);
    if (!filename.endsWith('.srwb')) throw new Error(`Expected .srwb file, got: ${filename}`);

    // Read and validate content
    const downloadPath = await download.path();
    const fs = await import('fs');
    const content = fs.readFileSync(downloadPath, 'utf-8');
    const srwb = JSON.parse(content);
    console.log(`   Format: ${srwb.format}, Version: ${srwb.format_version}`);
    console.log(`   Notebook name: ${srwb.notebook?.name || 'N/A'}`);
    if (srwb.format !== 'srwb') throw new Error('Wrong format');
    if (srwb.format_version !== '1.0') throw new Error('Wrong format_version');
    if (!srwb.notebook) throw new Error('Missing notebook field');
    if (!srwb.exported_at) throw new Error('Missing exported_at');

    // 9. Test .srwb export (all tabs)
    console.log('9. Testing .srwb export (all tabs)...');
    await page.click('#menu-btn');
    await page.waitForSelector('#menu-modal:not(.hidden)', { timeout: 5000 });
    await page.click('#btn-export-workbook');
    await page.waitForSelector('#export-workbook-modal:not(.hidden)', { timeout: 5000 });
    await page.click('input[name="wb-export-format"][value="srwb"]');
    await page.click('input[name="wb-export-scope"][value="all"]');

    const [download2] = await Promise.all([
        page.waitForEvent('download', { timeout: 10000 }),
        page.click('#btn-do-export-workbook')
    ]);
    const filename2 = download2.suggestedFilename();
    console.log(`   Downloaded: ${filename2}`);
    if (!filename2.endsWith('.srwb')) throw new Error(`Expected .srwb, got: ${filename2}`);
    const content2 = fs.readFileSync(await download2.path(), 'utf-8');
    const srwb2 = JSON.parse(content2);
    console.log(`   Format: ${srwb2.format}, workbook notebooks: ${srwb2.workbook?.notebooks?.length || 0}`);
    if (!srwb2.workbook) throw new Error('Missing workbook field for all-tabs export');
    if (!srwb2.workbook.notebooks || srwb2.workbook.notebooks.length === 0) throw new Error('Empty notebooks array');

    // 10. Add a code cell so ipynb has content to export
    console.log('10. Adding a code cell for .ipynb test...');
    await page.evaluate(() => {
        // Add a cell via the global API
        if (window._cells && window._cells.length === 0) {
            window._cells.push({
                id: 1,
                type: 'code',
                language: 'python',
                code: 'print("hello")',
                outputs: []
            });
            window._cellCounter = 1;
        }
    });

    // 11. Test .ipynb export
    console.log('11. Testing .ipynb export...');
    await page.click('#menu-btn');
    await page.waitForSelector('#menu-modal:not(.hidden)', { timeout: 5000 });
    await page.click('#btn-export-workbook');
    await page.waitForSelector('#export-workbook-modal:not(.hidden)', { timeout: 5000 });
    await page.click('input[name="wb-export-format"][value="ipynb"]');
    await page.click('input[name="wb-export-scope"][value="current"]');

    const [download3] = await Promise.all([
        page.waitForEvent('download', { timeout: 10000 }),
        page.click('#btn-do-export-workbook')
    ]);
    const filename3 = download3.suggestedFilename();
    console.log(`   Downloaded: ${filename3}`);
    if (!filename3.endsWith('.ipynb')) throw new Error(`Expected .ipynb, got: ${filename3}`);
    const content3 = fs.readFileSync(await download3.path(), 'utf-8');
    const ipynb = JSON.parse(content3);
    console.log(`   nbformat: ${ipynb.nbformat}, cells: ${ipynb.cells?.length || 0}`);
    if (ipynb.nbformat !== 4) throw new Error('Wrong nbformat');
    if (!ipynb.metadata?.kernelspec) throw new Error('Missing kernelspec');

    // 12. Create a second notebook and test .ipynb all-tabs zip export
    console.log('12. Creating second notebook for all-tabs .ipynb test...');
    await page.evaluate(() => {
        const nm = window.notebookManager;
        const nb2 = nm.createNotebook({ name: 'Test Notebook 2' });
        // Add a cell to the second notebook
        nb2.cells = [{
            id: 1, type: 'code', language: 'r',
            code: 'print("hello from R")', outputs: []
        }];
        nb2.cellCounter = 1;
        // Switch back to first notebook so nb2 is inactive
        const first = nm.getNotebooks()[0];
        nm.switchTo(first.id);
    });

    console.log('13. Testing .ipynb export (all tabs → zip)...');
    await page.click('#menu-btn');
    await page.waitForSelector('#menu-modal:not(.hidden)', { timeout: 5000 });
    await page.click('#btn-export-workbook');
    await page.waitForSelector('#export-workbook-modal:not(.hidden)', { timeout: 5000 });
    await page.click('input[name="wb-export-format"][value="ipynb"]');
    await page.click('input[name="wb-export-scope"][value="all"]');

    const [download4] = await Promise.all([
        page.waitForEvent('download', { timeout: 10000 }),
        page.click('#btn-do-export-workbook')
    ]);
    const filename4 = download4.suggestedFilename();
    console.log(`   Downloaded: ${filename4}`);
    if (!filename4.endsWith('.zip')) throw new Error(`Expected .zip for multi-tab ipynb, got: ${filename4}`);
    console.log('   Multi-tab .ipynb zip export works.');

    // 14. Verify menu still has Export Document button
    console.log('14. Verifying Export Document button still exists...');
    await page.click('#menu-btn');
    await page.waitForSelector('#menu-modal:not(.hidden)', { timeout: 5000 });
    const hasExportDoc = await page.evaluate(() => !!document.getElementById('btn-export'));
    if (!hasExportDoc) throw new Error('Export Document button missing from menu');
    console.log('   Export Document button present.');

    // Verify old buttons are gone
    const hasOldIpynb = await page.evaluate(() => !!document.getElementById('btn-export-ipynb'));
    const hasOldPkg = await page.evaluate(() => !!document.getElementById('btn-export-package'));
    if (hasOldIpynb) throw new Error('Old btn-export-ipynb should be removed');
    if (hasOldPkg) throw new Error('Old btn-export-package should be removed');
    console.log('   Old buttons removed correctly.');

    console.log('\n✓ All export workbook tests passed!');

    await browser.close();
    process.exit(0);
})().catch(err => {
    console.error('\n✗ Test failed:', err.message);
    process.exit(1);
});
