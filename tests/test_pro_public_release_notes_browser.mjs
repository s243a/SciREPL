// GitHub Pages-style subpath check; static local files only, no app/provider calls.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, statSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { PRO_NOTE_LOCALES, proNotePath } from '../scripts/render-pro-release-notes.mjs';

const root = fileURLToPath(new URL('../www/', import.meta.url));
const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (!url.pathname.startsWith('/SciREPL/')) { response.writeHead(404).end(); return; }
    let path = resolve(root, '.' + decodeURIComponent(url.pathname.slice('/SciREPL'.length)));
    if (!path.startsWith(root)) { response.writeHead(403).end(); return; }
    try {
        if (statSync(path).isDirectory()) path = resolve(path, 'index.html');
        response.writeHead(200, { 'Content-Type': ({ '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.png': 'image/png' })[extname(path)] || 'application/octet-stream' });
        response.end(readFileSync(path));
    } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
const external = [], pageErrors = [];
await context.route('**/*', route => {
    if (!route.request().url().startsWith(origin + '/')) { external.push(route.request().url()); return route.abort(); }
    return route.continue();
});
const page = await context.newPage();
page.on('pageerror', error => pageErrors.push(String(error)));
let profiles = 0;
try {
    for (const viewport of [{ width: 360, height: 800 }, { width: 800, height: 360 }]) {
        await page.setViewportSize(viewport);
        for (const locale of PRO_NOTE_LOCALES) {
            const route = locale === 'en' ? proNotePath(locale) : `v1.5.0/${locale}/`;
            const response = await page.goto(`${origin}/SciREPL/pro/releases/${route}`);
            assert.equal(response.status(), 200, `${locale}: served from repository subpath`);
            const result = await page.evaluate(() => ({
                lang: document.documentElement.lang,
                dir: document.documentElement.dir,
                overflow: document.documentElement.scrollWidth > innerWidth + 1,
                languages: [...document.querySelectorAll('.release-note-languages a')].map(a => ({
                    text: a.textContent.trim(), href: a.href, h: a.getBoundingClientRect().height,
                })),
                notes: document.querySelector('.notes')?.textContent.trim() || '',
                images: [...document.images].every(image => image.complete && image.naturalWidth > 0),
                draft: document.querySelector('meta[name="scirepl-translation-status"]')?.content,
            }));
            assert.equal(result.lang, locale);
            if (locale === 'ar') assert.equal(result.dir, 'rtl');
            assert.equal(result.overflow, false, `${locale} ${viewport.width}: no horizontal page overflow`);
            assert.equal(result.languages.length, 13);
            assert.ok(result.languages.every(link => link.text && link.h >= 43 && link.href.startsWith(origin + '/SciREPL/pro/releases/')));
            assert.equal(result.images, true, `${locale}: local image loading`);
            if (locale !== 'en') { assert.equal(result.draft, 'draft'); assert.ok(result.notes.includes('Bash') && result.notes.includes('Prolog')); }
            profiles++;
        }
    }
    assert.deepEqual(external, [], 'no external requests from static notes');
    assert.deepEqual(pageErrors, []);
    console.log(`Public Pro notes: ${profiles} portrait/landscape browser profiles passed; no external requests or page errors.`);
} finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
}
