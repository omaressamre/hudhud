#!/usr/bin/env bash
# Downloads the brand fonts (SIL OFL) into extension/fonts and site/fonts.
# Converts to WOFF2 when fontTools + brotli are available, otherwise keeps the TTF.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BASE="https://raw.githubusercontent.com/google/fonts/main/ofl"
tmp="$(mktemp -d)"
fetch() { # url out-name
  curl -fsSL --retry 3 "$1" -o "$tmp/$2.ttf"
  if python3 -c 'import fontTools, brotli' 2>/dev/null; then
    python3 -m fontTools.ttLib.woff2 compress -o "$tmp/$2.woff2" "$tmp/$2.ttf"
  fi
  for d in "$ROOT/extension/fonts" "$ROOT/site/fonts"; do
    mkdir -p "$d"
    if [ -f "$tmp/$2.woff2" ]; then cp "$tmp/$2.woff2" "$d/"; else cp "$tmp/$2.ttf" "$d/"; fi
  done
  echo "font: $2"
}
fetch "$BASE/readexpro/ReadexPro%5BHEXP,wght%5D.ttf" ReadexPro
fetch "$BASE/baloobhaijaan2/BalooBhaijaan2%5Bwght%5D.ttf" BalooBhaijaan2
rm -rf "$tmp"
