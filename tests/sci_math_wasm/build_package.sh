#!/bin/bash
# Build the sci_math WASM module and package it as test_wasm_pkg.zip
# Usage: ./build_package.sh [output_dir]
#
# Prerequisites:
#   rustup target add wasm32-unknown-unknown

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OUTPUT_DIR="${1:-$(dirname "$(dirname "$SCRIPT_DIR")")}"

echo "=== Building sci_math WASM ==="
cd "$SCRIPT_DIR"
cargo build --release --target wasm32-unknown-unknown

WASM_FILE="$SCRIPT_DIR/target/wasm32-unknown-unknown/release/sci_math.wasm"

if [ ! -f "$WASM_FILE" ]; then
    echo "ERROR: Build failed — $WASM_FILE not found"
    exit 1
fi

echo "   WASM size: $(du -h "$WASM_FILE" | cut -f1)"

# Optional: strip debug info
if command -v wasm-strip &>/dev/null; then
    wasm-strip "$WASM_FILE"
    echo "   Stripped:  $(du -h "$WASM_FILE" | cut -f1)"
fi

echo "=== Packaging ==="
STAGING=$(mktemp -d)
mkdir -p "$STAGING/wasm"
cp "$WASM_FILE" "$STAGING/wasm/sci_math.wasm"

cat > "$STAGING/scirepl.json" <<'EOF'
{
  "format_version": "2.0",
  "name": "sci_math",
  "version": "0.1.0",
  "description": "A toy Rust WASM library — add, multiply, fibonacci, factorial, stats",
  "wasm_modules": [
    {
      "name": "sci_math",
      "file": "wasm/sci_math.wasm",
      "exports": ["add", "multiply", "fibonacci", "factorial", "stats", "list_functions"],
      "ffi": "json"
    }
  ]
}
EOF

PKG_PATH="$OUTPUT_DIR/test_wasm_pkg.zip"
cd "$STAGING"
zip -r "$PKG_PATH" scirepl.json wasm/

rm -rf "$STAGING"

echo "=== Done ==="
echo "Package: $PKG_PATH"
echo "Size:    $(du -h "$PKG_PATH" | cut -f1)"
