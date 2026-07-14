/** End-to-end regression test for both TypR catalog workbooks. */
import { chromium } from 'playwright';

const BASE = 'http://localhost:8085';
const TIMEOUT = 300_000;

function assert(condition, message, detail = '') {
    if (!condition) throw new Error(message + (detail ? `: ${detail}` : ''));
    console.log(`  PASS: ${message}`);
}

async function installCatalogItem(page, name) {
    await page.evaluate(() => {
        document.getElementById('btn-browse-packages').click();
    });
    await page.waitForSelector('#package-catalog-modal:not(.hidden)');

    await page.evaluate(async (itemName) => {
        const cards = [...document.querySelectorAll('#package-catalog-list .pkg-card')];
        const card = cards.find(c => c.querySelector('strong')?.textContent?.trim() === itemName);
        if (!card) throw new Error(`Catalog item not found: ${itemName}`);
        const button = card.querySelector('.pkg-install-btn');
        await window.packageCatalog._install(button);
    }, name);
}

async function runAllAndCollect(page) {
    await page.evaluate(async () => window.runAllCells());
    return page.evaluate(() => (window._cells || []).map(cell => ({
        name: cell.name,
        language: cell.language,
        code: cell.code,
        output: cell.outputCard?.querySelector('.card-body')?.textContent || '',
        error: !!cell.outputCard?.classList.contains('card-error'),
    })));
}

(async () => {
    const browser = await chromium.launch({
        headless: true,
        args: ['--disable-dev-shm-usage', '--disable-gpu', '--no-sandbox'],
    });
    const context = await browser.newContext({ serviceWorkers: 'block' });
    await context.addInitScript(() => {
        localStorage.clear();
        localStorage.setItem('scirepl_privacy_accepted', '1');
        localStorage.setItem('scirepl_auto_download', '1');
        localStorage.removeItem('scirepl_enabled_languages');
    });
    const page = await context.newPage();
    page.setDefaultTimeout(TIMEOUT);
    page.on('console', msg => {
        const text = msg.text();
        if (/error|TypR|dependency|Prolog/i.test(text)) {
            console.log('  [page]', text.substring(0, 240));
        }
    });

    try {
        console.log('1. Loading SciREPL...');
        await page.goto(BASE, { waitUntil: 'networkidle', timeout: 30_000 });
        await page.waitForSelector('#run-btn:not([disabled])');

        console.log('\n2. Installing and running TypR Introduction...');
        await installCatalogItem(page, 'TypR Introduction');
        const intro = await runAllAndCollect(page);
        const introErrors = intro.filter(c => c.error);
        assert(introErrors.length === 0, 'TypR Introduction Run All has no error cards',
            introErrors.map(c => c.name).join(', '));

        const square = intro.find(c => c.name === 'square');
        const forwarding = intro.find(c => c.name === 'variadic_forwarding');
        const transpile = intro.find(c => c.name === 'transpile_demo');
        const forwardingR = await page.evaluate(source => {
            const kernel = window.kernelManager.getKernel('typr');
            const compiled = kernel._typrModule.compile(source);
            const main = compiled.r_code.indexOf('# === Main Code ===');
            return compiled.r_code.substring(main >= 0 ? main : 0);
        }, forwarding?.code || '');
        assert(square?.output.includes('7 squared = 49'), 'typed square executes', square?.output);
        assert(forwarding?.output.includes('Names: count, enabled'),
            'heterogeneous named arguments survive variadic forwarding',
            `${forwarding?.output}\nGenerated R:\n${forwardingR}`);
        assert(!forwarding?.output.includes('Type errors'), 'variadic forwarding type-checks');
        assert(transpile?.output.includes('fib'), 'typed recursive function transpiles');

        console.log('\n3. Installing and running Prolog Generates TypR...');
        await installCatalogItem(page, 'Prolog Generates TypR');

        const dependency = await page.evaluate(() => {
            const installed = JSON.parse(localStorage.getItem('scirepl_installed_packages') || '[]');
            return installed.some(p => p.name === 'UnifyWeaver SciREPL');
        });
        assert(dependency, 'catalog installs and remembers the UnifyWeaver dependency');

        const generated = await runAllAndCollect(page);
        const generatedErrors = generated.filter(c => c.error);
        assert(generatedErrors.length === 0, 'Prolog Generates TypR Run All has no error cards',
            generatedErrors.map(c => `${c.name || '(unnamed)'}: ${c.output}`).join(' | '));

        const compileCell = generated.find(c => c.name === 'compile_to_typr');
        const typrCell = generated.find(c => c.name === 'typr_output');
        const rCell = generated.find(c => c.name === 'r_output');
        const generatedR = await page.evaluate(source => {
            const kernel = window.kernelManager.getKernel('typr');
            return kernel._typrModule.compile(source).r_code;
        }, typrCell?.code || '');
        assert(compileCell?.output.includes('TypR code written to cell'), 'Prolog populates the TypR cell');
        assert(typrCell?.code.includes('fn(start: char)') && !typrCell.code.includes('@{'),
            'UnifyWeaver emits native typed TypR without raw-R traversal blocks');
        assert(!typrCell?.output.includes('Type errors'), 'generated TypR type-checks', typrCell?.output);
        assert(typrCell?.output.includes('Descendants of alice:') && typrCell.output.includes('eve'),
            'generated TypR executes the transitive closure',
            `${typrCell?.output}\nGenerated casts:\n${generatedR.split('\n').filter(line => line.includes('as.Array')).join('\n')}`);
        assert(typrCell?.output.includes('alice is ancestor of eve: TRUE'),
            'generated TypR check query succeeds', typrCell?.output);
        assert(rCell?.output.includes('Descendants of alice:') && !rCell.error,
            'plain R comparison still executes after TypR', rCell?.output);

        console.log('\nAll TypR workbook regressions passed.');
    } finally {
        await browser.close();
    }
})().catch(err => {
    console.error('FAIL:', err.message);
    process.exit(1);
});
