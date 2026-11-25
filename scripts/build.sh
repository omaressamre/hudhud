#!/usr/bin/env bash
# Builds release artifacts into dist/:
#   hudhud-vX.Y.Z-windows.zip       install.bat + hudhud-helper.exe + extension/
#   hudhud-vX.Y.Z-macos.zip         install.command + darwin binaries + extension/
#   hudhud-vX.Y.Z-linux.zip         install.sh + amd64/arm64 binaries + extension/
#   hudhud-vX.Y.Z-extension-only.zip  the extension alone (Load unpacked, no self-update)
#   hudhud-helper-{windows,macos,linux}.zip  same bytes under the pre-0.9.4 names, so helpers
#                                   0.9.0–0.9.3 can still self-update (drop these in 1.0)
# Usage: scripts/build.sh [--no-fonts]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
VERSION="$(python3 -c 'import json;print(json.load(open("extension/manifest.json"))["version"])')"
DIST="$ROOT/dist"
rm -rf "$DIST" && mkdir -p "$DIST"

node scripts/gen-locales.mjs
if [[ "${1:-}" != "--no-fonts" ]]; then scripts/fetch-fonts.sh || echo "warning: fonts not fetched, using system fonts"; fi

# helper binaries
GOFLAGS="-trimpath" ; LDFLAGS="-s -w"
build() { # os arch out
  ( cd helper && CGO_ENABLED=0 GOOS="$1" GOARCH="$2" go build $GOFLAGS -ldflags "$LDFLAGS" -o "$3" . )
}
stage="$(mktemp -d)"
mkdir -p "$stage/win" "$stage/mac/bin" "$stage/linux/bin"
build windows amd64 "$stage/win/hudhud-helper.exe"
build darwin amd64 "$stage/mac/bin/hudhud-helper-darwin-amd64"
build darwin arm64 "$stage/mac/bin/hudhud-helper-darwin-arm64"
build linux amd64 "$stage/linux/bin/hudhud-helper-linux-amd64"
build linux arm64 "$stage/linux/bin/hudhud-helper-linux-arm64"

cp installers/install.bat installers/install.ps1 installers/uninstall.bat installers/uninstall.ps1 "$stage/win/"
cp installers/install.command installers/install.sh installers/uninstall.sh "$stage/mac/"
cp installers/install.sh installers/uninstall.sh "$stage/linux/"
for d in win mac linux; do
  cp LICENSE TRADEMARKS.md "$stage/$d/"
  cp -r extension "$stage/$d/extension"
  rm -f "$stage/$d/extension/fonts/README.md"
  cp installers/setup.html "$stage/$d/setup.html"
done
chmod +x "$stage"/mac/*.sh "$stage"/mac/*.command "$stage"/linux/*.sh "$stage"/mac/bin/* "$stage"/linux/bin/*

( cd "$stage/win" && zip -qr "$DIST/hudhud-v$VERSION-windows.zip" . )
( cd "$stage/mac" && zip -qr "$DIST/hudhud-v$VERSION-macos.zip" . )
( cd "$stage/linux" && zip -qr "$DIST/hudhud-v$VERSION-linux.zip" . )
( cd extension && zip -qr "$DIST/hudhud-v$VERSION-extension-only.zip" . -x 'fonts/README.md' )
( zip -qj "$DIST/hudhud-v$VERSION-extension-only.zip" LICENSE TRADEMARKS.md )
for os in windows macos linux; do cp "$DIST/hudhud-v$VERSION-$os.zip" "$DIST/hudhud-helper-$os.zip"; done
rm -rf "$stage"
# Firefox build (unsigned folder; the release workflow signs it into hudhud-vX.Y.Z-firefox.xpi)
node scripts/firefox-manifest.mjs "$DIST/firefox" >/dev/null
cp LICENSE TRADEMARKS.md "$DIST/firefox/"
( cd "$DIST" && sha256sum *.zip > SHA256SUMS.txt )
ls -la "$DIST"
