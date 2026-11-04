#!/bin/zsh
# Builds Storagelyzer and moves it to /Applications.
#
# The bundle is *moved*, not copied: with a second copy (same bundle id) left in
# the build folder, macOS sometimes opens that one instead — and Full Disk
# Access granted to /Applications/Storagelyzer.app would not apply to it.
set -euo pipefail
cd "${0:A:h}/.."

APP="Storagelyzer.app"
BUILT="src-tauri/target/release/bundle/macos/$APP"
DEST="/Applications/$APP"
LSREGISTER=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister

npm run tauri build -- --bundles app

if pgrep -f "$DEST/Contents/MacOS/" >/dev/null; then
  echo "Quit Storagelyzer first (it is running from $DEST)." >&2
  exit 1
fi

"$LSREGISTER" -u "$BUILT" 2>/dev/null || true
rm -rf "$DEST"
mv "$BUILT" "$DEST"
"$LSREGISTER" -f "$DEST"

echo
echo "Installed $DEST"
echo "Ad-hoc signed builds get a new signature each time: if the app reports no"
echo "Full Disk Access, switch it off and on again in System Settings → Privacy & Security."
