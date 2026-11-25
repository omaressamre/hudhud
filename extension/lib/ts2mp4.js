// محوّل MPEG-TS → MP4 (remux من غير re-encode)، شغال وهو بيستقبل البيانات (streaming).
//
// بيدعم: فيديو H.264 + صوت AAC (ADTS) أو MP3، أو واحد منهم بس.
// أي حاجة تانية (H.265، AC-3، ...) بترمي UnsupportedStream عشان اللي بيستخدمه يرجع لـTS.
//
// شكل الملف الناتج: ftyp | mdat (هيدر 64-بت) | moov في الآخر.
// البيانات بتتكتب على طول وهي جاية، والفهرس (moov) بيتكتب في الآخر، وحجم الـmdat بيتصلّح بكتابة في مكانه.
//
// الاستخدام:
//   const mux = new TsToMp4({ write: async (bytes, position) => {...} }); // position = undefined → append
//   await mux.push(tsBytes) ... await mux.push(tsBytes)
//   const info = await mux.finish();

export class UnsupportedStream extends Error {
  constructor(message) { super(message); this.code = 'unsupported'; }
}

const TS = 188;
const WRAP = 2 ** 33;
const HALF = 2 ** 32;

const STREAM = {
  0x1b: 'h264', 0x0f: 'aac', 0x11: 'aac-latm', 0x03: 'mp3', 0x04: 'mp3',
  0x24: 'hevc', 0x81: 'ac3', 0x87: 'eac3', 0x06: 'private', 0x15: 'id3', 0x86: 'scte35',
};

// ═════════════ أدوات بايتات ═════════════

export function concat(parts, total) {
  if (parts.length === 1) return parts[0];
  if (total === undefined) total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export class Bytes {
  constructor() { this.parts = []; this.length = 0; }
  u8(v) { return this.raw(Uint8Array.of(v & 0xff)); }
  u16(v) { return this.raw(Uint8Array.of((v >>> 8) & 0xff, v & 0xff)); }
  u24(v) { return this.raw(Uint8Array.of((v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff)); }
  u32(v) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v >>> 0); return this.raw(b); }
  i32(v) { const b = new Uint8Array(4); new DataView(b.buffer).setInt32(0, v); return this.raw(b); }
  u64(v) { const b = new Uint8Array(8); const d = new DataView(b.buffer); d.setUint32(0, Math.floor(v / 2 ** 32)); d.setUint32(4, v >>> 0); return this.raw(b); }
  str(s) { return this.raw(Uint8Array.from(s, (c) => c.charCodeAt(0))); }
  zeros(n) { return this.raw(new Uint8Array(n)); }
  raw(b) { this.parts.push(b); this.length += b.length; return this; }
  bytes() { return concat(this.parts, this.length); }
}

export function box(type, ...children) {
  const body = new Bytes();
  for (const c of children) body.raw(c instanceof Bytes ? c.bytes() : c);
  const b = new Bytes().u32(8 + body.length).str(type);
  return b.raw(body.bytes()).bytes();
}

export function fullBox(type, version, flags, ...children) {
  return box(type, new Bytes().u8(version).u24(flags).bytes(), ...children);
}

class BitReader {
  constructor(b) { this.b = b; this.p = 0; }
  u(n) {
    let v = 0;
    for (let i = 0; i < n; i++) {
      const byte = this.b[this.p >> 3];
      if (byte === undefined) throw new Error('bitstream overrun');
      v = v * 2 + ((byte >> (7 - (this.p & 7))) & 1);
      this.p++;
    }
    return v;
  }
  ue() {
    let z = 0;
    while (this.u(1) === 0) { if (++z > 31) throw new Error('bad exp-golomb'); }
    return 2 ** z - 1 + (z ? this.u(z) : 0);
  }
  se() { const k = this.ue(); return k & 1 ? (k + 1) / 2 : -(k / 2); }
}

function removeEmulation(nal) {
  const out = new Uint8Array(nal.length);
  let o = 0, zeros = 0;
  for (let i = 0; i < nal.length; i++) {
    const v = nal[i];
    if (zeros >= 2 && v === 3) { zeros = 0; continue; }
    out[o++] = v;
    zeros = v === 0 ? zeros + 1 : 0;
  }
  return out.subarray(0, o);
}

// ═════════════ H.264 ═════════════

/** تقسيم Annex-B لـNAL units */
export function splitNals(b) {
  const nals = [];
  let i = 0, start = -1;
  const n = b.length;
  while (i + 2 < n) {
    if (b[i] === 0 && b[i + 1] === 0 && b[i + 2] === 1) {
      if (start >= 0) {
        let end = i;
        while (end > start && b[end - 1] === 0) end--; // الصفر الزيادة في start code الـ4 بايت
        if (end > start) nals.push(b.subarray(start, end));
      }
      i += 3;
      start = i;
    } else if (b[i + 2] > 1) {
      i += 3; // تسريع: مستحيل يبقى فيه start code هنا
    } else {
      i++;
    }
  }
  if (start >= 0 && start < n) {
    let end = n;
    while (end > start && b[end - 1] === 0) end--;
    if (end > start) nals.push(b.subarray(start, end));
  }
  return nals;
}

export function parseSps(nal) {
  const r = new BitReader(removeEmulation(nal.subarray(1)));
  const profile = r.u(8);
  r.u(8);
  r.u(8);
  r.ue();
  let chroma = 1;
  if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profile)) {
    chroma = r.ue();
    if (chroma === 3) r.u(1);
    r.ue(); r.ue(); r.u(1);
    if (r.u(1)) {
      for (let i = 0; i < (chroma !== 3 ? 8 : 12); i++) {
        if (r.u(1)) {
          const size = i < 6 ? 16 : 64;
          let last = 8, next = 8;
          for (let j = 0; j < size; j++) {
            if (next !== 0) next = (last + r.se() + 256) % 256;
            last = next === 0 ? last : next;
          }
        }
      }
    }
  }
  r.ue();
  const poc = r.ue();
  if (poc === 0) r.ue();
  else if (poc === 1) { r.u(1); r.se(); r.se(); const k = r.ue(); for (let i = 0; i < k; i++) r.se(); }
  r.ue(); r.u(1);
  const wMbs = r.ue() + 1;
  const hMaps = r.ue() + 1;
  const frameMbsOnly = r.u(1);
  if (!frameMbsOnly) r.u(1);
  r.u(1);
  let cl = 0, cr = 0, ct = 0, cb = 0;
  if (r.u(1)) { cl = r.ue(); cr = r.ue(); ct = r.ue(); cb = r.ue(); }
  const cropX = chroma === 0 || chroma === 3 ? 1 : 2;
  const cropY = (chroma === 1 ? 2 : 1) * (2 - frameMbsOnly);
  let sarW = 1, sarH = 1;
  try {
    if (r.u(1) && r.u(1)) { // vui → aspect_ratio_info
      const idc = r.u(8);
      const table = [[1, 1], [1, 1], [12, 11], [10, 11], [16, 11], [40, 33], [24, 11], [20, 11], [32, 11], [80, 33], [18, 11], [15, 11], [64, 33], [160, 99], [4, 3], [3, 2], [2, 1]];
      if (idc === 255) { sarW = r.u(16); sarH = r.u(16); } else if (table[idc]) [sarW, sarH] = table[idc];
    }
  } catch {}
  return {
    width: wMbs * 16 - (cl + cr) * cropX,
    height: (2 - frameMbsOnly) * hMaps * 16 - (ct + cb) * cropY,
    sarW: sarW || 1, sarH: sarH || 1,
  };
}

// ═════════════ الصوت ═════════════

const AAC_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

const MP3_BITRATES = {
  // [version1][layer] , [version2][layer] بالكيلوبت
  '1-1': [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  '1-2': [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  '1-3': [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  '2-1': [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  '2-2': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  '2-3': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};
const MP3_RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

function parseAdts(b, o) {
  if (o + 7 > b.length) return null;
  if (b[o] !== 0xff || (b[o + 1] & 0xf6) !== 0xf0) return { bad: true };
  const protectionAbsent = b[o + 1] & 1;
  const objectType = ((b[o + 2] >> 6) & 3) + 1;
  const rateIdx = (b[o + 2] >> 2) & 0xf;
  const channels = ((b[o + 2] & 1) << 2) | ((b[o + 3] >> 6) & 3);
  const frameLen = ((b[o + 3] & 3) << 11) | (b[o + 4] << 3) | ((b[o + 5] >> 5) & 7);
  const header = protectionAbsent ? 7 : 9;
  if (frameLen < header || !AAC_RATES[rateIdx]) return { bad: true };
  return { objectType, rateIdx, rate: AAC_RATES[rateIdx], channels, frameLen, header, samples: 1024 };
}

function parseMpa(b, o) {
  if (o + 4 > b.length) return null;
  if (b[o] !== 0xff || (b[o + 1] & 0xe0) !== 0xe0) return { bad: true };
  const ver = (b[o + 1] >> 3) & 3; // 3 = MPEG1, 2 = MPEG2, 0 = MPEG2.5
  const layerBits = (b[o + 1] >> 1) & 3;
  const layer = 4 - layerBits;
  const brIdx = b[o + 2] >> 4;
  const srIdx = (b[o + 2] >> 2) & 3;
  const pad = (b[o + 2] >> 1) & 1;
  const channels = (b[o + 3] >> 6) === 3 ? 1 : 2;
  if (ver === 1 || layerBits === 0 || brIdx === 0 || brIdx === 15 || srIdx === 3) return { bad: true };
  const br = MP3_BITRATES[`${ver === 3 ? 1 : 2}-${layer}`][brIdx] * 1000;
  const rate = MP3_RATES[ver][srIdx];
  let frameLen, samples;
  if (layer === 1) { frameLen = (Math.floor((12 * br) / rate) + pad) * 4; samples = 384; }
  else if (layer === 3 && ver !== 3) { frameLen = Math.floor((72 * br) / rate) + pad; samples = 576; }
  else { frameLen = Math.floor((144 * br) / rate) + pad; samples = 1152; }
  return { rate, channels, frameLen, header: 0, samples, mpegVersion: ver };
}

// ═════════════ التراك (عيّنات + توقيت) ═════════════

class Track {
  constructor(type, id) {
    this.type = type;
    this.id = id;
    this.sizes = [];
    this.dts = []; // بوحدة 90kHz، متصلة (بعد معالجة اللف والقطع)
    this.cto = []; // pts - dts
    this.keys = []; // فهرس العينات اللي keyframe (فيديو)
    this.chunks = []; // [offset, count]
    this.wrap = 0;
    this.shift = 0;
    this.lastIn = null;
    this.lastOut = null;
    this.frameDur = type === 'video' ? 3000 : 1920;
    this.discontinuities = 0;
  }

  /** بيحوّل timestamp خام (33 بت) لقيمة متصلة: بيعالج اللف كل 26 ساعة والقفزات (discontinuity) */
  continuous(raw) {
    let v = raw + this.wrap;
    if (this.lastIn !== null && v < this.lastIn - HALF) { this.wrap += WRAP; v += WRAP; }
    if (this.lastIn !== null && v > this.lastIn + HALF) { v -= WRAP; } // رجوع لورا بعد لف
    let out = v + this.shift;
    if (this.lastOut !== null) {
      const d = out - this.lastOut;
      if (d < -45000 || d > 10 * 90000) { // قفزة: نكمّل من مكان ما وقفنا
        this.shift += this.lastOut + this.frameDur - out;
        out = this.lastOut + this.frameDur;
        this.discontinuities++;
      } else if (d > 0 && d < 90000) {
        this.frameDur = this.frameDur * 0.9 + d * 0.1;
      }
    }
    this.lastIn = v;
    this.lastOut = out;
    return out;
  }
}

function ctoOf(pts, dts) {
  let d = (pts - dts) % WRAP;
  if (d > HALF) d -= WRAP;
  if (d < -HALF) d += WRAP;
  return d;
}

// ═════════════ فك علبة TS ═════════════

class TsDemux {
  constructor(owner, { video, audio }) {
    this.owner = owner;
    this.wantVideo = video;
    this.wantAudio = audio;
    this.rest = null;
    this.pmtPid = -1;
    this.videoPid = -1;
    this.audioPid = -1;
    this.pmtSeen = false;
    this.pes = new Map(); // pid → { parts, size }
  }


  push(data) {
    let b = data;
    if (this.rest) { b = concat([this.rest, data]); this.rest = null; }
    let o = 0;
    const n = b.length;
    while (o + TS <= n) {
      if (b[o] !== 0x47) {
        // فقدنا التزامن: ندوّر على أول 0x47 بعده 0x47 بعد 188
        let k = o + 1;
        while (k + TS < n && !(b[k] === 0x47 && b[k + TS] === 0x47)) k++;
        if (k + TS >= n) { o = k; break; }
        o = k;
        continue;
      }
      this.packet(b, o);
      o += TS;
    }
    if (o < n) this.rest = b.slice(o);
  }

  packet(b, o) {
    const pusi = (b[o + 1] & 0x40) !== 0;
    const pid = ((b[o + 1] & 0x1f) << 8) | b[o + 2];
    const afc = (b[o + 3] >> 4) & 3;
    let p = o + 4;
    if (afc === 2 || afc === 0) return; // مفيش payload
    if (afc === 3) p += 1 + b[o + 4];
    const end = o + TS;
    if (p >= end) return;

    if (pid === 0) {
      if (pusi) p += 1 + b[p];
      this.parsePat(b, p, end);
    } else if (pid === this.pmtPid) {
      if (pusi) p += 1 + b[p];
      this.parsePmt(b, p, end);
    } else if ((pid === this.videoPid && this.wantVideo) || (pid === this.audioPid && this.wantAudio)) {
      let st = this.pes.get(pid);
      if (pusi) {
        if (st && st.size) this.flushPes(pid, st);
        st = { parts: [], size: 0 };
        this.pes.set(pid, st);
      }
      if (!st) return; // لسه ما شفناش بداية PES
      const chunk = b.subarray(p, end);
      st.parts.push(chunk);
      st.size += chunk.length;
    }
  }

  parsePat(b, p, end) {
    if (b[p] !== 0x00) return;
    const len = ((b[p + 1] & 0x0f) << 8) | b[p + 2];
    const last = Math.min(p + 3 + len - 4, end);
    for (let q = p + 8; q + 4 <= last; q += 4) {
      const prog = (b[q] << 8) | b[q + 1];
      const pmt = ((b[q + 2] & 0x1f) << 8) | b[q + 3];
      if (prog !== 0) { this.pmtPid = pmt; return; }
    }
  }

  parsePmt(b, p, end) {
    if (b[p] !== 0x02) return;
    const len = ((b[p + 1] & 0x0f) << 8) | b[p + 2];
    const last = Math.min(p + 3 + len - 4, end);
    const infoLen = ((b[p + 10] & 0x0f) << 8) | b[p + 11];
    let video = -1, audio = -1, aCodec = null, unsupportedVideo = null, unsupportedAudio = null;
    for (let q = p + 12 + infoLen; q + 5 <= last;) {
      const type = b[q];
      const pid = ((b[q + 1] & 0x1f) << 8) | b[q + 2];
      const esLen = ((b[q + 3] & 0x0f) << 8) | b[q + 4];
      const kind = STREAM[type];
      if (kind === 'h264' && video < 0) video = pid;
      else if ((kind === 'aac' || kind === 'mp3') && audio < 0) { audio = pid; aCodec = kind; }
      else if (kind === 'hevc') unsupportedVideo = 'H.265/HEVC';
      else if (kind === 'ac3' || kind === 'eac3' || kind === 'aac-latm') unsupportedAudio = kind.toUpperCase();
      q += 5 + esLen;
    }
    if (!this.wantVideo) video = -1;
    if (!this.wantAudio) { audio = -1; unsupportedAudio = null; }
    if (video < 0 && unsupportedVideo && this.wantVideo) throw new UnsupportedStream(`video codec ${unsupportedVideo} is not supported`);
    if (audio < 0 && unsupportedAudio) throw new UnsupportedStream(`audio codec ${unsupportedAudio} is not supported`);
    if (video < 0 && audio < 0 && !this.pmtSeen) throw new UnsupportedStream('no supported video or audio');
    if (aCodec && this.owner.audioCodec && aCodec !== this.owner.audioCodec) throw new UnsupportedStream('audio format changed mid-stream');
    if (this.pmtSeen) {
      if (video !== this.videoPid || audio !== this.audioPid) {
        // بعض الـstreams بتغيّر الـPIDs بعد discontinuity
        if ((video >= 0) !== (this.videoPid >= 0) || (audio >= 0) !== (this.audioPid >= 0)) {
          throw new UnsupportedStream('video config changed mid-stream');
        }
        this.flushAll();
        this.videoPid = video;
        this.audioPid = audio;
      }
      return;
    }
    this.pmtSeen = true;
    this.videoPid = video;
    this.audioPid = audio;
    if (aCodec) this.owner.audioCodec = aCodec;
  }

  flushAll() {
    for (const [pid, st] of this.pes) if (st.size) this.flushPes(pid, st);
    this.pes.clear();
  }

  flushPes(pid, st) {
    const b = concat(st.parts, st.size);
    st.parts = [];
    st.size = 0;
    if (b.length < 9 || b[0] !== 0 || b[1] !== 0 || b[2] !== 1) return;
    const flags = b[7] >> 6;
    const hlen = b[8];
    let pts = null, dts = null;
    const ts = (q) => (b[q] & 0x0e) * 536870912 + (b[q + 1] << 22) + ((b[q + 2] >> 1) << 15) + (b[q + 3] << 7) + (b[q + 4] >> 1);
    if (flags & 2) pts = ts(9);
    if (flags === 3) dts = ts(14);
    if (dts === null) dts = pts;
    const payload = b.subarray(9 + hlen);
    if (pid === this.videoPid) this.owner.onVideo(payload, pts, dts);
    else this.owner.onAudio(payload, pts);
  }
}

// ═════════════ المحوّل ═════════════

export class TsToMp4 {
  /**
   * @param {{write: (bytes: Uint8Array, position?: number) => Promise<void>}} out
   * @param {{separateAudio?: boolean}} [opts] separateAudio: الصوت هييجي من pushAudio بس (ونتجاهل أي صوت جوه TS الفيديو)
   */
  constructor(out, opts = {}) {
    this.out = out;
    this.pos = 0;
    this.headerWritten = false;
    this.mdatHeaderPos = 0;
    this.main = new TsDemux(this, { video: true, audio: !opts.separateAudio });
    this.audioDemux = null;
    this.audioCodec = null;
    this.video = new Track('video', 1);
    this.audio = new Track('audio', 2);
    this.sps = null;
    this.pps = null;
    this.spsInfo = null;
    this.audioCfg = null;
    this.aLeft = null; // باقي frame صوت متقطع بين PESين
    this.aNext = null; // التوقيت المتوقع لأول frame صوت جاي
    this.queue = []; // { track, data }
    this.gotKey = false;
  }

  // ───── استقبال البيانات ─────

  /** بيانات TS (فيديو + صوت، أو فيديو بس لو الصوت جاي منفصل) */
  async push(data) {
    this.main.push(data);
    await this.drain();
  }

  /** بيانات TS لصوت منفصل (HLS audio rendition) — نفس ساعة التوقيت بتاعة الفيديو */
  async pushAudio(data) {
    if (!this.audioDemux) this.audioDemux = new TsDemux(this, { video: false, audio: true });
    this.audioDemux.push(data);
    await this.drain();
  }

  flushAll() {
    this.main.flushAll();
    if (this.audioDemux) this.audioDemux.flushAll();
  }

  onVideo(payload, pts, dts) {
    if (pts === null) return; // من غير توقيت مش هنعرف نحطه فين
    const nals = splitNals(payload);
    const keep = [];
    let key = false, vcl = false;
    for (const nal of nals) {
      const t = nal[0] & 0x1f;
      if (t === 9) continue; // AUD
      if (t === 7) { if (!this.sps) { this.sps = nal.slice(); this.spsInfo = parseSps(this.sps); } }
      else if (t === 8) { if (!this.pps) this.pps = nal.slice(); }
      if (t === 5) key = true;
      if (t >= 1 && t <= 5) vcl = true;
      keep.push(nal);
    }
    if (!vcl) return;
    if (!this.gotKey) {
      if (!key || !this.sps || !this.pps) return; // نبدأ من أول keyframe
      this.gotKey = true;
    }
    let size = 0;
    for (const n of keep) size += 4 + n.length;
    const out = new Uint8Array(size);
    const dv = new DataView(out.buffer);
    let o = 0;
    for (const n of keep) { dv.setUint32(o, n.length); out.set(n, o + 4); o += 4 + n.length; }

    const tr = this.video;
    const d = tr.continuous(dts);
    if (key) tr.keys.push(tr.sizes.length);
    tr.sizes.push(size);
    tr.dts.push(d);
    tr.cto.push(ctoOf(pts, dts));
    this.queue.push({ track: tr, data: out });
  }

  onAudio(payload, pts) {
    let b = payload;
    const tr = this.audio;
    const fresh = !this.aLeft;
    if (this.aLeft) { b = concat([this.aLeft, payload]); this.aLeft = null; }
    const parse = this.audioCodec === 'mp3' ? parseMpa : parseAdts;
    // توقيت أول frame: من الـPES لو مفيش باقي من قبل، أو لو القفزة كبيرة
    let t = this.aNext;
    if (pts !== null && (fresh || t === null)) t = pts;
    if (t === null) return;
    let o = 0;
    while (o < b.length) {
      const h = parse(b, o);
      if (!h) break; // هيدر ناقص
      if (h.bad) { o++; continue; } // ندوّر على الـsync اللي بعده
      if (o + h.frameLen > b.length) break; // frame ناقص: يكمل في الـPES الجاي
      if (!this.audioCfg) this.audioCfg = h;
      const frame = b.slice(o + h.header, o + h.frameLen);
      const d = tr.continuous(Math.round(t) % WRAP);
      tr.sizes.push(frame.length);
      tr.dts.push(d);
      tr.cto.push(0);
      this.queue.push({ track: tr, data: frame });
      t += (h.samples * 90000) / h.rate;
      o += h.frameLen;
    }
    this.aNext = t;
    if (o < b.length) this.aLeft = b.slice(o);
  }

  // ───── الكتابة ─────

  async write(bytes, position) {
    if (position === undefined) {
      await this.out.write(bytes);
      this.pos += bytes.length;
    } else {
      await this.out.write(bytes, position);
    }
  }

  async drain() {
    if (!this.queue.length) return;
    if (!this.headerWritten) {
      const ftyp = box('ftyp', new Bytes().str('isom').u32(512).str('isomiso2avc1mp41').bytes());
      this.mdatHeaderPos = ftyp.length;
      await this.write(concat([ftyp, new Bytes().u32(1).str('mdat').u64(16).bytes()]));
      this.headerWritten = true;
    }
    // العينات المتتالية من نفس التراك = chunk واحد = كتابة واحدة
    const q = this.queue;
    this.queue = [];
    let i = 0;
    while (i < q.length) {
      const tr = q[i].track;
      let j = i, size = 0;
      while (j < q.length && q[j].track === tr) { size += q[j].data.length; j++; }
      tr.chunks.push([this.pos, j - i]);
      await this.write(concat(q.slice(i, j).map((x) => x.data), size));
      i = j;
    }
  }

  async finish() {
    this.flushAll();
    this.aLeft = null;
    await this.drain();
    const tracks = [];
    if (this.video.sizes.length && this.spsInfo) tracks.push(this.video);
    if (this.audio.sizes.length && this.audioCfg) tracks.push(this.audio);
    if (!tracks.length) throw new UnsupportedStream('no video or audio could be read');
    const mdatEnd = this.pos;
    const moov = this.buildMoov(tracks);
    await this.write(moov);
    await this.write(new Bytes().u64(mdatEnd - this.mdatHeaderPos).bytes(), this.mdatHeaderPos + 8);
    return {
      size: this.pos,
      video: this.video.sizes.length ? { frames: this.video.sizes.length, width: this.spsInfo?.width, height: this.spsInfo?.height } : null,
      audio: this.audio.sizes.length ? { frames: this.audio.sizes.length, codec: this.audioCodec, rate: this.audioCfg?.rate } : null,
      discontinuities: this.video.discontinuities + this.audio.discontinuities,
    };
  }

  // ───── الفهرس (moov) ─────

  buildMoov(tracks) {
    const MOVIE_TS = 1000;
    // بداية العرض لكل تراك = أصغر pts (عشان الـB-frames)
    for (const tr of tracks) {
      const n = tr.sizes.length;
      let minPts = Infinity;
      for (let i = 0; i < n; i++) minPts = Math.min(minPts, tr.dts[i] + tr.cto[i]);
      tr.minPts = minPts;
      tr.timescale = tr.type === 'video' ? 90000 : this.audioCfg.rate;
      // المدد: الفرق بين dts المتتالية، وآخر عينة زي اللي قبلها
      const conv = tr.type === 'video' ? (x) => x : (x) => Math.round((x * tr.timescale) / 90000);
      const t = new Float64Array(n);
      for (let i = 0; i < n; i++) t[i] = conv(tr.dts[i] - tr.dts[0]);
      const durs = new Uint32Array(n);
      const nominal = tr.type === 'audio' ? (this.audioCfg.samples || 1024) : 0;
      for (let i = 0; i < n - 1; i++) {
        let d = Math.round(t[i + 1] - t[i]);
        if (d <= 0) d = 1;
        if (nominal && (d < nominal / 2 || d > nominal * 8)) d = nominal;
        durs[i] = d;
      }
      durs[n - 1] = n > 1 ? durs[n - 2] : (nominal || 3000);
      tr.durs = durs;
      let total = 0;
      for (let i = 0; i < n; i++) total += durs[i];
      tr.mediaDuration = total;
    }
    const start = Math.min(...tracks.map((t) => t.minPts));
    let movieDur = 0;
    for (const tr of tracks) {
      const mediaTime = tr.type === 'video' ? tr.minPts - tr.dts[0] : 0; // بوحدة التراك (فيديو = 90k)
      const delay = Math.round(((tr.minPts - start) / 90000) * MOVIE_TS);
      // نهاية العرض = أكبر pts + مدة آخر frame
      let maxEnd = 0;
      const n = tr.sizes.length;
      if (tr.type === 'video') {
        for (let i = 0; i < n; i++) maxEnd = Math.max(maxEnd, tr.dts[i] - tr.dts[0] + tr.cto[i] + tr.durs[i]);
      } else maxEnd = tr.mediaDuration;
      const segDur = Math.max(0, Math.round(((maxEnd - mediaTime) / tr.timescale) * MOVIE_TS));
      tr.edit = { mediaTime, delay, segDur };
      tr.movieDur = delay + segDur;
      movieDur = Math.max(movieDur, tr.movieDur);
    }
    const mvhd = this.mvhd(movieDur, MOVIE_TS, tracks.length + 1);
    return box('moov', mvhd, ...tracks.map((tr) => this.trak(tr)));
  }

  mvhd(duration, timescale, nextId) {
    const v1 = duration > 0xffffffff;
    const b = new Bytes();
    if (v1) b.u64(0).u64(0).u32(timescale).u64(duration);
    else b.u32(0).u32(0).u32(timescale).u32(duration);
    b.u32(0x00010000).u16(0x0100).zeros(10);
    for (const m of [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000]) b.u32(m);
    b.zeros(24).u32(nextId);
    return fullBox('mvhd', v1 ? 1 : 0, 0, b.bytes());
  }

  trak(tr) {
    const video = tr.type === 'video';
    const tk = new Bytes();
    const v1 = tr.movieDur > 0xffffffff;
    if (v1) tk.u64(0).u64(0).u32(tr.id).u32(0).u64(tr.movieDur);
    else tk.u32(0).u32(0).u32(tr.id).u32(0).u32(tr.movieDur);
    tk.zeros(8).u16(0).u16(video ? 0 : 1).u16(video ? 0 : 0x0100).u16(0);
    for (const m of [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000]) tk.u32(m);
    if (video) {
      const { width, height, sarW, sarH } = this.spsInfo;
      const dispW = Math.round((width * sarW) / sarH);
      tk.u32(dispW * 65536).u32(height * 65536);
    } else tk.u32(0).u32(0);
    const tkhd = fullBox('tkhd', v1 ? 1 : 0, 3, tk.bytes());

    // edit list: فراغ في الأول لو التراك بيبدأ متأخر + الجزء الأساسي
    const e = tr.edit;
    const entries = [];
    if (e.delay > 0) entries.push([e.delay, -1]);
    entries.push([e.segDur, e.mediaTime]);
    const ev1 = entries.some(([d, m]) => d > 0xffffffff || m > 0x7fffffff);
    const el = new Bytes().u32(entries.length);
    for (const [d, m] of entries) {
      if (ev1) el.u64(d).u64(m < 0 ? 2 ** 64 - 1 : m); else el.u32(d).i32(m);
      el.u16(1).u16(0);
    }
    const edts = box('edts', fullBox('elst', ev1 ? 1 : 0, 0, el.bytes()));

    const mdv1 = tr.mediaDuration > 0xffffffff;
    const md = new Bytes();
    if (mdv1) md.u64(0).u64(0).u32(tr.timescale).u64(tr.mediaDuration);
    else md.u32(0).u32(0).u32(tr.timescale).u32(tr.mediaDuration);
    md.u16(0x55c4).u16(0); // language "und"
    const mdhd = fullBox('mdhd', mdv1 ? 1 : 0, 0, md.bytes());
    const name = video ? 'VideoHandler' : 'SoundHandler';
    const hdlr = fullBox('hdlr', 0, 0, new Bytes().u32(0).str(video ? 'vide' : 'soun').zeros(12).str(name).u8(0).bytes());
    const mhd = video ? fullBox('vmhd', 0, 1, new Bytes().zeros(8).bytes()) : fullBox('smhd', 0, 0, new Bytes().zeros(4).bytes());
    const dinf = box('dinf', fullBox('dref', 0, 0, new Bytes().u32(1).bytes(), fullBox('url ', 0, 1)));
    const minf = box('minf', mhd, dinf, this.stbl(tr));
    return box('trak', tkhd, edts, box('mdia', mdhd, hdlr, minf));
  }

  stsd(tr) {
    if (tr.type === 'video') {
      const { width, height, sarW, sarH } = this.spsInfo;
      const sps = this.sps, pps = this.pps;
      const avcC = box('avcC', new Bytes()
        .u8(1).u8(sps[1]).u8(sps[2]).u8(sps[3]).u8(0xff)
        .u8(0xe1).u16(sps.length).raw(sps)
        .u8(1).u16(pps.length).raw(pps).bytes());
      const extra = [avcC];
      if (sarW !== sarH) extra.push(box('pasp', new Bytes().u32(sarW).u32(sarH).bytes()));
      const entry = box('avc1', new Bytes()
        .zeros(6).u16(1) // reserved + data_reference_index
        .zeros(16).u16(width).u16(height)
        .u32(0x00480000).u32(0x00480000).u32(0).u16(1)
        .zeros(32) // compressor name
        .u16(0x18).u16(0xffff).bytes(), ...extra);
      return fullBox('stsd', 0, 0, new Bytes().u32(1).bytes(), entry);
    }
    const c = this.audioCfg;
    const mp3 = this.audioCodec === 'mp3';
    const rate = c.rate;
    const channels = c.channels || 2;
    // esds: ES_Descriptor → DecoderConfigDescriptor → DecoderSpecificInfo (AAC بس)
    const desc = (tag, body) => {
      const b = new Bytes().u8(tag);
      let len = body.length;
      const lenBytes = [];
      do { lenBytes.unshift(len & 0x7f); len >>= 7; } while (len > 0);
      for (let i = 0; i < lenBytes.length - 1; i++) lenBytes[i] |= 0x80;
      for (const x of lenBytes) b.u8(x);
      return b.raw(body).bytes();
    };
    let dsi = new Uint8Array(0);
    if (!mp3) {
      const asc = (c.objectType << 11) | (c.rateIdx << 7) | (channels << 3);
      dsi = desc(0x05, new Bytes().u16(asc).bytes());
    }
    const dcd = desc(0x04, new Bytes().u8(mp3 ? (c.mpegVersion === 3 ? 0x6b : 0x69) : 0x40).u8(0x15).u24(0).u32(0).u32(0).raw(dsi).bytes());
    const esd = desc(0x03, new Bytes().u16(tr.id).u8(0).raw(dcd).raw(desc(0x06, Uint8Array.of(0x02))).bytes());
    const esds = fullBox('esds', 0, 0, esd);
    const entry = box('mp4a', new Bytes()
      .zeros(6).u16(1).zeros(8)
      .u16(channels).u16(16).u16(0).u16(0)
      .u32(rate < 65536 ? rate * 65536 : 0).bytes(), esds);
    return fullBox('stsd', 0, 0, new Bytes().u32(1).bytes(), entry);
  }

  stbl(tr) {
    return box('stbl', this.stsd(tr), ...sampleTables(tr));
  }
}

// جداول العيّنات (stts/ctts/stss/stsc/stsz/stco) — مشتركة مع lib/mp4merge.js
// tr: { type, sizes[], durs[], cto[], keys[], chunks[[offset,count]] }
export function sampleTables(tr) {
  const n = tr.sizes.length;
  // stts (run-length)
  const stts = new Bytes();
  let runs = 0;
  const sttsBody = new Bytes();
  for (let i = 0; i < n;) {
    let j = i;
    while (j < n && tr.durs[j] === tr.durs[i]) j++;
    sttsBody.u32(j - i).u32(tr.durs[i]);
    runs++;
    i = j;
  }
  stts.u32(runs).raw(sttsBody.bytes());
  const boxes = [fullBox('stts', 0, 0, stts.bytes())];

  // ctts (فيديو بـB-frames بس)
  if (tr.cto.some((x) => x !== 0)) {
    const neg = tr.cto.some((x) => x < 0);
    const body = new Bytes();
    let r = 0;
    for (let i = 0; i < n;) {
      let j = i;
      while (j < n && tr.cto[j] === tr.cto[i]) j++;
      body.u32(j - i);
      if (neg) body.i32(tr.cto[i]); else body.u32(tr.cto[i]);
      r++;
      i = j;
    }
    boxes.push(fullBox('ctts', neg ? 1 : 0, 0, new Bytes().u32(r).raw(body.bytes()).bytes()));
  }

  // stss (keyframes) — لو مش كل العينات key
  if (tr.type === 'video' && tr.keys.length < n) {
    const b = new Bytes().u32(tr.keys.length);
    for (const k of tr.keys) b.u32(k + 1);
    boxes.push(fullBox('stss', 0, 0, b.bytes()));
  }

  // stsc
  const stsc = new Bytes();
  let entries = 0;
  const stscBody = new Bytes();
  let prev = -1;
  tr.chunks.forEach(([, count], i) => {
    if (count !== prev) { stscBody.u32(i + 1).u32(count).u32(1); entries++; prev = count; }
  });
  stsc.u32(entries).raw(stscBody.bytes());
  boxes.push(fullBox('stsc', 0, 0, stsc.bytes()));

  // stsz
  const same = tr.sizes.every((s) => s === tr.sizes[0]);
  const stsz = new Bytes();
  if (same) stsz.u32(tr.sizes[0]).u32(n);
  else {
    stsz.u32(0).u32(n);
    const arr = new Uint8Array(n * 4);
    const dv = new DataView(arr.buffer);
    tr.sizes.forEach((s, i) => dv.setUint32(i * 4, s));
    stsz.raw(arr);
  }
  boxes.push(fullBox('stsz', 0, 0, stsz.bytes()));

  // stco / co64
  const big = tr.chunks.some(([off]) => off > 0xffffffff);
  const cn = tr.chunks.length;
  const arr = new Uint8Array(cn * (big ? 8 : 4));
  const dv = new DataView(arr.buffer);
  tr.chunks.forEach(([off], i) => {
    if (big) { dv.setUint32(i * 8, Math.floor(off / 2 ** 32)); dv.setUint32(i * 8 + 4, off >>> 0); }
    else dv.setUint32(i * 4, off);
  });
  boxes.push(fullBox(big ? 'co64' : 'stco', 0, 0, new Bytes().u32(cn).raw(arr).bytes()));
  return boxes;
}
