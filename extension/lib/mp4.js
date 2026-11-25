// قراءة رأس ملف MP4 (أول كام KB) عشان نعرف: صورة ولا صوت، الأبعاد، والمدة.
// فيسبوك وانستجرام بيبعتوا الصورة والصوت في ملفين منفصلين، فده بيفرّق بينهم.

const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'mvex', 'minf', 'stbl', 'edts']);

function type(view, off) {
  return String.fromCharCode(view.getUint8(off), view.getUint8(off + 1), view.getUint8(off + 2), view.getUint8(off + 3));
}

function u64(view, off) {
  return view.getUint32(off) * 2 ** 32 + view.getUint32(off + 4);
}

function walk(view, start, end, cb, path = []) {
  let off = start;
  while (off + 8 <= end) {
    let size = view.getUint32(off);
    const t = type(view, off + 4);
    let header = 8;
    if (size === 1) {
      if (off + 16 > end) return;
      size = u64(view, off + 8);
      header = 16;
    } else if (size === 0) {
      size = end - off;
    }
    if (size < header) return;
    const boxEnd = Math.min(off + size, end);
    cb(t, off + header, boxEnd, path);
    if (CONTAINERS.has(t)) walk(view, off + header, boxEnd, cb, [...path, t]);
    if (off + size > end) return; // الملف متقطع
    off += size;
  }
}

/**
 * @param {ArrayBuffer} buf
 * @returns {null | {tracks: {type:'video'|'audio', width?:number, height?:number}[], duration: number|null}}
 */
export function sniffMp4(buf) {
  const view = new DataView(buf);
  if (buf.byteLength < 16) return null;
  const first = type(view, 4);
  if (!['ftyp', 'moov', 'styp', 'sidx', 'free'].includes(first)) return null;

  const tracks = [];
  let cur = null;
  let timescale = 0;
  let duration = 0;
  let fragDuration = 0;

  walk(view, 0, buf.byteLength, (t, p, end) => {
    try {
      if (t === 'mvhd') {
        const v = view.getUint8(p);
        if (v === 1) { timescale = view.getUint32(p + 20); duration = u64(view, p + 24); }
        else { timescale = view.getUint32(p + 12); duration = view.getUint32(p + 16); }
      } else if (t === 'mehd') {
        const v = view.getUint8(p);
        fragDuration = v === 1 ? u64(view, p + 4) : view.getUint32(p + 4);
      } else if (t === 'trak') {
        cur = { type: null };
        tracks.push(cur);
      } else if (t === 'tkhd' && cur) {
        const v = view.getUint8(p);
        const wOff = p + (v === 1 ? 88 : 76);
        if (wOff + 8 <= end) {
          cur.width = view.getUint32(wOff) >>> 16;
          cur.height = view.getUint32(wOff + 4) >>> 16;
        }
      } else if (t === 'hdlr' && cur) {
        const h = type(view, p + 8);
        if (h === 'vide') cur.type = 'video';
        else if (h === 'soun') cur.type = 'audio';
      }
    } catch {}
  });

  const known = tracks.filter((x) => x.type);
  if (!known.length) return null;
  for (const t of known) if (t.type === 'audio') { delete t.width; delete t.height; }
  const d = duration || fragDuration;
  return { tracks: known, duration: timescale && d ? Math.round((d / timescale) * 10) / 10 : null };
}
