// دمج ملف صورة + ملف صوت (MP4) في ملف MP4 واحد، من غير re-encode، وهو بيستقبل البيانات (streaming).
//
// معمول لفيسبوك وانستجرام (DASH: الصورة والصوت كل واحد في ملف fragmented MP4)، وبيشتغل كمان مع:
// - fragmented MP4 (moov + moof/mdat) بـsidx أو من غيره، وبـdefault-base-is-moof أو من غيره
// - MP4 عادي (moov في الأول، أو في الآخر ← بنجيبه بـRange request)
// - أي كوديك: إعدادات الكوديك (stsd) بتتنقل زي ما هي، فـH.264/H.265/VP9/AV1/AAC/Opus كلهم شغالين
//
// الملف الناتج: ftyp | mdat (هيدر 64-بت) | moov. الصورة الأول وبعدين الصوت (للتشغيل من على الجهاز ده مش فارق).
//
// الاستخدام:
//   const m = new Mp4Merger({ write: async (bytes, position) => {...} });
//   await m.addSource({ open: (start, end) => fetch(...).then(r => r), kind: 'video' });
//   await m.addSource({ open: ..., kind: 'audio' });
//   const info = await m.finish();

import { Bytes, box, fullBox, concat, sampleTables, UnsupportedStream } from './ts2mp4.js';

export { UnsupportedStream };

const CHUNK_BYTES = 1 << 20; // نكتب العيّنات في مجموعات حوالي 1MB

// ═════════════ قراءة stream ═════════════

export class StreamReader {
  constructor(stream, pos = 0) {
    this.r = stream.getReader();
    this.q = [];
    this.head = 0;
    this.qBytes = 0;
    this.pos = pos;
    this.eof = false;
  }

  async fill(n) {
    while (this.qBytes < n && !this.eof) {
      const { value, done } = await this.r.read();
      if (done) { this.eof = true; break; }
      if (value && value.length) { this.q.push(value); this.qBytes += value.length; }
    }
    return this.qBytes >= n;
  }

  take(n, copy = true) {
    const out = copy ? new Uint8Array(n) : null;
    let o = 0;
    while (o < n) {
      const c = this.q[0];
      const k = Math.min(c.length - this.head, n - o);
      if (out) out.set(c.subarray(this.head, this.head + k), o);
      o += k;
      this.head += k;
      if (this.head === c.length) { this.q.shift(); this.head = 0; }
    }
    this.qBytes -= n;
    this.pos += n;
    return out;
  }

  async read(n) {
    if (!(await this.fill(n))) throw new Error('file ended early');
    return this.take(n);
  }

  async skip(n) {
    while (n > 0) {
      await this.fill(Math.min(n, 1 << 20));
      if (!this.qBytes) throw new Error('file ended early');
      const k = Math.min(n, this.qBytes);
      this.take(k, false);
      n -= k;
    }
  }

  async readAll() {
    const parts = [];
    let total = 0;
    while (await this.fill(1)) { const k = this.qBytes; parts.push(this.take(k)); total += k; }
    return concat(parts, total);
  }

  /** هيدر البوكس الجاي: { type, start, size (null = لحد آخر الملف), header } */
  async boxHeader() {
    if (!(await this.fill(8))) return null;
    const start = this.pos;
    const h = this.take(8);
    const dv = new DataView(h.buffer);
    let size = dv.getUint32(0);
    const type = String.fromCharCode(h[4], h[5], h[6], h[7]);
    let header = 8;
    if (size === 1) {
      const l = await this.read(8);
      const ldv = new DataView(l.buffer);
      size = ldv.getUint32(0) * 2 ** 32 + ldv.getUint32(4);
      header = 16;
    } else if (size === 0) size = null;
    if (size !== null && size < header) throw new Error('broken MP4 file');
    return { type, start, size, header };
  }

  cancel() { try { this.r.cancel().catch(() => {}); } catch {} }
}

// ═════════════ تحليل البوكسات ═════════════

function* children(b, start, end) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let o = start;
  while (o + 8 <= end) {
    let size = dv.getUint32(o);
    const type = String.fromCharCode(b[o + 4], b[o + 5], b[o + 6], b[o + 7]);
    let h = 8;
    if (size === 1) { size = dv.getUint32(o + 8) * 2 ** 32 + dv.getUint32(o + 12); h = 16; }
    else if (size === 0) size = end - o;
    if (size < h || o + size > end) return;
    yield { type, start: o, p: o + h, end: o + size };
    o += size;
  }
}

function find(b, start, end, type) {
  for (const c of children(b, start, end)) if (c.type === type) return c;
  return null;
}

function u64(dv, o) { return dv.getUint32(o) * 2 ** 32 + dv.getUint32(o + 4); }
function i64(dv, o) { const hi = dv.getInt32(o); return hi * 2 ** 32 + dv.getUint32(o + 4); }

function parseMoov(b) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const out = { movieTs: 1000, tracks: [], trex: new Map() };
  for (const c of children(b, 0, b.length)) {
    if (c.type === 'mvhd') {
      const v = b[c.p];
      out.movieTs = v === 1 ? dv.getUint32(c.p + 20) : dv.getUint32(c.p + 12);
    } else if (c.type === 'trak') {
      out.tracks.push(parseTrak(b, dv, c));
    } else if (c.type === 'mvex') {
      for (const x of children(b, c.p, c.end)) {
        if (x.type !== 'trex') continue;
        out.trex.set(dv.getUint32(x.p + 4), {
          sdi: dv.getUint32(x.p + 8), dur: dv.getUint32(x.p + 12), size: dv.getUint32(x.p + 16), flags: dv.getUint32(x.p + 20),
        });
      }
    }
  }
  return out;
}

function parseTrak(b, dv, trak) {
  const t = { id: 0, edits: [], handler: '', timescale: 0, lang: 0x55c4, stsd: null, width: 0, height: 0, stbl: null };
  for (const c of children(b, trak.p, trak.end)) {
    if (c.type === 'tkhd') {
      const v = b[c.p];
      t.id = dv.getUint32(c.p + (v === 1 ? 20 : 12));
      const w = c.p + (v === 1 ? 88 : 76);
      if (w + 8 <= c.end) { t.width = dv.getUint32(w); t.height = dv.getUint32(w + 4); }
    } else if (c.type === 'edts') {
      const el = find(b, c.p, c.end, 'elst');
      if (el) {
        const v = b[el.p];
        const n = dv.getUint32(el.p + 4);
        let o = el.p + 8;
        for (let i = 0; i < n && o < el.end; i++) {
          if (v === 1) { t.edits.push({ dur: u64(dv, o), mediaTime: i64(dv, o + 8) }); o += 20; }
          else { t.edits.push({ dur: dv.getUint32(o), mediaTime: dv.getInt32(o + 4) }); o += 12; }
        }
      }
    } else if (c.type === 'mdia') {
      for (const m of children(b, c.p, c.end)) {
        if (m.type === 'mdhd') {
          const v = b[m.p];
          t.timescale = dv.getUint32(m.p + (v === 1 ? 20 : 12));
          t.lang = dv.getUint16(m.p + (v === 1 ? 32 : 20));
        } else if (m.type === 'hdlr') {
          t.handler = String.fromCharCode(b[m.p + 8], b[m.p + 9], b[m.p + 10], b[m.p + 11]);
        } else if (m.type === 'minf') {
          const stbl = find(b, m.p, m.end, 'stbl');
          if (stbl) {
            t.stbl = {};
            for (const s of children(b, stbl.p, stbl.end)) {
              if (s.type === 'stsd') t.stsd = b.slice(s.start, s.end);
              else t.stbl[s.type] = s;
            }
            t.stbl._b = b;
            t.stbl._dv = dv;
          }
        }
      }
    }
  }
  if (t.stsd) {
    const entry = String.fromCharCode(t.stsd[20], t.stsd[21], t.stsd[22], t.stsd[23]);
    t.entry = entry;
    if (entry === 'encv' || entry === 'enca') t.drm = true;
  }
  return t;
}

/** جدول العيّنات من MP4 عادي (مش fragmented) */
function progressiveSamples(t) {
  const s = t.stbl;
  if (!s || !s.stsz || !(s.stco || s.co64) || !s.stsc || !s.stts) return null;
  const b = s._b, dv = s._dv;
  const n = dv.getUint32(s.stsz.p + 8);
  if (!n) return null;
  const fixed = dv.getUint32(s.stsz.p + 4);
  const sizes = new Array(n);
  for (let i = 0; i < n; i++) sizes[i] = fixed || dv.getUint32(s.stsz.p + 12 + i * 4);

  const co = s.co64 || s.stco;
  const cn = dv.getUint32(co.p + 4);
  const chunkOff = new Array(cn);
  for (let i = 0; i < cn; i++) chunkOff[i] = s.co64 ? u64(dv, co.p + 8 + i * 8) : dv.getUint32(co.p + 8 + i * 4);

  const offsets = new Array(n);
  const sc = dv.getUint32(s.stsc.p + 4);
  let sample = 0;
  for (let e = 0; e < sc; e++) {
    const first = dv.getUint32(s.stsc.p + 8 + e * 12) - 1;
    const per = dv.getUint32(s.stsc.p + 12 + e * 12);
    const sdi = dv.getUint32(s.stsc.p + 16 + e * 12);
    if (sdi !== 1) throw new UnsupportedStream('multiple codec configs');
    const last = e + 1 < sc ? dv.getUint32(s.stsc.p + 8 + (e + 1) * 12) - 1 : cn;
    for (let c = first; c < last && sample < n; c++) {
      let off = chunkOff[c];
      for (let k = 0; k < per && sample < n; k++) { offsets[sample] = off; off += sizes[sample]; sample++; }
    }
  }
  if (sample < n) throw new Error('incomplete sample table');

  const durs = new Array(n);
  let i = 0;
  const tn = dv.getUint32(s.stts.p + 4);
  for (let e = 0; e < tn; e++) {
    const cnt = dv.getUint32(s.stts.p + 8 + e * 8), d = dv.getUint32(s.stts.p + 12 + e * 8);
    for (let k = 0; k < cnt && i < n; k++) durs[i++] = d;
  }
  while (i < n) durs[i++] = durs[i - 2] || 1;

  const cto = new Array(n).fill(0);
  if (s.ctts) {
    const v = b[s.ctts.p];
    const cnum = dv.getUint32(s.ctts.p + 4);
    let j = 0;
    for (let e = 0; e < cnum; e++) {
      const cnt = dv.getUint32(s.ctts.p + 8 + e * 8);
      const off = v === 1 ? dv.getInt32(s.ctts.p + 12 + e * 8) : dv.getUint32(s.ctts.p + 12 + e * 8);
      for (let k = 0; k < cnt && j < n; k++) cto[j++] = off;
    }
  }
  let sync = null;
  if (s.stss) {
    sync = new Set();
    const sn = dv.getUint32(s.stss.p + 4);
    for (let e = 0; e < sn; e++) sync.add(dv.getUint32(s.stss.p + 8 + e * 4) - 1);
  }
  const list = new Array(n);
  let dts = 0;
  for (let k = 0; k < n; k++) {
    list[k] = { off: offsets[k], size: sizes[k], dur: durs[k], cto: cto[k], sync: !sync || sync.has(k), dts };
    dts += durs[k];
  }
  return list;
}

function parseMoof(b, moofStart, trackId, trex, state) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const out = [];
  for (const traf of children(b, 0, b.length)) {
    if (traf.type !== 'traf') continue;
    const tfhd = find(b, traf.p, traf.end, 'tfhd');
    if (!tfhd) continue;
    const f = (b[tfhd.p + 1] << 16) | (b[tfhd.p + 2] << 8) | b[tfhd.p + 3];
    const id = dv.getUint32(tfhd.p + 4);
    if (id !== trackId) continue;
    let o = tfhd.p + 8;
    const d = trex.get(id) || { sdi: 1, dur: 0, size: 0, flags: 0 };
    let base = moofStart, sdi = d.sdi, defDur = d.dur, defSize = d.size, defFlags = d.flags;
    if (f & 0x1) { base = u64(dv, o); o += 8; }
    if (f & 0x2) { sdi = dv.getUint32(o); o += 4; }
    if (f & 0x8) { defDur = dv.getUint32(o); o += 4; }
    if (f & 0x10) { defSize = dv.getUint32(o); o += 4; }
    if (f & 0x20) { defFlags = dv.getUint32(o); o += 4; }
    if (sdi !== 1) throw new UnsupportedStream('multiple codec configs');
    const tfdt = find(b, traf.p, traf.end, 'tfdt');
    if (tfdt) state.dts = b[tfdt.p] === 1 ? u64(dv, tfdt.p + 4) : dv.getUint32(tfdt.p + 4);
    let dataPos = base;
    let firstTrun = true;
    for (const tr of children(b, traf.p, traf.end)) {
      if (tr.type !== 'trun') continue;
      const v = b[tr.p];
      const tf = (b[tr.p + 1] << 16) | (b[tr.p + 2] << 8) | b[tr.p + 3];
      const count = dv.getUint32(tr.p + 4);
      let q = tr.p + 8;
      if (tf & 0x1) { dataPos = base + dv.getInt32(q); q += 4; } else if (!firstTrun) { /* بيكمّل بعد اللي قبله */ }
      firstTrun = false;
      let firstFlags = null;
      if (tf & 0x4) { firstFlags = dv.getUint32(q); q += 4; }
      for (let k = 0; k < count; k++) {
        const dur = tf & 0x100 ? dv.getUint32((q += 4) - 4) : defDur;
        const size = tf & 0x200 ? dv.getUint32((q += 4) - 4) : defSize;
        let flags = tf & 0x400 ? dv.getUint32((q += 4) - 4) : defFlags;
        if (k === 0 && firstFlags !== null) flags = firstFlags;
        let cto = 0;
        if (tf & 0x800) { cto = v === 1 ? dv.getInt32(q) : dv.getUint32(q); q += 4; }
        out.push({ off: dataPos, size, dur, cto, sync: !(flags & 0x10000), dts: state.dts });
        dataPos += size;
        state.dts += dur;
      }
    }
  }
  return out;
}

// ═════════════ الدمج ═════════════

export class Mp4Merger {
  constructor(out) {
    this.out = out;
    this.pos = 0;
    this.headerWritten = false;
    this.mdatHeaderPos = 0;
    this.tracks = [];
    this.pending = [];
    this.pendingBytes = 0;
    this.cur = null;
  }

  async write(bytes, position) {
    if (position === undefined) { await this.out.write(bytes); this.pos += bytes.length; }
    else await this.out.write(bytes, position);
  }

  async ensureHeader() {
    if (this.headerWritten) return;
    const ftyp = box('ftyp', new Bytes().str('isom').u32(512).str('isomiso2avc1mp41').bytes());
    this.mdatHeaderPos = ftyp.length;
    await this.write(concat([ftyp, new Bytes().u32(1).str('mdat').u64(16).bytes()]));
    this.headerWritten = true;
  }

  async emit(sample, data) {
    const tr = this.cur;
    if (!tr.sizes.length && !sample.sync && tr.type === 'video') return; // نبدأ من أول keyframe
    if (sample.sync && tr.type === 'video') tr.keys.push(tr.sizes.length);
    if (!tr.sizes.length) tr.firstDts = sample.dts;
    tr.sizes.push(data.length);
    tr.durs.push(sample.dur);
    tr.cto.push(sample.cto);
    tr.dtsList.push(sample.dts);
    this.pending.push(data);
    this.pendingBytes += data.length;
    if (this.pendingBytes >= CHUNK_BYTES) await this.flushChunk();
  }

  async flushChunk() {
    if (!this.pending.length) return;
    await this.ensureHeader();
    this.cur.chunks.push([this.pos, this.pending.length]);
    const data = concat(this.pending, this.pendingBytes);
    this.pending = [];
    this.pendingBytes = 0;
    await this.write(data);
  }

  /**
   * @param {{open: (start?: number, end?: number) => Promise<Response>, kind: 'video'|'audio', onProgress?: (bytes:number, total:number|null) => void}} src
   */
  async addSource(src) {
    const res = await src.open(0);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const total = Number(res.headers.get('content-length')) || null;
    const rd = new StreamReader(res.body, 0);
    const want = src.kind === 'audio' ? 'soun' : 'vide';
    let moov = null, track = null, trex = null, progressive = null, pIdx = 0;
    const fragState = { dts: 0 };
    let pendingMoof = null;
    let lastReport = 0;
    const report = () => {
      if (src.onProgress && rd.pos - lastReport > 256 * 1024) { lastReport = rd.pos; src.onProgress(rd.pos, total); }
    };

    const useMoov = (bytes) => {
      moov = parseMoov(bytes);
      track = moov.tracks.find((t) => t.handler === want);
      if (!track) throw new UnsupportedStream(src.kind === 'audio' ? 'no audio track in the audio file' : 'no video track in the video file');
      if (track.drm) throw new UnsupportedStream('DRM-protected');
      if (!track.stsd) throw new UnsupportedStream('missing codec config');
      trex = moov.trex;
      progressive = progressiveSamples(track);
      if (progressive) progressive.sort((a, b) => a.off - b.off);
      this.cur = {
        type: src.kind, src: track, movieTs: moov.movieTs,
        sizes: [], durs: [], cto: [], keys: [], chunks: [], dtsList: [], firstDts: 0,
      };
      this.tracks.push(this.cur);
    };

    try {
      for (;;) {
        const h = await rd.boxHeader();
        if (!h) break;
        const payloadLen = h.size === null ? null : h.size - h.header;
        if (h.type === 'moov') {
          useMoov(payloadLen === null ? await rd.readAll() : await rd.read(payloadLen));
        } else if (h.type === 'moof') {
          if (!moov) throw new UnsupportedStream('moof before moov');
          const body = await rd.read(payloadLen);
          pendingMoof = parseMoof(body, h.start, track.id, trex, fragState);
        } else if (h.type === 'mdat') {
          const dataStart = rd.pos;
          const dataEnd = payloadLen === null ? null : dataStart + payloadLen;
          if (!moov) {
            // moov في آخر الملف: نجيبه بـRange request
            if (dataEnd === null) throw new UnsupportedStream('moov not found');
            const tail = await src.open(dataEnd);
            if (tail.status !== 206) throw new UnsupportedStream('server does not support Range');
            const tr = new StreamReader(tail.body, dataEnd);
            for (;;) {
              const th = await tr.boxHeader();
              if (!th) break;
              if (th.type === 'moov') { useMoov(await tr.read(th.size - th.header)); break; }
              if (th.size === null) break;
              await tr.skip(th.size - th.header);
            }
            tr.cancel();
            if (!moov) throw new UnsupportedStream('moov not found');
          }
          if (pendingMoof) {
            const body = payloadLen === null ? await rd.readAll() : await rd.read(payloadLen);
            for (const s of pendingMoof) {
              const rel = s.off - dataStart;
              if (rel < 0 || rel + s.size > body.length) throw new UnsupportedStream('unexpected sample offsets');
              await this.emit(s, body.slice(rel, rel + s.size));
            }
            pendingMoof = null;
            await this.flushChunk();
          } else if (progressive) {
            // MP4 عادي: نمشي على الـmdat بالترتيب وناخد العيّنات بتاعة التراك بتاعنا
            while (pIdx < progressive.length) {
              const s = progressive[pIdx];
              if (dataEnd !== null && s.off >= dataEnd) break;
              if (s.off < rd.pos) throw new UnsupportedStream('unexpected sample order');
              await rd.skip(s.off - rd.pos);
              await this.emit(s, await rd.read(s.size));
              pIdx++;
              report();
            }
            await this.flushChunk();
            if (dataEnd !== null && rd.pos < dataEnd) await rd.skip(dataEnd - rd.pos);
            if (pIdx >= progressive.length) break; // خلصنا، مش محتاجين باقي الملف
          } else if (dataEnd !== null) await rd.skip(payloadLen);
          else break;
        } else {
          if (payloadLen === null) break;
          await rd.skip(payloadLen);
        }
        report();
      }
    } finally {
      rd.cancel();
    }
    await this.flushChunk();
    if (!this.cur || !this.cur.sizes.length) throw new UnsupportedStream(src.kind === 'audio' ? 'no audio read' : 'no video read');
    if (progressive && pIdx < progressive.length) throw new Error('file was cut short');
    if (src.onProgress) src.onProgress(rd.pos, total);
    this.cur = null;
  }

  async finish() {
    if (!this.tracks.length) throw new UnsupportedStream('no data');
    await this.ensureHeader();
    const mdatEnd = this.pos;
    const MOVIE_TS = 1000;
    // التوقيت: كل تراك بيحتفظ بالـedit list الأصلية بتاعته (عشان مزامنة الصوت/AAC priming و B-frames)
    for (const tr of this.tracks) {
      const ts = tr.src.timescale;
      const n = tr.sizes.length;
      let mediaDuration = 0;
      for (let i = 0; i < n; i++) mediaDuration += tr.durs[i];
      tr.mediaDuration = mediaDuration;
      let emptyDelay = 0; // ثواني
      let mediaTime = 0;
      for (const e of tr.src.edits) {
        if (e.mediaTime === -1) emptyDelay += e.dur / (tr.movieTs || 1000);
        else { mediaTime = e.mediaTime; break; }
      }
      let mt = mediaTime - tr.firstDts; // بوحدة التراك، نسبة لأول عينة عندنا
      let delay = emptyDelay;
      if (mt < 0) { delay += -mt / ts; mt = 0; }
      let maxEnd = 0;
      for (let i = 0; i < n; i++) maxEnd = Math.max(maxEnd, tr.dtsList[i] - tr.firstDts + tr.cto[i] + tr.durs[i]);
      tr.edit = { mediaTime: mt, delaySec: delay, segDur: Math.max(0, Math.round(((maxEnd - mt) / ts) * MOVIE_TS)) };
    }
    const minDelay = Math.min(...this.tracks.map((t) => t.edit.delaySec));
    let movieDur = 0;
    this.tracks.forEach((tr, i) => {
      tr.id = i + 1;
      tr.edit.delay = Math.round((tr.edit.delaySec - minDelay) * MOVIE_TS);
      tr.movieDur = tr.edit.delay + tr.edit.segDur;
      movieDur = Math.max(movieDur, tr.movieDur);
    });

    const mv = new Bytes();
    const mv1 = movieDur > 0xffffffff;
    if (mv1) mv.u64(0).u64(0).u32(MOVIE_TS).u64(movieDur); else mv.u32(0).u32(0).u32(MOVIE_TS).u32(movieDur);
    mv.u32(0x00010000).u16(0x0100).zeros(10);
    for (const m of [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000]) mv.u32(m);
    mv.zeros(24).u32(this.tracks.length + 1);
    const moov = box('moov', fullBox('mvhd', mv1 ? 1 : 0, 0, mv.bytes()), ...this.tracks.map((t) => this.trak(t)));
    await this.write(moov);
    await this.write(new Bytes().u64(mdatEnd - this.mdatHeaderPos).bytes(), this.mdatHeaderPos + 8);
    const v = this.tracks.find((t) => t.type === 'video');
    const a = this.tracks.find((t) => t.type === 'audio');
    return {
      size: this.pos,
      video: v ? { frames: v.sizes.length, codec: v.src.entry, width: v.src.width >>> 16, height: v.src.height >>> 16 } : null,
      audio: a ? { frames: a.sizes.length, codec: a.src.entry } : null,
    };
  }

  trak(tr) {
    const video = tr.type === 'video';
    const tk = new Bytes();
    const v1 = tr.movieDur > 0xffffffff;
    if (v1) tk.u64(0).u64(0).u32(tr.id).u32(0).u64(tr.movieDur); else tk.u32(0).u32(0).u32(tr.id).u32(0).u32(tr.movieDur);
    tk.zeros(8).u16(0).u16(video ? 0 : 1).u16(video ? 0 : 0x0100).u16(0);
    for (const m of [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000]) tk.u32(m);
    tk.u32(video ? tr.src.width : 0).u32(video ? tr.src.height : 0);
    const tkhd = fullBox('tkhd', v1 ? 1 : 0, 3, tk.bytes());

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

    const md1 = tr.mediaDuration > 0xffffffff;
    const md = new Bytes();
    if (md1) md.u64(0).u64(0).u32(tr.src.timescale).u64(tr.mediaDuration); else md.u32(0).u32(0).u32(tr.src.timescale).u32(tr.mediaDuration);
    md.u16(tr.src.lang).u16(0);
    const mdhd = fullBox('mdhd', md1 ? 1 : 0, 0, md.bytes());
    const hdlr = fullBox('hdlr', 0, 0, new Bytes().u32(0).str(video ? 'vide' : 'soun').zeros(12).str(video ? 'VideoHandler' : 'SoundHandler').u8(0).bytes());
    const mhd = video ? fullBox('vmhd', 0, 1, new Bytes().zeros(8).bytes()) : fullBox('smhd', 0, 0, new Bytes().zeros(4).bytes());
    const dinf = box('dinf', fullBox('dref', 0, 0, new Bytes().u32(1).bytes(), fullBox('url ', 0, 1)));
    const stbl = box('stbl', tr.src.stsd, ...sampleTables(tr));
    return box('trak', tkhd, edts, box('mdia', mdhd, hdlr, box('minf', mhd, dinf, stbl)));
  }
}
