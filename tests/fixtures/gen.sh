#!/usr/bin/env bash
# Generates the media fixtures the tests serve on :8765 (needs ffmpeg with libx264, libx265,
# libvpx-vp9, libopus and libmp3lame).
#
#   tests/fixtures/gen.sh [out-dir]           small set for the Firefox test (CI): ff-hls.html, directpage.html
#   tests/fixtures/gen.sh --full [out-dir]    everything tests/run-all.sh --full needs (≈60 MB, ~1 min)
#
# out-dir defaults to tests/.fixtures/site; --full also writes the remux set to <out-dir>/../remux
# (the default HH_SITE and HH_REMUX in tests/common.py and tests/test.mjs).
set -euo pipefail
FULL=0
if [[ "${1:-}" == "--full" ]]; then FULL=1; shift; fi
TESTS="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-$TESTS/.fixtures/site}"
REMUX="$(dirname "$OUT")/remux"
mkdir -p "$OUT"
ff() { ffmpeg -hide_banner -loglevel error -y "$@"; }
V() { echo -f lavfi -i "testsrc2=size=${1:-640x360}:rate=${2:-25}"; }   # test picture
A() { echo -f lavfi -i "sine=frequency=${1:-440}:sample_rate=${2:-48000}"; }  # test tone
H=(-f hls -hls_time 2 -hls_playlist_type vod)
X264=(-c:v libx264 -pix_fmt yuv420p)

# ── small set (Firefox e2e in CI) ─────────────────────────────────────────────
mkdir -p "$OUT/hls"
ff $(V) $(A 440 44100) -t 6 "${X264[@]}" -g 50 -c:a aac -b:a 96k \
   "${H[@]}" -hls_segment_filename "$OUT/hls/seg%03d.ts" "$OUT/hls/index.m3u8"
ff $(V) $(A 440 44100) -t 4 "${X264[@]}" -c:a aac -movflags +faststart "$OUT/direct.mp4"
cat > "$OUT/ff-hls.html" <<'HTML'
<!doctype html><html><head><meta charset="utf-8"><title>HLS fixture</title></head>
<body><script>fetch('/hls/index.m3u8');</script></body></html>
HTML
cat > "$OUT/directpage.html" <<'HTML'
<!doctype html><html><head><meta charset="utf-8"><title>Direct fixture</title></head>
<body><video src="/direct.mp4" autoplay muted></video></body></html>
HTML
if [[ $FULL == 0 ]]; then echo "fixtures (small): $OUT"; exit 0; fi

# ── full set ──────────────────────────────────────────────────────────────────
# Pages: tests/site/*.html (index, hlspage, rxpage, stories, stories2, thumbs)
cp "$TESTS"/site/*.html "$OUT/"

# Direct files (> 1 MB: e2e sets "ignore videos under 1 MB"). slow-/fail- trigger the fake yt-dlp paths.
ff $(V 1280x720) $(A) -t 8 "${X264[@]}" -b:v 2M -c:a aac -movflags +faststart "$OUT/big.mp4"
cp "$OUT/big.mp4" "$OUT/slow-big.mp4"; cp "$OUT/big.mp4" "$OUT/fail-big.mp4"

# /hls: master with 720p and 360p variants (index.html fetches master, then 720)
for r in 720:1280x720 360:640x360; do
  h=${r%%:*}; s=${r#*:}
  ff $(V "$s") $(A) -t 8 "${X264[@]}" -g 50 -c:a aac \
     "${H[@]}" -hls_segment_filename "$OUT/hls/$h-%03d.ts" "$OUT/hls/$h.m3u8"
done
printf '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2"\n720.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,CODECS="avc1.64001e,mp4a.40.2"\n360.m3u8\n' > "$OUT/hls/master.m3u8"

# /hls2: byte ranges (one file), fMP4 segments, AES-128 (allowed: not DRM), and an AES-128 master
mkdir -p "$OUT/hls2/br" "$OUT/hls2/fmp4" "$OUT/hls2/enc2" "$OUT/hls2/enc/720" "$OUT/hls2/enc/360"
ff $(V) $(A) -t 8 "${X264[@]}" -g 50 -c:a aac "${H[@]}" -hls_flags single_file "$OUT/hls2/br/index.m3u8"
ff $(V) $(A) -t 8 "${X264[@]}" -g 50 -c:a aac "${H[@]}" -hls_segment_type fmp4 \
   -hls_fmp4_init_filename init.mp4 -hls_segment_filename "$OUT/hls2/fmp4/s%03d.m4s" "$OUT/hls2/fmp4/index.m3u8"
aes() {  # aes <dir> <size>: AES-128 HLS with the key served next to the playlist
  head -c 16 /dev/urandom > "$1/k.key"
  printf 'k.key\n%s/k.key\n%s\n' "$1" "$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')" > "$1/keyinfo"
  ff $(V "$2") $(A) -t 8 "${X264[@]}" -g 50 -c:a aac "${H[@]}" -hls_key_info_file "$1/keyinfo" \
     -hls_segment_filename "$1/s%03d.ts" "$1/index.m3u8"
  rm "$1/keyinfo"
}
aes "$OUT/hls2/enc2" 640x360
aes "$OUT/hls2/enc/720" 1280x720
aes "$OUT/hls2/enc/360" 640x360
printf '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720\nenc/720/index.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360\nenc/360/index.m3u8\n' > "$OUT/hls2/master-enc.m3u8"

# /rx: TS→MP4 remux cases (e2e6 compares frames with ffmpeg's own reading)
rx() { local d="$OUT/rx/$1"; shift; mkdir -p "$d"; ff "$@" "${H[@]}" -hls_segment_filename "$d/s%03d.ts" "$d/index.m3u8"; }
rx t1  $(V) $(A) -t 10 "${X264[@]}" -bf 2 -c:a aac                                   # plain H.264 + AAC
rx t3  $(V) -itsoffset 0.7 $(A 600) -t 8 "${X264[@]}" -bf 2 -c:a aac                   # audio starts 0.7 s late
rx t6  $(V) $(A 700 44100) -t 8 "${X264[@]}" -c:a libmp3lame -b:a 128k -shortest       # MP3 audio
rx t7  $(V) -t 4 -c:v libx265 -x265-params log-level=none -pix_fmt yuv420p             # HEVC → kept as TS
rx t10 $(V 640x360 30) $(A 500 44100) -t 30 "${X264[@]}" -bf 3 -c:a aac -shortest -hls_time 1   # many short segments
rx t15 $(V 1280x720 24000/1001) $(A 400) -t 10 -c:v libx264 -profile:v high -bf 3 -b_strategy 2 \
       -x264-params b-pyramid=normal:keyint=48 -pix_fmt yuv420p -c:a aac -shortest     # 23.976 fps, B-pyramid
# t20: master with a separate audio rendition (EXT-X-MEDIA)
mkdir -p "$OUT/rx/t20/v" "$OUT/rx/t20/audio"
ff $(V) -t 8 "${X264[@]}" -g 50 "${H[@]}" -hls_segment_filename "$OUT/rx/t20/v/s%03d.ts" "$OUT/rx/t20/v/index.m3u8"
ff $(A 300) -t 8 -c:a aac "${H[@]}" -hls_segment_filename "$OUT/rx/t20/audio/ar%03d.ts" "$OUT/rx/t20/audio/ar.m3u8"
printf '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Arabic",LANGUAGE="ar",DEFAULT=YES,AUTOSELECT=YES,URI="audio/ar.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=640x360,CODECS="avc1.64001e,mp4a.40.2",AUDIO="aud"\nv/index.m3u8\n' > "$OUT/rx/t20/master.m3u8"

# /fb: story halves for sniffing and pairing (test.mjs, e2e3). v/a pair by asset id, v2/a2 by duration (6 s).
FRAG=(-movflags +frag_keyframe+empty_moov+default_base_moof)
mkdir -p "$OUT/fb" "$OUT/fb2"
ff $(V) -t 8 "${X264[@]}" -bf 3 -g 25 "${FRAG[@]}" "$OUT/fb/v.mp4"
ff $(A) -t 8 -c:a aac -b:a 96k "${FRAG[@]}" "$OUT/fb/a.mp4"
ff $(V) -t 6 "${X264[@]}" -movflags +faststart "$OUT/fb/v2.mp4"
ff $(A) -t 6 -c:a aac -movflags +faststart "$OUT/fb/a2.mp4"

# /fb2: merge cases (e2e7): fragmented (Facebook-style), moov at the end, VP9 + Opus, and a broken video
ff $(V 640x360 30) -t 8 "${X264[@]}" -bf 3 -g 30 "${FRAG[@]}" "$OUT/fb2/fb_v.mp4"
ff $(A) -t 8 -c:a aac -b:a 96k "${FRAG[@]}" "$OUT/fb2/fb_a.mp4"
ff $(V 640x360 30) -t 8 "${X264[@]}" -bf 3 "$OUT/fb2/me_v.mp4"
ff $(A) -t 8 -c:a aac "$OUT/fb2/me_a.mp4"
ff $(V 640x360 30) -t 8 -c:v libvpx-vp9 -b:v 500k -deadline realtime -cpu-used 8 "${FRAG[@]}" "$OUT/fb2/vp_v.mp4"
ff $(A) -t 8 -c:a libopus -b:a 96k "${FRAG[@]}" "$OUT/fb2/vp_a.mp4"
# bad: a valid start (so it's detected as a story video) followed by garbage → the merge must fail cleanly
{ head -c 4000 "$OUT/fb2/fb_v.mp4"; head -c 200000 /dev/urandom; } > "$OUT/fb2/bad_v.mp4"
cp "$OUT/fb2/fb_a.mp4" "$OUT/fb2/bad_a.mp4"

# /thumbs: og:image, a direct video, and an MP4 with moov at the end (thumbnail needs a Range read)
mkdir -p "$OUT/thumbs"
ff $(V 1280x720) -frames:v 1 "$OUT/thumbs/og.jpg"
ff $(V) $(A) -t 6 "${X264[@]}" -b:v 1500k -c:a aac -movflags +faststart "$OUT/thumbs/direct.mp4"
ff $(V) $(A) -t 6 "${X264[@]}" -b:v 1500k -c:a aac "$OUT/thumbs/moovend.mp4"

# remux set for tests/test.mjs (t1: 250 video frames, AAC 48 kHz, 640 wide)
rm -rf "$REMUX/t1"; mkdir -p "$REMUX/t1"
cp "$OUT"/rx/t1/*.ts "$OUT/rx/t1/index.m3u8" "$REMUX/t1/"

echo "fixtures (full): $OUT  remux: $REMUX  ($(du -sh "$OUT" | cut -f1))"
