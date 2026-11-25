// R package downloads require the current privacy-policy revision, as Python
// package downloads do. Run the app server first (PORT, default 8085).
//
// Default mode is hermetic: the webR module URL is answered with a small stub
// that records install requests and mimics the R-side gate, so the run needs
// no 50 MB runtime and no network. It proves the JavaScript side: the dialog,
// when it appears, and that a dismissal starts no install.
//
// `--real-webr <dir>` (or SCIREPL_WEBR_DIR) serves a local webR 0.5.4 copy
// (the folder holding webr.mjs, R.wasm and vfs/) instead, and blocks the webR
// package repository. It proves the R-side gate on install.packages() and
// library() auto-install by counting real repository requests.
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright';

const BASE = (process.env.SCIREPL_TEST_BASE || `http://localhost:${process.env.PORT || 8085}`).replace(/\/+$/, '');
const APP_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const flag = process.argv.indexOf('--real-webr');
const REAL_DIR = flag >= 0 ? resolve(process.argv[flag + 1] || '') : process.env.SCIREPL_WEBR_DIR || '';
const REAL = !!REAL_DIR;
if (REAL) assert.ok(existsSync(join(REAL_DIR, 'webr.mjs')), `No webr.mjs in ${REAL_DIR}`);
const TIMEOUT = REAL ? 240_000 : 60_000;
const WEBR_HOSTS = new Set(['webr.r-wasm.org']);
const isWebrRuntime = url => WEBR_HOSTS.has(url.hostname) || /^\/npm\/webr@/.test(url.pathname);
const isRepo = url => url.hostname === 'repo.r-wasm.org';

let checks = 0;
const check = (message, condition, detail) => {
    checks++;
    assert.ok(condition, `${message}${detail ? ': ' + String(detail).slice(-1400) : ''}`);
    console.log(`PASS ${message}`);
};

// Mimics webR 0.5.4 plus the R gate SciREPL installs: R reads
// options(scirepl.package_network_consent) and refuses with RKernel's message.
const STUB = `
const state = window.__webrStub = { flag: null, gate: 0, installs: [] };
const refusal = () => new Error('Error in unknown source: ' + RKernel.PACKAGE_CONSENT_MESSAGE);
const install = names => {
    if (state.flag !== true) throw refusal();
    state.installs.push(...names);
};
class Shelter {
    async captureR(code) {
        // Like real webR with captureConditions:false, an R error is printed
        // to the captured stderr and evaluation stops; captureR resolves.
        const match = code.match(/install\\.packages\\("([^"]+)"\\)/);
        if (match && state.flag !== true) return { output: [{ type: 'stderr',
            data: 'Error: ' + RKernel.PACKAGE_CONSENT_MESSAGE }], images: [] };
        if (match) install([match[1]]);
        return { output: [{ type: 'stdout', data: 'STUB_CELL_DONE' }], images: [] };
    }
    purge() {}
}
export class WebR {
    constructor() { this.version = '0.5.4'; this.FS = { mkdir: async () => {}, writeFile: async () => {},
        readFile: async () => new Uint8Array() }; }
    get Shelter() { return Shelter; }
    async init() {}
    async evalRVoid(code) {
        if (code.includes('scirepl_consent_gate')) state.gate++;
        const option = code.match(/scirepl\\.package_network_consent = (TRUE|FALSE)/);
        if (option) state.flag = option[1] === 'TRUE';
    }
    async evalRString() { return ''; }
    async installPackages(names) { install(names); }
}
`;

const MIME = { '.mjs': 'text/javascript', '.js': 'text/javascript', '.wasm': 'application/wasm',
    '.json': 'application/json', '.so': 'application/octet-stream', '.data': 'application/octet-stream' };

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ serviceWorkers: 'block' });
const repoRequests = [];
await context.addInitScript(version => {
    localStorage.setItem('scirepl_onboarding_seen', '1');
    localStorage.setItem('scirepl_whats_new_seen_version', version);
    localStorage.setItem('scirepl_auto_download', '1');
    localStorage.setItem('scirepl_r_prewarm', 'no');
    if (!sessionStorage.getItem('scirepl_test_seeded')) {
        // R itself loads under the pre-revision boolean consent: the case
        // the package gate exists for.
        localStorage.setItem('scirepl_privacy_accepted', '1');
        localStorage.removeItem('scirepl_privacy_accepted_revision');
        sessionStorage.setItem('scirepl_test_seeded', '1');
    }
}, APP_VERSION);
await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (isRepo(url)) {
        repoRequests.push(url.href);
        return route.abort('internetdisconnected');
    }
    if (!isWebrRuntime(url)) return route.continue();
    if (!REAL) {
        if (url.pathname.endsWith('/webr.mjs')) return route.fulfill({ body: STUB, contentType: 'text/javascript' });
        return route.fulfill({ status: 404, body: '' });
    }
    const relative = decodeURIComponent(url.pathname.replace(/^.*?\/(?:v0\.5\.4|webr@0\.5\.4\/dist)\//, ''));
    const file = join(REAL_DIR, relative);
    if (!file.startsWith(REAL_DIR) || !existsSync(file)) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ body: readFileSync(file), contentType: MIME[extname(file)] || 'application/octet-stream',
        headers: { 'Access-Control-Allow-Origin': '*' } });
});
const page = await context.newPage();
page.setDefaultTimeout(TIMEOUT);
page.on('dialog', dialog => dialog.type() === 'confirm' ? dialog.accept() : dialog.dismiss());

const modalVisible = () => page.locator('#privacy-modal:not(.hidden)').isVisible();
const installs = () => REAL ? repoRequests.length : page.evaluate(() => window.__webrStub.installs.length);

async function setConsent(kind) {
    await page.evaluate(kind => {
        const key = KernelManager.PRIVACY_POLICY_REVISION_KEY;
        if (kind === 'current') {
            localStorage.setItem('scirepl_privacy_accepted', '1');
            localStorage.setItem(key, KernelManager.PRIVACY_POLICY_REVISION);
        } else if (kind === 'old') {
            localStorage.setItem('scirepl_privacy_accepted', '1');
            localStorage.setItem(key, 'superseded-revision');
        } else {
            localStorage.removeItem('scirepl_privacy_accepted');
            localStorage.removeItem(key);
        }
    }, kind);
}

async function startCell(code) {
    const before = await page.evaluate(() => window._cells.length);
    await page.locator('#lang-selector').selectOption('r');
    await page.locator('#code-input').fill(code);
    await page.locator('#run-btn').click();
    return before;
}

async function finishCell(before) {
    await page.waitForFunction(count => window._cells.length > count
        && !window._currentOutputCard && !document.querySelector('#run-btn').disabled, before);
    return page.evaluate(() => {
        const card = window._cells.at(-1)?.outputCard;
        return { text: card?.textContent || '', error: !!card?.classList.contains('card-error') };
    });
}

const runCell = async code => finishCell(await startCell(code));

// Dismissal: the cell must fail with the privacy message and install nothing.
async function dismissed(name, code, kind) {
    await setConsent(kind);
    const baseline = await installs();
    const pending = await startCell(code);
    await page.locator('#privacy-modal:not(.hidden)').waitFor();
    check(`${name} (${kind} consent): privacy dialog appears and nothing was downloaded`,
        await installs() === baseline);
    await page.locator('#privacy-modal .modal-close').click();
    const result = await finishCell(pending);
    check(`${name} (${kind} consent): dismissal fails the cell with the privacy message`,
        result.error && /must be accepted/.test(result.text) && !result.text.includes('TAIL_RAN'), result.text);
    check(`${name} (${kind} consent): dismissal downloads nothing`, await installs() === baseline);
    check(`${name} (${kind} consent): dismissal records no consent`,
        await page.evaluate(() => !window.kernelManager.hasCurrentPrivacyConsent()));
}

try {
    console.log(`Mode: ${REAL ? 'real webR from ' + REAL_DIR : 'stub webR'}`);
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__SCIREPL_APP_READY && window.kernelManager);

    console.log('1. R loads under older consent; the package gate is installed');
    await page.evaluate(async () => { await window.kernelManager.ensureReady('r'); });
    check('R is ready without current-revision consent and without a dialog',
        await page.evaluate(() => !window.kernelManager.hasCurrentPrivacyConsent()) && !await modalVisible());
    if (REAL) {
        const gate = await runCell('cat(isTRUE(attr(webr::install, "scirepl_consent_gate")), '
            + 'identical(get("install.packages", as.environment("webr_shims")), webr::install), "\\n")');
        check('webr::install and the install.packages() shim are the gated function', !gate.error
            && gate.text.includes('TRUE TRUE'), gate.text);
    } else {
        check('R gate code is evaluated once at init', await page.evaluate(() => window.__webrStub.gate === 1));
    }
    check('loading R requested no package', await installs() === 0);

    console.log('2. Without the current revision every install path asks first');
    await dismissed('%install', '%install glue', 'old');
    await dismissed('install.packages()', 'install.packages("glue")\ncat("TAIL_RAN\\n")', 'old');
    await dismissed('install.packages()', 'install.packages("glue")\ncat("TAIL_RAN\\n")', 'missing');
    if (REAL) await dismissed('library() auto-install', 'library(glue)\ncat("TAIL_RAN\\n")', 'old');

    await setConsent('old');
    const apiStart = await installs();
    const api = page.evaluate(() => window.kernelManager.getKernel('r').installPackages(['ggplot2', 'dplyr'])
        .then(() => 'resolved', error => error.message));
    await page.locator('#privacy-modal:not(.hidden)').waitFor();
    await page.locator('#privacy-modal .modal-close').click();
    const apiResult = await api;
    check('installPackages() (%install, pre-warm) rejects once on dismissal and installs nothing',
        apiResult !== 'resolved' && /privacy/i.test(apiResult) && await installs() === apiStart
        && !await modalVisible(), apiResult);

    console.log('3. Accepting from an in-R refusal records consent; the next run installs');
    await setConsent('old');
    const refusedStart = await installs();
    const refused = await startCell('install.packages("glue")');
    await page.locator('#privacy-modal:not(.hidden)').waitFor();
    await page.locator('#privacy-accept-btn').click();
    const refusedResult = await finishCell(refused);
    check('accepted refusal tells the user to run the cell again', refusedResult.error
        && /run the cell again/.test(refusedResult.text) && await installs() === refusedStart, refusedResult.text);
    check('acceptance records the current revision', await page.evaluate(() => window.kernelManager.hasCurrentPrivacyConsent()));

    console.log('4. With current consent installs proceed with no dialog');
    for (const [name, code] of [['install.packages()', 'install.packages("glue")'], ['%install', '%install cli']]) {
        const start = await installs();
        const result = await runCell(code);
        check(`${name}: install proceeds with no privacy dialog`, !await modalVisible()
            && await installs() > start, result.text);
        if (!REAL) check(`${name}: install completes`, !result.error, result.text);
    }
    const repeatStart = await installs();
    await page.evaluate(() => window.kernelManager.getKernel('r').installPackages(['ggplot2']));
    check('installPackages() proceeds with no dialog', !await modalVisible() && await installs() > repeatStart);
    const plain = await runCell('cat("PLAIN_R_OK\\n")');
    check('ordinary R code still runs', !plain.error && /PLAIN_R_OK|STUB_CELL_DONE/.test(plain.text), plain.text);
    console.log(`R package consent: ${checks} checks passed.`);
} finally {
    await browser.close();
}
