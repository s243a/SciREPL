/* Real DOM + IndexedDB + validator/controller/loader across reloads.
 * Kernel/notebook fixtures are deliberately local; this is not a device gate. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../www');
const scripts = ['vendor/jszip/jszip.min.js', 'vendor/pako/pako_inflate.min.js', 'js/package_archive_validation.js',
    'js/package_archive_store.js', 'js/package_install_ui.js', 'js/package_loader.js', 'js/package_installs.js'];
const html = `<!doctype html><html><head><meta charset="UTF-8"><link rel="stylesheet" href="/css/style.css"></head><body>
<button id="catalog-manage-installed" hidden>Saved packages</button>
<script>
window.Capacitor={getPlatform:()=> 'android'};
window.t=key=>key;
window.fixtureFiles=new Map(); window.fixtureExecution=0;
if(!localStorage.fixtureNotebooks) localStorage.fixtureNotebooks=JSON.stringify([{id:'existing-1'},{id:'existing-2'}]);
window.kernelManager={async ensureReady(){},getKernel:()=>({getVFS:()=>({exists:p=>fixtureFiles.has(p),bulkWrite:rows=>rows.forEach(r=>fixtureFiles.set(r.path,r.content)),addSearchPath(){}}),isReady:()=>false})};
window.notebookManager={getNotebooks:()=>JSON.parse(localStorage.fixtureNotebooks)};
window.sharedVFS={}; window.executeCell=()=>fixtureExecution++;
</script>${scripts.map(src => `<script src="/${src}"></script>`).join('')}
<script>
window.beginFixture=async(value)=>{
  const zip=new JSZip();
  zip.file('scirepl.json',JSON.stringify({format_version:'1.0',name:'Fixture package',files:[{src:'lib.pl',dest:'/user/fixture/lib.pl'}]}));
  zip.file('lib.pl',value);
  const file=new File([await zip.generateAsync({type:'uint8array'})],'fixture.zip');
  window.fixtureOutcome=null;
  packageInstalls.install(file).then(value=>window.fixtureOutcome={ok:true,value},error=>window.fixtureOutcome={ok:false,code:error.code});
};
</script></body></html>`;
const server = createServer((request, response) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    if (pathname === '/') { response.setHeader('content-type', 'text/html; charset=utf-8'); response.end(html); return; }
    const filename = path.resolve(root, '.' + pathname);
    if (!filename.startsWith(root + path.sep)) { response.writeHead(404); response.end(); return; }
    try { const data = readFileSync(filename); response.setHeader('content-type', filename.endsWith('.css') ? 'text/css' : 'application/javascript'); response.end(data); }
    catch { response.writeHead(404); response.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
let checks = 0;
const check = (value, label) => { assert.ok(value, label); checks++; };
try {
    const context = await browser.newContext({ viewport: { width: 412, height: 915 } });
    const page = await context.newPage();
    const nativeDialogs = [];
    page.on('dialog', async dialog => { nativeDialogs.push(dialog.type()); await dialog.dismiss(); });
    const origin = `http://127.0.0.1:${server.address().port}/`;
    await page.goto(origin);
    const notebooks = await page.evaluate(() => localStorage.fixtureNotebooks);
    await page.evaluate(() => beginFixture('fixture(v1).'));
    await page.locator('#package-install-cancel').click();
    await page.waitForFunction(() => fixtureOutcome !== null);
    check(await page.evaluate(() => fixtureOutcome.code === 'INSTALL_CANCELLED' && fixtureFiles.size === 0 && !document.getElementById('package-install-choice-modal')), 'Cancel leaves no import or queued dialog');
    check(await page.evaluate(async () => (await packageArchiveStore.list()).length === 0), 'Cancel stores nothing');
    await page.evaluate(() => beginFixture('fixture(v1).'));
    check(await page.locator('#package-install-persistent').isChecked(), 'Persistent is default');
    await page.locator('#package-install-confirm').click();
    await page.waitForFunction(() => fixtureOutcome !== null);
    check(await page.evaluate(() => fixtureOutcome.ok && fixtureOutcome.value.mode === 'persistent' && fixtureFiles.get('/user/fixture/lib.pl') === 'fixture(v1).'), 'Persistent choice installs supporting file');
    check(await page.evaluate(async () => (await packageArchiveStore.list()).length === 1), 'Persistent archive committed');
    await page.reload();
    check(await page.evaluate(() => fixtureFiles.size === 0), 'Fresh session starts with empty fixture kernel');
    await context.setOffline(true);
    await page.evaluate(() => packageInstalls.restore());
    check(await page.evaluate(() => fixtureFiles.get('/user/fixture/lib.pl') === 'fixture(v1).'), 'Retained bytes restore while offline after reload');
    check(await page.evaluate(() => localStorage.fixtureNotebooks) === notebooks, 'Restore preserves existing notebooks');
    await page.evaluate(() => beginFixture('fixture(v2-session).'));
    await page.locator('#package-install-session').check();
    await page.locator('#package-install-confirm').click();
    await page.waitForFunction(() => fixtureOutcome !== null);
    check(await page.evaluate(() => fixtureOutcome.ok && fixtureFiles.get('/user/fixture/lib.pl') === 'fixture(v2-session).'), 'Session choice takes effect now');
    check(await page.evaluate(async () => (await packageArchiveStore.list()).length === 1), 'Session choice retains no additional archive');
    await context.setOffline(false); await page.reload(); await context.setOffline(true);
    await page.evaluate(() => packageInstalls.restore());
    check(await page.evaluate(() => fixtureFiles.get('/user/fixture/lib.pl') === 'fixture(v1).'), 'Session replacement does not change retained version');
    await page.locator('#catalog-manage-installed').click();
    await page.locator('[data-package-remove]').click();
    await page.locator('#package-install-remove-confirm').click();
    await page.waitForFunction(async () => (await packageArchiveStore.list()).length === 0);
    await page.locator('#package-install-manage-close').click();
    check(await page.evaluate(() => fixtureFiles.get('/user/fixture/lib.pl') === 'fixture(v1).' && localStorage.fixtureNotebooks) === notebooks, 'Removal preserves live files and notebooks');
    await context.setOffline(false); await page.reload(); await context.setOffline(true);
    await page.evaluate(() => packageInstalls.restore());
    check(await page.evaluate(() => fixtureFiles.size === 0 && fixtureExecution === 0), 'Removed archive is not restored or executed next session');
    check(nativeDialogs.length === 0, 'No native confirm/alert dialogs were created');
    await context.close();
    console.log(`PASS: ${checks} real DOM/IndexedDB reload and offline-orchestration checks (kernel fixture, not native-device clearance)`);
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
