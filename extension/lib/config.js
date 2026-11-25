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


export const releaseAsset = (os) => {
  const name = os === 'mac' ? 'hudhud-helper-macos.zip' : os === 'win' ? 'hudhud-helper-windows.zip' : 'hudhud-helper-linux.zip';
  return `https://github.com/${CONFIG.repo}/releases/latest/download/${name}`;
};
export const releasesPage = () => `https://github.com/${CONFIG.repo}/releases/latest`;
export const latestReleaseApi = () => `https://api.github.com/repos/${CONFIG.repo}/releases/latest`;
