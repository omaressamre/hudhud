// Generates extension/_locales/<lang>/messages.json.
//   ar, en: from scripts/strings.mjs (key: [arabic, english]) — the source of truth.
//   other languages: from scripts/i18n/<lang>.mjs (key: 'text'), translated from the English.
// Every language must have every key, except Arabic-only plural forms (_two/_few/_many),
// which fall back to _other at runtime. tests/unit.mjs checks keys and placeholders.
import { writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import strings from './strings.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', 'extension', '_locales');
export const ARABIC_ONLY = /_(two|few|many)$/;

function write(lang, out) {
  mkdirSync(join(root, lang), { recursive: true });
  writeFileSync(join(root, lang, 'messages.json'), JSON.stringify(out, null, 2) + '\n');
}

for (const [i, lang] of ['ar', 'en'].entries()) {
  const out = {};
  for (const [key, vals] of Object.entries(strings)) {
    if (!/^[A-Za-z0-9_]+$/.test(key)) throw new Error(`bad key ${key}`);
    if (!Array.isArray(vals) || vals.length !== 2) throw new Error(`bad entry ${key}`);
    out[key] = { message: vals[i] };
  }
  write(lang, out);
}

const extra = readdirSync(join(here, 'i18n')).filter((f) => f.endsWith('.mjs')).map((f) => f.slice(0, -4)).sort();
for (const lang of extra) {
  const tr = (await import(pathToFileURL(join(here, 'i18n', lang + '.mjs')))).default;
  const out = {};
  for (const key of Object.keys(strings)) {
    if (ARABIC_ONLY.test(key)) continue;
    if (typeof tr[key] !== 'string') throw new Error(`${lang}: missing ${key}`);
    out[key] = { message: tr[key] };
  }
  for (const key of Object.keys(tr)) if (!(key in strings)) throw new Error(`${lang}: unknown key ${key}`);
  write(lang, out);
}
console.log(`locales: ${Object.keys(strings).length} keys · ${['ar', 'en', ...extra].join(', ')}`);
