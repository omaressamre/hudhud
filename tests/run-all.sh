#!/usr/bin/env bash
# Runs the whole test suite.
#   quick (CI):   tests/run-all.sh            → syntax, locales, unit tests that need no media, go vet + build
#   full (local): tests/run-all.sh --full     → + browser end-to-end tests with Chrome, ffmpeg and fixtures
# Full mode needs: google-chrome, python3 + playwright, ffmpeg/ffprobe, Go, and the media fixtures in
# HH_SITE (defaults to tests/.fixtures/site; generate them with tests/fixtures/gen.sh when available).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
pass() { printf '\033[32m✓ %s\033[0m\n' "$1"; }

# 1) locales are in sync with scripts/strings.mjs
cp -r extension/_locales /tmp/hh-locales-before
node scripts/gen-locales.mjs >/dev/null
diff -r /tmp/hh-locales-before extension/_locales >/dev/null || { echo "locales out of date: run node scripts/gen-locales.mjs"; rm -rf /tmp/hh-locales-before; exit 1; }
rm -rf /tmp/hh-locales-before
pass "locales"

# 2) every JS file parses, manifest is valid JSON
for f in $(find extension -name '*.js' -not -path '*/node_modules/*'); do node --check "$f"; done
python3 -c 'import json;json.load(open("extension/manifest.json"))'
pass "syntax"

# 3) unit tests that don't need media fixtures
node tests/unit.mjs
pass "unit"

# 4) helper
( cd helper && go test ./... && go vet ./... && GOOS=windows go vet ./... && GOOS=darwin go vet ./... && go build -o /tmp/hhhost/hudhud-helper . )
pass "helper"

[[ "${1:-}" == "--full" ]] || exit 0

# 5) full: media unit tests + end-to-end in Chrome
export HH_HOST=/tmp/hhhost/hudhud-helper
cp tests/fakebin/yt-dlp /tmp/hhhost/yt-dlp && chmod +x /tmp/hhhost/yt-dlp
node tests/test.mjs
pass "media unit"
SITE="${HH_SITE:-$ROOT/tests/.fixtures/site}"
python3 tests/serve.py "$SITE" 8765 >/tmp/hh-serve.log 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null || true' EXIT
sleep 1
for t in e2e e2e2 e2e3 e2e4 e2e5 e2e6 e2e7 e2e8; do
  echo "── $t"; timeout 300 python3 "tests/$t.py"
done
pass "e2e"
