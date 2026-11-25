/* Actual bundled SWI-Prolog + PrologKernel.execute() SharedVFS synchronization.
 * App storage, installer, archive validation, snapshots and cold-reload are real.
 * Only the surrounding notebook/manager UI is a fixture; no provider or phone.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const www = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../www');
const scripts = [
    'vendor/jszip/jszip.min.js', 'vendor/pako/pako_inflate.min.js',
    'js/indexeddb_store.js', 'js/shared_vfs.js', 'js/persistence.js',
    'js/prolog_vfs.js', 'js/kernels/prolog.js', 'js/package_archive_validation.js',
    'js/package_archive_store.js', 'js/package_install_ui.js', 'js/package_loader.js',
    'js/package_installs.js',
];
const html = `<!doctype html><html><head><meta charset="UTF-8">
<link rel="stylesheet" href="/css/style.css"></head><body>
<button id="catalog-manage-installed" hidden>Saved packages</button>
<script>
window.Capacitor={getPlatform:()=> 'android'};
window.t=key=>key;
window.KERNEL_CONFIG={languages:{prolog:{sources:[{type:'cdn',url:location.origin+'/vendor/swipl/dynamic-import.js'}]}}};
window.kernelManager={
  register(name,Kernel){this.kernel=new Kernel();},
  async ensureReady(name){if(name!=='prolog')throw Error('Unexpected kernel');await this.kernel.init();},
  getKernel(name){return name==='prolog'?this.kernel:null;},updateProgress(){},hideDownloadModal(){}
};
window.fixtureNotebooks=[{id:'existing-workbook',cells:[{code:'print(1)'}]}];
window.notebookManager={loadFromManifest:async()=>[],getNotebooks:()=>fixtureNotebooks};
</script>${scripts.map(src => `<script src="/${src}"></script>`).join('')}
<script>
sessionManager.session.notebooks=fixtureNotebooks;
window.packageCatalog={restoreInstalledToProlog:()=>packageInstalls.restore()};
window.fixtureBoot=async()=>{
  await sessionManager.restoreSharedState();
  await kernelManager.ensureReady('prolog');
};
window.beginRootInstall=async(dest,marker,raw=false)=>{
  const zip=new JSZip();
  if(!raw)zip.file('scirepl.json',JSON.stringify({format_version:'1.0',name:'Shared-root fixture',
    files:[{src:'support.pl',dest,target:'prolog'}]}));
  zip.file(raw?dest.replace(/^\\/user\\//,''):'support.pl','session_fixture('+marker+').\\n');
  fixtureOutcome=null;
  packageInstalls.install(new File([await zip.generateAsync({type:'uint8array'})],'root-fixture.zip'))
    .then(value=>fixtureOutcome={ok:true,value},error=>fixtureOutcome={ok:false,code:error.code});
};
</script></body></html>`;
const mime = { '.css': 'text/css', '.js': 'application/javascript', '.wasm': 'application/wasm' };
const server = createServer((request, response) => {
    const pathname = new URL(request.url || '/', 'http://localhost').pathname;
    if (pathname === '/') {
        response.setHeader('content-type', 'text/html; charset=utf-8'); response.end(html); return;
    }
    const filename = path.resolve(www, '.' + decodeURIComponent(pathname));
    if (!filename.startsWith(www + path.sep)) { response.writeHead(403); response.end(); return; }
    try {
        response.setHeader('content-type', mime[path.extname(filename)] || 'application/octet-stream');
        response.end(readFileSync(filename));
    } catch (_) { response.writeHead(404); response.end(); }
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
let browser;
let checks = 0;
const failures = [];
const check = (condition, label) => {
    checks++;
    if (!condition) failures.push(label);
};
try {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const context = await browser.newContext({ viewport: { width: 412, height: 915 }, serviceWorkers: 'block' });
    const origin = `http://127.0.0.1:${server.address().port}`;
    const external = [];
    await context.route('**/*', route => {
        if (new URL(route.request().url()).origin === origin) return route.continue();
        external.push(route.request().url()); return route.abort('blockedbyclient');
    });
    const page = await context.newPage();
    page.setDefaultTimeout(120_000);
    page.on('pageerror', error => failures.push('pageerror: ' + error.message));
    const ready = () => page.waitForFunction(() => window.vfsStore?.isReady() && window.packageInstalls && window.beginRootInstall);
    await page.goto(origin);
    await ready();
    await page.evaluate(() => fixtureBoot());
    check(await page.evaluate(() => !!kernelManager.kernel._swipl?.FS && kernelManager.kernel.isReady()), 'uses the real initialized SWI-Prolog runtime');
    const notebooks = await page.evaluate(() => JSON.stringify(sessionManager.session.notebooks));
    const roots = ['/shared', '/tmp', '/education', '/user/education'];
    const cases = [];
    const routes = [...roots.map(root => ({root, raw:false})), {root:'/user/education',raw:true}];
    for (const [i, {root,raw}] of routes.entries()) {
        for (const hasUser of [false, true]) {
            const dest = `${root}/scirepl-root-${i}-${hasUser ? 'user' : 'session'}.pl`;
            const marker = `marker_${i}_${hasUser ? 'user' : 'session'}`;
            const userContent = `user_owned(original_${i}).\n`;
            if (hasUser) {
                await page.evaluate(({ dest, userContent }) => sharedVFS.writeFile(dest, userContent, 'user'), { dest, userContent });
                check(await page.evaluate(() => sessionManager.saveSharedState()), `${dest}: existing user file is durably saved before install`);
            }
            await page.evaluate(({ dest, marker, raw }) => beginRootInstall(dest, marker, raw), { dest, marker, raw });
            await page.locator('#package-install-session').check();
            await page.locator('#package-install-confirm').click();
            await page.waitForFunction(() => window.fixtureOutcome !== null);
            const outcome = await page.evaluate(() => fixtureOutcome);
            check(hasUser ? !outcome.ok && outcome.code === 'PACKAGE_FILE_CONFLICT' : outcome.ok && outcome.value.mode === 'session',
                `${dest}: ${hasUser ? 'Shared user collision is rejected before import' : 'session-only install succeeds'}`);
            // This goes through the unmodified real kernel.execute method and
            // its automatic _syncSharedPaths pass, never a mocked sync helper.
            // Plain goals are portable across both kernel revisions. Explicit
            // emitted receipts prove success; ground success may display no
            // bindings, so absence of an error alone would not be sufficient.
            const receipt = `cell_checked_${marker}`;
            const code = outcome.ok
                ? `read_file_to_string('${dest}', Text, []), sub_string(Text, _, _, _, '${marker}'), format('${receipt}~n', []).`
                : `format('${receipt}~n', []).`;
            const result = await page.evaluate(code => kernelManager.kernel.execute(code), code);
            check(!result.error && result.stdout.includes(receipt),
                `${dest}: a real Prolog cell executes and can read installed support`);
            if (outcome.ok && !hasUser) {
                const editReceipt = `edit_checked_${marker}`;
                const edit = await page.evaluate(code => kernelManager.kernel.execute(code),
                    `setup_call_cleanup(open('${dest}', write, Stream), format(Stream, 'edited_session_fixture(~w).~n', [${marker}]), close(Stream)), format('${editReceipt}~n', []).`);
                check(!edit.error && edit.stdout.includes(editReceipt), `${dest}: a real Prolog cell edits session support through native I/O`);
                check(await page.evaluate(dest => sharedVFS.readFile(dest, 'utf8')?.includes('edited_session_fixture('), dest),
                    `${dest}: automatic real-kernel sync mirrors the changed session bytes`);
            }
            const state = await page.evaluate(async ({ dest }) => {
                const saved = await sessionManager.saveSharedState();
                await sessionManager.savePrologState();
                const durable = (await vfsStore.loadSharedFiles()).find(entry => entry.path === dest);
                return { saved, shared: sharedVFS.readFile(dest, 'utf8'),
                    compact: sharedVFS.snapshot().files.some(entry => entry.path === dest),
                    durable: durable ? (typeof durable.content === 'string' ? durable.content : new TextDecoder().decode(durable.content)) : null,
                    prologDurable: (await vfsStore.loadFiles()).some(entry => entry.path === dest),
                    archives: (await packageArchiveStore.list()).length };
            }, { dest });
            check(state.saved, `${dest}: Shared snapshot commits`);
            check(hasUser ? state.shared === userContent : state.shared?.includes(marker),
                `${dest}: ${hasUser ? 'real kernel sync preserves user Shared bytes' : 'support is available in the live shared session'}`);
            check(hasUser ? state.durable === userContent && state.compact : state.durable === null && !state.compact,
                `${dest}: ${hasUser ? 'durable Shared snapshot preserves user copy' : 'session package bytes excluded from durable and fallback Shared snapshots'}`);
            check(!state.prologDurable && state.archives === 0, `${dest}: no Prolog snapshot or retained archive leaks session package`);
            cases.push({ dest, marker, hasUser, userContent });
        }
    }
    const persistent = [];
    for (const [i, {root,raw}] of routes.entries()) {
        const dest = `${root}/scirepl-persistent-${i}.pl`;
        const marker = `persistent_marker_${i}`;
        await page.evaluate(({ dest, marker, raw }) => beginRootInstall(dest, marker, raw), { dest, marker, raw });
        await page.locator('#package-install-confirm').click();
        await page.waitForFunction(() => window.fixtureOutcome !== null);
        check(await page.evaluate(() => fixtureOutcome.ok && fixtureOutcome.value.mode === 'persistent'),
            `${dest}: persistent control installs`);
        const archiveId = await page.evaluate(() => fixtureOutcome.value?.archiveId);
        const receipt = `persistent_checked_${marker}`;
        const cell = await page.evaluate(code => kernelManager.kernel.execute(code),
            `consult('${dest}'), session_fixture(${marker}), format('${receipt}~n', []).`);
        check(!cell.error && cell.stdout.includes(receipt), `${dest}: persistent support is queryable before restart`);
        check(await page.evaluate(({dest,archiveId}) => sharedVFS.getPackageOrigin(dest)?.archiveId === archiveId
            && packageInstalls.isManagedPath(dest,'shared'), {dest,archiveId}),
            `${dest}: unchanged native sync retains verified Shared provenance and ownership`);
        check(await page.evaluate(() => sessionManager.saveSharedState()), `${dest}: persistent Shared control commits`);
        await page.evaluate(() => sessionManager.savePrologState());
        persistent.push({dest,marker,archiveId});
    }
    // New page state + new runtime, same actual browser IndexedDB. Loading the
    // fixture/runtime uses loopback; data restore/replay below runs offline.
    await page.reload(); await ready();
    await page.evaluate(() => fixtureBoot());
    await context.setOffline(true);
    await page.evaluate(() => packageInstalls.restore());
    const cold = await page.evaluate(cases => ({
        files: cases.map(item => ({ ...item,
            shared: sharedVFS.readFile(item.dest, 'utf8'),
            native: kernelManager.kernel.getVFS().stat(item.dest),
        })),
        notebooks: JSON.stringify(sessionManager.session.notebooks),
    }), cases);
    for (const item of cold.files) {
        check(item.hasUser ? item.shared === item.userContent : item.shared === null,
            `${item.dest}: cold-restart ${item.hasUser ? 'retains only user Shared copy' : 'does not resurrect session support'}`);
        check(item.native === null, `${item.dest}: cold native Prolog filesystem contains no session package copy`);
    }
    for (const item of persistent) {
        const receipt = `restored_checked_${item.marker}`;
        const cell = await page.evaluate(code => kernelManager.kernel.execute(code),
            `consult('${item.dest}'), session_fixture(${item.marker}), format('${receipt}~n', []).`);
        check(!cell.error && cell.stdout.includes(receipt), `${item.dest}: retained archive is queryable through the real kernel after cold restart`);
        check(await page.evaluate(({dest,marker}) => sharedVFS.readFile(dest,'utf8')?.includes(marker),item),
            `${item.dest}: cold restart retains persistent Shared support`);
        check(await page.evaluate(({dest,archiveId}) => sharedVFS.getPackageOrigin(dest)?.archiveId === archiveId
            && packageInstalls.isManagedPath(dest,'shared'), item),
            `${item.dest}: cold-restart query preserves verified Shared provenance and ownership`);
    }
    const finalCell = await page.evaluate(() => kernelManager.kernel.execute("format('cold_restart_checked~n', [])."));
    check(!finalCell.error && finalCell.stdout.includes('cold_restart_checked'), 'a real cell still executes offline after cold restart');
    check(cold.notebooks === notebooks, 'package imports and cold restart leave existing notebooks unchanged');
    check(external.length === 0, 'no external network request was made');
    await context.close();
    for (const failure of failures) console.error('FAIL: ' + failure);
    assert.equal(failures.length, 0, `${failures.length}/${checks} real-kernel shared-root checks failed`);
    console.log(`PASS: ${checks} actual SWI-Prolog shared-root install/sync/save/cold-restart checks across ${roots.join(', ')}`);
} finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
}
