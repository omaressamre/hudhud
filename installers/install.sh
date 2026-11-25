#!/bin/bash
# Hudhud Helper installer for macOS and Linux (per-user, no sudo needed).
#
#   bash install.sh
#
# Downloads show live progress and RESUME if interrupted: just run it again.
# Compatible with the old bash 3.2 that ships with macOS.

set -u

EXT_ID="${HUDHUD_EXTENSION_ID:-gdcallopdofegjbibhflneideofehmpk}"
HOST_NAME="com.hudhud.helper"
SRC="$(cd "$(dirname "$0")" && pwd)"
MIRROR="${HUDHUD_MIRROR:-}"     # للاختبار: بديل لـhttps:// (سيرفر محلي)
STEPS=6
STEP=0

c_cyan=''; c_green=''; c_yellow=''; c_red=''; c_dim=''; c_off=''
if [ -t 1 ]; then
  c_cyan=$'\033[36m'; c_green=$'\033[32m'; c_yellow=$'\033[33m'; c_red=$'\033[31m'; c_dim=$'\033[2m'; c_off=$'\033[0m'
fi

step() { STEP=$((STEP + 1)); echo; echo "${c_cyan}[$STEP/$STEPS] $1${c_off}"; }
ok()   { echo "    ${c_green}OK${c_off}  $1"; }
info() { echo "    $1"; }
warn() { echo "    ${c_yellow}$1${c_off}"; }
die()  { echo; echo "${c_red}ERROR: $1${c_off}"; echo "Fix the problem above and run install.sh again (downloads will resume)."; exit 1; }

# ───────── النظام والمعالج ─────────
OS="${HUDHUD_OS:-$(uname -s)}"
ARCH="${HUDHUD_ARCH:-$(uname -m)}"
case "$ARCH" in
  x86_64|amd64) ARCH=amd64 ;;
  arm64|aarch64) ARCH=arm64 ;;
  *) die "unsupported CPU: $ARCH (only x86_64 and arm64)" ;;
esac
case "$OS" in
  Darwin)
    OSN=darwin
    DEST="$HOME/Library/Application Support/Hudhud"
    YT_FILE=yt-dlp_macos
    if [ "$ARCH" = arm64 ]; then DENO_FILE=deno-aarch64-apple-darwin.zip; else DENO_FILE=deno-x86_64-apple-darwin.zip; fi
    ;;
  Linux)
    OSN=linux
    DEST="${XDG_DATA_HOME:-$HOME/.local/share}/hudhud"
    if [ "$ARCH" = arm64 ]; then
      YT_FILE=yt-dlp_linux_aarch64; FF_FILE=ffmpeg-master-latest-linuxarm64-gpl.tar.xz; DENO_FILE=deno-aarch64-unknown-linux-gnu.zip
    else
      YT_FILE=yt-dlp_linux; FF_FILE=ffmpeg-master-latest-linux64-gpl.tar.xz; DENO_FILE=deno-x86_64-unknown-linux-gnu.zip
    fi
    ;;
  *) die "unsupported system: $OS (use install.bat on Windows)" ;;
esac
CACHE="$DEST/.downloads"

url() { # بيحوّل اللينك لسيرفر الاختبار لو HUDHUD_MIRROR متحدد
  if [ -n "$MIRROR" ]; then echo "$MIRROR/${1#https://}"; else echo "$1"; fi
}

# ───────── تحميل بيكمّل من مكان ما وقف ─────────
fetch() { # fetch URL OUTPUT LABEL [soft]   (soft: يرجع 1 بدل ما يوقف التسطيب)
  local u; u="$(url "$1")"
  local out="$2" label="$3" soft="${4:-}" part="$2.part" try=1 rc=0 max=6
  [ -n "$soft" ] && max=2
  while :; do
    if command -v curl >/dev/null 2>&1; then
      if [ -s "$part" ]; then info "resuming $label..."; else info "downloading $label..."; fi
      # shellcheck disable=SC2086
      curl -L --fail --connect-timeout 20 --retry 3 --retry-delay 3 ${HUDHUD_CURL_OPTS:-} -C - -o "$part" "$u"
      rc=$?
    elif command -v wget >/dev/null 2>&1; then
      info "downloading $label..."
      wget -c --show-progress -q -O "$part" "$u"
      rc=$?
    else
      die "curl (or wget) is required"
    fi
    if [ $rc -eq 0 ]; then mv -f "$part" "$out"; return 0; fi
    if [ -n "$soft" ] && [ $rc -eq 22 ]; then rm -f "$part"; return 1; fi   # الملف مش موجود على السيرفر: نجرّب البديل على طول
    if [ $rc -eq 33 ] || [ $rc -eq 36 ]; then
      warn "server can't resume, starting this file again"; rm -f "$part"
    fi
    if [ $try -ge $max ]; then
      rm -f "$part"
      [ -n "$soft" ] && return 1
      die "download failed: $u"
    fi
    try=$((try + 1))
    warn "network problem (code $rc), retrying in 5s (attempt $try/$max) - it will continue, not restart..."
    sleep 5
  done
}

works() { [ -x "$1" ] && "$1" "$2" >/dev/null 2>&1; }

extract_zip() { # extract_zip ZIP DIR
  mkdir -p "$2"
  if command -v unzip >/dev/null 2>&1; then unzip -q -o "$1" -d "$2"
  elif command -v bsdtar >/dev/null 2>&1; then bsdtar -xf "$1" -C "$2"
  elif command -v python3 >/dev/null 2>&1; then python3 -m zipfile -e "$1" "$2"
  else die "unzip is required (install it with your package manager)"; fi
}

install_bin() { # install_bin ARCHIVE_DIR NAME
  local f
  f="$(find "$1" -type f -name "$2" | head -n 1)"
  [ -n "$f" ] || return 1
  cp -f "$f" "$DEST/$2" && chmod +x "$DEST/$2"
}

unquarantine() {
  if [ "$OSN" = darwin ] && command -v xattr >/dev/null 2>&1; then
    xattr -dr com.apple.quarantine "$1" 2>/dev/null || true
  fi
}

# ───────── التسطيب ─────────
echo "Hudhud Helper - installer ($OSN-$ARCH)"
echo "Install folder : $DEST"
echo "Extension ID   : $EXT_ID"
echo "${c_dim}Tip: if you stop it, just run install.sh again - downloads resume.${c_off}"
mkdir -p "$DEST" "$CACHE" || die "can't create $DEST"

step "Helper program"
HELPER_SRC="$SRC/bin/hudhud-helper-$OSN-$ARCH"
[ -f "$HELPER_SRC" ] || die "the helper binary is not in this folder ($HELPER_SRC).
  This looks like the source code. Download hudhud-helper-$( [ "$OSN" = darwin ] && echo macos || echo linux ).zip from
  https://github.com/omaressamre/hudhud/releases/latest, unzip it and run the installer from there."
pkill -f "$DEST/hudhud-helper" 2>/dev/null || true
cp -f "$HELPER_SRC" "$DEST/hudhud-helper" || die "can't copy the helper"
chmod +x "$DEST/hudhud-helper"
unquarantine "$DEST/hudhud-helper"
ok "$DEST/hudhud-helper"

step "yt-dlp"
YT="$DEST/yt-dlp"
if works "$YT" --version; then
  info "already installed, checking for updates..."
  "$YT" -U 2>&1 | sed 's/^/    /'
else
  rm -f "$YT"
  fetch "https://github.com/yt-dlp/yt-dlp/releases/latest/download/$YT_FILE" "$YT" "yt-dlp"
  chmod +x "$YT"; unquarantine "$YT"
fi
works "$YT" --version || die "yt-dlp does not run"
ok "yt-dlp $("$YT" --version 2>/dev/null)"

step "ffmpeg (one time only, the biggest download)"
FF="$DEST/ffmpeg"
if works "$FF" -version; then
  info "already installed"
else
  if [ "$OSN" = linux ]; then
    command -v xz >/dev/null 2>&1 || die "xz is required to unpack ffmpeg (Debian/Ubuntu: sudo apt install xz-utils)"
    ARC="$CACHE/$FF_FILE"
    [ -f "$ARC" ] || fetch "https://github.com/yt-dlp/FFmpeg-Builds/releases/download/latest/$FF_FILE" "$ARC" "ffmpeg"
    rm -rf "$CACHE/ff"; mkdir -p "$CACHE/ff"
    info "unpacking..."
    if ! tar -xJf "$ARC" -C "$CACHE/ff"; then rm -f "$ARC"; die "the ffmpeg archive was broken; run install.sh again"; fi
    install_bin "$CACHE/ff" ffmpeg && install_bin "$CACHE/ff" ffprobe || die "ffmpeg not found inside the archive"
  else
    # ماك: نسخ static لـIntel و Apple Silicon (ffmpeg.martin-riedl.de)
    for tool in ffmpeg ffprobe; do
      ZIP="$CACHE/$tool.zip"
      if [ ! -f "$ZIP" ]; then
        fetch "https://ffmpeg.martin-riedl.de/redirect/latest/macos/$ARCH/release/$tool.zip" "$ZIP" "$tool" soft \
          || { warn "release build not available, using the latest snapshot build"; \
               fetch "https://ffmpeg.martin-riedl.de/redirect/latest/macos/$ARCH/snapshot/$tool.zip" "$ZIP" "$tool (snapshot)"; }
      fi
      rm -rf "$CACHE/$tool"
      extract_zip "$ZIP" "$CACHE/$tool"
      install_bin "$CACHE/$tool" "$tool" || { rm -f "$ZIP"; die "$tool not found inside the archive; run install.sh again"; }
    done
  fi
  rm -rf "$CACHE/ff" "$CACHE/ffmpeg" "$CACHE/ffprobe" "$CACHE"/*.tar.xz "$CACHE"/ffmpeg.zip "$CACHE"/ffprobe.zip
  unquarantine "$DEST/ffmpeg"; unquarantine "$DEST/ffprobe"
fi
works "$FF" -version || die "ffmpeg does not run"
ok "ffmpeg ready"

step "Deno (one time only, needed by yt-dlp for YouTube)"
DENO="$DEST/deno"
if works "$DENO" --version; then
  info "already installed"
else
  ZIP="$CACHE/deno.zip"
  [ -f "$ZIP" ] || fetch "https://github.com/denoland/deno/releases/latest/download/$DENO_FILE" "$ZIP" "Deno"
  rm -rf "$CACHE/deno"
  extract_zip "$ZIP" "$CACHE/deno"
  install_bin "$CACHE/deno" deno || { rm -f "$ZIP"; die "deno not found inside the archive; run install.sh again"; }
  rm -rf "$CACHE/deno" "$ZIP"
  unquarantine "$DENO"
fi
works "$DENO" --version || die "deno does not run"
ok "$("$DENO" --version 2>/dev/null | head -n 1)"

step "Hudhud extension"
EXT="$DEST/extension"
FIRST_EXT=0
if [ -f "$SRC/extension/manifest.json" ]; then
  [ -f "$EXT/hudhud-install.json" ] || FIRST_EXT=1
  if [ ! -s "$DEST/install-id" ]; then
    od -An -tx1 -N16 /dev/urandom | tr -d ' \n' > "$DEST/install-id"
  fi
  INSTALL_ID="$(tr -d ' \n' < "$DEST/install-id")"
  rm -rf "$DEST/extension.new"
  cp -R "$SRC/extension" "$DEST/extension.new" || die "can't copy the extension"
  printf '{"id":"%s"}\n' "$INSTALL_ID" > "$DEST/extension.new/hudhud-install.json"
  rm -rf "$EXT" && mv "$DEST/extension.new" "$EXT" || die "can't replace $EXT"
  if [ -f "$SRC/setup.html" ]; then
    esc="$(printf '%s' "$EXT" | sed -e 's/[&|\\]/\\&/g' -e 's/</\&lt;/g')"
    sed "s|{{EXT_PATH}}|$esc|" "$SRC/setup.html" > "$DEST/setup.html"
  fi
  unquarantine "$EXT"
  ok "$EXT"
else
  info "no extension folder in this package, skipping"
fi

step "Registering with your browsers"
MANIFEST="{
  \"name\": \"$HOST_NAME\",
  \"description\": \"Hudhud Helper (yt-dlp + ffmpeg)\",
  \"path\": \"$DEST/hudhud-helper\",
  \"type\": \"stdio\",
  \"allowed_origins\": [\"chrome-extension://$EXT_ID/\"]
}"
if [ "$OSN" = darwin ]; then
  AS="$HOME/Library/Application Support"
  BROWSERS="Google/Chrome|Google/Chrome Beta|Google/Chrome Canary|Chromium|Microsoft Edge|Microsoft Edge Beta|Microsoft Edge Dev|BraveSoftware/Brave-Browser|Vivaldi|Arc/User Data"
  DEFAULTS="Google/Chrome|Microsoft Edge"
else
  AS="${XDG_CONFIG_HOME:-$HOME/.config}"
  BROWSERS="google-chrome|google-chrome-beta|google-chrome-unstable|chromium|microsoft-edge|microsoft-edge-beta|microsoft-edge-dev|BraveSoftware/Brave-Browser|vivaldi"
  DEFAULTS="google-chrome|chromium|microsoft-edge"
fi
register() { # register BROWSER_DIR
  mkdir -p "$AS/$1/NativeMessagingHosts" && printf '%s\n' "$MANIFEST" > "$AS/$1/NativeMessagingHosts/$HOST_NAME.json" && ok "$1"
}
registered=0
OLDIFS="$IFS"; IFS='|'; set -- $BROWSERS; IFS="$OLDIFS"
for b in "$@"; do
  if [ -d "$AS/$b" ]; then register "$b" && registered=$((registered + 1)); fi
done
if [ $registered -eq 0 ]; then
  # لسه مفيش متصفح اتفتح: نسجّل في الأماكن الافتراضية
  OLDIFS="$IFS"; IFS='|'; set -- $DEFAULTS; IFS="$OLDIFS"
  for b in "$@"; do register "$b"; done
fi
if [ "$OSN" = linux ] && { [ -d "$HOME/snap/chromium" ] || [ -d "$HOME/.var/app/com.google.Chrome" ] || [ -d "$HOME/.var/app/org.chromium.Chromium" ]; }; then
  warn "Note: Snap/Flatpak browsers may block the helper. If it says 'not connected', use the normal .deb/.rpm Chrome or Edge."
fi
rm -rf "$CACHE"

echo
if [ "$FIRST_EXT" = 1 ]; then
  echo "${c_green}Done! One last step: add the extension to your browser.${c_off}"
  echo "Extension folder: ${c_cyan}$EXT${c_off}"
  if [ "$OSN" = darwin ]; then
    printf '%s' "$EXT" | pbcopy 2>/dev/null && echo "(copied to your clipboard)"
    [ -n "${HUDHUD_NO_OPEN:-}" ] || open "$DEST/setup.html" 2>/dev/null
  elif [ -z "${HUDHUD_NO_OPEN:-}" ] && { [ -n "${DISPLAY:-}" ] || [ -n "${WAYLAND_DISPLAY:-}" ]; }; then
    xdg-open "$DEST/setup.html" >/dev/null 2>&1 &
  fi
  echo "Setup guide: $DEST/setup.html"
elif [ -f "$EXT/manifest.json" ]; then
  echo "${c_green}Done! Hudhud was updated. Reload it from chrome://extensions or edge://extensions.${c_off}"
else
  echo "${c_green}Done! Open the Hudhud popup: it should say the helper is connected.${c_off}"
  echo "If it does not, reload the extension from chrome://extensions or edge://extensions."
fi
