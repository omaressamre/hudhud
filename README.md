<p align="center"><img src="extension/assets/icon.svg" width="96" alt=""></p>

<h1 align="center">Hudhud · هدهد</h1>

<p align="center">A free browser extension that finds the videos on a page and downloads them.<br>
إضافة مجانية للمتصفح بتلاقي الفيديوهات في الصفحة وتنزّلها.</p>

---

## What it does

- Finds videos as they play (direct files, HLS and DASH streams) and lists them in the popup.
- Downloads them **in the browser** — HLS is converted to a real MP4 locally, and Facebook / Instagram stories are merged (video + audio) without any upload.
- With the optional **Hudhud Helper** (a small native app running yt-dlp, ffmpeg and Deno) it also handles YouTube and other sites yt-dlp supports, playlists, audio-only MP3, subtitles and metadata.
- Arabic and English UI (switchable without restarting), light and dark themes.
- No accounts, no tracking, no ads. See [PRIVACY.md](PRIVACY.md).

Hudhud does **not** circumvent DRM. Encrypted streams (Netflix, Shahid, etc.) are detected and skipped.

## Install

Hudhud is not in the Chrome Web Store. Get it from the [latest release](https://github.com/omaressamre/hudhud/releases/latest) — one zip per system contains both the extension and the helper:

| System | Download | Run |
|---|---|---|
| Windows | `hudhud-vX.Y.Z-windows.zip` | `install.bat` |
| macOS | `hudhud-vX.Y.Z-macos.zip` | `install.command` |
| Linux | `hudhud-vX.Y.Z-linux.zip` | `bash install.sh` |

1. Unzip and run the installer. It is per-user (no admin), downloads yt-dlp, ffmpeg and Deno, registers the helper with Chrome, Edge and Brave, and copies the extension to the Hudhud folder (`%LOCALAPPDATA%\Hudhud\extension`, `~/Library/Application Support/Hudhud/extension` or `~/.local/share/hudhud/extension`).
2. A setup page opens: in `chrome://extensions` turn on **Developer mode**, click **Load unpacked** and pick that folder. You only do this once.
3. **Updates:** when a new release is out, the popup shows **Update now**. The helper downloads the release for your system, checks it against `SHA256SUMS.txt`, replaces the extension folder and itself, and the extension reloads.

`hudhud-vX.Y.Z-extension-only.zip` is the extension alone, for people who don't want the helper (it can't update itself). Uninstall with the matching `uninstall` script, then remove Hudhud from `chrome://extensions`.

### Firefox

Install the signed add-on from the [site](https://omaressamre.github.io/hudhud/#download) (Firefox 140 or newer). It updates itself through Firefox. For YouTube and playlists also run the installer for your system above — it registers the helper with Firefox too, and the add-on updates the helper with one click.

> Coming from the old **VidSaver** build? Run its uninstaller first — Hudhud uses a new helper name (`com.hudhud.helper`) and folder.

## Repository layout

| Path | What |
|---|---|
| `extension/` | MV3 extension: service worker, popup, options, welcome, offscreen converter |
| `helper/` | Go native-messaging helper (`com.hudhud.helper`) |
| `installers/` | Per-user installers for Windows, macOS, Linux |
| `scripts/` | `gen-locales.mjs` (strings → `_locales`), `fetch-fonts.sh`, `build.sh`, `firefox-manifest.mjs` (Firefox build), `firefox-updates.mjs` |
| `tests/` | Unit tests and Chrome end-to-end tests |
| `site/` | Static landing page (GitHub Pages) |
| `docs/` | Architecture and testing notes |

## Develop

```bash
node scripts/gen-locales.mjs     # after editing scripts/strings.mjs
scripts/fetch-fonts.sh           # brand fonts (optional; falls back to system fonts)
tests/run-all.sh                 # quick checks (what CI runs)
tests/run-all.sh --full          # + Chrome end-to-end tests (see docs/TESTING.md)
scripts/build.sh                 # release zips in dist/
```

UI strings live only in `scripts/strings.mjs` as `key: [arabic, english]`. Don't edit `_locales/*/messages.json` by hand.

## Releasing

Bump `version` in `extension/manifest.json` and `Version` in `helper/main.go` (they must match), then push a tag `vX.Y.Z`. The release workflow builds the zips and publishes a GitHub release. The extension checks `releases/latest` to tell users when a newer helper is out.

## Support

Hudhud is free. If it saves you time, you can support it — links are in the extension's options page and on the [site](https://omaressamre.github.io/hudhud/).

## License

Hudhud is free software: you can redistribute it and/or modify it under the terms of the [GNU General Public License v3](LICENSE) (GPL-3.0-only). Copyright © 2026 Omar Essam.

The name **Hudhud / هدهد**, the logo and the hoopoe mascot are **not** covered by the GPL — see [TRADEMARKS.md](TRADEMARKS.md). Forks are welcome under their own name and artwork.

yt-dlp (Unlicense), ffmpeg (LGPL/GPL) and Deno (MIT) are downloaded by the installer from their official releases and are not bundled here.
