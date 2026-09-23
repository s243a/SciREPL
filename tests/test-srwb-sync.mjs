/**
 * Playwright test: verify .srwb files are synced to SharedVFS
 * when notebooks are saved.
 */
import { chromium } from 'playwright';

const BASE = 'http://localhost:8080';

(async () => {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();

    // Collect console messages for debugging
    const logs = [];
    page.on('console', msg => logs.push(`[${msg.type()}] ${msg.text()}`));

    console.log('1. Loading SciREPL...');
    await page.goto(BASE, { waitUntil: 'networkidle', timeout: 30000 });

    // Wait for the app to initialize
    await page.waitForFunction(() => window.sharedVFS && window.notebookManager, { timeout: 15000 });
    console.log('   App initialized.');

    // 2. Check that /shared/notebooks directory exists
    const dirExists = await page.evaluate(() => {
        return window.sharedVFS._dirs.has('/shared/notebooks');
    });
    console.log(`2. /shared/notebooks dir exists: ${dirExists}`);
    if (!dirExists) throw new Error('/shared/notebooks directory not created');

    // 3. Trigger a save and check for .srwb files
    console.log('3. Triggering notebook save...');
    await page.evaluate(() => {
        window.notebookManager.saveState();
    });

    // Small delay for sync
    await page.waitForTimeout(500);

    const files = await page.evaluate(() => {
        return window.sharedVFS.listDir('/shared/notebooks');
    });
    console.log(`   Files in /shared/notebooks: ${JSON.stringify(files)}`);

    const srwbFiles = files.filter(f => f.endsWith('.srwb'));
    if (srwbFiles.length === 0) throw new Error('No .srwb files found after save');
    console.log(`   Found ${srwbFiles.length} .srwb file(s): ${srwbFiles.join(', ')}`);

    // 4. Read and validate the .srwb content
    const firstFile = srwbFiles[0];
    const content = await page.evaluate((filename) => {
        const entry = window.sharedVFS._files.get('/shared/notebooks/' + filename);
        return entry ? entry.content : null;
    }, firstFile);

    if (!content) throw new Error('Could not read .srwb file content');

    const parsed = JSON.parse(content);
    console.log(`4. .srwb format: ${parsed.format}, version: ${parsed.format_version}`);
    console.log(`   Notebook name: ${parsed.notebook.name}`);
    console.log(`   Cells: ${parsed.notebook.cells.length}`);

    if (parsed.format !== 'srwb') throw new Error('Wrong format field');
    if (parsed.format_version !== '1.0') throw new Error('Wrong format_version');
    if (!parsed.notebook.name) throw new Error('Missing notebook name');
    if (!parsed.notebook.id) throw new Error('Missing notebook id');

    // 5. Create a second notebook tab and verify both sync
    console.log('5. Creating second notebook...');
    await page.evaluate(() => {
        window.notebookManager.createNotebook({ name: 'Test Notebook 2' });
        window.notebookManager.saveState();
    });

    await page.waitForTimeout(500);

    const files2 = await page.evaluate(() => {
        return window.sharedVFS.listDir('/shared/notebooks');
    });
    const srwb2 = files2.filter(f => f.endsWith('.srwb'));
    console.log(`   Files after second notebook: ${srwb2.join(', ')}`);
    if (srwb2.length < 2) throw new Error(`Expected 2+ .srwb files, got ${srwb2.length}`);

    // 6. Delete the second notebook and verify cleanup
    console.log('6. Deleting second notebook...');
    await page.evaluate(() => {
        const nbs = window.notebookManager.getNotebooks();
        const second = nbs.find(n => n.name === 'Test Notebook 2');
        if (second) {
            window.notebookManager.removeNotebook(second.id);
            window.notebookManager.saveState();
        }
    });

    await page.waitForTimeout(500);

    const files3 = await page.evaluate(() => {
        return window.sharedVFS.listDir('/shared/notebooks');
    });
    const srwb3 = files3.filter(f => f.endsWith('.srwb'));
    console.log(`   Files after deletion: ${srwb3.join(', ')}`);
    if (srwb3.length !== 1) throw new Error(`Expected 1 .srwb file after deletion, got ${srwb3.length}`);

    // 7. Verify the file browser would show these files
    console.log('7. Checking file browser visibility...');
    const browserFiles = await page.evaluate(() => {
        const vfs = window.sharedVFS;
        const all = [];
        for (const [path] of vfs._files) {
            if (path.startsWith('/shared/notebooks/')) all.push(path);
        }
        return all;
    });
    console.log(`   SharedVFS paths: ${browserFiles.join(', ')}`);

    console.log('\n✓ All tests passed!');

    await browser.close();
    process.exit(0);
})().catch(err => {
    console.error('\n✗ Test failed:', err.message);
    process.exit(1);
});
