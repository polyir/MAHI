#!/usr/bin/env bash
set -euo pipefail

PROFILE="${1:-release}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="$REPO_ROOT/target/$PROFILE/bundle/macos/MAHI.app"
ARCHIVE="$REPO_ROOT/target/$PROFILE/bundle/macos/MAHI-notarization.zip"

if [ ! -d "$APP" ]; then
  echo "notarize-macos: $APP not found" >&2
  exit 1
fi

TEAM_ID="$(codesign -dvv "$APP" 2>&1 | sed -n 's/^TeamIdentifier=//p')"
if [ -z "$TEAM_ID" ] || [ "$TEAM_ID" = "not set" ]; then
  echo "notarize-macos: MAHI must be signed with Developer ID first" >&2
  exit 1
fi

rm -f "$ARCHIVE"
ditto -c -k --keepParent "$APP" "$ARCHIVE"

if [ -n "${MAHI_NOTARY_PROFILE:-}" ]; then
  xcrun notarytool submit "$ARCHIVE" --keychain-profile "$MAHI_NOTARY_PROFILE" --wait
elif [ -n "${APPLE_ID:-}" ] && [ -n "${APPLE_APP_SPECIFIC_PASSWORD:-}" ]; then
  xcrun notarytool submit "$ARCHIVE" \
    --apple-id "$APPLE_ID" \
    --password "$APPLE_APP_SPECIFIC_PASSWORD" \
    --team-id "${APPLE_TEAM_ID:-$TEAM_ID}" \
    --wait
else
  echo "notarize-macos: set MAHI_NOTARY_PROFILE or Apple notarization credentials" >&2
  exit 1
fi

xcrun stapler staple "$APP"
xcrun stapler validate "$APP"
rm -f "$ARCHIVE"
echo "notarize-macos: notarized and stapled $APP"
