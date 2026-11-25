# Testing

## Quick suite (CI)

```bash
tests/run-all.sh
```

Checks that `_locales` is generated from `scripts/strings.mjs`, that every JS file parses, runs `tests/unit.mjs` (detection, naming, locale key/placeholder parity), `go test` (self-update: swap, checksum, incomplete package) and `go vet` for linux, windows and darwin.

## Full suite (local)

```bash
HH_SITE=/path/to/fixtures/site HH_REMUX=/path/to/fixtures/remux tests/run-all.sh --full
```

Needs Google Chrome, Python 3 with Playwright, ffmpeg/ffprobe and Go. It serves the fixtures with `tests/serve.py` on port 8765 and runs:

| Test | Covers |
|---|---|
| `e2e.py` | direct file download in the browser |
| `e2e2.py` | native helper download from the popup |
| `e2e3.py` | FB/IG story pairing and merge |
| `e2e4.py` | HLS → MP4 in the browser |
| `e2e5.py` | context menu entries |
| `e2e6.py` | TS→MP4 remux is byte-identical to ffmpeg; HEVC falls back to TS |
| `e2e7.py` | MP4 merge is identical to ffmpeg |
| `e2e8.py` | YouTube page item and thumbnails |
| `e2e9.py` | helper installed by `installers/install.sh` (set `HH_INSTALL_HOME`) |
| `e2e10.py` | one-click update: extension loaded from the install folder, helper swaps both from a fake release, extension reloads (`HH_INSTALL_HOME`, `HH_BUNDLE`) |

The media fixtures (a few hundred MB of generated test videos and HLS playlists) are **not** in the repository. Point `HH_SITE` / `HH_REMUX` at your copy, or put them in `tests/.fixtures/` (git-ignored). `tests/fakebin/yt-dlp` is a fake yt-dlp that the helper tests use instead of the network.

## Visual checks

`tests/ui_shots.py` and `tests/ui_states.py` screenshot the popup, options and welcome pages in Arabic/English × light/dark into `HH_SHOTS` (default `/tmp/hh-test-shots`) for comparison with the Figma frames.

## Firefox

CI runs `tests/firefox_e2e.py` in headless Firefox with geckodriver and Selenium, on fixtures made by `tests/fixtures/gen.sh` (needs ffmpeg). WebDriver can't script `moz-extension://` pages, so the test adds a content-script bridge to a copy of the build (never shipped). It checks install, the helper over native messaging, HLS → MP4 through the offscreen iframe, and a direct download. `web-ext lint` runs on the same build.
