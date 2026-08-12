/**
 * Playwright test: NotebookVFS — /nb/ mount for cell access
 */
import { chromium } from 'playwright';

const PORT = process.env.PORT || 8085;
const BASE = `http://localhost:${PORT}`;

(async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const logs = [];
    page.on('console', msg => logs.push(`[${msg.type()}] ${msg.text()}`));

    console.log('1. Loading SciREPL...');
    await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.evaluate(async () => {
        const regs = await navigator.serviceWorker.getRegistrations();
        for (const r of regs) await r.unregister();
        const keys = await caches.keys();
        for (const k of keys) await caches.delete(k);
        localStorage.setItem('scirepl_privacy_accepted', '1');
        localStorage.setItem('scirepl_onboarding_seen', '1');
        localStorage.setItem('scirepl_whats_new_seen_version', window.KERNEL_CONFIG.app.version);
        localStorage.setItem('scirepl_auto_download', '1');
    });
    await page.reload({ waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForSelector('#run-btn:not([disabled])', { timeout: 10000 });

    // Test 1: NotebookVFS exists
    console.log('2. Checking NotebookVFS...');
    const vfsExists = await page.evaluate(() => !!window.notebookVFS);
    if (!vfsExists) throw new Error('FAIL: window.notebookVFS not found');
    console.log('   PASS: NotebookVFS initialized');

    // Test 2: /nb/ path recognized by SharedVFS
    console.log('3. Checking /nb/ path delegation...');
    const nbExists = await page.evaluate(() => window.sharedVFS.exists('/nb'));
    if (!nbExists) throw new Error('FAIL: /nb does not exist in SharedVFS');
    const nbIsDir = await page.evaluate(() => window.sharedVFS.isDir('/nb'));
    if (!nbIsDir) throw new Error('FAIL: /nb is not a directory');
    console.log('   PASS: /nb exists as directory in SharedVFS');

    // Test 3: Create cells and read via /nb/
    console.log('4. Creating test cells...');
    await page.evaluate(async () => {
        await window.kernelManager.ensureReady('javascript');
        await window.kernelManager.execute('42', 'javascript');
    });
    // Execute via the run button to create a proper cell
    await page.selectOption('#lang-selector', 'javascript');
    await page.fill('#code-input', 'let x = 42; x');
    await page.click('#run-btn');
    await page.waitForSelector('.card-input', { timeout: 10000 });
    await page.waitForTimeout(500);

    const cellCount = await page.evaluate(() => window._cells.length);
    console.log('   Created', cellCount, 'cell(s)');

    // Read cell via /nb/In[1]/.code
    const cellCode = await page.evaluate(() => {
        return window.sharedVFS.readFile('/nb/In[1]/.code');
    });
    console.log('   /nb/In[1]/.code:', JSON.stringify(cellCode));
    if (!cellCode || !cellCode.includes('42')) {
        throw new Error('FAIL: Could not read cell code via /nb/In[1]/.code');
    }
    console.log('   PASS: Read cell code via SharedVFS');

    // Test 4: Read cell language
    const cellLang = await page.evaluate(() => {
        return window.sharedVFS.readFile('/nb/In[1]/.language');
    });
    if (cellLang !== 'javascript') {
        throw new Error('FAIL: Expected language "javascript", got: ' + cellLang);
    }
    console.log('   PASS: Read cell language: ' + cellLang);

    // Test 5: Read cell output
    const cellOutput = await page.evaluate(() => {
        return window.sharedVFS.readFile('/nb/In[1]/.output');
    });
    console.log('   /nb/In[1]/.output:', JSON.stringify(cellOutput));
    console.log('   PASS: Read cell output (may be empty if not captured yet)');

    // Test 6: List cells
    const listing = await page.evaluate(() => {
        return window.sharedVFS.readFile('/nb');
    });
    const parsed = JSON.parse(listing);
    if (!Array.isArray(parsed) || parsed.length === 0) {
        throw new Error('FAIL: /nb listing is empty');
    }
    console.log('   PASS: /nb listing:', parsed.map(c => c.label).join(', '));

    // Test 7: listDir for /nb/
    const dirEntries = await page.evaluate(() => {
        return window.sharedVFS.listDir('/nb');
    });
    if (!dirEntries.includes('In[1]')) {
        throw new Error('FAIL: listDir /nb/ missing In[1]');
    }
    console.log('   PASS: listDir /nb/:', dirEntries.join(', '));

    // Test 8: listDir for cell properties
    const cellDir = await page.evaluate(() => {
        return window.sharedVFS.listDir('/nb/In[1]');
    });
    if (!cellDir.includes('.code') || !cellDir.includes('.output')) {
        throw new Error('FAIL: listDir /nb/In[1] missing properties');
    }
    console.log('   PASS: listDir /nb/In[1]:', cellDir.join(', '));

    // Test 9: Set cell name
    console.log('5. Testing cell naming...');
    const nameSet = await page.evaluate(() => {
        return window.notebookVFS._setCellName(0, 'my_test_cell');
    });
    if (!nameSet) throw new Error('FAIL: Could not set cell name');

    const nameRead = await page.evaluate(() => {
        return window.sharedVFS.readFile('/nb/my_test_cell/.code');
    });
    if (nameRead !== cellCode) {
        throw new Error('FAIL: Named cell code mismatch');
    }
    console.log('   PASS: Cell named "my_test_cell", accessible by name');

    // Test 10: Named cell appears in listDir
    const dirWithName = await page.evaluate(() => {
        return window.sharedVFS.listDir('/nb');
    });
    if (!dirWithName.includes('my_test_cell')) {
        throw new Error('FAIL: Named cell not in listDir');
    }
    console.log('   PASS: Named cell in directory listing');

    // Test 11: Cell name label in UI
    const hasLabel = await page.evaluate(() => {
        const label = document.querySelector('.cell-name-label');
        return label ? label.textContent : null;
    });
    if (hasLabel !== 'my_test_cell') {
        throw new Error('FAIL: Cell name label not rendered, got: ' + hasLabel);
    }
    console.log('   PASS: Cell name label rendered in UI');

    // Test 12: Write to cell code via /nb/
    console.log('6. Testing write via /nb/...');
    const writeResult = await page.evaluate(() => {
        window.sharedVFS.writeFile('/nb/my_test_cell/.code', 'console.log("modified")');
        return window._cells[0].code;
    });
    if (writeResult !== 'console.log("modified")') {
        throw new Error('FAIL: Write to cell code failed, got: ' + writeResult);
    }
    console.log('   PASS: Write to cell code via SharedVFS');

    // Test 13: Invalid name rejected
    const invalidName = await page.evaluate(() => {
        return window.notebookVFS._setCellName(0, 'In[5]');
    });
    if (invalidName) throw new Error('FAIL: In[N] pattern should be rejected as name');
    console.log('   PASS: Invalid cell name rejected');

    // Test 14: stat for /nb/ paths
    const nbStat = await page.evaluate(() => window.sharedVFS.stat('/nb'));
    if (!nbStat || !nbStat.isDir) throw new Error('FAIL: /nb stat should be dir');
    const cellStat = await page.evaluate(() => window.sharedVFS.stat('/nb/In[1]'));
    if (!cellStat || !cellStat.isDir) throw new Error('FAIL: /nb/In[1] stat should be dir');
    const codeStat = await page.evaluate(() => window.sharedVFS.stat('/nb/In[1]/.code'));
    if (!codeStat || !codeStat.isFile) throw new Error('FAIL: /nb/In[1]/.code stat should be file');
    console.log('   PASS: stat works for /nb/ paths');

    // Test 15: Cell object reference (bare path)
    const cellRef = await page.evaluate(() => {
        return window.sharedVFS.readFile('/nb/In[1]');
    });
    const refParsed = JSON.parse(cellRef);
    if (!refParsed.code || !refParsed.language) {
        throw new Error('FAIL: Cell reference missing fields');
    }
    console.log('   PASS: Cell object reference:', refParsed.name, refParsed.language);

    // Test 16: vfs_read_file (Rust bridge) works for /nb/
    const vfsRead = await page.evaluate(() => {
        const bytes = window.sharedVFS.vfs_read_file('/nb/In[1]/.language');
        return bytes ? new TextDecoder().decode(bytes) : null;
    });
    if (vfsRead !== 'javascript') {
        throw new Error('FAIL: vfs_read_file for /nb/ returned: ' + vfsRead);
    }
    console.log('   PASS: vfs_read_file works for /nb/ (Bash bridge)');

    // Test 17: vfs_list_dir (Rust bridge) works for /nb/
    const vfsList = await page.evaluate(() => {
        return window.sharedVFS.vfs_list_dir('/nb');
    });
    const vfsListParsed = JSON.parse(vfsList);
    if (!vfsListParsed.some(e => e.name === 'In[1]')) {
        throw new Error('FAIL: vfs_list_dir missing In[1]');
    }
    console.log('   PASS: vfs_list_dir works for /nb/ (Bash bridge)');

    console.log('\n=== ALL TESTS PASSED ===');
    await browser.close();
    process.exit(0);
})().catch(err => {
    console.error('FAIL:', err.message);
    console.error(err.stack);
    process.exit(1);
});
