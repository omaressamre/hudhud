// Writes the Firefox build of the extension: same files, Firefox-flavoured manifest.
// Usage: node scripts/firefox-manifest.mjs <out-dir>   (copies extension/ there first)
import fs from 'node:fs';
import path from 'node:path';

export const GECKO_ID = 'hudhud@omaressamre.github.io';
export const UPDATE_URL = 'https://omaressamre.github.io/hudhud/firefox/updates.json';

export function firefoxManifest(m) {
  const out = structuredClone(m);
  delete out.key; // Chrome-only (fixed extension id)
  delete out.minimum_chrome_version;
  out.background = { scripts: [m.background.service_worker], type: 'module' }; // event page with a DOM
  out.permissions = m.permissions.filter((p) => p !== 'offscreen'); // offscreen.html runs in an iframe instead
  out.browser_specific_settings = {
    gecko: {
      id: GECKO_ID,
      strict_min_version: '140.0',
      update_url: UPDATE_URL,
      data_collection_permissions: { required: ['none'] },
    },
  };
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = process.argv[2];
  if (!dir) { console.error('usage: firefox-manifest.mjs <dir>'); process.exit(2); }
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.cpSync(path.join(root, 'extension'), dir, { recursive: true });
  const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(firefoxManifest(m), null, 2) + '\n');
  fs.rmSync(path.join(dir, 'fonts', 'README.md'), { force: true });
  console.log('firefox build:', dir);
}
