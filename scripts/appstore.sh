#!/bin/zsh
# Mac App Store builds of Storagelyzer.
#
#   scripts/appstore.sh local [--universal]
#       The App Store version (App Sandbox) signed ad hoc, to try on this Mac.
#       Needs no Apple Developer account. Opens the app when done.
#
#   scripts/appstore.sh check
#       Shows what is still missing for a submission (certificates, profile, …).
#
#   scripts/appstore.sh build
#       Universal (Apple silicon + Intel) app, signed for the App Store and
#       packed into a signed installer: dist-appstore/Storagelyzer-<version>.pkg
#
#   scripts/appstore.sh upload [path/to.pkg]
#       Validates the package with App Store Connect and uploads it. (Transporter
#       from the Mac App Store does the same with drag and drop.)
#
# Settings come from scripts/appstore.env (not in git); see appstore.env.example.
set -euo pipefail
cd "${0:A:h}/.."
ROOT=$PWD

[[ -f scripts/appstore.env ]] && source scripts/appstore.env

BUNDLE_ID=com.wojtek.storagelyzer
APP_NAME=Storagelyzer
VERSION=$(sed -n 's/^  "version": "\(.*\)",$/\1/p' src-tauri/tauri.conf.json)
OUT=$ROOT/dist-appstore
WORK=$ROOT/src-tauri/target/appstore
mkdir -p "$WORK"

die() { print -u2 "error: $*"; exit 1; }
ok() { print "  ✓ $*"; }
missing() { print "  ✗ $*"; MISSING=1; }

# Tauri merges this JSON into tauri.conf.json for one build.
overlay() {
  python3 - "$@" <<'EOF'
import json, sys
args = dict(a.split("=", 1) for a in sys.argv[1:])
mac = {"entitlements": args["entitlements"], "signingIdentity": args["identity"]}
if "bundleVersion" in args:
    mac["bundleVersion"] = args["bundleVersion"]
if "profile" in args:
    mac["files"] = {"embedded.provisionprofile": args["profile"]}
print(json.dumps({"bundle": {"targets": ["app"], "macOS": mac}}))
EOF
}

show_signature() {
  local app=$1
  print "\nSignature:"
  codesign -dvv "$app" 2>&1 | grep -E "^(Identifier|Authority|TeamIdentifier|Signature)=" | sed 's/^/  /'
  print "Entitlements:"
  codesign -d --entitlements - --xml "$app" 2>/dev/null | plutil -p - | sed 's/^/  /'
}

cmd_local() {
  local target=() built
  if [[ ${1:-} == --universal ]]; then
    rustup target add aarch64-apple-darwin x86_64-apple-darwin >/dev/null
    target=(--target universal-apple-darwin)
    built=src-tauri/target/universal-apple-darwin/release/bundle/macos/$APP_NAME.app
  else
    built=src-tauri/target/release/bundle/macos/$APP_NAME.app
  fi
  npm run tauri build -- "${target[@]}" --bundles app \
    --config "$(overlay entitlements=$ROOT/src-tauri/macos/Sandbox-local.entitlements identity=-)"

  # Kept apart from /Applications/Storagelyzer.app (the build from source).
  local dest=$WORK/local/$APP_NAME.app
  rm -rf "$dest" && mkdir -p "${dest:h}" && mv "$built" "$dest"
  codesign --verify --strict "$dest"
  show_signature "$dest"
  lipo -archs "$dest/Contents/MacOS/storagelyzer" | sed 's/^/Architectures: /'
  print "\nApp Store test build: $dest"
  print "Its data and remembered permissions live in ~/Library/Containers/$BUNDLE_ID"
  [[ -n ${NO_OPEN:-} ]] || open "$dest"
}

cmd_check() {
  MISSING=0
  print "Mac App Store prerequisites:"
  if xcode-select -p | grep -q Xcode.app; then ok "Xcode: $(xcodebuild -version | head -1)"; else missing "Xcode (full Xcode, not only the Command Line Tools)"; fi
  local targets=$(rustup target list --installed)
  for t in aarch64-apple-darwin x86_64-apple-darwin; do
    if print -r -- "$targets" | grep -qx $t; then ok "Rust target $t"; else missing "Rust target $t (rustup target add $t)"; fi
  done
  if [[ -n ${APPLE_TEAM_ID:-} ]]; then ok "Team ID $APPLE_TEAM_ID"; else missing "APPLE_TEAM_ID in scripts/appstore.env"; fi
  local ids=$(security find-identity -v -p codesigning 2>/dev/null; security find-identity -v 2>/dev/null)
  if [[ -n ${APP_SIGN_IDENTITY:-} ]] && print -r -- "$ids" | grep -qF "$APP_SIGN_IDENTITY"; then
    ok "app certificate: $APP_SIGN_IDENTITY"
  else
    missing "app certificate (Apple Distribution) — APP_SIGN_IDENTITY=${APP_SIGN_IDENTITY:-<not set>}"
  fi
  if [[ -n ${INSTALLER_SIGN_IDENTITY:-} ]] && print -r -- "$ids" | grep -qF "$INSTALLER_SIGN_IDENTITY"; then
    ok "installer certificate: $INSTALLER_SIGN_IDENTITY"
  else
    missing "installer certificate (Mac Installer Distribution) — INSTALLER_SIGN_IDENTITY=${INSTALLER_SIGN_IDENTITY:-<not set>}"
  fi
  if [[ -n ${PROVISIONING_PROFILE:-} && -f ${PROVISIONING_PROFILE:-} ]]; then
    local plist=$WORK/profile.plist
    security cms -D -i "$PROVISIONING_PROFILE" >"$plist"
    local appid=$(/usr/libexec/PlistBuddy -c "Print :Entitlements:com.apple.application-identifier" "$plist" 2>/dev/null)
    local expires=$(/usr/libexec/PlistBuddy -c "Print :ExpirationDate" "$plist" 2>/dev/null)
    if [[ $appid == "${APPLE_TEAM_ID:-}.$BUNDLE_ID" ]]; then
      ok "provisioning profile for $appid (valid until $expires)"
    else
      missing "provisioning profile is for '$appid', expected '${APPLE_TEAM_ID:-TEAMID}.$BUNDLE_ID'"
    fi
  else
    missing "PROVISIONING_PROFILE (Mac App Store profile for $BUNDLE_ID)"
  fi
  if [[ -n ${ASC_KEY_ID:-} && -n ${ASC_ISSUER_ID:-} ]]; then
    ok "App Store Connect API key $ASC_KEY_ID (for upload)"
  else
    print "  – ASC_KEY_ID / ASC_ISSUER_ID not set: upload with Transporter instead"
  fi
  return $MISSING
}

cmd_build() {
  cmd_check || die "fix the items marked ✗ first (see appstore/README.md)"
  rustup target add aarch64-apple-darwin x86_64-apple-darwin >/dev/null

  # Every upload needs a new build number (CFBundleVersion); the version stays $VERSION.
  local build=${BUILD_NUMBER:-$(date +%Y%m%d.%H%M)}
  local ent=$WORK/AppStore.entitlements
  sed "s/__TEAM_ID__/$APPLE_TEAM_ID/g" src-tauri/macos/AppStore.entitlements >"$ent"

  npm run tauri build -- --target universal-apple-darwin --bundles app --config "$(overlay \
    entitlements=$ent identity=$APP_SIGN_IDENTITY bundleVersion=$build profile=${PROVISIONING_PROFILE:A})"

  local app=src-tauri/target/universal-apple-darwin/release/bundle/macos/$APP_NAME.app
  codesign --verify --strict --deep "$app"
  show_signature "$app"
  [[ $(lipo -archs "$app/Contents/MacOS/storagelyzer") == *x86_64*arm64* ]] || die "the app is not universal"

  mkdir -p "$OUT"
  local pkg=$OUT/$APP_NAME-$VERSION-$build.pkg
  xcrun productbuild --component "$app" /Applications --sign "$INSTALLER_SIGN_IDENTITY" "$pkg"
  pkgutil --check-signature "$pkg" | head -4
  print "\nReady to upload: $pkg"
  print "  scripts/appstore.sh upload \"$pkg\"   (or drag it into Transporter)"
}

cmd_upload() {
  local pkg=${1:-$(ls -t "$OUT"/*.pkg 2>/dev/null | head -1)}
  [[ -f $pkg ]] || die "no package; run scripts/appstore.sh build first"
  [[ -n ${ASC_KEY_ID:-} && -n ${ASC_ISSUER_ID:-} ]] ||
    die "set ASC_KEY_ID and ASC_ISSUER_ID in scripts/appstore.env, or upload $pkg with Transporter"
  local auth=(--api-key "$ASC_KEY_ID" --api-issuer "$ASC_ISSUER_ID")
  print "Validating $pkg…"
  xcrun altool --validate-app "$pkg" -t macos "${auth[@]}"
  print "Uploading…"
  xcrun altool --upload-package "$pkg" -t macos "${auth[@]}"
  print "\nUploaded. The build shows up in App Store Connect → $APP_NAME → TestFlight after processing (usually 5–30 min)."
}

case ${1:-} in
  local) shift; cmd_local "$@" ;;
  check) cmd_check ;;
  build) cmd_build ;;
  upload) shift; cmd_upload "$@" ;;
  *) sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
