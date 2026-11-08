// Real bundled Pyodide installer boundary regressions. Package traffic is
// blocked at the browser route (including a control request), never by
// replacing micropip, its parser, or its compiled-package loader.
// Run the app server first; npm run fetch:bundles supplies the local runtime.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const BASE = (process.env.SCIREPL_TEST_BASE || `http://localhost:${process.env.PORT || 8085}`).replace(/\/+$/, '');
const APP_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const PINNED_CDN = 'https://cdn.jsdelivr.net/pyodide/v0.27.4/full/';
const FIXTURE_ROOT = `${BASE}/__installer_test__/`;
const TIMEOUT = 180_000;
const hosts = new Set(['cdn.jsdelivr.net', 'unpkg.com', 'pypi.org', 'files.pythonhosted.org']);
const packageRequest = url => hosts.has(new URL(url).hostname) || url.startsWith(FIXTURE_ROOT);
let checks = 0;
const check = (message, condition, detail) => {
    checks++;
    assert.ok(condition, `${message}${detail ? ': ' + String(detail).slice(-1400) : ''}`);
    console.log(`PASS ${message}`);
};

// Two small real wheels in memory. The custom index's only version is a
// prerelease, proving pre=True and the index reach native micropip unchanged.
function wheel(dist, version, mod, dependency = '') {
    return Buffer.from(execFileSync('python3', ['-c', `
import base64, csv, hashlib, io, sys, zipfile
dist, version, mod, dependency = sys.argv[1:]
name = dist.replace('-', '_') + '-' + version
files = {
    mod + '/__init__.py': 'VALUE = "fixture-ready"\\n',
    name + '.dist-info/METADATA': 'Metadata-Version: 2.1\\nName: ' + dist + '\\nVersion: ' + version + '\\n' + ('Requires-Dist: ' + dependency + '\\n' if dependency else ''),
    name + '.dist-info/WHEEL': 'Wheel-Version: 1.0\\nGenerator: scirepl-test\\nRoot-Is-Purelib: true\\nTag: py3-none-any\\n',
}
rows, buf = [], io.BytesIO()
with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as archive:
    for path, content in files.items():
        archive.writestr(path, content)
        digest = base64.urlsafe_b64encode(hashlib.sha256(content.encode()).digest()).rstrip(b'=').decode()
        rows.append((path, 'sha256=' + digest, str(len(content.encode()))))
    rows.append((name + '.dist-info/RECORD', '', ''))
    record = io.StringIO(); csv.writer(record).writerows(rows)
    archive.writestr(name + '.dist-info/RECORD', record.getvalue())
print(base64.b64encode(buf.getvalue()).decode())
`, dist, version, mod, dependency], { encoding: 'utf8' }).trim(), 'base64');
}

const optionFile = 'scirepl_options_fixture-1.0.0rc1-py3-none-any.whl';
const urlFile = 'scirepl_url_fixture-1.0.0-py3-none-any.whl';
const optionWheel = wheel('scirepl-options-fixture', '1.0.0rc1', 'scirepl_options_fixture');
const urlWheel = wheel('scirepl-url-fixture', '1.0.0', 'scirepl_url_fixture');
const prelude = readFileSync(new URL('../www/js/prelude.py', import.meta.url), 'utf8');
const wrapperStart = prelude.indexOf('def _configure_package_install_consent():');
const wrapperEnd = prelude.indexOf('\n_configure_package_install_consent()', wrapperStart);
assert.ok(wrapperStart >= 0 && wrapperEnd > wrapperStart, 'Expected consent-wrapper configuration source');
const wrapperSource = prelude.slice(wrapperStart, wrapperEnd);
const fixtureIndex = {
    meta: { 'api-version': '1.0' }, name: 'scirepl-options-fixture', versions: ['1.0.0rc1'],
    files: [{ filename: optionFile, url: FIXTURE_ROOT + optionFile,
        hashes: { sha256: createHash('sha256').update(optionWheel).digest('hex') } }],
};

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ serviceWorkers: 'block' });
const requests = [];
const fixtureRequests = [];
let blockPackages = true;
let blockOnlyContourpy = false;
await context.addInitScript(version => {
    localStorage.setItem('scirepl_onboarding_seen', '1');
    localStorage.setItem('scirepl_whats_new_seen_version', version);
    localStorage.setItem('scirepl_auto_download', '1');
}, APP_VERSION);
await context.route('**/*', async route => {
    const request = route.request(), url = request.url();
    if (url.startsWith(FIXTURE_ROOT)) {
        fixtureRequests.push({ url, cookie: request.headers().cookie || '' });
        if (url.endsWith(optionFile)) return route.fulfill({ body: optionWheel, contentType: 'application/octet-stream' });
        if (url.endsWith(urlFile)) return route.fulfill({ body: urlWheel, contentType: 'application/octet-stream' });
        if (url.includes('/simple/scirepl-options-fixture/')) return route.fulfill({
            body: JSON.stringify(fixtureIndex), contentType: 'application/vnd.pypi.simple.v1+json',
        });
        return route.fulfill({ status: 200, body: 'fixture-control' });
    }
    if (hosts.has(new URL(url).hostname) && (blockPackages
        || (blockOnlyContourpy && /\/contourpy[^/]*\.whl$/.test(new URL(url).pathname)))) return route.abort('internetdisconnected');
    return route.continue();
});
const page = await context.newPage();
page.setDefaultTimeout(TIMEOUT);
page.on('request', request => { if (packageRequest(request.url())) requests.push(request.url()); });
page.on('dialog', dialog => dialog.type() === 'confirm' ? dialog.accept() : dialog.dismiss());

async function clearConsent(legacy = false) {
    await page.evaluate(legacy => {
        localStorage.removeItem('scirepl_privacy_accepted_revision');
        if (legacy) localStorage.setItem('scirepl_privacy_accepted', '1');
        else localStorage.removeItem('scirepl_privacy_accepted');
    }, legacy);
}

async function startCell(code) {
    const before = await page.evaluate(() => window._cells.length);
    await page.locator('#lang-selector').selectOption('python');
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

async function runCell(code) { return finishCell(await startCell(code)); }
const denied = output => output.error && /privacy|consent|disclosure/i.test(output.text);
const noFalseSuccess = output => !/(?:^|\n)\s*Installed matplotlib\b/.test(output.text)
    && !output.text.includes('OFFLINE_TAIL_RAN');

try {
    console.log('1. Fresh bundled startup remains local and usable without consent');
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__SCIREPL_APP_READY && window.kernelManager);
    await page.evaluate(async () => { await window.kernelManager.ensureReady('python'); });
    check('cold Python uses actual bundled 0.27.4, not a CDN override', await page.evaluate(() =>
        window.kernelManager.getRuntimeSessionSource('python')?.source === 'vendor/pyodide/pyodide.js'
        && window.kernelManager.getKernel('python').getPyodide().version === '0.27.4'
        && !localStorage.getItem('scirepl_python_source')));
    check('bundled startup requires neither package traffic nor accepted consent', requests.length === 0
        && await page.evaluate(() => !window.kernelManager.hasCurrentPrivacyConsent()));

    console.log('2. Raw, aliased, helper and magic installs fail closed before network');
    for (const [name, code] of [
        ['raw micropip', 'import micropip\nawait micropip.install("networkx")\nprint("DENIED_TAIL_RAN")'],
        ['helper', 'await pip_install("networkx")\nprint("DENIED_TAIL_RAN")'],
        ['%pip', '%pip install networkx\nprint("DENIED_TAIL_RAN")'],
    ]) {
        await clearConsent();
        const baseline = requests.length, pending = await startCell(code);
        await page.locator('#privacy-modal:not(.hidden)').waitFor();
        check(`${name}: current disclosure appears before any package request`, requests.length === baseline);
        await page.locator('#privacy-modal .modal-close').click();
        const result = await finishCell(pending);
        check(`${name}: dismissal raises an error and prevents cell tail`, denied(result)
            && !result.text.includes('DENIED_TAIL_RAN'), result.text);
        check(`${name}: denied install emits no package request`, requests.length === baseline);
    }

    await clearConsent();
    await page.evaluate(() => {
        window.__packageRealConsent = window.kernelManager.ensureNetworkConsent;
        window.kernelManager.ensureNetworkConsent = async () => {};
    });
    const noOpStart = requests.length;
    try {
        const output = await runCell('import micropip\nawait micropip.install("networkx")\nprint("NOOP_TAIL_RAN")');
        check('resolved-but-unrecorded consent cannot authorize raw install', denied(output)
            && !output.text.includes('NOOP_TAIL_RAN') && requests.length === noOpStart, output.text);
    } finally {
        await page.evaluate(() => {
            window.kernelManager.ensureNetworkConsent = window.__packageRealConsent;
            delete window.__packageRealConsent;
        });
    }

    await clearConsent(true);
    const aliasStart = requests.length;
    const alias = await startCell('from micropip import install as user_install\nrequirements = ["numpy"]\nawait user_install(requirements, deps=False)\nprint("ALIAS_ACCEPTED")');
    await page.locator('#privacy-modal:not(.hidden)').waitFor();
    check('legacy consent and from-import/dynamic list still require current acceptance', requests.length === aliasStart);
    await page.locator('#privacy-accept-btn').click();
    const accepted = await finishCell(alias);
    check('acceptance reaches original installer with dynamic list and kwargs', !accepted.error && accepted.text.includes('ALIAS_ACCEPTED'), accepted.text);
    check('current acceptance is recorded', await page.evaluate(() => window.kernelManager.hasCurrentPrivacyConsent()));
    const repeated = await runCell('await user_install("numpy", deps=False)\nprint("REPEATED_ACCEPTED")');
    check('repeated accepted install does not prompt again', !repeated.error && repeated.text.includes('REPEATED_ACCEPTED')
        && await page.locator('#privacy-modal').isHidden());

    console.log('3. Native markers, wheel URLs, keyword and positional options survive');
    const forwarded = await runCell(`from types import SimpleNamespace\n_forward_calls = []\nasync def _forward_delegate(*args, **kwargs):\n    _forward_calls.append((args, kwargs))\n    if kwargs.get("native_failure"):\n        raise ValueError("native-failure-preserved")\n    return "native-return-preserved"\n_forward_namespace = {"_micropip": SimpleNamespace(install=_forward_delegate)}\nexec(${JSON.stringify(wrapperSource)}, _forward_namespace)\n_forward_namespace["_configure_package_install_consent"]()\n_forward_install = _forward_namespace["_micropip"].install\n_forward_namespace["_configure_package_install_consent"]()\nassert _forward_install is _forward_namespace["_micropip"].install\nassert _forward_install.__wrapped__ is _forward_delegate\n_forward_args = (["a", "b"], True, False, "omit", True, ["https://fixture.invalid/simple"])\nassert await _forward_install(*_forward_args, verbose=2) == "native-return-preserved"\nassert _forward_calls[-1] == (_forward_args, {"verbose": 2})\ntry:\n    await _forward_install("a", native_failure=True)\nexcept ValueError as exc:\n    assert str(exc) == "native-failure-preserved"\nelse:\n    raise AssertionError("Native failure was swallowed")\nprint("FORWARDING_PRESERVED")`);
    check('actual wrapper forwards every argument, return and exception without stacking on repeat setup', !forwarded.error
        && forwarded.text.includes('FORWARDING_PRESERVED'), forwarded.text);
    const markerStart = requests.length;
    const marker = await runCell('import micropip\nawait micropip.install("scirepl-never-requested; sys_platform == \'not_a_runtime\'", deps=False)\nprint("MARKER_SKIPPED")');
    check('native environment markers are preserved, not reparsed by %pip grammar', !marker.error
        && marker.text.includes('MARKER_SKIPPED') && requests.length === markerStart, marker.text);
    const indexUrl = FIXTURE_ROOT + 'simple';
    await context.addCookies([{ name: 'scirepl_installer_fixture_cookie', value: 'control', url: BASE }]);
    await page.evaluate(url => fetch(url), FIXTURE_ROOT + 'cookie-control');
    check('fixture control observes same-origin cookie', fixtureRequests.at(-1).cookie.includes('scirepl_installer_fixture_cookie'));
    const fixtureStart = fixtureRequests.length;
    const options = await runCell(`requirements = ["scirepl-options-fixture"]\nawait user_install(requirements, True, True, "omit", True, [${JSON.stringify(indexUrl)}], verbose=False)\nimport scirepl_options_fixture\nprint(scirepl_options_fixture.VALUE)`);
    check('dynamic requirements, positional args, pre=True and custom index work unchanged', !options.error
        && options.text.includes('fixture-ready'), options.text);
    check('credentials=omit reaches actual custom-index and wheel fetches', fixtureRequests.length > fixtureStart
        && fixtureRequests.slice(fixtureStart).every(request => !request.cookie), JSON.stringify(fixtureRequests.slice(fixtureStart)));
    const urlResult = await runCell(`await user_install(${JSON.stringify(FIXTURE_ROOT + urlFile)}, credentials="omit")\nimport scirepl_url_fixture\nprint(scirepl_url_fixture.VALUE)`);
    check('explicit wheel URL is passed to native micropip unchanged', !urlResult.error && urlResult.text.includes('fixture-ready'), urlResult.text);

    console.log('4. Real blocked downloads are errors, never install success');
    const control = await page.evaluate(async url => {
        try { await fetch(url); return false; } catch (_) { return true; }
    }, PINNED_CDN + '__scirepl_network_block_control__');
    check('package-host block is verified by an actual failed control fetch', control);
    for (const [name, code] of [
        ['raw', 'await micropip.install("matplotlib")\nprint("OFFLINE_TAIL_RAN")'],
        ['helper', 'await pip_install("matplotlib")\nprint("OFFLINE_TAIL_RAN")'],
        ['%pip', '%pip install matplotlib\nprint("OFFLINE_TAIL_RAN")'],
    ]) {
        const output = await runCell(code);
        check(`${name}: blocked compiled-package download fails the cell and stops the tail`, output.error && noFalseSuccess(output), output.text);
        check(`${name}: known distribution is not falsely reported absent`, !/not in the Pyodide distribution/.test(output.text), output.text);
        if (name === 'helper') check('helper explicitly reports failure without claiming installation succeeded',
            output.text.includes('Failed to install matplotlib')
            && !/(?:^|\n)\s*Installed matplotlib\b/.test(output.text), output.text);
        check(`${name}: Python stdout is restored after failure`, await page.evaluate(() =>
            window.kernelManager.getKernel('python').getPyodide().runPython('sys.stdout is sys.__stdout__')));
        const next = await runCell(`print(${JSON.stringify(`STDOUT_AFTER_${name}_FAILURE`)})`);
        check(`${name}: next ordinary cell prints normally`, !next.error
            && next.text.includes(`STDOUT_AFTER_${name}_FAILURE`), next.text);
    }
    const onlineAgain = await runCell('print("STDOUT_STILL_WORKS")');
    check('ordinary execution survives failed installer cleanup', !onlineAgain.error && onlineAgain.text.includes('STDOUT_STILL_WORKS'));

    console.log('5. Bundled offline install, same-session recovery and real PyPI wheel');
    const pandasStart = requests.length;
    const pandas = await runCell('await micropip.install("pandas")\nimport pandas\nprint("PANDAS_READY")');
    check('bundled pandas installs while external package hosts remain blocked', !pandas.error && pandas.text.includes('PANDAS_READY'), pandas.text);
    check('bundled pandas installs without any external package request', requests.length === pandasStart);
    blockPackages = false;
    blockOnlyContourpy = true;
    const partial = await runCell('await micropip.install("matplotlib")\nprint("PARTIAL_TAIL_RAN")');
    check('one blocked compiled dependency fails even when other wheels and root arrive', partial.error
        && !partial.text.includes('PARTIAL_TAIL_RAN'), partial.text);
    blockOnlyContourpy = false;
    const recovery = await runCell('await micropip.install("matplotlib")\nimport matplotlib\nprint("MATPLOTLIB_RECOVERED")');
    check('failed compiled install recovers when network returns in the same interpreter', !recovery.error
        && recovery.text.includes('MATPLOTLIB_RECOVERED'), recovery.text);
    const pyPI = await runCell('await micropip.install("tabulate")\nfrom tabulate import tabulate\nprint(tabulate([[1, 2]], headers=["a", "b"]))\nprint("PYPI_READY")');
    check('normal pure-Python PyPI wheels still install and import', !pyPI.error && pyPI.text.includes('PYPI_READY'), pyPI.text);
    check('tests used the guarded public micropip API', await page.evaluate(() =>
        window.kernelManager.getKernel('python').getPyodide().runPython('bool(getattr(micropip.install, "_scirepl_consent_guarded", False))')));
    console.log(`Python package consent: ${checks} checks passed.`);
} finally {
    await browser.close();
}
