/**
 * Static debug/release identity gate. No Android SDK, device, network, or
 * generated build output is needed; variant merging remains Gradle's job.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RELEASE_ID = 'com.unifyweaver.scirepl';
const DEBUG_ID = `${RELEASE_ID}.debug`;
const read = (relative) => readFileSync(path.join(ROOT, relative), 'utf8');
const withoutXmlComments = (source) => source.replace(/<!--[\s\S]*?-->/g, '');
let checks = 0;

function check(message, test) {
    test();
    checks += 1;
    console.log(`  PASS ${message}`);
}

// Preserve quoted strings when removing comments (including URLs), then find
// balanced Groovy blocks without counting braces inside those strings.
function withoutGroovyComments(source) {
    return source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g,
        (token) => token.startsWith('/') ? token.replace(/[^\n]/g, ' ') : token);
}

function block(source, name) {
    const opening = new RegExp(`\\b${name}\\s*\\{`).exec(source);
    assert.ok(opening, `Missing Gradle ${name} block`);
    const start = opening.index + opening[0].length;
    let depth = 1;
    let quote = null;
    for (let index = start; index < source.length; index += 1) {
        const character = source[index];
        if (quote) {
            if (character === '\\') index += 1;
            else if (character === quote) quote = null;
        } else if (character === '"' || character === "'") quote = character;
        else if (character === '{') depth += 1;
        else if (character === '}' && --depth === 0) return source.slice(start, index);
    }
    assert.fail(`Unclosed Gradle ${name} block`);
}

function attributes(tag) {
    return Object.fromEntries([...tag.matchAll(/([\w:-]+)\s*=\s*(["'])(.*?)\2/g)]
        .map((match) => [match[1], match[3]]));
}

function openingTag(source, name) {
    const tag = withoutXmlComments(source).match(new RegExp(`<${name}\\b[^>]*>`))?.[0];
    assert.ok(tag, `Missing XML ${name} element`);
    return attributes(tag);
}

function strings(source) {
    return Object.fromEntries([...withoutXmlComments(source)
        .matchAll(/<string\b([^>]*)>([\s\S]*?)<\/string\s*>/g)]
        .map((match) => [attributes(match[1]).name, match[2].trim()]));
}

const gradle = withoutGroovyComments(read('android/app/build.gradle'));
const defaultConfig = block(gradle, 'defaultConfig');
const buildTypes = block(gradle, 'buildTypes');
const debugBuild = block(buildTypes, 'debug');
const releaseBuild = block(buildTypes, 'release');
const mainManifest = read('android/app/src/main/AndroidManifest.xml');
const debugManifest = read('android/app/src/debug/AndroidManifest.xml');
const mainStrings = strings(read('android/app/src/main/res/values/strings.xml'));
const debugStrings = strings(read('android/app/src/debug/res/values/strings.xml'));
const mainApplication = openingTag(mainManifest, 'application');
const debugApplication = openingTag(debugManifest, 'application');

check('release package and shared Java namespace remain unchanged', () => {
    assert.match(defaultConfig, /\bapplicationId\s*(?:=\s*)?["']com\.unifyweaver\.scirepl["']/);
    assert.equal([...gradle.matchAll(/\bapplicationId\s*(?:=\s*)?["']/g)].length, 1,
        'Only defaultConfig may set the base applicationId');
    assert.match(gradle, /\bnamespace\s*(?:=\s*)?["']com\.unifyweaver\.scirepl["']/);
});

check('package/version suffixes belong only to the debug build type', () => {
    for (const [property, value] of [['applicationIdSuffix', '.debug'], ['versionNameSuffix', '-debug']]) {
        const declaration = new RegExp(`\\b${property}\\s*(?:=\\s*)?["']([^"']+)["']`, 'g');
        assert.deepEqual([...debugBuild.matchAll(declaration)].map((match) => match[1]), [value]);
        assert.equal([...gradle.matchAll(new RegExp(`\\b${property}\\b`, 'g'))].length, 1,
            `${property} must not affect defaultConfig, release, or other variants`);
        assert.doesNotMatch(releaseBuild, new RegExp(`\\b${property}\\b`));
    }
});

check('debug labels and package resources differ without changing release labels', () => {
    for (const name of ['app_name', 'title_activity_main']) {
        assert.equal(mainStrings[name], 'Sci REPL', `${name} release label changed`);
        assert.equal(debugStrings[name], 'Sci REPL (debug)', `${name} debug label is missing`);
    }
    for (const name of ['package_name', 'custom_url_scheme']) {
        assert.equal(mainStrings[name], RELEASE_ID, `${name} release identity changed`);
        assert.equal(debugStrings[name], DEBUG_ID, `${name} must match the debug applicationId`);
    }
    assert.equal(mainApplication['android:label'], '@string/app_name');
    assert.equal(openingTag(mainManifest, 'activity')['android:label'], '@string/title_activity_main');
});

check('FileProvider authority follows each variant applicationId', () => {
    const providers = [...withoutXmlComments(mainManifest).matchAll(/<provider\b[^>]*>/g)]
        .map((match) => attributes(match[0]));
    const provider = providers.find((entry) => entry['android:name'] === 'androidx.core.content.FileProvider');
    assert.ok(provider, 'Main manifest must retain the FileProvider');
    assert.equal(provider['android:authorities'], '${applicationId}.fileprovider');
    assert.doesNotMatch(withoutXmlComments(debugManifest), /<provider\b/,
        'Debug must inherit the variant-safe FileProvider, not duplicate it');
});

check('manifest icon overrides are debug-only and explicit to the merger', () => {
    assert.equal(mainApplication['android:icon'], '@mipmap/ic_launcher');
    assert.equal(mainApplication['android:roundIcon'], '@mipmap/ic_launcher_round');
    assert.equal(debugApplication['android:icon'], '@mipmap/ic_launcher_debug');
    assert.equal(debugApplication['android:roundIcon'], '@mipmap/ic_launcher_debug_round');
    assert.equal(openingTag(debugManifest, 'manifest')['xmlns:tools'], 'http://schemas.android.com/tools');
    const replaces = new Set((debugApplication['tools:replace'] || '').split(',').map((value) => value.trim()));
    for (const attribute of ['android:icon', 'android:roundIcon']) assert.ok(replaces.has(attribute));
});

function files(directory) {
    if (!existsSync(directory)) return [];
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const absolute = path.join(directory, entry.name);
        return entry.isDirectory() ? files(absolute) : [absolute];
    });
}

// Index source resources, not generated intermediates. For a reference, only
// resources available at that API are eligible; debug wins an exact qualifier
// collision. Density variants are all checked so a missing badge cannot hide
// behind a valid alternative on one device.
const resources = new Map();
for (const sourceSet of ['main', 'debug']) {
    const directory = path.join(ROOT, 'android/app/src', sourceSet, 'res');
    for (const file of files(directory)) {
        const folder = path.basename(path.dirname(file));
        const type = folder.split('-')[0];
        const api = Number(folder.match(/(?:^|-)v(\d+)(?:-|$)/)?.[1] || 1);
        const xml = file.endsWith('.xml') ? withoutXmlComments(readFileSync(file, 'utf8')) : null;
        const add = (resourceType, name, source) => {
            const key = `@${resourceType}/${name}`;
            const entry = { file, sourceSet, folder, api, xml: source };
            const entries = resources.get(key) || [];
            const collision = entries.findIndex((candidate) => candidate.folder === folder);
            if (collision >= 0) entries[collision] = entry;
            else entries.push(entry);
            resources.set(key, entries);
        };
        if (type !== 'values') add(type, path.basename(file).replace(/\.[^.]+$/, ''), xml);
        else for (const match of xml.matchAll(/<(color|drawable|mipmap|dimen|integer|bool|string|item)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1\s*>)/g)) {
            const attrs = attributes(match[2]);
            const resourceType = match[1] === 'item' ? attrs.type : match[1];
            if (resourceType && attrs.name) add(resourceType, attrs.name, match[0]);
        }
    }
}

function reachable(reference, api, ancestors = []) {
    if (reference.startsWith('@android:')) return [];
    const entries = (resources.get(reference) || []).filter((entry) => entry.api <= api);
    assert.ok(entries.length, `${reference} is not resolvable for API ${api}`);
    return entries.flatMap((entry) => reachableEntry(entry, api, ancestors));
}

function reachableEntry(entry, api, ancestors = []) {
    assert.ok(!ancestors.includes(entry.file), `Resource cycle at ${entry.file}`);
    const references = [...(entry.xml || '').matchAll(/@(?:android:)?[a-z]+\/[a-z0-9_]+/g)]
        .map((match) => match[0]);
    return [entry, ...references.flatMap((nested) => reachable(nested, api, [...ancestors, entry.file]))];
}

function hasDebugVector(graph) {
    return graph.some((entry) => entry.sourceSet === 'debug' && /<vector\b/.test(entry.xml || ''));
}

function checkAdaptiveLayers(entry, api) {
    assert.match(entry.xml, /<adaptive-icon\b/);
    for (const layer of ['background', 'foreground']) {
        const reference = openingTag(entry.xml, layer)['android:drawable'];
        assert.ok(reference, `Adaptive ${layer} is missing in ${entry.file}`);
        const graph = reachable(reference, api);
        if (layer === 'foreground') {
            assert.ok(hasDebugVector(graph), `Adaptive foreground must retain debug artwork in ${entry.file}`);
        }
    }
}

check('release launcher resources resolve without any debug artwork', () => {
    for (const reference of ['@mipmap/ic_launcher', '@mipmap/ic_launcher_round']) {
        assert.ok((resources.get(reference) || []).every((entry) => entry.sourceSet === 'main'),
            'Use distinct debug icon names instead of replacing the release resource names');
        for (const api of [23, 26, 33]) {
            assert.ok(reachable(reference, api).every((entry) => entry.sourceSet === 'main'),
                `${reference} must not reference debug-only resources`);
        }
    }
});

for (const name of ['ic_launcher_debug', 'ic_launcher_debug_round']) {
    check(`${name} resolves on legacy and adaptive launchers with debug-only artwork`, () => {
        const reference = `@mipmap/${name}`;
        const entries = resources.get(reference) || [];
        assert.ok(entries.length && entries.every((entry) => entry.sourceSet === 'debug'),
            `${reference} must exist only in src/debug`);
        const legacy = entries.find((entry) => entry.folder === 'mipmap-anydpi');
        assert.ok(legacy, `${name} requires a legacy, unversioned launcher resource`);
        assert.match(legacy.xml, /<(?:vector|layer-list)\b/);
        const adaptive = entries.find((entry) => entry.folder === 'mipmap-anydpi-v26');
        assert.ok(adaptive, `${name} requires an API 26 adaptive launcher resource`);
        assert.ok(hasDebugVector(reachableEntry(legacy, 23)),
            `${name} must include debug-only vector artwork on API 23`);
        checkAdaptiveLayers(adaptive, 26);
        reachableEntry(adaptive, 26);
        // Free declares <monochrome> in the v26 adaptive icon (ignored before
        // API 33); a separate v33 file, if one is added, must keep it too.
        for (const themed of entries.filter((entry) => /^mipmap-anydpi-v(26|33)$/.test(entry.folder))) {
            checkAdaptiveLayers(themed, 33);
            const monochrome = openingTag(themed.xml, 'monochrome')['android:drawable'];
            assert.ok(monochrome, `${name} themed icon must declare monochrome artwork in ${themed.folder}`);
            assert.ok(hasDebugVector(reachable(monochrome, 33)),
                `${name} monochrome artwork must retain its debug distinction`);
            reachableEntry(themed, 33);
        }
    });
}

check('debug badge stays inside the adaptive-icon safe zone (33dp radius)', () => {
    const badge = withoutXmlComments(read('android/app/src/debug/res/drawable/ic_debug_badge.xml'));
    // First path is the disc: "M<cx>,<cy - r>a<r>,<r> ..." with a stroke ring.
    const disc = badge.match(/<path\b[^>]*>/)[0];
    const { 'android:pathData': data, 'android:strokeWidth': stroke = '0' } = attributes(disc);
    const match = data.match(/^M([\d.]+),([\d.]+)a([\d.]+),/);
    assert.ok(match, `Unexpected badge disc path: ${data}`);
    const [cx, top, radius] = match.slice(1).map(Number);
    const cy = top + radius;
    const outer = radius + Number(stroke) / 2;
    const reach = Math.hypot(cx - 54, cy - 54) + outer;
    assert.ok(reach <= 33, `Badge reaches ${reach.toFixed(2)}dp from centre; safe zone is 33dp`);
    assert.ok(cx > 54 && cy > 54, 'Badge belongs in the bottom-right quadrant');
});

console.log(`Android debug identity: ${checks} checks passed`);
