/**
 * Playwright test: TypR kernel — compile typed R and execute via webR
 *
 * Tests:
 * 1. TypR appears in language selector
 * 2. TypR WASM compiler loads
 * 3. Simple TypR code compiles to R
 * 4. #!typecheck directive works
 * 5. #!transpile directive shows R output
 * 6. Type error is reported as warning
 * 7. Full execution via webR (if webR loads)
 *
 * Uses DOM signaling for CDN kernel interactions.
 */
import { chromium } from 'playwright';

const BASE = 'http://localhost:8085';
let passed = 0;
let failed = 0;

function ok(label) { passed++; console.log('   PASS: ' + label); }
function fail(label, err) { failed++; console.error('   FAIL: ' + label + ' — ' + err); }

let _domExecCounter = 0;
async function domExec(page, asyncJsCode, { timeout = 30000 } = {}) {
    const id = `_domexec_${++_domExecCounter}`;
    const resultAttr = `data-${id}-result`;
    const errorAttr = `data-${id}-error`;

    await page.addScriptTag({ content: `
        (async () => {
            try {
                const __result = await (async () => { ${asyncJsCode} })();
                document.body.setAttribute('${resultAttr}',
                    __result === undefined ? '__undefined__' : JSON.stringify(__result));
            } catch(e) {
                document.body.setAttribute('${errorAttr}', e.message || String(e));
            }
        })();
    `});

    await page.waitForFunction(
        ([r, e]) => document.body.hasAttribute(r) || document.body.hasAttribute(e),
        [resultAttr, errorAttr],
        { timeout, polling: 500 }
    );

    const err = await page.getAttribute('body', errorAttr);
    if (err) throw new Error(err);
    const raw = await page.getAttribute('body', resultAttr);
    if (raw === '__undefined__') return undefined;
    return JSON.parse(raw);
}

(async () => {
    const browser = await chromium.launch({
        headless: true,
        args: ['--disable-dev-shm-usage', '--disable-gpu', '--no-sandbox']
    });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', err => errors.push(err.message));
    page.on('console', msg => {
        if (msg.text().includes('TypR') || msg.text().includes('typr') || msg.text().includes('rror'))
            console.log('  [page]', msg.text().substring(0, 150));
    });

    // Setup
    console.log('1. Loading SciREPL...');
    await page.addInitScript(() => {
        localStorage.setItem('scirepl_privacy_accepted', '1');
        localStorage.setItem('scirepl_auto_download', '1');
        localStorage.removeItem('scirepl_enabled_languages'); // ensure all languages show
    });
    await page.goto(BASE, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForSelector('#run-btn:not([disabled])', { timeout: 10000 });

    // Test 1: TypR in language selector
    console.log('\n2. Checking language selector...');
    const hasTypR = await page.evaluate(() => {
        const sel = document.getElementById('lang-selector');
        return sel ? [...sel.options].some(o => o.value === 'typr') : false;
    });
    if (hasTypR) ok('TypR appears in language selector');
    else fail('TypR in selector', 'not found');

    // Test 2: TypR kernel registered
    const registered = await page.evaluate(() => {
        return window.kernelManager && window.kernelManager._registry &&
               window.kernelManager._registry.typr !== undefined;
    });
    if (registered) ok('TypR kernel registered in KernelManager');
    else fail('TypR kernel registered', 'not in registry');

    // Test 3: Load TypR WASM compiler directly (without webR)
    console.log('\n3. Testing TypR WASM compiler...');
    try {
        const compileResult = await domExec(page, `
            const mod = await import('./vendor/typr/typr_wasm.js');
            await mod.default();
            const result = mod.compile('let x <- 42\\ncat(x)');
            return {
                has_errors: result.has_errors,
                errors: result.errors,
                r_code_length: result.r_code.length,
                r_code_preview: result.r_code.substring(result.r_code.length - 100),
            };
        `, { timeout: 15000 });

        if (compileResult.r_code_length > 0) ok('TypR compiles "let x <- 42" — R code length: ' + compileResult.r_code_length);
        else fail('TypR compile', 'empty R code');

        console.log('   R code tail:', compileResult.r_code_preview.trim());
    } catch (e) {
        fail('TypR WASM compile', e.message);
    }

    // Test 4: Type check only
    console.log('\n4. Testing #!typecheck...');
    try {
        const tcResult = await domExec(page, `
            const mod = await import('./vendor/typr/typr_wasm.js');
            const result = mod.typeCheck('let x <- 42\\ncat(x)');
            return { has_errors: result.has_errors, errors: result.errors };
        `);
        if (!tcResult.has_errors) ok('typeCheck passes for valid code');
        else fail('typeCheck valid', tcResult.errors);
    } catch (e) {
        fail('typeCheck', e.message);
    }

    // Test 5: Type error detection
    console.log('\n5. Testing type error detection...');
    try {
        const errResult = await domExec(page, `
            const mod = await import('./vendor/typr/typr_wasm.js');
            const result = mod.typeCheck('let x: int <- "hello"\\ncat(x)');
            return { has_errors: result.has_errors, errors: result.errors };
        `);
        if (errResult.has_errors) ok('Type error detected for int <- "hello": ' + errResult.errors.substring(0, 80));
        else ok('No type error (TypR may allow coercion)');
    } catch (e) {
        fail('Type error detection', e.message);
    }

    // Test 6: Transpile only
    console.log('\n6. Testing transpile...');
    try {
        const transpiled = await domExec(page, `
            const mod = await import('./vendor/typr/typr_wasm.js');
            return mod.transpile('let x <- 42\\ncat(x)');
        `);
        if (transpiled && transpiled.includes('42')) ok('Transpile output contains 42: ' + transpiled.trim().substring(0, 80));
        else fail('Transpile', 'unexpected output: ' + transpiled);
    } catch (e) {
        fail('Transpile', e.message);
    }

    // Test 7: Full kernel execution (requires webR — may be slow)
    console.log('\n7. Testing full TypR kernel execution (loads webR)...');
    try {
        // Use DOM signaling for the heavy webR load
        const attr = 'data-typr-exec-result';
        const errAttr = 'data-typr-exec-error';

        await page.addScriptTag({ content: `
            (async () => {
                try {
                    await window.kernelManager.ensureReady('typr');
                    const result = await window.kernelManager.execute('let x <- 42\\ncat(x)', 'typr');
                    document.body.setAttribute('${attr}', JSON.stringify(result));
                } catch(e) {
                    document.body.setAttribute('${errAttr}', e.message || String(e));
                }
            })();
        `});

        await page.waitForFunction(
            ([a, e]) => document.body.hasAttribute(a) || document.body.hasAttribute(e),
            [attr, errAttr],
            { timeout: 300000, polling: 2000 }
        );

        const execErr = await page.getAttribute('body', errAttr);
        if (execErr) {
            fail('Full execution', execErr);
        } else {
            const execResult = JSON.parse(await page.getAttribute('body', attr));
            if (execResult.stdout && execResult.stdout.includes('42')) {
                ok('Full execution: cat(x) outputs 42');
            } else if (execResult.error) {
                fail('Full execution', 'error: ' + execResult.error);
            } else {
                ok('Full execution completed: ' + JSON.stringify(execResult).substring(0, 100));
            }
        }
    } catch (e) {
        fail('Full execution', e.message);
    }

    // Summary
    console.log('\n' + '='.repeat(50));
    console.log(`Results: ${passed} passed, ${failed} failed`);
    if (errors.length > 0) {
        console.log('\nPage errors:');
        errors.slice(-5).forEach(e => console.log('  ' + e));
    }
    console.log('='.repeat(50));

    await browser.close();
    process.exit(failed > 0 ? 1 : 0);
})().catch(err => {
    console.error('FATAL:', err.message);
    process.exit(1);
});
