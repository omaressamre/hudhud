// تصنيف الـresponses: هل ده فيديو مباشر، ولا HLS، ولا DASH، ولا حاجة نتجاهلها.
// دالة "نقية" (من غير chrome APIs) عشان نقدر نختبرها بـnode.

const DIRECT_EXT = /\.(mp4|m4v|webm|mov|mkv|flv|avi|ogv|3gp|mp3|m4a|ogg|opus|wav|flac)$/i;
const SEGMENT_EXT = /\.(ts|m4s|aac|vtt|webvtt|key|cmfv|cmfa)$/i;
const HLS_MIME = /(mpegurl|vnd\.apple\.mpegurl)/i;
const DASH_MIME = /dash\+xml/i;
const DIRECT_MIME = /^(video|audio)\//i;
const IGNORED_MIME = /^(video\/mp2t|video\/iso\.segment|audio\/aac)$/i;

// مواقع بتقطّع الفيديو لـrange requests، تحميلها صح محتاج yt-dlp ("فحص الصفحة")
// + سيرفرات إعلانات الفيديو
const IGNORED_HOSTS = [
  /(^|\.)googlevideo\.com$/i,
  /(^|\.)(doubleclick\.net|googlesyndication\.com|googleadservices\.com|2mdn\.net|imasdk\.googleapis\.com)$/i,
  /(^|\.)(adnxs\.com|moatads\.com|springserve\.com|spotxchange\.com|innovid\.com|teads\.tv|serving-sys\.com|adsrvr\.org)$/i,
];

// فيسبوك وانستجرام: الملف بيتطلب حتت بـbytestart/byteend، والصورة والصوت منفصلين
const SPLIT_HOSTS = /(^|\.)(fbcdn\.net|cdninstagram\.com)$/i;

function b64urlJson(s) {
  try {
    const b = s.replace(/-/g, '+').replace(/_/g, '/');
    const txt = typeof atob === 'function' ? atob(b + '==='.slice((b.length + 3) % 4)) : Buffer.from(b, 'base64').toString('binary');
    return JSON.parse(decodeURIComponent(escape(txt)));
  } catch { return null; }
}

/** معلومات من بارامتر efg (Base64 JSON) في لينكات فيسبوك/انستجرام */
export function parseEfg(u) {
  const efg = u.searchParams.get('efg');
  const o = efg ? b64urlJson(efg) : null;
  if (!o) return {};
  const tag = String(o.vencode_tag || '');
  const out = {};
  if (tag) out.track = /audio/i.test(tag) ? 'audio' : 'video';
  const h = /(\d{3,4})p\b/.exec(tag);
  if (h) out.height = Number(h[1]);
  const asset = o.xpv_asset_id || o.video_id || o.asset_id;
  if (asset) out.assetId = String(asset);
  return out;
}

export function isSplitHost(url) {
  try { return SPLIT_HOSTS.test(new URL(url).hostname); } catch { return false; }
}

/** اللينك الكامل للملف (من غير bytestart/byteend) */
export function normalizeSplitUrl(url) {
  try {
    const u = new URL(url);
    u.searchParams.delete('bytestart');
    u.searchParams.delete('byteend');
    return u.toString();
  } catch { return url; }
}

export function headerValue(headers, name) {
  if (!headers) return undefined;
  const n = name.toLowerCase();
  const h = headers.find((x) => x.name.toLowerCase() === n);
  return h ? h.value : undefined;
}

export function totalSize(headers) {
  const cr = headerValue(headers, 'content-range'); // bytes 0-1023/123456
  if (cr) {
    const m = /\/(\d+)\s*$/.exec(cr);
    if (m) return Number(m[1]);
  }
  const cl = headerValue(headers, 'content-length');
  return cl && /^\d+$/.test(cl) ? Number(cl) : null;
}

function pathOf(url) {
  try { return new URL(url).pathname; } catch { return ''; }
}

/**
 * @returns {null | {kind:'direct'|'hls'|'dash', mime:string, size:number|null}}
 */
export function classify(url, headers, { minSize = 1024 * 1024 } = {}) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  if (IGNORED_HOSTS.some((re) => re.test(u.hostname))) return null;

  const mime = (headerValue(headers, 'content-type') || '').split(';')[0].trim().toLowerCase();
  const path = u.pathname;
  const size = totalSize(headers);

  if (SPLIT_HOSTS.test(u.hostname) && (DIRECT_MIME.test(mime) || /\.(mp4|m4a)$/i.test(path))) {
    const efg = parseEfg(u);
    const track = efg.track || (/^audio\//.test(mime) ? 'audio' : null);
    return {
      kind: 'direct', mime: track === 'audio' ? 'audio/mp4' : 'video/mp4', size: null,
      url: normalizeSplitUrl(url), split: true, track, height: efg.height || null, assetId: efg.assetId || null,
    };
  }

  if (HLS_MIME.test(mime) || /\.m3u8$/i.test(path)) return { kind: 'hls', mime: mime || 'application/vnd.apple.mpegurl', size };
  if (DASH_MIME.test(mime) || /\.mpd$/i.test(path)) return { kind: 'dash', mime: mime || 'application/dash+xml', size };

  if (SEGMENT_EXT.test(path) || IGNORED_MIME.test(mime)) return null;
  // قطع فيديو متقسمة بالـquery (range=, bytestart=)
  if (/[?&](range|bytestart|bytes)=/i.test(u.search)) return null;

  const looksDirect = DIRECT_MIME.test(mime) || (DIRECT_EXT.test(path) && (!mime || mime === 'application/octet-stream'));
  if (!looksDirect) return null;
  if (size !== null && size < minSize) return null;
  return { kind: 'direct', mime: mime || guessMime(path), size };
}

export function guessMime(path) {
  const ext = (/\.([a-z0-9]+)$/i.exec(path) || [])[1]?.toLowerCase();
  const map = { mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mkv: 'video/x-matroska',
    flv: 'video/x-flv', ogv: 'video/ogg', mp3: 'audio/mpeg', m4a: 'audio/mp4', ogg: 'audio/ogg', opus: 'audio/opus', wav: 'audio/wav', flac: 'audio/flac' };
  return map[ext] || 'video/mp4';
}

export function extFor(url, mime) {
  const m = /\.([a-z0-9]{2,5})$/i.exec(pathOf(url));
  if (m && DIRECT_EXT.test('.' + m[1])) return m[1].toLowerCase();
  const map = { 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov', 'video/x-matroska': 'mkv', 'video/x-flv': 'flv',
    'video/ogg': 'ogv', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/ogg': 'ogg', 'audio/webm': 'webm', 'audio/wav': 'wav' };
  return map[mime] || 'mp4';
}

/** معرّف ثابت للعنصر من الـURL (من غير بارامترات الـrange) */
export function itemId(url) {
  let s = url;
  try {
    const u = new URL(url);
    ['range', 'bytestart', 'byteend'].forEach((p) => u.searchParams.delete(p));
    if (SPLIT_HOSTS.test(u.hostname)) u.search = ''; // نفس الملف ممكن ييجي بتوقيعات مختلفة
    s = u.toString();
  } catch {}
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}
