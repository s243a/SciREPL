// DOCX export uses the library bundled with the app and makes no third-party
// request. Every non-same-origin request is blocked and recorded: the library
// must still load from www/vendor/docx and produce a document.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const BASE = (process.env.SCIREPL_TEST_BASE || `http://localhost:${process.env.PORT || 8085}/`).replace(/\/?$/, '/');
const origin = new URL(BASE).origin;

const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  await context.addInitScript(() => {
    localStorage.setItem('scirepl_onboarding_seen', '1');
    addEventListener('DOMContentLoaded', () => localStorage.setItem('scirepl_whats_new_seen_version', window.KERNEL_CONFIG.app.version), { once: true });
  });
  const page = await context.newPage();
  const external = [];
  const docxScripts = [];
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => { if (/docx/i.test(request.url()) && request.resourceType() === 'script') docxScripts.push(request.url()); });
  await page.route('**/*', (route) => {
    const url = route.request().url();
    if (new URL(url).origin !== origin) { external.push(url); return route.abort(); }
    return route.continue();
  });

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.exportManager && window.KERNEL_CONFIG);

  const delivery = await page.evaluate(() => window.KERNEL_CONFIG.components.docx);
  assert.equal(delivery.delivery.kind, 'bundled', 'docx is declared bundled');
  assert.deepEqual(delivery.sources, [], 'docx has no download sources');

  const result = await page.evaluate(async () => {
    await window.exportManager._loadDocxLibrary();
    const { Document, Packer, Paragraph, TextRun } = window.docx;
    const doc = new Document({ sections: [{ children: [new Paragraph({ children: [new TextRun('SciREPL bundled DOCX')] })] }] });
    const blob = await Packer.toBlob(doc);
    const head = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
    return { size: blob.size, zip: String.fromCharCode(...head) };
  });
  assert.ok(result.size > 1000, `a DOCX document is produced (${result.size} bytes)`);
  assert.equal(result.zip, 'PK', 'the output is a ZIP (DOCX) container');
  assert.deepEqual(docxScripts, [new URL('vendor/docx/docx.iife.js', BASE).href], 'the library loads once, from the bundled path');
  assert.deepEqual(external.filter((url) => /docx|jsdelivr|unpkg/i.test(url)), [], 'no DOCX-related third-party request');
  assert.deepEqual(errors, [], 'no page errors');
  console.log(`DOCX bundled export: library from ${docxScripts[0]}, ${result.size}-byte document, no third-party DOCX request.`);
} finally {
  await browser.close();
}
