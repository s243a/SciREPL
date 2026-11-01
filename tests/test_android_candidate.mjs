// Offline fixtures: no downloads, SDK builds, signing, device access or uploads.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { BUNDLETOOL, apkSigningBlock, bundleManifest, checkApkBadging, checkBundleManifest, entryProblems, fetchBundletool, inspectArchive, parseArgs, releaseIdentity, sourceFiles, validateCandidate, verifyBundletool } from '../scripts/validate-android-candidate.mjs';

const require = createRequire(import.meta.url);
const JSZip = require('../www/vendor/jszip/jszip.min.js');
const temporary = mkdtempSync(path.join(tmpdir(), 'scirepl-android-candidate-'));
let checks = 0;
function verify(name, run) { return Promise.resolve().then(run).then(() => { checks++; console.log(`PASS ${name}`); }); }
const identity = { packageName: 'com.unifyweaver.scirepl', version: '1.5.0', code: 17, targetSdk: 36, compileSdk: 36 };
const xml = '<manifest package="com.unifyweaver.scirepl" android:versionName="1.5.0" android:versionCode="17" android:compileSdkVersion="36"><uses-sdk android:minSdkVersion="23" android:targetSdkVersion="36" /></manifest>';
const badging = "package: name='com.unifyweaver.scirepl' versionCode='17' versionName='1.5.0' compileSdkVersion='36'\nsdkVersion:'23'\ntargetSdkVersion:'36'\n";

function put(relative, bytes) {
  const file = path.join(temporary, relative);
  mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, bytes); return file;
}
const sources = {
  'index.html': '<title>Free candidate</title>',
  'js/kernel_config.js': 'window.KERNEL_CONFIG = {"profile":"full"};',
  'sw.js': "const CACHE_VERSION = 'v231';",
  'pro/index.html': '<title>Public Pro marketing is allowed</title>',
};
for (const [file, text] of Object.entries(sources)) put(`www/${file}`, text);
const expected = sourceFiles(path.join(temporary, 'www'));
async function archive(kind, name, changes = {}) {
  const zip = new JSZip();
  const prefix = kind === 'aab' ? 'base/assets/public/' : 'assets/public/';
  for (const [file, text] of Object.entries(sources)) zip.file(prefix + file, text);
  if (kind === 'aab') {
    zip.file('BundleConfig.pb', 'fixture'); zip.file('base/manifest/AndroidManifest.xml', 'fixture'); zip.file('base/dex/classes.dex', 'fixture');
  } else { zip.file('AndroidManifest.xml', 'fixture'); zip.file('classes.dex', 'fixture'); }
  for (const [file, text] of Object.entries(changes)) {
    if (text === null) zip.remove(file); else zip.file(file, text);
  }
  return put(name, await zip.generateAsync({ type: 'nodebuffer' }));
}

try {
  await verify('manifest requires exact Free identity and checked-in API 36', () => {
    checkBundleManifest(xml, identity);
    for (const [before, after, message] of [
      ['com.unifyweaver.scirepl', 'com.unifyweaver.scirepl.pro', /package/],
      ['com.unifyweaver.scirepl', 'com.unifyweaver.scirepl.debug', /package/],
      ['android:versionName="1.5.0"', 'android:versionName="1.4.0"', /version name/],
      ['android:versionCode="17"', 'android:versionCode="16"', /version code/],
      ['android:targetSdkVersion="36"', 'android:targetSdkVersion="35"', /target SDK/],
      ['android:compileSdkVersion="36"', 'android:compileSdkVersion="35"', /compile SDK/],
    ]) assert.throws(() => checkBundleManifest(xml.replace(before, after), identity), message);
    assert.throws(() => checkBundleManifest('<manifest/>', identity), /package/);
  });
  await verify('APK badging independently requires matching Free release identity', () => {
    checkApkBadging(badging, identity);
    assert.throws(() => checkApkBadging(badging.replace("versionCode='17'", "versionCode='16'"), identity), /identity/);
    assert.throws(() => checkApkBadging(badging.replace("targetSdkVersion:'36'", "targetSdkVersion:'35'"), identity), /target SDK/);
    assert.throws(() => checkApkBadging(badging.replace('com.unifyweaver.scirepl', 'com.unifyweaver.scirepl.debug'), identity), /package/);
  });
  await verify('source metadata enforces release channel and minimum target/compile SDK', () => {
    put('package.json', JSON.stringify({ version: '1.5.0', android: { versionCode: 17 }, releaseChannel: 'release' }));
    put('android/variables.gradle', 'targetSdkVersion = 36\ncompileSdkVersion = 36\n');
    assert.deepEqual(releaseIdentity(temporary), identity);
    put('android/variables.gradle', 'targetSdkVersion = 35\ncompileSdkVersion = 36\n');
    assert.throws(() => releaseIdentity(temporary), /at least 36/);
  });
  await verify('the development-only tool is pinned by official release size and SHA-256', async () => {
    assert.equal(BUNDLETOOL.version, '1.18.3');
    assert.match(BUNDLETOOL.url, /^https:\/\/github\.com\/google\/bundletool\/releases\/download\/1\.18\.3\//);
    assert.match(BUNDLETOOL.sha256, /^[a-f0-9]{64}$/);
    const wrong = put('wrong-bundletool.jar', 'not a jar');
    assert.throws(() => verifyBundletool(wrong), /pinned official release/);
    await assert.rejects(() => fetchBundletool(wrong), /pinned official release/);
    assert.equal(readFileSync(wrong, 'utf8'), 'not a jar', 'never overwrite an existing mismatched tool');
  });
  await verify('missing AAB fails before commands, even if an APK exists', async () => {
    let commands = 0;
    await assert.rejects(() => validateCandidate({ root: temporary, aab: path.join(temporary, 'absent.aab'), run() { commands++; } }), /AAB is missing/);
    assert.equal(commands, 0);
  });
  await verify('bundletool validation failure propagates before manifest inspection', () => {
    const calls = [];
    assert.throws(() => bundleManifest('bad.aab', 'tool.jar', (program, args) => {
      calls.push({ program, args }); throw new Error('fixture: bundletool validation failed');
    }), /bundletool validation failed/);
    assert.equal(calls.length, 1); assert.equal(calls[0].args[2], 'validate');
  });
  await verify('both bundletool validate and base-manifest dump are mandatory', () => {
    const calls = [];
    const result = bundleManifest('ok.aab', 'tool.jar', (program, args) => { calls.push(args); return args[2] === 'dump' ? xml : ''; });
    assert.equal(result, xml); assert.equal(calls.length, 2);
    assert.ok(calls[1].includes('--module=base'));
  });
  await verify('complete AAB web assets match byte for byte, including public marketing', async () => {
    const file = await archive('aab', 'valid.aab');
    const result = await inspectArchive(file, 'aab', expected);
    assert.equal(result.publicAssets, Object.keys(sources).length);
  });
  await verify('missing or changed packaged web assets fail closed', async () => {
    const missing = await archive('aab', 'missing.aab', { 'base/assets/public/sw.js': null });
    await assert.rejects(() => inspectArchive(missing, 'aab', expected), /missing.*sw\.js/);
    const changed = await archive('aab', 'changed.aab', { 'base/assets/public/index.html': 'x'.repeat(sources['index.html'].length) });
    await assert.rejects(() => inspectArchive(changed, 'aab', expected), /bytes differ.*index\.html/);
    const unexpected = await archive('aab', 'unexpected.aab', { 'base/assets/public/extra.js': 'unexpected' });
    await assert.rejects(() => inspectArchive(unexpected, 'aab', expected), /Unexpected packaged web asset/);
  });
  await verify('native Pro modules, models, bundled R, signatures and duplicate/unsafe entries fail', () => {
    for (const names of [
      ['localmodel/manifest/AndroidManifest.xml'], ['qwen_coder_05b/assets/model.gguf'],
      ['anotherfeature/manifest/AndroidManifest.xml'],
      ['base/assets/public/vendor/webr/webr.mjs'], ['base/lib/arm64-v8a/libllama.so'],
      ['META-INF/UPLOAD.RSA'], ['x', 'x'], ['base/assets/public/../escape'],
    ]) assert.ok(entryProblems(names, 'aab').length, names.join(','));
    assert.deepEqual(entryProblems(['base/assets/public/pro/index.html'], 'aab'), []);
  });
  await verify('real archive with forbidden Pro entries fails, not just the pure layout helper', async () => {
    const model = await archive('aab', 'model.aab', { 'qwen_coder_05b/assets/model.gguf': 'model' });
    await assert.rejects(() => inspectArchive(model, 'aab', expected), /Pro runtime\/model content/);
    const signed = await archive('aab', 'signed.aab', { 'META-INF/UPLOAD.SF': 'signature' });
    await assert.rejects(() => inspectArchive(signed, 'aab', expected), /JAR-signed/);
  });
  await verify('unsigned APK layout passes and APK signing blocks are rejected', async () => {
    const file = await archive('apk', 'valid.apk');
    assert.equal(apkSigningBlock(file), false);
    assert.equal((await inspectArchive(file, 'apk', expected)).publicAssets, Object.keys(sources).length);
    const bytes = readFileSync(file), end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    const central = bytes.readUInt32LE(end + 16), magic = Buffer.alloc(32);
    magic.write('APK Sig Block 42', 16, 'ascii');
    const signed = Buffer.concat([bytes.subarray(0, central), magic, bytes.subarray(central)]);
    signed.writeUInt32LE(central + magic.length, end + magic.length + 16);
    const signedPath = put('apk-v2.apk', signed);
    assert.equal(apkSigningBlock(signedPath), true);
    await assert.rejects(() => inspectArchive(signedPath, 'apk', expected), /APK v2\/v3 signing block/);
  });
  await verify('CLI rejects missing/failing inputs and download mode cannot bypass validation', () => {
    const cli = fileURLToPath(new URL('../scripts/validate-android-candidate.mjs', import.meta.url));
    for (const args of [[], ['--aab', path.join(temporary, 'absent.aab')], ['--unknown'], ['--fetch-bundletool', 'x', '--aab', 'y']]) {
      const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
      assert.notEqual(result.status, 0); assert.equal(result.stdout, '');
    }
    assert.throws(() => parseArgs(['--aab']), /needs a path/);
  });
} finally { rmSync(temporary, { recursive: true, force: true }); }
console.log(`Android candidate: ${checks} offline validation groups passed.`);
