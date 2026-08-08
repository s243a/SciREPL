/**
 * Test: Prolog Generates TypR workbook
 *
 * Simulates the workbook flow:
 * 1. Load UnifyWeaver compiler modules (Prolog)
 * 2. Define family tree facts (Prolog)
 * 3. Compile ancestor/2 to TypR (Prolog)
 * 4. Execute generated TypR code
 * 5. Run queries
 */
import { chromium } from 'playwright';

const BASE = 'http://localhost:8085';

let _counter = 0;
async function domExec(page, code, { timeout = 60000 } = {}) {
    const id = `_de_${++_counter}`;
    const rAttr = `data-${id}-r`;
    const eAttr = `data-${id}-e`;
    await page.addScriptTag({ content: `
        (async () => {
            try {
                const __r = await (async () => { ${code} })();
                document.body.setAttribute('${rAttr}',
                    __r === undefined ? '__undef__' : JSON.stringify(__r));
            } catch(e) {
                document.body.setAttribute('${eAttr}', e.message || String(e));
            }
        })();
    `});
    await page.waitForFunction(
        ([r, e]) => document.body.hasAttribute(r) || document.body.hasAttribute(e),
        [rAttr, eAttr], { timeout, polling: 1000 }
    );
    const err = await page.getAttribute('body', eAttr);
    if (err) throw new Error(err);
    const raw = await page.getAttribute('body', rAttr);
    if (raw === '__undef__') return undefined;
    return JSON.parse(raw);
}

async function ensureKernel(page, name, timeout = 300000) {
    const attr = `data-k-${name}`;
    const eAttr = `data-k-${name}-e`;
    await page.addScriptTag({ content: `
        window.kernelManager.ensureReady('${name}')
            .then(() => document.body.setAttribute('${attr}', '1'))
            .catch(e => document.body.setAttribute('${eAttr}', e.message));
    `});
    await page.waitForFunction(
        ([a, e]) => document.body.hasAttribute(a) || document.body.hasAttribute(e),
        [attr, eAttr], { timeout, polling: 2000 }
    );
    const err = await page.getAttribute('body', eAttr);
    if (err) throw new Error(`${name} kernel failed: ${err}`);
}

async function kernelExec(page, kernel, code, { timeout = 60000 } = {}) {
    const escaped = JSON.stringify(code);
    return await domExec(page, `
        const r = await window.kernelManager.execute(${escaped}, '${kernel}');
        return { stdout: r.stdout || '', error: r.error || '' };
    `, { timeout });
}

(async () => {
    const browser = await chromium.launch({
        headless: true,
        args: ['--disable-dev-shm-usage', '--disable-gpu', '--no-sandbox']
    });
    const page = await browser.newPage();
    page.on('console', msg => {
        const t = msg.text();
        if (t.includes('rror') || t.includes('TypR') || t.includes('Prolog') || t.includes('compile'))
            console.log('  [page]', t.substring(0, 200));
    });

    console.log('1. Loading SciREPL...');
    await page.addInitScript(() => {
        localStorage.setItem('scirepl_privacy_accepted', '1');
        localStorage.setItem('scirepl_onboarding_seen', '1');
        localStorage.setItem('scirepl_auto_download', '1');
        localStorage.removeItem('scirepl_enabled_languages');
    });
    await page.goto(BASE, { waitUntil: 'networkidle', timeout: 30000 });
    await page.evaluate(async () => {
        const regs = await navigator.serviceWorker.getRegistrations();
        for (const r of regs) await r.unregister();
    });
    await page.reload({ waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForSelector('#run-btn:not([disabled])', { timeout: 10000 });

    // Step 1: Load Prolog kernel
    console.log('\n2. Loading Prolog kernel...');
    await ensureKernel(page, 'prolog', 300000);
    console.log('   Prolog ready');

    // Step 2: Load compiler modules
    console.log('\n3. Loading UnifyWeaver compiler...');
    const loadResult = await kernelExec(page, 'prolog',
        "[\'../init\'].\n:- use_module(unifyweaver(targets/typr_target)).\n:- use_module(unifyweaver(core/recursive_compiler)).",
        { timeout: 60000 });
    console.log('   Load result:', loadResult.stdout.substring(0, 100) || '(ok)');
    if (loadResult.error) {
        console.log('   ERROR:', loadResult.error.substring(0, 200));
    }

    // Step 3: Define family tree
    console.log('\n4. Defining family tree...');
    const factsResult = await kernelExec(page, 'prolog',
        ":- dynamic parent/2, ancestor/2.\nparent(alice, bob).\nparent(bob, charlie).\nparent(bob, diana).\nparent(charlie, eve).\nparent(diana, frank).\nancestor(X, Y) :- parent(X, Y).\nancestor(X, Y) :- parent(X, Z), ancestor(Z, Y).",
        { timeout: 30000 });
    console.log('   Facts result:', factsResult.stdout.substring(0, 100) || '(ok)');
    if (factsResult.error) console.log('   ERROR:', factsResult.error.substring(0, 200));

    // Step 4: Compile to TypR
    console.log('\n5. Compiling ancestor/2 to TypR...');
    const compileResult = await kernelExec(page, 'prolog',
        "compile_recursive(ancestor/2, [target(typr)], Code), write(Code).",
        { timeout: 60000 });
    console.log('   Compile stdout length:', compileResult.stdout.length);
    if (compileResult.error) {
        console.log('   COMPILE ERROR:', compileResult.error.substring(0, 300));
    }
    if (compileResult.stdout.length > 0) {
        // Show last 200 chars
        console.log('   Generated code tail:', compileResult.stdout.substring(compileResult.stdout.length - 200));
    }

    // Step 5: Execute the generated TypR code
    if (compileResult.stdout.length > 100) {
        console.log('\n6. Loading TypR kernel...');
        await ensureKernel(page, 'typr', 300000);
        console.log('   TypR ready');

        console.log('\n7. Executing generated TypR code...');
        const typrResult = await kernelExec(page, 'typr', compileResult.stdout, { timeout: 60000 });
        console.log('   TypR stdout:', typrResult.stdout.substring(0, 200));
        if (typrResult.error) console.log('   TypR ERROR:', typrResult.error.substring(0, 300));

        // Step 6: Query
        console.log('\n8. Running query...');
        const queryResult = await kernelExec(page, 'typr',
            'let results <- ancestor_all("alice");\ncat(paste("Descendants:", paste(sep=", ", ...results)));',
            { timeout: 30000 });
        console.log('   Query result:', queryResult.stdout);
        if (queryResult.error) console.log('   Query ERROR:', queryResult.error.substring(0, 200));
    } else {
        console.log('\n   Skipping TypR execution — no code generated');
    }

    console.log('\n' + '='.repeat(50));
    console.log('Done');
    console.log('='.repeat(50));

    await browser.close();
    process.exit(0);
})().catch(err => {
    console.error('FATAL:', err.message);
    process.exit(1);
});
