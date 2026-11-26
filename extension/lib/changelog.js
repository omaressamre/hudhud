// Release notes for the update banner. The GitHub release body is the CHANGELOG.md section of that
// version (see scripts/changelog.mjs): "### English" and "### العربية" lists of "- " points.

/** Points of one language from a release body (Arabic for the Arabic UI, English otherwise). */
export function notesFor(body, lang, max = 4) {
  const want = lang === 'ar' ? /^###\s*(العربية|Arabic)\s*$/i : /^###\s*English\s*$/i;
  const out = [];
  let inside = false;
  for (const raw of String(body || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('#')) { inside = want.test(line); continue; }
    if (inside && /^[-*]\s+/.test(line)) out.push(line.replace(/^[-*]\s+/, '').replace(/\*\*|`/g, ''));
  }
  // a release without our sections (e.g. written by hand): no list rather than a wrong one
  return out.slice(0, max);
}

/** The CHANGELOG.md section for `version` (without its "## " heading), or '' */
export function changelogSection(md, version) {
  const lines = String(md || '').split(/\r?\n/);
  const start = lines.findIndex((l) => new RegExp(`^##\\s+v?${version.replace(/\./g, '\\.')}\\b`).test(l));
  if (start < 0) return '';
  let end = lines.findIndex((l, i) => i > start && /^##\s/.test(l));
  if (end < 0) end = lines.length;
  return lines.slice(start + 1, end).join('\n').trim();
}
