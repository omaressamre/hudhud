// Project links in one place. Change these before publishing.
export const CONFIG = {
  // GitHub "owner/repo" used for release downloads and update checks.
  repo: 'omaressamre/hudhud',
  // Public website (GitHub Pages by default).
  site: 'https://omaressamre.github.io/hudhud/',
  // Donations
  instapay: 'https://ipn.eg/S/omaressamre/instapay',
  // Show the support banner after this many finished downloads (and again every N after a dismiss).
  supportAfter: 20,
  // A short public video used by the welcome page "try it" button.
  testVideo: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ',
};


/** New bug report on GitHub, with the diagnostics field filled in (issue form: .github/ISSUE_TEMPLATE/bug.yml). */
export const bugReportUrl = (diagnostics = '') =>
  `https://github.com/${CONFIG.repo}/issues/new?template=bug.yml` + (diagnostics ? '&diagnostics=' + encodeURIComponent(diagnostics) : '');
export const releasesPage = () => `https://github.com/${CONFIG.repo}/releases/latest`;
export const latestReleaseApi = () => `https://api.github.com/repos/${CONFIG.repo}/releases/latest`;

const OS_ZIP = { win: 'windows', mac: 'macos', linux: 'linux' };
/**
 * Download link for the latest package for `os` ('win' | 'mac' | 'linux').
 * Files are named hudhud-vX.Y.Z-<os>.zip, so the name comes from the release; falls back to the releases page.
 */
export async function releaseAsset(os) {
  const want = new RegExp(`^hudhud-v[\\d.]+-${OS_ZIP[os] || 'linux'}\\.zip$`);
  try {
    const r = await fetch(latestReleaseApi(), { headers: { Accept: 'application/vnd.github+json' } });
    if (r.ok) {
      const a = ((await r.json()).assets || []).find((x) => want.test(x.name));
      if (a) return a.browser_download_url;
    }
  } catch {}
  return releasesPage();
}
export const openReleaseAsset = async (os) => chrome.tabs.create({ url: await releaseAsset(os) });
