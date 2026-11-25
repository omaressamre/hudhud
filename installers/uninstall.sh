#!/bin/bash
# Hudhud Helper uninstaller for macOS and Linux. Your downloaded videos are NOT touched.
set -u
HOST_NAME="com.hudhud.helper"
OS="${HUDHUD_OS:-$(uname -s)}"
if [ "$OS" = Darwin ]; then
  DEST="$HOME/Library/Application Support/Hudhud"; AS="$HOME/Library/Application Support"
else
  DEST="${XDG_DATA_HOME:-$HOME/.local/share}/hudhud"; AS="${XDG_CONFIG_HOME:-$HOME/.config}"
fi
pkill -f "$DEST/" 2>/dev/null || true
find "$AS" -maxdepth 4 -path "*NativeMessagingHosts/$HOST_NAME.json" -print -delete 2>/dev/null | sed 's/^/removed /'
rm -rf "$DEST" && echo "removed $DEST"
echo "Hudhud Helper uninstalled."
echo "Also remove Hudhud from chrome://extensions (or edge://extensions)."
