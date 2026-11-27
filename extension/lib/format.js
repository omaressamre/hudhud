// Small formatting/choice helpers shared by the popup and the background (tested in tests/unit.mjs).

export function fmtSize(b) {
  if (!b) return '';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return `${b.toFixed(i > 1 ? 1 : 0)} ${u[i]}`;
}

/**
 * Default quality for a page video: the user's last choice when it fits this video.
 * opts: menu options ({value:'v1080'|'v0'|'mp3'|'m4a'} or '-'); last: the stored choice.
 * A remembered height picks the highest available height at or below it, else the lowest one.
 */
export function pickQuality(opts, last) {
  const list = opts.filter((o) => o !== '-');
  if (!list.length) return '';
  if (!last) return list[0].value;
  if (list.some((o) => o.value === last)) return last;
  const want = /^v(\d+)$/.exec(last)?.[1];
  const vids = list.filter((o) => /^v\d+$/.test(o.value) && o.value !== 'v0').map((o) => Number(o.value.slice(1)));
  if (want && vids.length) {
    const fit = vids.filter((h) => h <= Number(want));
    return 'v' + (fit.length ? Math.max(...fit) : Math.min(...vids));
  }
  return list[0].value;
}
