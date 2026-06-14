#!/usr/bin/env bash
# build-package.sh — (re)build the UnifyWeaver SciREPL package into
# www/packages/ as a BUILD ARTIFACT (not tracked in git; distributed as a
# GitHub release asset, and bundled into the APK at build time for offline use).
#
# Requires the UnifyWeaver monorepo checkout:
#   - the parent UnifyWeaver repo (src/unifyweaver, scripts/, examples/)
#   - the UnifyWeaver_Education repo checked out at ../../../education
# Standalone clones won't have these; in that case the app falls back to the
# package release asset (catalog pkg.url), so this step no-ops with a notice.
set -e
SCRIPT="../../../scripts/build_scirepl_package.sh"
# Absolute output path — the build script cd's into a temp staging dir before
# zipping, so a relative path would resolve against that temp dir.
OUT="$(pwd)/www/packages/unifyweaver_scirepl.zip"
if [ -f "$SCRIPT" ]; then
  mkdir -p "$(dirname "$OUT")"
  bash "$SCRIPT" "$OUT"
else
  echo "[build-package] $SCRIPT not found (standalone clone)."
  echo "[build-package] Skipping — fetch the package release asset instead; keeping any existing $OUT."
fi
