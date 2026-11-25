/* Two retained archives sharing one mirrored path, using the real SWI kernel.
 * The failed-reinstall variant injects a pre-mount error only; all storage,
 * validation, restoration, native execution/sync and cold reloads remain real.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const www = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../www');
const scripts = ['vendor/jszip/jszip.min.js', 'vendor/pako/pako_inflate.min.js',
    'js/indexeddb_store.js', 'js/shared_vfs.js', 'js/persistence.js', 'js/prolog_vfs.js',
    'js/kernels/prolog.js', 'js/package_archive_validation.js', 'js/package_archive_store.js',
    'js/package_install_ui.js', 'js/package_loader.js', 'js/package_installs.js'];
const html = `<!doctype html><html><head><meta charset="UTF-8"><link rel="stylesheet" href="/css/style.css"></head><body>
<button id="catalog-manage-installed" hidden>Saved packages</button>
<script>
window.Capacitor={getPlatform:()=> 'android'};
window.t=key=>key;
window.KERNEL_CONFIG={languages:{prolog:{sources:[{type:'cdn',url:location.origin+'/vendor/swipl/dynamic-import.js'}]}}};
window.kernelManager={register(name,Kernel){this.kernel=new Kernel();},
  async ensureReady(name){if(name!=='prolog')throw Error('Unexpected kernel');await this.kernel.init();},
  getKernel(name){return name==='prolog'?this.kernel:null;},updateProgress(){},hideDownloadModal(){}};
window.fixtureNotebooks=[{id:'existing-workbook',cells:[{code:'print(1)'}]}];
window.notebookManager={loadFromManifest:async()=>[],getNotebooks:()=>fixtureNotebooks};
</script>${scripts.map(src => `<script src="/${src}"></script>`).join('')}
<script>
sessionManager.session.notebooks=fixtureNotebooks;
window.packageCatalog={restoreInstalledToProlog:()=>packageInstalls.restore()};
window.fixtureBoot=async()=>{await sessionManager.restoreSharedState();await kernelManager.ensureReady('prolog');};
window.fixtureArchives=new Map();
window.beginOverlapInstall=async({dest,marker,raw,target='prolog',bytes=null,failBeforeMount=false})=>{
  const key=JSON.stringify([dest,marker,raw,target,bytes]);
  let file=fixtureArchives.get(key);
  if(!file){
    const zip=new JSZip();
    const src=bytes?'support.bin':'support.pl';
    if(!raw)zip.file('scirepl.json',JSON.stringify({format_version:'1.0',name:'Overlap fixture '+marker,
      files:[{src,dest,target,binary:!!bytes}]}));
    zip.file(raw?dest.replace(/^\\/user\\//,''):src,bytes?Uint8Array.from(bytes):'overlap_fixture('+marker+').\\n');
    file=new File([await zip.generateAsync({type:'uint8array'})],marker+'.zip');
    fixtureArchives.set(key,file);
  }
  const original=packageLoader.loadPrepared;
  if(failBeforeMount)packageLoader.loadPrepared=async()=>{throw Object.assign(Error('Injected pre-mount failure'),{code:'FIXTURE_BEFORE_MOUNT'});};
  fixtureOutcome=null;
  packageInstalls.install(file).then(value=>fixtureOutcome={ok:true,value},error=>fixtureOutcome={ok:false,code:error.code})
    .finally(()=>{packageLoader.loadPrepared=original;});
};
window.overlapState=async(dest)=>{
  const kernel=kernelManager.kernel;
  let native=null;
  let nativeBytes=null;
  try{native=kernel._swipl.FS.readFile(dest,{encoding:'utf8'});}catch{}
  try{nativeBytes=Array.from(kernel._swipl.FS.readFile(dest));}catch{}
  const row=(await vfsStore.loadSharedFiles()).find(entry=>entry.path===dest);
  const text=value=>typeof value==='string'?value:value?new TextDecoder().decode(value):null;
  const bytes=value=>value==null?null:Array.from(typeof value==='string'?new TextEncoder().encode(value):value);
  return {native,shared:sharedVFS.readFile(dest,'utf8'),origin:sharedVFS.getPackageOrigin(dest)?.archiveId||null,
    nativeBytes,sharedBytes:bytes(sharedVFS.readFile(dest)),durableBytes:bytes(row?.content),
    owned:packageInstalls.isManagedPath(dest,'shared'),durable:text(row?.content),durableOrigin:row?.packageOrigin?.archiveId||null};
};
</script></body></html>`;
const mime = { '.css': 'text/css', '.js': 'application/javascript', '.wasm': 'application/wasm' };
const server = createServer((request, response) => {
    const pathname = new URL(request.url || '/', 'http://localhost').pathname;
    if (pathname === '/') { response.setHeader('content-type', 'text/html; charset=utf-8'); response.end(html); return; }
    const filename = path.resolve(www, '.' + decodeURIComponent(pathname));
    if (!filename.startsWith(www + path.sep)) { response.writeHead(403); response.end(); return; }
    try { response.setHeader('content-type', mime[path.extname(filename)] || 'application/octet-stream'); response.end(readFileSync(filename)); }
    catch { response.writeHead(404); response.end(); }
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
let browser;
let checks = 0;
const failures = [];
const check = (condition, label) => { checks++; if (!condition) failures.push(label); };
const sameBytes = (left, right) => JSON.stringify(left) === JSON.stringify(right);
try {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    let context = await browser.newContext({ serviceWorkers: 'block' });
    const origin = `http://127.0.0.1:${server.address().port}`;
    const external = [];
    await context.route('**/*', route => {
        if (new URL(route.request().url()).origin === origin) return route.continue();
        external.push(route.request().url()); return route.abort('blockedbyclient');
    });
    let page = await context.newPage();
    page.setDefaultTimeout(120_000);
    page.on('pageerror', error => failures.push('pageerror: ' + error.message));
    const ready = () => page.waitForFunction(() => window.vfsStore?.isReady() && window.packageInstalls && window.beginOverlapInstall);
    await page.goto(origin); await ready(); await page.evaluate(() => fixtureBoot());
    const notebooks = await page.evaluate(() => JSON.stringify(sessionManager.session.notebooks));
    const routes = ['/shared', '/tmp', '/education', '/user/education'].map(root => ({ root, raw: false }));
    routes.push({ root: '/user/education', raw: true });
    const cases = [];
    async function install(input) {
        await page.evaluate(input => beginOverlapInstall(input), input);
        await page.locator('#package-install-confirm').click();
        await page.waitForFunction(() => window.fixtureOutcome !== null);
        return page.evaluate(() => fixtureOutcome);
    }
    for (const [index, { root, raw }] of routes.entries()) {
        for (const order of ['ab', 'aba', 'aba_failed_b']) {
            const dest = `${root}/scirepl-overlap-${index}-${order}.pl`;
            const a = `archive_a_${index}_${order}`, b = `archive_b_${index}_${order}`;
            const first = await install({ dest, marker: a, raw });
            const second = await install({ dest, marker: b, raw });
            check(first.ok && second.ok && first.value.archiveId !== second.value.archiveId, `${dest}: two different retained archives install successfully`);
            let expected = { marker: b, archiveId: second.value?.archiveId };
            if (order !== 'ab') {
                const again = await install({ dest, marker: a, raw });
                check(again.ok && again.value.archiveId === first.value.archiveId, `${dest}: exact A bytes reinstall without a duplicate archive`);
                expected = { marker: a, archiveId: first.value?.archiveId };
            }
            if (order === 'aba_failed_b') {
                const failed = await install({ dest, marker: b, raw, failBeforeMount: true });
                check(!failed.ok && failed.code === 'FIXTURE_BEFORE_MOUNT', `${dest}: deduplicated B reinstall fails before changing files`);
                check(await page.evaluate(async ({a,b}) => {
                    const rows=await packageArchiveStore.list();
                    return rows.find(row=>row.id===b).createdAt>rows.find(row=>row.id===a).createdAt;
                }, { a: first.value.archiveId, b: second.value.archiveId }), `${dest}: failed attempt advanced B's retained install timestamp`);
            }
            const state = await page.evaluate(dest => overlapState(dest), dest);
            const content = `overlap_fixture(${expected.marker}).\n`;
            check(state.native === content && state.shared === content && state.origin === expected.archiveId,
                `${dest}: warm copies and provenance match the last successful install`);
            cases.push({ dest, content, archiveId: expected.archiveId, order });
        }
    }
    const edited = { dest: '/shared/scirepl-overlap-edited.pl', content: 'edited_user_copy(preserve_me).\n' };
    const editA = await install({ dest: edited.dest, marker: 'edited_archive_a', raw: false });
    const editB = await install({ dest: edited.dest, marker: 'edited_archive_b', raw: false });
    check(editA.ok && editB.ok, 'edited-Shared control retains both overlapping archives');
    check(await page.evaluate(async item => {
        sharedVFS.writeFile(item.dest, item.content, 'user');
        await sessionManager.saveSharedState();
        return sharedVFS.readFile(item.dest, 'utf8') === item.content && !sharedVFS.getPackageOrigin(item.dest);
    }, edited), 'edited-Shared control saves an unowned user edit before cold restart');
    check(await page.evaluate(async () => (await packageArchiveStore.list()).length === 32), 'exactly two retained archives per path, including failed attempts and edited-copy control');
    for (const round of [1, 2]) {
        // Fresh browser page and SWI runtime, same real IndexedDB. Loopback
        // assets load before the offline archive replay and execution steps.
        await context.setOffline(false); await page.reload(); await ready(); await page.evaluate(() => fixtureBoot());
        await context.setOffline(true); await page.evaluate(() => packageInstalls.restore());
        for (const item of cases) {
            const state = await page.evaluate(dest => overlapState(dest), item.dest);
            check(state.native === item.content && state.shared === item.content,
                `${item.dest}: cold round ${round} copies agree before a normal cell`);
            check(state.origin === item.archiveId && state.owned,
                `${item.dest}: cold round ${round} preserves winning Shared provenance and ownership`);
        }
        const editBefore = await page.evaluate(dest => overlapState(dest), edited.dest);
        check(editBefore.native === null && editBefore.shared === edited.content && !editBefore.origin && !editBefore.owned,
            `edited-Shared cold round ${round}: overlapping archives cannot claim or seed a native copy over the edit`);
        const receipt = `overlap_sync_round_${round}`;
        const cell = await page.evaluate(code => kernelManager.kernel.execute(code), `format('${receipt}~n', []).`);
        check(!cell.error && cell.stdout.includes(receipt), `round ${round}: actual Prolog cell emits its success receipt and runs native sync`);
        check(await page.evaluate(() => sessionManager.saveSharedState()), `round ${round}: Shared snapshot commits`);
        check(await page.evaluate(() => sessionManager.savePrologState()), `round ${round}: Prolog snapshot commits`);
        for (const item of cases) {
            const state = await page.evaluate(dest => overlapState(dest), item.dest);
            check(state.native === item.content && state.shared === item.content && state.durable === item.content,
                `${item.dest}: cold round ${round} sync/save keeps the last successful bytes in both copies and IndexedDB`);
            check(state.origin === item.archiveId && state.durableOrigin === item.archiveId && state.owned,
                `${item.dest}: cold round ${round} sync/save keeps winning Shared provenance intact`);
        }
        const editAfter = await page.evaluate(dest => overlapState(dest), edited.dest);
        check(editAfter.native === null && editAfter.shared === edited.content && editAfter.durable === edited.content
            && !editAfter.origin && !editAfter.durableOrigin && !editAfter.owned,
        `edited-Shared round ${round}: real sync/save preserves unowned user bytes`);
    }
    check(await page.evaluate(() => JSON.stringify(sessionManager.session.notebooks)) === notebooks, 'overlap restoration leaves existing notebook fixtures unchanged');
    await context.close();

    // Isolate the missing-snapshot case from the failed-reinstall cases above.
    // A separate origin-storage context avoids archive-capacity interference.
    // Only the Shared snapshot/fallback is removed, not retained archive records.
    context = await browser.newContext({ serviceWorkers: 'block' });
    await context.route('**/*', route => {
        if (new URL(route.request().url()).origin === origin) return route.continue();
        external.push(route.request().url()); return route.abort('blockedbyclient');
    });
    page = await context.newPage();
    page.setDefaultTimeout(120_000);
    page.on('pageerror', error => failures.push('pageerror: ' + error.message));
    await page.goto(origin); await ready(); await page.evaluate(() => fixtureBoot());
    const missing = [];
    for (const [index, { root, raw }] of routes.entries()) {
        for (const order of ['ab', 'aba']) {
            const dest = `${root}/scirepl-missing-shared-${index}-${order}.pl`;
            const a = `missing_a_${index}_${order}`, b = `missing_b_${index}_${order}`;
            const first = await install({ dest, marker: a, raw });
            const second = await install({ dest, marker: b, raw });
            check(first.ok && second.ok, `${dest}: both retained archives install before Shared snapshot removal`);
            let expected = { marker: b, archiveId: second.value?.archiveId };
            if (order === 'aba') {
                const again = await install({ dest, marker: a, raw });
                check(again.ok && again.value.archiveId === first.value.archiveId, `${dest}: explicit A reinstall records the final successful precedence`);
                expected = { marker: a, archiveId: first.value?.archiveId };
            }
            missing.push({ dest, content: `overlap_fixture(${expected.marker}).\n`, archiveId: expected.archiveId });
        }
    }
    const mixedDest = '/shared/scirepl-missing-shared-mixed-target.pl';
    const mixedA = await install({ dest: mixedDest, marker: 'mixed_native_a', raw: false });
    const mixedB = await install({ dest: mixedDest, marker: 'mixed_shared_b', raw: false, target: 'shared' });
    check(mixedA.ok && mixedB.ok, 'mixed-target control installs native A followed by Shared-only B before snapshot removal');
    missing.push({ dest: mixedDest, content: 'overlap_fixture(mixed_shared_b).\n', archiveId: mixedB.value?.archiveId, sharedOnlyWinner: true });
    const binaryDest = '/shared/scirepl-missing-shared-mixed-binary.bin';
    const binaryBytes = [0, 255, 128, 10];
    const binaryA = await install({ dest: binaryDest, marker: 'mixed_binary_native_a', raw: false });
    const binaryB = await install({ dest: binaryDest, marker: 'mixed_binary_shared_b', raw: false, target: 'shared', bytes: binaryBytes });
    check(binaryA.ok && binaryB.ok, 'binary mixed-target control retains ASCII-native A and exact non-UTF8 Shared-only B');
    missing.push({ dest: binaryDest, bytes: binaryBytes, archiveId: binaryB.value?.archiveId, sharedOnlyWinner: true });
    await page.evaluate(async () => {
        await vfsStore.saveAllSharedFiles([], []);
        sessionManager.session.sharedVFS = null;
        sessionManager.session.sharedVFSDeletedPaths = [];
        sessionManager.save();
    });
    check(await page.evaluate(async () => (await vfsStore.loadSharedFiles()).length === 0
        && (await packageArchiveStore.list()).length === 24 && !sessionManager.session.sharedVFS),
    'fixture removed only Shared snapshots; all twenty-four validated archives remain retained');
    for (const round of [1, 2]) {
        await context.setOffline(false); await page.reload(); await ready(); await page.evaluate(() => fixtureBoot());
        await context.setOffline(true); await page.evaluate(() => packageInstalls.restore());
        for (const item of missing) {
            const state = await page.evaluate(dest => overlapState(dest), item.dest);
            // On the first pass A seeded a native mirror before Shared-only B
            // advanced it. On pass two the saved B copy prevents stale A from
            // seeding anything, and Shared-only B must not force a new mirror.
            const nativeMatches = item.sharedOnlyWinner && round === 2 ? state.nativeBytes === null
                : item.bytes ? sameBytes(state.nativeBytes, item.bytes) : state.native === item.content;
            const sharedMatches = item.bytes ? sameBytes(state.sharedBytes, item.bytes) : state.shared === item.content;
            check(nativeMatches && sharedMatches && state.origin === item.archiveId,
                `${item.dest}: missing-snapshot cold round ${round} restores a coherent native state and winning Shared provenance`);
        }
        const receipt = `missing_shared_sync_round_${round}`;
        const cell = await page.evaluate(code => kernelManager.kernel.execute(code), `format('${receipt}~n', []).`);
        check(!cell.error && cell.stdout.includes(receipt), `missing-snapshot round ${round}: real Prolog cell runs native sync`);
        check(await page.evaluate(() => sessionManager.saveSharedState()), `missing-snapshot round ${round}: Shared snapshot commits`);
        await page.evaluate(() => sessionManager.savePrologState());
        for (const item of missing) {
            const state = await page.evaluate(dest => overlapState(dest), item.dest);
            const nativeMatches = item.sharedOnlyWinner && round === 2 ? state.nativeBytes === null
                : item.bytes ? sameBytes(state.nativeBytes, item.bytes) : state.native === item.content;
            const sharedMatches = item.bytes ? sameBytes(state.sharedBytes, item.bytes) && sameBytes(state.durableBytes, item.bytes)
                : state.shared === item.content && state.durable === item.content;
            check(nativeMatches && sharedMatches && state.origin === item.archiveId && state.durableOrigin === item.archiveId && state.owned,
            `${item.dest}: missing-snapshot round ${round} sync/save preserves last-success bytes and provenance`);
        }
    }
    check(external.length === 0, 'no external request was made');
    await context.close();
    for (const failure of failures) console.error('FAIL: ' + failure);
    assert.equal(failures.length, 0, `${failures.length}/${checks} actual-kernel mirrored-overlap checks failed`);
    console.log(`PASS: ${checks} actual SWI-Prolog retained-archive overlap checks across normal, deduplicated and failed reinstall orders`);
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
