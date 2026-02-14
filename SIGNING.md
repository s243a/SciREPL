# APK Signing Guide

This document describes how to properly sign the SciREPL APK for distribution on Android devices.

## Prerequisites

Install the required tools on Ubuntu/Debian:

```bash
sudo apt update
sudo apt install zipalign apksigner
```

**Important:** You need **both** tools:
- `zipalign` - Optimizes APK file alignment (required for Android 11+)
- `apksigner` - Signs with APK Signature Schemes v1/v2/v3 (required for modern Android)

## Signing Process

### Step 1: Generate Keystore (One-time setup)

```bash
keytool -genkey -v \
  -keystore scirepl-release.keystore \
  -alias scirepl \
  -keyalg RSA \
  -keysize 2048 \
  -validity 10000
```

**⚠️ CRITICAL:** Backup this keystore file securely! If you lose it, you cannot update your app.

### Step 2: Download Unsigned APK

From [GitHub Releases](https://github.com/s243a/SciREPL/releases), download the unsigned APK (e.g., `SciREPL-v0.1.1-unsigned.apk`).

### Step 3: Zipalign FIRST

```bash
zipalign -f -v 4 SciREPL-v0.1.1-unsigned.apk SciREPL-v0.1.1-aligned.apk
```

**Verify alignment:**
```bash
zipalign -c -v 4 SciREPL-v0.1.1-aligned.apk
```

You should see `Verification successful`.

### Step 4: Sign with apksigner

```bash
apksigner sign \
  --ks scirepl-release.keystore \
  --ks-key-alias scirepl \
  --ks-pass pass:YOUR_PASSWORD \
  --key-pass pass:YOUR_PASSWORD \
  --out SciREPL-v0.1.1-final.apk \
  SciREPL-v0.1.1-aligned.apk
```

**Verify signature:**
```bash
apksigner verify --verbose SciREPL-v0.1.1-final.apk
```

You should see:
```
Verifies
Verified using v1 scheme (JAR signing): true
Verified using v2 scheme (APK Signature Scheme v2): true
Verified using v3 scheme (APK Signature Scheme v3): true
```

### Step 5: Install

```bash
adb install SciREPL-v0.1.1-final.apk
```

---

## Common Issues & Solutions

### ❌ Error: `INSTALL_PARSE_FAILED_NO_CERTIFICATES`

**Problem:** APK was signed with `jarsigner` instead of `apksigner`.

**Solution:** Use `apksigner` (see Step 4 above). Modern Android requires APK Signature Scheme v2 or v3, which `jarsigner` does not provide.

---

### ❌ Error: `Failed parse during installPackageLI: ... resources.arsc ... aligned on a 4-byte boundary`

**Problem:** APK was not zipaligned, or was signed before zipaligning.

**Solution:** 
1. **Always** zipalign first (Step 3)
2. **Then** sign (Step 4)
3. **Never** zipalign after signing - it breaks the signature

---

### ❌ Error: `INSTALL_FAILED_UPDATE_INCOMPATIBLE: ... signatures do not match`

**Problem:** Trying to update an app that was signed with a different key.

**Solution:**
```bash
# Uninstall old version first
adb uninstall com.unifyweaver.scirepl

# Then install new version
adb install SciREPL-v0.1.1-final.apk
```

---

### ❌ Error: `zipalign: command not found`

**Problem:** `zipalign` is not installed.

**Solution:**
```bash
sudo apt install zipalign
```

---

### ❌ Error: `apksigner: command not found`

**Problem:** `apksigner` is not installed.

**Solution:**
```bash
sudo apt install apksigner
```

---

## Correct Order Summary

✅ **RIGHT:**
```
1. Download unsigned APK
2. Zipalign
3. Sign with apksigner
4. Install
```

❌ **WRONG:**
```
1. Download unsigned APK
2. Sign with jarsigner       ← Wrong tool (v1 only)
3. Zipalign                   ← Too late (breaks signature)
4. Install                    ← Will fail
```

---

## Automation (Future Enhancement)

For fully automated signing in GitHub Actions, you would need to:
1. Convert keystore to base64 and store as GitHub Secret
2. Update `.github/workflows/build-release.yml` to decode and sign
3. Use `apksigner` instead of manual signing

This is not currently implemented to keep the signing key fully local for security.
