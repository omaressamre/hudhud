// Prints the Firefox update manifest for a release tag (served at site/firefox/updates.json).
//   node scripts/firefox-updates.mjs v1.2.3
import { GECKO_ID } from './firefox-manifest.mjs';
const tag = process.argv[2];
if (!/^v\d+\.\d+\.\d+$/.test(tag || '')) { console.error('usage: firefox-updates.mjs vX.Y.Z'); process.exit(2); }
const link = `https://github.com/omaressamre/hudhud/releases/download/${tag}/hudhud-${tag}-firefox.xpi`;
console.log(JSON.stringify({ addons: { [GECKO_ID]: { updates: [{ version: tag.slice(1), update_link: link }] } } }, null, 2));
