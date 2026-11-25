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
    'js/package_archive_store.js', 'js/package_install_ui.js', 'js/package_loader.js',
    'js/indexeddb_store.js', 'js/shared_vfs.js', 'js/persistence.js', 'js/package_installs.js'];
const html = `<!doctype html><html><head><meta charset="UTF-8"><link rel="stylesheet" href="/css/style.css"></head><body>
<button id="catalog-manage-installed" hidden>Saved packages</button>
<script>
window.Capacitor={getPlatform:()=> 'android'};
window.t=key=>key;
window.fixtureFiles=new Map(); window.fixtureExecution=0;
if(!localStorage.fixtureNotebooks) localStorage.fixtureNotebooks=JSON.stringify([{id:'existing-1'},{id:'existing-2'}]);
window.fixtureVFS={exists:p=>fixtureFiles.has(p),stat:p=>fixtureFiles.has(p)?{isDir:false}:null,
  bulkWrite:rows=>rows.forEach(r=>fixtureFiles.set(r.path,r.content)),addSearchPath(){},
  getMountedFiles:()=>[...fixtureFiles.keys()].map(path=>({path})),readFile:p=>fixtureFiles.get(p),getSearchPaths:()=>[]};
window.kernelManager={async ensureReady(){},getKernel:()=>({getVFS:()=>fixtureVFS,isReady:()=>false})};
window.notebookManager={getNotebooks:()=>JSON.parse(localStorage.fixtureNotebooks)};
window.executeCell=()=>fixtureExecution++;
</script>${scripts.map(src => `<script src="/${src}"></script>`).join('')}
<script>
sessionManager.session.notebooks=JSON.parse(localStorage.fixtureNotebooks);
window.beginFixtureInstall=file=>{
  window.fixtureOutcome=null;
  packageInstalls.install(file).then(value=>window.fixtureOutcome={ok:true,value},error=>window.fixtureOutcome={ok:false,code:error.code});
};
window.beginFixture=async(value)=>{
  const zip=new JSZip();
  zip.file('scirepl.json',JSON.stringify({format_version:'1.0',name:'Fixture package',files:[{src:'lib.pl',dest:'/user/fixture/lib.pl'}]}));
  zip.file('lib.pl',value);
  const file=new File([await zip.generateAsync({type:'uint8array'})],'fixture.zip');
  beginFixtureInstall(file);
};
window.beginSharedFixture=async(archiveId=null)=>{
  let file;
  if(archiveId){
    const retained=await packageArchiveStore.read(archiveId);
    if(!retained) throw Error('Expected retained Shared fixture archive');
    file=new File([retained.bytes],retained.filename);
  }else{
    const zip=new JSZip();
    zip.file('scirepl.json',JSON.stringify({format_version:'1.0',name:'Shared cold-reinstall fixture',files:[{src:'support.txt',dest:'/user/cold-reinstall.txt',target:'shared'}]}));
    zip.file('support.txt','shared_support(original).');
    file=new File([await zip.generateAsync({type:'uint8array'})],'shared-fixture.zip');
  }
  beginFixtureInstall(file);
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
    await context.route('**/*', route => new URL(route.request().url()).origin === new URL(origin).origin
        ? route.continue() : route.abort('blockedbyclient'));
    const ready = () => page.waitForFunction(() => window.vfsStore?.isReady() && window.packageInstalls && window.sessionManager && window.sharedVFS);
    await page.goto(origin);
    await ready();
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
    await ready();
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
    await context.setOffline(false); await page.reload(); await ready(); await context.setOffline(true);
    await page.evaluate(() => packageInstalls.restore());
    check(await page.evaluate(() => fixtureFiles.get('/user/fixture/lib.pl') === 'fixture(v1).'), 'Session replacement does not change retained version');
    await page.locator('#catalog-manage-installed').click();
    await page.locator('[data-package-remove]').click();
    await page.locator('#package-install-remove-confirm').click();
    await page.waitForFunction(async () => (await packageArchiveStore.list()).length === 0);
    await page.locator('#package-install-manage-close').click();
    check(await page.evaluate(() => fixtureFiles.get('/user/fixture/lib.pl') === 'fixture(v1).' && localStorage.fixtureNotebooks) === notebooks, 'Removal preserves live files and notebooks');
    await context.setOffline(false); await page.reload(); await ready(); await context.setOffline(true);
    await page.evaluate(() => packageInstalls.restore());
    check(await page.evaluate(() => fixtureFiles.size === 0 && fixtureExecution === 0), 'Removed archive is not restored or executed next session');

    // Real SharedVFS and VFSStore serialization must retain provenance through
    // browser IndexedDB, not merely through an in-memory persistence fixture.
    await page.evaluate(() => beginSharedFixture());
    await page.locator('#package-install-confirm').click();
    await page.waitForFunction(() => fixtureOutcome !== null);
    check(await page.evaluate(() => fixtureOutcome.ok && fixtureOutcome.value.mode === 'persistent'
        && sharedVFS.readFile('/user/cold-reinstall.txt') === 'shared_support(original).'), 'Shared persistent choice installs real SharedVFS support');
    const sharedArchiveId = await page.evaluate(() => fixtureOutcome.value.archiveId);
    check(await page.evaluate(async id => {
        const saved = (await vfsStore.loadSharedFiles()).find(file => file.path === '/user/cold-reinstall.txt');
        return saved?.content === 'shared_support(original).' && saved.packageOrigin?.archiveId === id;
    }, sharedArchiveId), 'Real IndexedDB stores Shared bytes and matching archive provenance');

    await context.setOffline(false); await page.reload(); await ready(); await context.setOffline(true);
    check(await page.evaluate(() => !sharedVFS.exists('/user/cold-reinstall.txt')
        && !packageInstalls.isManagedPath('/user/cold-reinstall.txt', 'shared')), 'Cold reload starts without in-memory Shared bytes or ownership');
    await page.evaluate(() => sessionManager.restoreSharedState());
    check(await page.evaluate(id => sharedVFS.readFile('/user/cold-reinstall.txt') === 'shared_support(original).'
        && sharedVFS.getPackageOrigin('/user/cold-reinstall.txt')?.archiveId === id
        && !packageInstalls.isManagedPath('/user/cold-reinstall.txt', 'shared'), sharedArchiveId), 'Offline IndexedDB restore preserves provenance without granting ownership by itself');
    await page.evaluate(() => packageInstalls.restore());
    check(await page.evaluate(async id => packageInstalls.isManagedPath('/user/cold-reinstall.txt', 'shared')
        && (await packageArchiveStore.list()).length === 1 && (await packageArchiveStore.read(id))?.id === id, sharedArchiveId), 'Validated offline archive restores ownership of unchanged Shared bytes');
    await page.evaluate(id => beginSharedFixture(id), sharedArchiveId);
    await page.locator('#package-install-confirm').click();
    await page.waitForFunction(() => fixtureOutcome !== null);
    check(await page.evaluate(async id => fixtureOutcome.ok && fixtureOutcome.value.archiveId === id
        && sharedVFS.readFile('/user/cold-reinstall.txt') === 'shared_support(original).'
        && (await packageArchiveStore.list()).length === 1, sharedArchiveId), 'Real DOM persistent reinstall succeeds after reload without duplicating the archive');

    check(await page.evaluate(async () => {
        sharedVFS.writeFile('/user/cold-reinstall.txt', 'shared_support(user_edit).', 'user');
        const committed = await sessionManager.saveSharedState();
        const saved = (await vfsStore.loadSharedFiles()).find(file => file.path === '/user/cold-reinstall.txt');
        return committed && saved?.content === 'shared_support(user_edit).' && !saved.packageOrigin
            && !packageInstalls.isManagedPath('/user/cold-reinstall.txt', 'shared');
    }), 'User edit persists through real IndexedDB but clears package provenance and overwrite authority');
    await page.evaluate(id => beginSharedFixture(id), sharedArchiveId);
    await page.locator('#package-install-confirm').click();
    await page.waitForFunction(() => fixtureOutcome !== null);
    check(await page.evaluate(async id => !fixtureOutcome.ok && fixtureOutcome.code === 'PACKAGE_FILE_CONFLICT'
        && sharedVFS.readFile('/user/cold-reinstall.txt') === 'shared_support(user_edit).'
        && (await packageArchiveStore.list()).length === 1 && (await packageArchiveStore.read(id))?.id === id, sharedArchiveId), 'DOM reinstall protects the edited Shared copy and retains the original archive');
    check(await page.evaluate(() => JSON.stringify(sessionManager.session.notebooks)) === notebooks
        && await page.evaluate(() => localStorage.fixtureNotebooks) === notebooks, 'Shared restore, reinstall and conflict preserve every existing notebook');
    check(nativeDialogs.length === 0, 'No native confirm/alert dialogs were created');
    await context.close();
    console.log(`PASS: ${checks} real DOM/IndexedDB reload and offline-orchestration checks (kernel fixture, not native-device clearance)`);
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
