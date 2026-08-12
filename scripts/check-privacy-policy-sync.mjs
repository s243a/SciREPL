#!/usr/bin/env node
/**
 * Keep the in-app policy and the separately published Play/GitHub policy in
 * lockstep. Head styling and navigation may differ; only the marked policy
 * body is canonical. Key runtime/network disclosures must also remain exact
 * copies of the reviewed English privacy catalogue used by the app modal.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const POLICY_FILES = ['www/privacy.html', 'docs/privacy.html'];
const START = '<!-- POLICY-CONTENT:START';
const END = '<!-- POLICY-CONTENT:END -->';

function fail(message) {
    console.error('[privacy-policy] ' + message);
    process.exit(1);
}

function readPolicy(relativePath) {
    const html = readFileSync(path.join(ROOT, relativePath), 'utf8');
    const start = html.indexOf(START);
    const startEnd = html.indexOf('-->', start);
    const end = html.indexOf(END, startEnd);
    if (start < 0 || startEnd < 0 || end < 0) {
        fail(`${relativePath} is missing the POLICY-CONTENT markers`);
    }
    return {
        html,
        body: html.slice(startEnd + 3, end).replace(/\r\n/g, '\n').trim(),
    };
}

const policies = Object.fromEntries(POLICY_FILES.map((file) => [file, readPolicy(file)]));
const canonical = policies[POLICY_FILES[0]].body;
for (const file of POLICY_FILES.slice(1)) {
    if (policies[file].body !== canonical) {
        fail(`${file} policy body differs from ${POLICY_FILES[0]}; synchronize the marked body`);
    }
}

const privacy = JSON.parse(readFileSync(
    path.join(ROOT, 'www/i18n/privacy.en.json'),
    'utf8',
)).strings;
const reviewedDisclosures = [
    'privacy.lastUpdated',
    'privacy.scireplBundlesCoreRuntimes',
    'privacy.bundledLanguageRuntimes',
    'privacy.webrRRuntimeFrom',
    'privacy.fengariLuaRuntimeFrom',
    'privacy.docxLibraryFrom',
    'privacy.policyRuntimeVersionChecks',
    'privacy.additionalPackagesFromNetwork',
    'privacy.koFiSupportLink',
    'privacy.allCodeYouEnter',
    'privacy.ifAdditionalLanguageRuntimesAdded',
];

for (const key of reviewedDisclosures) {
    const disclosure = privacy[key];
    if (typeof disclosure !== 'string' || !disclosure) {
        fail(`reviewed English catalogue is missing ${key}`);
    }
    for (const file of POLICY_FILES) {
        if (!policies[file].html.includes(disclosure)) {
            fail(`${file} does not contain the reviewed ${key} disclosure verbatim`);
        }
    }
}

// These were the materially incorrect public claims this check was introduced
// to retire. Positive catalogue checks alone would not catch them being left in
// the page alongside the corrected disclosure.
const staleClaims = [
    /<strong>Pyodide<\/strong>[\s\S]{0,400}Loaded on first launch/i,
    /<strong>SWI-Prolog WASM<\/strong>[\s\S]{0,400}SWI-Prolog\.github\.io/i,
    /Your Python code, session data, and exported files are never transmitted/i,
];
for (const file of POLICY_FILES) {
    for (const claim of staleClaims) {
        if (claim.test(policies[file].html)) {
            fail(`${file} still contains a retired runtime/network claim: ${claim}`);
        }
    }
}

console.log('[privacy-policy] public and in-app policy bodies/disclosures are synchronized — OK');
