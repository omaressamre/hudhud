// Generates extension/_locales/{ar,en}/messages.json from scripts/strings.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import strings from './strings.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'extension', '_locales');
for (const [i, lang] of ['ar', 'en'].entries()) {
  const out = {};
  for (const [key, vals] of Object.entries(strings)) {
    if (!/^[A-Za-z0-9_]+$/.test(key)) throw new Error(`bad key ${key}`);
    if (!Array.isArray(vals) || vals.length !== 2) throw new Error(`bad entry ${key}`);
    out[key] = { message: vals[i] };
  }
  mkdirSync(join(root, lang), { recursive: true });
  writeFileSync(join(root, lang, 'messages.json'), JSON.stringify(out, null, 2) + '\n');
}
console.log(`locales: ${Object.keys(strings).length} keys`);
