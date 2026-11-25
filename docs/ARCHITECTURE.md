# Architecture

```
 page ──webRequest──▶ background.js (service worker) ◀──messages──▶ popup / options / welcome
                         │        │
                         │        ├─▶ engines/browser.js ─▶ offscreen.html (HLS→MP4, story merge, OPFS)
                         │        │
                         │        └─▶ engines/native.js ─native messaging─▶ hudhud-helper (Go)
                         │                                                   ├─ yt-dlp (+ Deno for YouTube JS)
                         └─ content.js (page scan, colour scheme)            └─ ffmpeg
```

## Extension (`extension/`)

- **background.js** — detects media from `webRequest`, keeps per-tab item lists, runs the job queue, picks an engine per item, owns notifications, the context menu, the toolbar icon (idle/active × light/dark) and the update check. Strings via `lib/i18n.js`.
- **engines/browser.js + offscreen.js** — in-browser downloads. HLS segments are fetched and remuxed to MP4 by `lib/ts2mp4.js`; separate video/audio (FB/IG stories) are paired by `lib/pair.js` and merged by `lib/mp4merge.js`. Data is staged in OPFS, then saved with `chrome.downloads`.
- **engines/native.js** — talks to the helper over Native Messaging (`com.hudhud.helper`): `info`, `probe`, `download`, `cancel`, `reveal`, `chooseFolder`, `update`, `config`.
- **lib/i18n.js** — runtime i18n: loads `_locales/<lang>/messages.json` with `fetch` so the language can change without a browser restart; plural keys `key_one/_two/_few/_many/_other` via `Intl.PluralRules`; sets `dir`.
- **ui/theme.css** — design tokens matching the Figma variables; dark mode with `:root[data-theme=dark]`.
- **lib/config.js** — repo, site and donation links in one place.

The extension ID is fixed through the manifest `key`, so the helper's `allowed_origins` is stable. The private key that matches it is **not** in this repository.

## Helper (`helper/`)

A single static Go binary. Reads length-prefixed JSON from stdin, runs yt-dlp/ffmpeg as child processes (argv, no shell), streams progress back, and kills the process tree on cancel. Messages are localized with `tr(ar, en)` according to the `lang` sent in `config`.

## Versions

`extension/manifest.json` `version` and `helper/main.go` `Version` are always equal and match the git tag `vX.Y.Z`.

## Firefox

`scripts/firefox-manifest.mjs` turns the same source into the Firefox build: background as a module event page, no `offscreen` permission, `browser_specific_settings.gecko` (id `hudhud@omaressamre.github.io`, update URL on the site). Firefox has no offscreen API, so `engines/browser.js` loads `offscreen.html` in a hidden iframe of the background page; messages are the same. The release workflow signs the build as an unlisted add-on (`web-ext sign`, keys in `AMO_JWT_ISSUER`/`AMO_JWT_SECRET`) and the site serves `firefox/hudhud.xpi` and `firefox/updates.json`. The helper is registered for Firefox with `allowed_extensions`; on Firefox the self-update replaces only the helper (`helperOnly`).
