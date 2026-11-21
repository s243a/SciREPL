import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { File } from 'node:buffer';
import vm from 'node:vm';
import test from 'node:test';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
function harness(platform = 'android') {
    const values = new Map();
    const calls = { installs: [], imports: [], requests: [], alerts: [], notices: [], remounts: [] };
    const location = new URL('https://localhost/index.html');
    const window = { location, ToolCore: {}, Capacitor: { getPlatform: () => platform } };
    const localStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)) };
    const document = { addEventListener() {} };
    const context = vm.createContext({ window, document, location, URL, File, Blob, Response, Uint8Array, ArrayBuffer,
        TextEncoder, TextDecoder, localStorage, console: { warn() {}, error() {}, log() {} },
        alert: message => calls.alerts.push(message), setTimeout, clearTimeout,
        fetch: async url => { calls.requests.push(String(url)); return new Response('fixture archive'); } });
    vm.runInContext(read('www/js/file_io.js').replace(/^window\.fileIO = new FileIO\(\);$/m, ''), context);
    vm.runInContext(read('www/js/package_catalog.js'), context);
    vm.runInContext(read('www/js/kernels/prolog.js'), context);
    const file = vm.runInContext('Object.create(FileIO.prototype)', context);
    const catalog = vm.runInContext('Object.create(PackageCatalog.prototype)', context);
    const kernel = vm.runInContext('new PrologKernel()', context);
    catalog._preflightInstall = () => {};
    catalog._syncInstallButtons = () => {};
    window.fileIO = file; window.packageCatalog = catalog;
    window.packageLoader = {
        async loadFromFile(file) { calls.imports.push(file.name); },
        async remountFromFile(file) { calls.remounts.push(file.name); },
    };
    window.packageInstalls = {
        async install(file, options) { calls.installs.push({ file, options }); return { mode: 'persistent' }; },
        async restore() {},
        isInstalled() { return false; },
    };
    window.PackageInstallUI = { async notify(error) { calls.notices.push(error.message); } };
    return { context, window, file, catalog, kernel, localStorage, calls };
}

test('Free manual Android archives use explicit installation controller; Cancel has no import side effects', async () => {
    for (const name of ['manual.zip', 'manual.tar.gz', 'manual.tgz']) {
        const { window, file, calls } = harness();
        await file._handlePackageImport(new File(['fixture'], name));
        assert.equal(calls.installs.length, 1);
        assert.equal(calls.installs[0].file.name, name);
        assert.deepEqual(calls.imports, []);
        window.packageInstalls.install = async () => { throw Object.assign(new Error('cancelled'), { code: 'INSTALL_CANCELLED' }); };
        await file._handlePackageImport(new File(['fixture'], name));
        assert.deepEqual(calls.imports, []);
        assert.deepEqual(calls.alerts, []);
    }
});

test('Free Android fails closed without the install controller; browser imports remain unchanged', async () => {
    const android = harness(); delete android.window.packageInstalls;
    await android.file._handlePackageImport(new File(['fixture'], 'manual.zip'));
    assert.equal(android.calls.notices.length, 1);
    assert.equal(android.calls.alerts.length, 0);
    assert.deepEqual(android.calls.imports, []);
    const browser = harness('web');
    await browser.file._handlePackageImport(new File(['fixture'], 'manual.zip'));
    assert.deepEqual(browser.calls.imports, ['manual.zip']);
    assert.deepEqual(browser.calls.installs, []);
});

test('Free standalone .srwb import bypasses archive installation choices', async () => {
    const { file, context, calls } = harness();
    context.FileReader = class { readAsText() { this.onload({ target: { result: '{"fixture":true}' } }); } };
    let imported = null;
    file.importSrwb = text => { imported = text; };
    await file._handlePackageImport({ name: 'standalone.srwb' });
    assert.equal(imported, '{"fixture":true}');
    assert.deepEqual(calls.installs, []);
});

test('Free catalogue archives ask for a mode; exact bundled package needs no retained copy', async () => {
    const { catalog, calls } = harness();
    const pkg = { id: 'remote-fixture', type: 'package', name: 'Fixture', url: 'https://s243a.github.io/fixture.zip' };
    await catalog._doImport(pkg, new Blob(['fixture']));
    assert.equal(calls.installs.length, 1);
    assert.equal(calls.installs[0].options.pkg, pkg);
    assert.deepEqual(calls.imports, []);
    const bundled = catalog.builtinPackages.find(item => item.type === 'package');
    await catalog._doImport(bundled, new Blob(['fixture']));
    assert.equal(calls.installs.length, 1);
    assert.equal(calls.imports.length, 1);
});

test('Free startup uses fixed bundled bytes and never saved arbitrary Android URLs', async () => {
    const { catalog, calls } = harness();
    assert.equal(await catalog._fetchForRestore({ id: 'unknown', pages_url: 'https://bad.invalid/p.zip' }), null);
    assert.deepEqual(calls.requests, []);
    const builtin = catalog.builtinPackages.find(item => item.type === 'package');
    const blob = await catalog._fetchForRestore({ id: builtin.id, pages_url: 'https://bad.invalid/p.zip', url: 'https://bad.invalid/q.zip' });
    assert.ok(blob instanceof Blob);
    assert.deepEqual(calls.requests, [new URL(builtin.pages_url, 'https://localhost/index.html').href]);
    const browser = harness('web');
    await browser.catalog._fetchForRestore({ pages_url: 'https://example.test/p.zip' });
    assert.deepEqual(browser.calls.requests, ['https://example.test/p.zip']);
});

test('Free remembers only persistent Android catalogue installs and ignores removed archive identities', () => {
    const { catalog, window, localStorage } = harness();
    const pkg = { id: 'fixture', name: 'Fixture', type: 'package', url: 'https://example.test/fixture.zip' };
    catalog._rememberInstalled(pkg);
    assert.equal(localStorage.getItem('scirepl_installed_packages'), null);
    pkg._localArchiveId = 'a'.repeat(64);
    catalog._rememberInstalled(pkg);
    const remembered = JSON.parse(localStorage.getItem('scirepl_installed_packages'));
    assert.equal(remembered.length, 1);
    assert.equal(remembered[0].archiveId, pkg._localArchiveId);
    window.packageInstalls.isInstalled = (item, saved) => item.id === pkg.id && saved[0].archiveId === pkg._localArchiveId;
    assert.equal(catalog._installState(pkg), 'current');
    window.packageInstalls.isInstalled = () => false;
    assert.equal(catalog._installState(pkg), 'missing');
});

test('Free concurrent startup calls wait for one archive restore and skip saved-archive remote remounts', async () => {
    const { catalog, window, localStorage, calls } = harness();
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    let restores = 0, finished = false;
    window.packageInstalls.restore = async () => { restores++; await gate; };
    localStorage.setItem('scirepl_installed_packages', JSON.stringify([{ id: 'fixture', name: 'Fixture', archiveId: 'a'.repeat(64), url: 'https://bad.invalid/package.zip' }]));
    const first = catalog.restoreInstalledToProlog();
    const second = catalog.restoreInstalledToProlog().then(() => { finished = true; });
    await Promise.resolve(); assert.equal(restores, 1); assert.equal(finished, false);
    release(); await Promise.all([first, second]);
    assert.equal(finished, true); assert.deepEqual(calls.requests, []); assert.deepEqual(calls.remounts, []);
});

test('Free Prolog restoration waits across callers and reset clears only restore bookkeeping', async () => {
    const { kernel, window } = harness();
    let release, calls = 0, secondDone = false;
    const gate = new Promise(resolve => { release = resolve; });
    window.packageCatalog.restoreInstalledToProlog = async () => { calls++; await gate; };
    const first = kernel._ensurePackagesRestored();
    const second = kernel._ensurePackagesRestored().then(() => { secondDone = true; });
    await Promise.resolve(); assert.equal(calls, 1); assert.equal(secondDone, false);
    release(); await Promise.all([first, second]);
    assert.equal(kernel._packagesRestored, true);
    await kernel.destroy();
    assert.equal(kernel._packagesRestored, false); assert.equal(kernel._packagesRestorePromise, null);
    assert.equal(window.packageCatalog._restorePromise, null); assert.equal(window.packageInstalls.restorePromise, null);
});

test('Free verified workbook imports retain SHA/size gates and never use package-mode installation', async () => {
    for (const format of ['srwb', 'ipynb']) {
        const { catalog, window, calls } = harness();
        let actual;
        window.fileIO.importWorkbook = async (text, options) => { actual = { text, options }; };
        catalog._importWorkbook = async (pkg, importer) => importer();
        const pkg = { id: 'workbook', type: 'workbook', format, sourceId: 'official', _catalog: { sha256: 'b'.repeat(64), size: 123 } };
        await catalog._doImport(pkg, new Blob(['fixture']));
        assert.equal(actual.options.size, 123); assert.equal(actual.options.sha256, pkg._catalog.sha256);
        assert.equal(actual.options.mode, 'create'); assert.equal(actual.options.format, format);
        assert.deepEqual(calls.installs, []);
    }
});

test('Free Prolog can retry a transient local-store restore failure on the next execution', async () => {
    const { kernel, window, calls } = harness();
    let attempts = 0;
    window.packageCatalog.restoreInstalledToProlog = async () => {
        if (++attempts < 3) throw new Error('temporary unavailable local store');
    };
    assert.equal(await kernel._ensurePackagesRestored(), false);
    assert.equal(kernel._packagesRestored, false);
    assert.equal(kernel._packagesRestorePromise, null);
    assert.equal(await kernel._ensurePackagesRestored(), false);
    assert.equal(calls.notices.length, 1, 'repeated restore failures do not queue repeated notices');
    await kernel._ensurePackagesRestored();
    assert.equal(kernel._packagesRestored, true);
    assert.equal(attempts, 3);
    await kernel.destroy();
    assert.equal(kernel._packageRestoreWarningShown, false);
});

test('Free-only catalogue controls and workbook entries stay present', () => {
    const source = read('www/js/package_catalog.js');
    assert.match(source, /catalog-source-clear-data/);
    assert.match(source, /browse-shortcut-btn/);
    assert.match(source, /id: 'csv-basics-seedlings'/);
    assert.match(read('www/index.html'), /id="catalog-manage-installed"/);
    for (const file of ['package_archive_validation', 'package_archive_store', 'package_install_ui', 'package_installs']) {
        assert.match(read('www/index.html'), new RegExp(`js/${file}\\.js`));
        assert.match(read('www/sw.js'), new RegExp(`js/${file}\\.js`));
    }
});
