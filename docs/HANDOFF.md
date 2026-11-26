# Hudhud — handoff

Snapshot: **2026-11-26, v0.9.7**. Give this file to the next Claude session first. It explains where the project stands, how to work on it, and what's left.

> **ملخص للمستخدم:** الملف ده بيشرح لأي محادثة جديدة مع Claude كل حاجة عن هدهد: الكود، والقرارات اللي خدناها، وإزاي بنطلّع إصدار، وإيه اللي فاضل. ابدأ المحادثة الجديدة بإنك تديها لينك الريبو وتقولها تقرا `docs/HANDOFF.md`.

---

## 1. What Hudhud is

A free video-downloader browser extension (Arabic name هدهد, "hoopoe"), a private rebuild of the Video DownloadHelper idea:

- **Extension (MV3)** for Chrome, Edge and Brave, and a **signed Firefox add-on**. It finds media on pages (direct files, HLS, DASH, FB/IG stories) and downloads them in the browser. HLS is remuxed to MP4 locally; stories (separate video and audio) are merged into one MP4.
- **Helper**: a Go native-messaging host (`com.hudhud.helper`) that runs **yt-dlp + ffmpeg + Deno**. It adds YouTube, playlists, MP3, subtitles and many more sites.
- **Installers** for Windows, macOS and Linux (per-user, no admin). They download the tools, register the helper with Chrome, Edge, Brave and Firefox, and copy the extension into the Hudhud folder.
- **One-click self-update** (Chrome family): the helper downloads the release, verifies it against SHA256SUMS, swaps the extension folder and its own binary, and the extension reloads itself. On Firefox, Firefox updates the add-on and the helper updates only itself.
- **Landing site** on GitHub Pages, in Arabic and English, light and dark.

### Links and IDs

| What | Value |
|---|---|
| Repo (public) | https://github.com/omaressamre/hudhud (owner GitHub user `omaressamre`) |
| Site | https://omaressamre.github.io/hudhud/ |
| Releases | https://github.com/omaressamre/hudhud/releases |
| Chrome extension ID | `gdcallopdofegjbibhflneideofehmpk` (fixed by the public `key` in `extension/manifest.json`) |
| Firefox add-on ID | `hudhud@omaressamre.github.io` (AMO internal id 3141183, **unlisted** channel) |
| Firefox update manifest | https://omaressamre.github.io/hudhud/firefox/updates.json |
| Native host name | `com.hudhud.helper` |
| Donations | InstaPay only: `https://ipn.eg/S/omaressamre/instapay` (GitHub Sponsors deliberately dropped) |
| GitHub secrets | `AMO_JWT_ISSUER`, `AMO_JWT_SECRET` (Mozilla signing keys, already set) |

---

## 2. Decisions — don't change these without asking the user

- **License GPL-3.0-only** for the code. The **name, logo and mascot are reserved** (`TRADEMARKS.md`): forks need their own name and artwork. The git history was squashed to one GPL commit before going public, so don't reintroduce MIT anywhere.
- **Never circumvent DRM.** DRM streams are detected and skipped.
- **Free, no ads, no telemetry.** The only network calls are listed in `PRIVACY.md`; keep that file true.
- **No Chrome Web Store** (it doesn't allow YouTube downloaders). Chrome users load the unpacked extension from the Hudhud folder with Developer mode on.
- **Firefox: unlisted signing** through AMO, self-hosted. We could submit to the AMO listing later; that needs the user's go-ahead.
- **Arabic first, English second.** UI copy is in Egyptian Arabic. Layout is RTL-first (logical CSS properties, `<bdi>` for mixed-direction values).
- **Extension languages:** ar, en, es, fr, pt_BR, tr (added 2026-11-26 at the user's request). ar+en live in `scripts/strings.mjs`; the others in `scripts/i18n/<lang>.mjs`, translated by Claude from the English. Every new string needs all six. Site, installers, `setup.html` and helper messages stay Arabic/English.
- **Release file names carry the version**: `hudhud-vX.Y.Z-{windows,macos,linux}.zip`, `hudhud-vX.Y.Z-extension-only.zip`, `hudhud-vX.Y.Z-firefox.xpi`. The old fixed names `hudhud-helper-{os}.zip` are still published as **copies** so helpers 0.9.0–0.9.3 can self-update. Drop them at **1.0**.
- **One version everywhere**: `extension/manifest.json` `version` must equal `helper/main.go` `Version`. The release workflow refuses a mismatch.

---

## 3. Repository map

```
extension/            MV3 extension (same source builds the Firefox add-on)
  background.js       detection, job queue, engines, notifications, menus, toolbar icon, update check, self-update
  engines/browser.js  in-browser downloads; offscreen document (Chrome) or hidden iframe (Firefox)
  engines/native.js   native messaging client (port, idle disconnect, disconnectNative)
  offscreen.js        HLS assembly (OPFS), TS→MP4, story merge, thumbnails
  lib/                detect, hls, ts2mp4, mp4merge, pair, naming, i18n (runtime, switchable), config (links), platform (IS_FIREFOX)
  ui/                 theme.css (tokens = Figma "Hudhud / Theme"), popup/options/welcome css, icons.js (SVG icons + mascot)
  popup.* options.* welcome.*   UI pages
  _locales/           GENERATED from scripts/strings.mjs — never edit by hand
helper/               Go helper: main.go (protocol, yt-dlp/ffmpeg), update.go (selfUpdate, helperOnly), lang.go (tr(ar,en))
installers/           install.{bat,ps1,sh,command}, uninstall.*, setup.html (post-install guide, bilingual)
scripts/              strings.mjs (all UI strings as key:[ar,en]), gen-locales.mjs, build.sh, fetch-fonts.sh,
                      firefox-manifest.mjs (Firefox build), firefox-updates.mjs (updates.json)
site/                 landing page (index.html + site.js + style.css), privacy.html; site/firefox/ is added at deploy
tests/                unit.mjs, run-all.sh, e2e*.py (Chrome/Playwright), firefox_e2e.py (Selenium), fixtures/gen.sh
.github/workflows/    ci.yml (quick suite + Firefox e2e), release.yml (manual), pages.yml (site)
docs/                 ARCHITECTURE.md, TESTING.md, HANDOFF.md (this file)
```

More detail: `docs/ARCHITECTURE.md`, `docs/TESTING.md`, `README.md`, `CONTRIBUTING.md`.

---

## 4. How things work (the non-obvious parts)

- **Strings:** add `key: ['عربي', 'English']` to `scripts/strings.mjs`, the same key to every `scripts/i18n/*.mjs`, and run `node scripts/gen-locales.mjs` (it fails on a missing key). Plurals use `_one/_two/_few/_many/_other`. Helper messages use `tr(ar, en)`.
- **Managed install (Chrome):** the installer writes the same random id to `<install>/install-id` and `<install>/extension/hudhud-install.json`. The extension fetches its own `hudhud-install.json` and compares it with `info().installId` from the helper. If they match, Chrome runs the copy in the Hudhud folder, so **Update now** works. If they don't, the popup shows **Get one-click updates** with the right folder path (`info().extDir`).
- **Install folders:** `%LOCALAPPDATA%\Hudhud`, `~/Library/Application Support/Hudhud`, `~/.local/share/hudhud`. Each holds the helper, tools, `install-id`, `extension/` and `setup.html`.
- **Update check:** at browser start (at most every 12 h), on install or reload, and from **Settings → About → Check for updates**. It reads GitHub `releases/latest`. On Chrome it compares the older of extension and helper; on Firefox only the helper.
- **Firefox differences:** the background is a module event page with a DOM, and `offscreen.html` runs in an iframe there. Notifications must not include a `buttons` key at all, or Firefox throws synchronously. The DNR `initiatorDomains` uses the extension's URL host (a UUID in Firefox). The helper is registered with `allowed_extensions` (Windows: `HKCU\Software\Mozilla\NativeMessagingHosts`; macOS/Linux: Mozilla's `NativeMessagingHosts` folder).
- **Download race:** small files can finish before the job stores its `downloadId`. `earlyDownloads` in `background.js` handles that, so keep it.

---

## 5. Releasing

1. Bump `version` in `extension/manifest.json` **and** `Version` in `helper/main.go`, and add a `## X.Y.Z — date` section to `CHANGELOG.md` with `### English` and `### العربية` points (short, for users). The release fails without it, and `tests/unit.mjs` checks it.
2. `tests/run-all.sh` must pass. Commit and push to `main`.
3. Start **Actions → Release → Run workflow** on `main`. From a Claude session: `gh api -X POST repos/omaressamre/hudhud/actions/workflows/release.yml/dispatches -f ref=main`.
4. The workflow:
   - checks the versions match;
   - builds all zips;
   - signs the Firefox add-on (`web-ext sign --channel=unlisted`, 2–5 min);
   - writes `updates.json`;
   - creates the tag and release `vX.Y.Z`;
   - dispatches `pages.yml`, which puts `hudhud.xpi` and `updates.json` under `site/firefox/`.

   Mozilla emails the user on each signing. That's normal, and "tentatively approved" is fine.
5. Users see **Update now** in the popup (Chrome, managed install) or get the update from Firefox.

---

## 6. Testing

- `tests/run-all.sh` (CI runs it): locales in sync, JS syntax, `tests/unit.mjs` (detection, naming, locales, Firefox manifest), `go test` (self-update: swap, checksum, legacy name, helper-only), `go vet` for linux, windows and darwin.
- `tests/run-all.sh --full` runs the Chrome e2e tests locally. It needs Chrome, Playwright, ffmpeg and a fixture site on `:8765`. The original big fixtures lived only in the old sandbox (`/home/claude/testsite`, not in the repo). `tests/fixtures/gen.sh` regenerates a small set (HLS + direct MP4), enough for the Firefox test. Recreating story/remux fixtures is still open.
- **Firefox e2e runs in CI only** (`firefox` job in `ci.yml`, Selenium + geckodriver on ubuntu-latest). CI runs on every branch push, so you can iterate on a branch.
- `tests/e2e10.py` tests the whole one-click update against a fake release. Chrome reload only works with Developer mode on, and the test sets that pref.
- Visual checks: `tests/ui_states.py` and `tests/ui_shots.py`.

---

## 7. Notes for the next Claude session (environment gotchas)

- Clone the repo, then work in it. Push with `git -c push.negotiate=true push origin main`.
- The session proxy **blocks**: creating or pushing tags, force-push, the Actions secrets API, and the Pages settings API. That's why releases go through the **workflow dispatch** above (the workflow creates the tag).
- Package installs (`pip`, `npm`) may be blocked in the sandbox; GitHub Actions has full network. Firefox isn't in the sandbox either, so test Firefox on a branch in CI.
- Background processes die between turns, so restart the fixture server (`python3 tests/serve.py <dir> 8765 &`) before e2e runs.
- WebDriver can't script `moz-extension://` pages; `firefox_e2e.py` uses a test-only content-script bridge.
- `extension/fonts` and `site/fonts` are fetched in CI (`scripts/fetch-fonts.sh`); locally the UI falls back to system fonts.
- The Chrome **private key** (`key.pem`) that matches the manifest `key` is **not** in the repo. It's only needed to pack a `.crx`, which we don't do. The user has a copy; never commit it.

---

## 8. Status and open items

**Waiting on the user**
- [x] **One-click update confirmed on Windows** (0.9.5 → 0.9.6, Chrome). The earlier "Get the update" was Chrome loading the extension from another folder; that is now in the site FAQ and the popup points to the right folder.
- [ ] Check **Firefox** by hand: popup and options look, helper status after running the 0.9.5+ installer (registers Firefox), real YouTube, story and HLS downloads.
- [ ] Test **macOS** at all (Gatekeeper may block the unsigned helper; document the bypass).

**Next work (agreed pre-launch list)**
- [x] **"Copy diagnostics" button**: `extension/lib/diagnostics.js` (scrubs URLs to host, paths, emails), Settings → About (Copy diagnostics + Report a problem), popup error block (Report a problem). Report a problem copies the text and opens the bug form with the `diagnostics` field prefilled. Not released yet.
- [x] **GitHub issue templates**: `.github/ISSUE_TEMPLATE/{bug,feature,config}.yml` (bilingual issue forms; blank issues off, FAQ link).
- [ ] Real-site **QA matrix** (YouTube, FB, IG, TikTok, X, HLS sites × Windows/macOS × Chrome/Edge/Firefox).
- [x] Site FAQ `#warnings` (SmartScreen, antivirus false positives, macOS Gatekeeper), linked from step 1 and the download box; README note; `install.bat` stops with a message when run from inside the zip (ships in the next release).
- [ ] **VirusTotal:** check the release files and submit false positives (Microsoft: https://www.microsoft.com/wdsi/filesubmission).
- [x] **Friendly error messages** (`lib/errors.js`) in the popup, job list and notifications, in the UI language. Unknown technical errors show `errUnknown`; the raw text stays for diagnostics.
- [x] Legal line on the site footer and the welcome page (`legalNote`).
- [x] `CHANGELOG.md` (English + Arabic per version). The release workflow publishes the version's section as the release notes; the update banner and the "updated to" banner show its points (`lib/changelog.js`).
- [x] GitHub Actions on Node 24: checkout, setup-node, setup-go @v7, configure-pages @v6, upload-pages-artifact @v5, deploy-pages @v5; Go cache off (no go.sum).
- [ ] Recreate story/remux fixtures in `tests/fixtures/gen.sh` so `--full` works anywhere.
- [ ] At **1.0**: stop publishing the legacy `hudhud-helper-{os}.zip` copies.

**Later / optional**
- InstaPay QR code next to the button (for desktop visitors).
- Submit the Firefox add-on to the public AMO listing (needs screenshots, description and review).
- Demo video, social images, Behance case study publish. Figma work is done; ask the user for the file link if needed.

---

## 9. Working with the user

- He writes **Egyptian Arabic**; answer in Egyptian Arabic, short and plain, with technical terms in English where natural.
- He is a **designer** (the Figma work is his), not a developer. Explain choices simply, give exact click paths (Settings → …) and ask for screenshots when debugging on his machine.
- He likes being told clearly what's done, what he needs to do, and what's next, without long recaps.
