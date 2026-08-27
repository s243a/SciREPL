# Play Store Release Signing

Google Play releases should be uploaded as Android App Bundles (`.aab`), not APKs. The Gradle release build reads signing details from either:

- `android/release-signing.properties` (local, ignored by git)
- environment variables (`SCIREPL_RELEASE_STORE_FILE`, `SCIREPL_RELEASE_STORE_PASSWORD`, `SCIREPL_RELEASE_KEY_ALIAS`, `SCIREPL_RELEASE_KEY_PASSWORD`)

## One-time upload key setup

Create or copy the upload key into `signing/`:

```bash
mkdir -p signing
keytool -genkeypair -v \
  -keystore signing/scirepl-release.keystore \
  -alias scirepl \
  -keyalg RSA \
  -keysize 4096 \
  -validity 10000
```

Back up the keystore and passwords. Google Play can reset an upload key if Play App Signing is enabled, but losing local signing material still blocks releases until reset is complete.

## Local signing properties

```bash
cp android/release-signing.properties.example android/release-signing.properties
```

Edit `android/release-signing.properties`:

```properties
storeFile=../signing/scirepl-release.keystore
storePassword=...
keyAlias=scirepl
keyPassword=...
```

## Build the Play bundle

From the repo root:

```bash
npm run build:play
```

Output:

```text
android/app/build/outputs/bundle/release/app-release.aab
```

If signing properties are present, the bundle is signed and ready for Play Console upload. If signing properties are absent, Gradle creates an unsigned release bundle that is useful for verification only.

## Free vs Pro package IDs

- Free: `com.unifyweaver.scirepl`
- Pro: `com.unifyweaver.scirepl.pro`

These must stay distinct in Play Console. Each app also needs a monotonically increasing `android.versionCode` in `package.json` for every uploaded release; the Android Gradle build reads it from there.

## APK side-loading

APK builds remain useful for local testing:

```bash
npm run build:release:apk
```

For Play Store distribution, upload the signed `.aab`.
