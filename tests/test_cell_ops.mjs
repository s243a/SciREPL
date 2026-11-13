// Playwright test: verify cell delete and reorder (move up/down)
import { chromium } from 'playwright';

const TIMEOUT = 120_000;
const PORT = process.env.PORT || 8085;
const URL = `http://localhost:${PORT}/`;

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  const consoleLogs = [];
  page.on('console', msg => consoleLogs.push(`[${msg.type()}] ${msg.text()}`));
  page.on('pageerror', err => consoleLogs.push(`[PAGE ERROR] ${err.message}`));

  let allPassed = true;
  const results = [];
  const testLog = (name, passed, detail) => {
    const mark = passed ? 'PASS' : 'FAIL';
    if (!passed) allPassed = false;
    results.push({ name, passed, detail });
    console.log(`  [${mark}] ${name}${detail ? ': ' + detail : ''}`);
  };

  try {
    console.log('1. Navigating to SciREPL...');

    const context = browser.contexts()[0];
    await context.addInitScript(() => {
      localStorage.setItem('scirepl_privacy_accepted', '1');
      localStorage.setItem('scirepl_onboarding_seen', '1');
      addEventListener('DOMContentLoaded', () => localStorage.setItem(
          'scirepl_whats_new_seen_version', window.KERNEL_CONFIG.app.version), { once: true });
      localStorage.setItem('scirepl_auto_download', '1');
    });

    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });

    // Wait for app to be ready (kernels are lazy-loaded, no need to wait for Pyodide)
    console.log('   Waiting for app...');
    await page.waitForFunction(() => {
      return window.kernelManager && window._cells !== undefined && document.getElementById('run-btn');
    }, { timeout: 30000 });

    // Helper: execute code via kernel manager and wait for cells to render
    async function executeCell(code, lang = 'python') {
      return await page.evaluate(async ({ code, lang }) => {
        const km = window.kernelManager;
        await km.ensureReady(lang);
        return await km.execute(code, lang);
      }, { code, lang });
    }

    // Helper: run code via the input bar (creates cells in the UI)
    async function runFromInputBar(code) {
      const prevCount = await page.evaluate(() => window._cells.length);
      await page.fill('#code-input', code);
      await page.click('#run-btn');
      // Wait for cell count to increase (first call may trigger kernel download)
      await page.waitForFunction(
        (expected) => window._cells.length >= expected,
        prevCount + 1,
        { timeout: TIMEOUT }
      );
      await page.waitForTimeout(200);
    }

    // --- Test: UI elements present ---

    console.log('2. Testing cell UI elements...');

    await runFromInputBar('1 + 1');
    await page.waitForTimeout(1000);

    const hasDeleteBtn = await page.evaluate(() => {
      const card = document.querySelector('.card-input');
      return card && card.querySelector('.cell-delete-btn') !== null;
    });
    testLog('Delete button present on cell', hasDeleteBtn);

    const hasDragHandle = await page.evaluate(() => {
      const card = document.querySelector('.card-input');
      return card && card.querySelector('.cell-drag-handle') !== null;
    });
    testLog('Drag handle present on cell', hasDragHandle);

    const hasMoveUp = await page.evaluate(() => {
      const card = document.querySelector('.card-input');
      return card && card.querySelector('.cell-move-up') !== null;
    });
    testLog('Move up button present on cell', hasMoveUp);

    const hasMoveDown = await page.evaluate(() => {
      const card = document.querySelector('.card-input');
      return card && card.querySelector('.cell-move-down') !== null;
    });
    testLog('Move down button present on cell', hasMoveDown);

    // --- Test: Delete cell ---

    console.log('3. Testing cell deletion...');

    // Create 2 more cells (total 3)
    await runFromInputBar('2 + 2');
    await page.waitForTimeout(500);
    await runFromInputBar('3 + 3');
    await page.waitForTimeout(500);

    const beforeCount = await page.evaluate(() => window._cells.length);
    testLog('3 cells created', beforeCount === 3, `count=${beforeCount}`);

    // Delete the middle cell (index 1)
    const deletedId = await page.evaluate(() => {
      const cellId = window._cells[1].id;
      window.deleteCell(cellId);
      return cellId;
    });

    const afterDeleteCount = await page.evaluate(() => window._cells.length);
    testLog('Cell deleted (3 → 2)', afterDeleteCount === 2, `count=${afterDeleteCount}`);

    const deletedStillInDOM = await page.evaluate((id) => {
      return document.querySelector(`.card-input[data-cell-id="${id}"]`) !== null;
    }, deletedId);
    testLog('Deleted cell removed from DOM', !deletedStillInDOM);

    // --- Test: Move cell up/down ---

    console.log('4. Testing cell reordering...');

    // Add a third cell back
    await runFromInputBar('4 + 4');
    await page.waitForTimeout(500);

    const cellsBefore = await page.evaluate(() =>
      window._cells.map(c => ({ id: c.id, code: c.code }))
    );
    testLog('3 cells for reorder test', cellsBefore.length === 3, JSON.stringify(cellsBefore.map(c => c.code)));

    // Move last cell up
    const lastId = await page.evaluate(() => {
      const lastCell = window._cells[window._cells.length - 1];
      window.moveCellUp(lastCell.id);
      return lastCell.id;
    });

    const cellsAfterMoveUp = await page.evaluate(() =>
      window._cells.map(c => ({ id: c.id, code: c.code }))
    );
    testLog('Move up: last cell moved to middle',
      cellsAfterMoveUp[1].id === lastId,
      `order: ${cellsAfterMoveUp.map(c => c.code).join(', ')}`);

    // Move first cell down
    const firstId = await page.evaluate(() => {
      const firstCell = window._cells[0];
      window.moveCellDown(firstCell.id);
      return firstCell.id;
    });

    const cellsAfterMoveDown = await page.evaluate(() =>
      window._cells.map(c => ({ id: c.id, code: c.code }))
    );
    testLog('Move down: first cell moved to middle',
      cellsAfterMoveDown[1].id === firstId,
      `order: ${cellsAfterMoveDown.map(c => c.code).join(', ')}`);

    // --- Test: Move boundaries ---

    console.log('5. Testing move boundary conditions...');

    // Move first cell up (should be no-op)
    const firstBefore = await page.evaluate(() => {
      const codes = window._cells.map(c => c.code);
      window.moveCellUp(window._cells[0].id);
      return { before: codes, after: window._cells.map(c => c.code) };
    });
    testLog('Move up at top is no-op',
      JSON.stringify(firstBefore.before) === JSON.stringify(firstBefore.after));

    // Move last cell down (should be no-op)
    const lastBefore = await page.evaluate(() => {
      const codes = window._cells.map(c => c.code);
      window.moveCellDown(window._cells[window._cells.length - 1].id);
      return { before: codes, after: window._cells.map(c => c.code) };
    });
    testLog('Move down at bottom is no-op',
      JSON.stringify(lastBefore.before) === JSON.stringify(lastBefore.after));

    // --- Test: DOM order matches array order ---

    console.log('6. Testing DOM order consistency...');

    const domOrder = await page.evaluate(() => {
      const inputCards = document.querySelectorAll('.card-input');
      return Array.from(inputCards).map(c => parseInt(c.dataset.cellId));
    });
    const arrayOrder = await page.evaluate(() => window._cells.map(c => c.id));
    testLog('DOM order matches _cells array order',
      JSON.stringify(domOrder) === JSON.stringify(arrayOrder),
      `DOM=${JSON.stringify(domOrder)}, array=${JSON.stringify(arrayOrder)}`);

    // --- Test: Delete all cells ---

    console.log('7. Testing delete all cells...');

    await page.evaluate(() => {
      while (window._cells.length > 0) {
        window.deleteCell(window._cells[0].id);
      }
    });
    const emptyCount = await page.evaluate(() => window._cells.length);
    const emptyDOM = await page.evaluate(() => document.querySelectorAll('.card-input').length);
    testLog('All cells deleted', emptyCount === 0 && emptyDOM === 0,
      `cells=${emptyCount}, DOM=${emptyDOM}`);

    console.log('8. Testing immediate output persistence...');
    await page.selectOption('#lang-selector', 'javascript');
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ9sAAAAASUVORK5CYII=';
    async function runAndReadSnapshot(code) {
      await page.fill('#code-input', code);
      await page.click('#run-btn');
      await page.waitForFunction(code => window._cells.at(-1)?.code === code
        && window._currentOutputCard === null && document.getElementById('code-input').value === '', code);
      // Read the serialized snapshot before any later action or unload can save again.
      return page.evaluate(code => {
        const cell = window._cells.at(-1);
        const body = cell.outputCard?.querySelector('.card-body');
        const session = JSON.parse(localStorage.getItem(window.sessionManager.STORAGE_KEY));
        const notebook = session.notebooks.find(nb => nb.id === session.activeNotebookId);
        const pick = cells => cells?.find(item => item.code === code);
        return {
          rendered: body ? { text: body.textContent, html: body.innerHTML } : null,
          saved: pick(session.cells),
          notebookCount: session.notebooks.length,
          notebookSaved: pick(notebook?.cells),
        };
      }, code);
    }
    const matches = (saved, rendered) => Boolean(saved && rendered
      && saved.lastOutput === rendered.text && saved.lastOutputHtml === rendered.html);
    const single = await runAndReadSnapshot('console.log("single-save-marker");');
    testLog('Single-notebook text is persisted as soon as Run finishes',
      single.rendered?.text === 'single-save-marker' && matches(single.saved, single.rendered));

    await page.evaluate(() => {
      const manager = window.notebookManager;
      const scratch = manager.createNotebook({ name: 'Output persistence' });
      manager.switchTo(scratch.id);
    });
    const multi = await runAndReadSnapshot(`window.renderImage(${JSON.stringify(png)}); console.log("plot-save-marker");`);
    testLog('Text and inline image are immediately persisted in both snapshots',
      multi.notebookCount === 2 && multi.rendered?.text === 'plot-save-marker'
      && multi.rendered.html.includes(png) && matches(multi.saved, multi.rendered)
      && matches(multi.notebookSaved, multi.rendered));

    const empty = await runAndReadSnapshot('const no_output_expected = 1;');
    testLog('Empty output removes the output card but still saves the code',
      !empty.rendered && empty.saved?.lastOutput === '' && empty.saved?.lastOutputHtml === ''
      && empty.notebookSaved?.lastOutput === '' && empty.notebookSaved?.lastOutputHtml === '');

    await page.evaluate(() => {
      const manager = window.kernelManager;
      const original = manager.execute;
      manager.execute = async function (...args) {
        this.execute = original;
        throw new Error('handled-run-error-marker');
      };
    });
    const error = await runAndReadSnapshot('console.log("unreachable");');
    testLog('A handled execution error is immediately persisted with the cell',
      error.rendered?.text === 'handled-run-error-marker' && matches(error.saved, error.rendered)
      && matches(error.notebookSaved, error.rendered));

    // --- Summary ---
    console.log('\n' + '='.repeat(50));
    const passCount = results.filter(r => r.passed).length;
    console.log(`Results: ${passCount}/${results.length} passed`);
    console.log(allPassed ? '\nPASS: All cell operation tests passed!' : '\nFAIL: Some tests failed');

  } catch (err) {
    console.error('FATAL:', err.message);
    console.error('Console logs:', consoleLogs.slice(-15).join('\n'));
    allPassed = false;
  } finally {
    await browser.close();
    process.exit(allPassed ? 0 : 1);
  }
})();
