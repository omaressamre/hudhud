// Hudhud landing page: language + theme switching, release info.
// Arabic copy lives in index.html; English copy lives here. Donation links are edited in index.html.
const REPO = 'omaressamre/hudhud';

const EN = {
  skip: 'Skip to content',
  name: 'Hudhud',
  navFeatures: 'Features', navHow: 'How it works', navDownload: 'Download', navFaq: 'FAQ',
  otherLang: 'عربي',
  toggleTheme: 'Toggle dark mode',
  eyebrow: 'Free · No ads · For Chrome and Edge',
  heroTitle: 'Saw a video?<br><em>Hudhud</em> saves it.',
  heroLead: 'An extension that spots the videos on a page while you watch and downloads them in one click: YouTube and playlists, Facebook and Instagram stories, and HLS streams as a regular MP4.',
  ctaGet: 'Get Hudhud', ctaHow: 'How do I install it?',
  tick1: 'Arabic and English', tick2: 'Dark mode', tick3: 'Collects no data',
  shotAlt: 'The Hudhud popup showing a YouTube video ready to download and three downloads in progress',
  featTitle: 'Everything you need to keep a video',
  f1t: 'Finds it for you', f1d: 'Play the video and the icon lights up. No hunting for links, no developer tools.',
  f2t: 'YouTube and playlists', f2d: 'Pick any quality up to 4K, or grab the whole playlist at once. (With the helper.)',
  f3t: 'Stories, with sound', f3d: 'Facebook and Instagram stories arrive as separate video and audio — Hudhud merges them into one file, right in the browser.',
  f4t: 'HLS to MP4', f4d: 'Segmented streams are stitched together and converted to MP4 on your computer. Nothing is uploaded anywhere.',
  f5t: 'MP3 and subtitles', f5d: 'Download just the audio, and save subtitles, the thumbnail and metadata alongside the video if you like.',
  f6t: 'Private by design', f6d: 'No accounts, no tracking, no ads. Everything happens on your computer.',
  howTitle: 'Three steps and you’re set',
  s1t: 'Download Hudhud and run the installer', s1d: 'One file with the extension and the helper. Unzip it and run the installer; it fetches the rest. No admin rights needed.',
  s2t: 'Add the extension to your browser', s2d: 'A guide opens by itself: turn on “Developer mode” and pick the Hudhud folder. You do this once; after that, updates are one click inside the extension.',
  s3t: 'Press download', s3d: 'Open any video, click the Hudhud icon and pick a quality. The file lands in your Downloads folder.',
  dlTitle: 'Download', dlSub: 'Hudhud isn’t in the Chrome Web Store — you get it straight from here. Latest release:',
  dlMain: 'Download Hudhud', dlMainSub: 'Extension + helper · Chrome · Edge · Brave',
  dlExtOnly: 'Just the extension, without the helper (advanced)',
  osWin: 'install.bat', osMac: 'install.command', osLinux: 'bash install.sh',
  dlNote: 'The helper uses yt-dlp, ffmpeg and Deno, downloaded from their official sources during install.',
  drm: '<strong>Hudhud doesn’t break copy protection.</strong> Encrypted (DRM) videos such as Netflix or Shahid are recognised and skipped.',
  supTitle: 'Hudhud is free, and will stay free',
  supSub: 'If it saves you time, you can help us keep working on it. Every bit counts.',
  faqTitle: 'Frequently asked',
  q1: 'Is it really free?', a1: 'Yes — completely free and ad-free. The code is open under the GPL-3.0 license.',
  q2: 'Why isn’t it in the Chrome Web Store?', a2: 'The Chrome Web Store doesn’t allow extensions that download from YouTube, so we publish it here. Installing takes a minute.',
  q3: 'Do I need the helper?', a3: 'The installer sets up both, which is the easiest way. The extension alone downloads direct videos, stories and HLS; the helper adds YouTube, playlists, MP3, subtitles and many more sites.',
  q6: 'How do I update Hudhud?', a6: 'When a new version is out, an “Update now” button appears inside the extension. It updates the extension and the helper together in under a minute.',
  q4: 'Does it work on Edge and Brave?', a4: 'Yes, on any Chromium browser: Chrome, Edge, Brave, Vivaldi.',
  q5: 'Is it safe?', a5: 'The helper installs for your user only, without admin rights, and only talks to our extension. All the code is open for you to review.',
  privacy: 'Privacy',
  version: (v) => `Version ${v}`,
  title: 'Hudhud — download any video from your browser',
};
const AR_EXTRA = { version: (v) => `الإصدار ${v}`, title: 'هدهد · Hudhud — نزّل أي فيديو من المتصفح' };

const root = document.documentElement;
const AR = {};
const save = (k, v) => { try { const s = JSON.parse(localStorage.getItem('hh-site') || '{}'); s[k] = v; localStorage.setItem('hh-site', JSON.stringify(s)); } catch (e) {} };

function snapshotArabic() {
  document.querySelectorAll('[data-i18n]').forEach((el) => { AR[el.dataset.i18n] ??= el.innerHTML; });
  document.querySelectorAll('[data-i18n-aria]').forEach((el) => { AR[el.dataset.i18nAria] ??= el.getAttribute('aria-label'); });
  document.querySelectorAll('[data-i18n-alt]').forEach((el) => { AR[el.dataset.i18nAlt] ??= el.getAttribute('alt') || 'نافذة هدهد'; });
}

function applyLang(lang) {
  const dict = lang === 'en' ? EN : AR;
  root.lang = lang; root.dir = lang === 'ar' ? 'rtl' : 'ltr';
  document.querySelectorAll('[data-i18n]').forEach((el) => { const v = dict[el.dataset.i18n]; if (v != null) el.innerHTML = v; });
  document.querySelectorAll('[data-i18n-aria]').forEach((el) => el.setAttribute('aria-label', dict[el.dataset.i18nAria]));
  document.querySelectorAll('[data-i18n-alt]').forEach((el) => el.setAttribute('alt', dict[el.dataset.i18nAlt]));
  document.title = (lang === 'en' ? EN : AR_EXTRA).title;
  updateShot(); updateVersion(); setOsName();
}

function updateShot() {
  document.querySelectorAll('[data-shot]').forEach((img) => { img.src = `assets/popup-${root.lang}-${root.dataset.theme}.webp`; });
}

let release = null;
const OSNAME = { windows: 'Windows', macos: 'macOS', linux: 'Linux' };
const OSNAME_AR = { windows: 'ويندوز', macos: 'ماك', linux: 'لينكس' };
let detectedOs = '';
function setOsName() {
  const el = document.querySelector('[data-osname]');
  if (el && detectedOs) el.textContent = root.lang === 'en' ? 'for ' + OSNAME[detectedOs] : 'ل' + OSNAME_AR[detectedOs];
}
function updateVersion() {
  const el = document.querySelector('small[data-release]');
  if (!el || !release) return;
  const base = root.lang === 'en' ? EN.dlMainSub : AR.dlMainSub;
  el.textContent = `${base} · ${(root.lang === 'en' ? EN : AR_EXTRA).version(release.tag)}`;
}

async function loadRelease() {
  try {
    const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' } });
    if (!r.ok) return;
    const j = await r.json();
    const assets = j.assets || [];
    const find = (re) => assets.find((a) => re.test(a.name));
    release = { tag: String(j.tag_name || '').replace(/^v/, '') };
    const ext = find(/^hudhud-v[\d.]+-extension-only\.zip$/) || find(/^hudhud-extension-.*\.zip$/);
    if (ext) document.querySelector('[data-extonly]').href = ext.browser_download_url;
    document.querySelectorAll('.os-card').forEach((card) => {
      const a = find(new RegExp(`^hudhud-v[\\d.]+-${card.dataset.os}\\.zip$`));
      if (a) card.href = a.browser_download_url;
    });
    const mine = document.querySelector('.os-card.mine');
    if (mine) document.querySelector('[data-bundle]').href = mine.href;
    updateVersion();
  } catch (e) { /* offline or rate-limited: keep the releases page link */ }
}

function markOs() {
  const ua = navigator.userAgent;
  const os = /Windows/.test(ua) ? 'windows' : /Mac OS X/.test(ua) ? 'macos' : /Linux|X11/.test(ua) ? 'linux' : '';
  const card = os && document.querySelector(`.os-card[data-os="${os}"]`);
  if (card) {
    card.classList.add('mine');
    document.querySelector('[data-bundle]').href = card.href;
    detectedOs = os; setOsName();
  }
}

function hidePlaceholders() {
  document.querySelectorAll('[data-donate]').forEach((a) => { if (/INSTAPAY_HANDLE|example\.com/.test(a.href)) a.hidden = true; });
}

snapshotArabic();
if (root.lang === 'en') applyLang('en'); else updateShot();
markOs(); hidePlaceholders(); loadRelease();

document.getElementById('lang').addEventListener('click', () => {
  const next = root.lang === 'ar' ? 'en' : 'ar';
  applyLang(next); save('lang', next);
  const u = new URL(location.href); u.searchParams.delete('lang'); history.replaceState(null, '', u);
});
document.getElementById('theme').addEventListener('click', () => {
  const next = root.dataset.theme === 'dark' ? 'light' : 'dark';
  root.dataset.theme = next; save('theme', next); updateShot();
});
