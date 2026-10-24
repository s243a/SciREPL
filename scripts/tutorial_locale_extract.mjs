import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { ROOT, DATA, ROUTES, CHROME, makeUiGlossary, extractPage, sha } from './tutorial_locale_lib.mjs';

const proOption = process.argv.indexOf('--pro-i18n-root');
const proRoot = proOption >= 0 ? process.argv[proOption + 1] : undefined;
const ui = makeUiGlossary(proRoot);
const pages = ROUTES.map(route => extractPage(route, readFileSync(path.join(ROOT, 'www', 'help', route, 'index.html'), 'utf8'), ui));
const chrome = Object.entries(CHROME).map(([key, text]) => ({ id: `chrome.${key}`, text, protectedSpans: [] }));
const manifest = { schema: 1, sourceLocale: 'en', locales: ['en', 'ar', 'bn', 'de', 'es', 'fr', 'hi', 'id', 'ja', 'ko', 'pt-BR', 'ru', 'zh'], pages, chrome };
manifest.manifestHash = sha(JSON.stringify(manifest));
mkdirSync(DATA, { recursive: true });
writeFileSync(path.join(DATA, 'source.json'), JSON.stringify(manifest, null, 2) + '\n');
const fields = [...pages.flatMap(page => page.fields), ...chrome];
console.log(JSON.stringify({ pages: pages.length, fields: fields.length, sourceCharacters: fields.reduce((total, field) => total + field.text.length, 0), estimatedTokens: Math.ceil(fields.reduce((total, field) => total + field.text.length, 0) / 4), manifestHash: manifest.manifestHash }, null, 2));
