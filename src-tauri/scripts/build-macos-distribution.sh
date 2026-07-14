#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

export MAHI_REQUIRE_DISTRIBUTION_SIGNING=1

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
if [[ "$IDENTITY" != Developer\ ID\ Application:* ]] \
  && [ "$IDENTITY" != "MAHI Local Distribution" ]; then
  echo "build-macos-distribution: install a Developer ID or run create-local-signing-identity.sh" >&2
  exit 1
fi
export MAHI_CODESIGN_IDENTITY="$IDENTITY"

npx tauri build --bundles app --config '{"bundle":{"createUpdaterArtifacts":false}}'
bash src-tauri/scripts/fix-native-libs.sh release
if [[ "$IDENTITY" == Developer\ ID\ Application:* ]]; then
  bash src-tauri/scripts/notarize-macos.sh release
else
  echo "build-macos-distribution: self-signed mode; Apple notarization is unavailable"
fi

APP="src-tauri/target/release/bundle/macos/MAHI.app"
VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Contents/Info.plist")"
OUTPUT="src-tauri/target/release/bundle/macos"
ZIP="$OUTPUT/MAHI-$VERSION-macos.zip"
TARBALL="$OUTPUT/MAHI-$VERSION.app.tar.gz"
UPDATER_KEY="${MAHI_UPDATER_PRIVATE_KEY_PATH:-src-tauri/mahi-updater.key}"

if [ ! -f "$UPDATER_KEY" ]; then
  echo "build-macos-distribution: updater signing key not found: $UPDATER_KEY" >&2
  exit 1
fi

rm -f "$ZIP" "$TARBALL" "$TARBALL.sig"
ditto -c -k --sequesterRsrc --keepParent "$APP" "$ZIP"
COPYFILE_DISABLE=1 tar czf "$TARBALL" -C "$OUTPUT" MAHI.app
npx tauri signer sign -f "$UPDATER_KEY" \
  -p "${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}" "$TARBALL"

echo "build-macos-distribution: created $ZIP and $TARBALL"
