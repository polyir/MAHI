#!/usr/bin/env bash
# sherpa-rs-sys links vibe-coder against libonnxruntime and
# libsherpa-onnx-c-api via @rpath, but the built binary has no LC_RPATH
# entries and Tauri's bundler doesn't know to copy these sibling .dylibs
# into the .app — without this script the packaged app fails to launch at
# all with "Library not loaded" (confirmed empirically after the first
# real build of the local-AI-models feature). Run this after `tauri build`.
set -euo pipefail

PROFILE="${1:-release}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET_DIR="$REPO_ROOT/target/$PROFILE"
APP="$TARGET_DIR/bundle/macos/MAHI.app"
MACOS_DIR="$APP/Contents/MacOS"

if [ ! -d "$APP" ]; then
  echo "fix-native-libs: $APP not found — build the app first" >&2
  exit 1
fi

LIBS=(libonnxruntime.1.17.1.dylib libsherpa-onnx-c-api.dylib)

for lib in "${LIBS[@]}"; do
  cp -f "$TARGET_DIR/$lib" "$MACOS_DIR/$lib"
done

# Point every @rpath reference to these libs at @executable_path instead
# (the directory containing the running binary — Contents/MacOS itself),
# both in the main binary and in the libs that reference each other.
BINARY="$MACOS_DIR/vibe-coder"
for lib in "${LIBS[@]}"; do
  install_name_tool -change "@rpath/$lib" "@executable_path/$lib" "$BINARY"
done
install_name_tool -change "@rpath/libonnxruntime.1.17.1.dylib" "@executable_path/libonnxruntime.1.17.1.dylib" \
  "$MACOS_DIR/libsherpa-onnx-c-api.dylib"

# Rewriting load commands invalidates the signature. Distribution builds must
# be signed again with the publisher's stable Developer ID identity; otherwise
# macOS treats every update as a different app and drops TCC permissions.
IDENTITY="${MAHI_CODESIGN_IDENTITY:-${APPLE_SIGNING_IDENTITY:-}}"
if [ -z "$IDENTITY" ]; then
  IDENTITY="$(security find-identity -v -p codesigning 2>/dev/null \
    | sed -n 's/.*"\(Developer ID Application:[^"]*\)".*/\1/p' \
    | head -n 1)"
fi
if [ -z "$IDENTITY" ] && security find-identity -v -p codesigning 2>/dev/null \
  | grep -Fq '"MAHI Local Distribution"'; then
  IDENTITY="MAHI Local Distribution"
fi

if [ "${MAHI_REQUIRE_DISTRIBUTION_SIGNING:-0}" = "1" ]; then
  if [[ "$IDENTITY" != Developer\ ID\ Application:* ]] \
    && [ "$IDENTITY" != "MAHI Local Distribution" ]; then
    echo "fix-native-libs: a stable Developer ID or MAHI local distribution identity is required" >&2
    exit 1
  fi
fi

if [ -z "$IDENTITY" ]; then
  IDENTITY="-"
fi

xattr -cr "$APP"
for lib in "${LIBS[@]}"; do
  if [ "$IDENTITY" = "-" ]; then
    codesign --force --sign - "$MACOS_DIR/$lib"
  elif [ "$IDENTITY" = "MAHI Local Distribution" ]; then
    codesign --force --sign "$IDENTITY" "$MACOS_DIR/$lib"
  else
    codesign --force --sign "$IDENTITY" --timestamp --options runtime "$MACOS_DIR/$lib"
  fi
done
if [ "$IDENTITY" = "-" ]; then
  codesign --force --sign - "$APP"
elif [ "$IDENTITY" = "MAHI Local Distribution" ]; then
  codesign --force --sign "$IDENTITY" "$APP"
else
  codesign --force --sign "$IDENTITY" --timestamp --options runtime "$APP"
fi

codesign --verify --deep --strict "$APP"

echo "fix-native-libs: patched and signed $APP with $IDENTITY"
