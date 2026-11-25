#!/usr/bin/env bash
# Generates a small media fixture site (needs ffmpeg). Used by CI for the Firefox tests.
#   tests/fixtures/gen.sh [out-dir]    (default tests/.fixtures/site)
set -euo pipefail
OUT="${1:-$(cd "$(dirname "$0")/.." && pwd)/.fixtures/site}"
mkdir -p "$OUT/hls"
ff() { ffmpeg -hide_banner -loglevel error -y "$@"; }
SRC=(-f lavfi -i testsrc2=size=640x360:rate=25 -f lavfi -i sine=frequency=440:sample_rate=44100)
ff "${SRC[@]}" -t 6 -c:v libx264 -pix_fmt yuv420p -g 50 -c:a aac -b:a 96k \
   -f hls -hls_time 2 -hls_playlist_type vod -hls_segment_filename "$OUT/hls/seg%03d.ts" "$OUT/hls/index.m3u8"
ff "${SRC[@]}" -t 4 -c:v libx264 -pix_fmt yuv420p -c:a aac -movflags +faststart "$OUT/direct.mp4"
cat > "$OUT/hlspage.html" <<'HTML'
<!doctype html><html><head><meta charset="utf-8"><title>HLS fixture</title></head>
<body><script>fetch('/hls/index.m3u8');</script></body></html>
HTML
cat > "$OUT/directpage.html" <<'HTML'
<!doctype html><html><head><meta charset="utf-8"><title>Direct fixture</title></head>
<body><video src="/direct.mp4" autoplay muted></video></body></html>
HTML
echo "fixtures: $OUT"
