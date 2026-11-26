// Prints the CHANGELOG.md section of a version, for the GitHub release notes.
//   node scripts/changelog.mjs 0.9.7   (exits 1 when the version has no section)
import { readFileSync } from 'node:fs';
import { changelogSection } from '../extension/lib/changelog.js';

const version = String(process.argv[2] || '').replace(/^v/, '');
const md = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
const section = changelogSection(md, version);
if (!section) {
  console.error(`CHANGELOG.md has no section for ${version}`);
  process.exit(1);
}
console.log(section);
