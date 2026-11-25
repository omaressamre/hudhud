// تحليل ملفات m3u8 (HLS). بيرجع الجودات لو master، أو معلومات المقطع لو media playlist.

function parseAttrs(s) {
  const out = {};
  const re = /([A-Z0-9-]+)=("([^"]*)"|[^,]*)/g;
  let m;
  while ((m = re.exec(s))) out[m[1]] = m[3] !== undefined ? m[3] : m[2];
  return out;
}

function resolve(u, base) {
  try { return new URL(u, base).toString(); } catch { return u; }
}

export function parseM3U8(text, baseUrl) {
  if (!text || !text.trimStart().startsWith('#EXTM3U')) return null;
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  if (lines.some((l) => l.startsWith('#EXT-X-STREAM-INF'))) {
    const variants = [];
    const audio = [];
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (l.startsWith('#EXT-X-STREAM-INF:')) {
        const a = parseAttrs(l.slice(18));
        let j = i + 1;
        while (j < lines.length && lines[j].startsWith('#')) j++;
        if (j < lines.length) {
          const res = a.RESOLUTION || '';
          const height = Number((/x(\d+)/.exec(res) || [])[1]) || null;
          variants.push({ url: resolve(lines[j], baseUrl), bandwidth: Number(a.BANDWIDTH) || 0, resolution: res || null, height, codecs: a.CODECS || null, audioGroup: a.AUDIO || null });
          i = j;
        }
      } else if (l.startsWith('#EXT-X-MEDIA:')) {
        const a = parseAttrs(l.slice(13));
        if (a.TYPE === 'AUDIO' && a.URI) audio.push({ url: resolve(a.URI, baseUrl), group: a['GROUP-ID'], name: a.NAME, language: a.LANGUAGE || null, default: a.DEFAULT === 'YES' });
      }
    }
    variants.sort((x, y) => (y.height || 0) - (x.height || 0) || y.bandwidth - x.bandwidth);
    return { type: 'master', variants, audio };
  }

  let duration = 0, segments = 0, encrypted = null, live = true;
  for (const l of lines) {
    if (l.startsWith('#EXTINF:')) { duration += parseFloat(l.slice(8)) || 0; segments++; }
    else if (l.startsWith('#EXT-X-KEY:')) {
      const m = parseAttrs(l.slice(11)).METHOD;
      if (m && m !== 'NONE') encrypted = m; // AES-128 = تشفير HLS عادي، SAMPLE-AES غالباً DRM
    } else if (l.startsWith('#EXT-X-ENDLIST') || l.startsWith('#EXT-X-PLAYLIST-TYPE:VOD')) live = false;
  }
  return { type: 'media', duration: Math.round(duration), segments, encrypted, live };
}

export function qualityLabel(v) {
  if (v.height) return `${v.height}p`;
  if (v.bandwidth) return `${Math.round(v.bandwidth / 1000)} kbps`;
  return 'Default';
}

/**
 * تفاصيل media playlist للتحميل: الـsegments والتشفير والـinit segment (fMP4).
 * @returns {{segments: {url, seq, key, range}[], map: {url, range}|null, ended: boolean, drm: boolean, duration: number}}
 */
export function parseMediaPlaylist(text, baseUrl) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  let seq = 0, key = null, map = null, range = null, ended = false, drm = false, duration = 0;
  const lastEnd = new Map();
  const segments = [];
  const parseRange = (s, url) => {
    const [len, off] = s.split('@');
    const start = off !== undefined ? Number(off) : (lastEnd.get(url) || 0);
    const end = start + Number(len) - 1;
    lastEnd.set(url, end + 1);
    return { start, end };
  };
  for (const l of lines) {
    if (l.startsWith('#EXT-X-MEDIA-SEQUENCE:')) seq = Number(l.slice(22)) || 0;
    else if (l.startsWith('#EXT-X-KEY:')) {
      const a = parseAttrs(l.slice(11));
      if (!a.METHOD || a.METHOD === 'NONE') key = null;
      else if (a.METHOD === 'AES-128') key = { method: 'AES-128', uri: resolve(a.URI, baseUrl), iv: a.IV || null };
      else { drm = true; key = { method: a.METHOD }; }
    } else if (l.startsWith('#EXT-X-MAP:')) {
      const a = parseAttrs(l.slice(11));
      const url = resolve(a.URI, baseUrl);
      map = { url, range: a.BYTERANGE ? parseRange(a.BYTERANGE, url) : null };
    } else if (l.startsWith('#EXT-X-BYTERANGE:')) {
      range = l.slice(17);
    } else if (l.startsWith('#EXTINF:')) {
      duration += parseFloat(l.slice(8)) || 0;
    } else if (l === '#EXT-X-ENDLIST' || l === '#EXT-X-PLAYLIST-TYPE:VOD') {
      ended = true;
    } else if (!l.startsWith('#')) {
      const url = resolve(l, baseUrl);
      segments.push({ url, seq: seq + segments.length, key, range: range ? parseRange(range, url) : null });
      range = null;
    }
  }
  return { segments, map, ended, drm, duration: Math.round(duration) };
}

/** الـIV بتاع AES-128: من الـplaylist، أو رقم الـsegment كـ16 بايت big-endian */
export function ivFor(key, seq) {
  const iv = new Uint8Array(16);
  if (key.iv) {
    const hex = key.iv.replace(/^0x/i, '').padStart(32, '0');
    for (let i = 0; i < 16; i++) iv[i] = parseInt(hex.substr(i * 2, 2), 16);
  } else {
    let n = seq;
    for (let i = 15; i >= 8 && n > 0; i--) { iv[i] = n & 0xff; n = Math.floor(n / 256); }
  }
  return iv;
}
