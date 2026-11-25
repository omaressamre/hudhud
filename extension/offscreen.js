// تحميل HLS جوه المتصفح (من غير البرنامج المساعد).
// بيشتغل في offscreen document لأن الـservice worker ما ينفعش يعمل blob URLs وبيقفل لوحده.
// الـsegments بتتكتب بالترتيب على OPFS (القرص) مش في الرام، فالفيديوهات الطويلة مش بتتقل الجهاز.

import { parseM3U8, parseMediaPlaylist, ivFor } from './lib/hls.js';
import { TsToMp4 } from './lib/ts2mp4.js';
import { Mp4Merger } from './lib/mp4merge.js';
import { initI18n, t } from './lib/i18n.js';

// offscreen documents can't read chrome.storage, so ask the service worker for the language
const syncLang = () => chrome.runtime.sendMessage({ type: 'uiLang' }).then((r) => initI18n(r?.data || 'auto')).catch(() => initI18n('auto'));
syncLang();
chrome.runtime.onMessage.addListener((m) => { if (m?.target === 'offscreen' && m.type === 'lang') syncLang(); });

const CONCURRENCY = 6;
const MAX_AHEAD = 24; // أقصى عدد segments مستنية في الرام قبل ما تتكتب
const jobs = new Map(); // jobId → { ctrl, fileName, blobUrl }

function post(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {});
}

class Fail extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

async function fetchBuf(url, range, signal) {
  const headers = range ? { Range: `bytes=${range.start}-${range.end}` } : undefined;
  for (let attempt = 1; ; attempt++) {
    try {
      const r = await fetch(url, { credentials: 'include', headers, signal });
      if (!r.ok) throw new Fail('http', `HTTP ${r.status}`);
      return new Uint8Array(await r.arrayBuffer());
    } catch (e) {
      if (signal.aborted || attempt >= 4 || (e instanceof Fail && /HTTP 40[134]/.test(e.message))) throw e;
      await new Promise((res) => setTimeout(res, 600 * attempt));
    }
  }
}

async function fetchText(url, signal) {
  return new TextDecoder().decode(await fetchBuf(url, null, signal));
}

function pickVariant(variants, height) {
  if (!height) return variants[0];
  return variants.find((v) => (v.height || 0) <= height) || variants[variants.length - 1];
}

// بيقرا الـplaylists ويطلع خطة التحميل: segments الفيديو (والصوت لو منفصل) ونوع العلبة
async function makePlan({ url, height }, signal) {
  let text = await fetchText(url, signal);
  const top = parseM3U8(text, url);
  if (!top) throw new Fail('parse', t('hlsBad'));
  let videoUrl = url, audioUrl = null;
  if (top.type === 'master') {
    if (!top.variants.length) throw new Fail('parse', t('hlsNoVariants'));
    const v = pickVariant(top.variants, height);
    if (v.audioGroup) {
      const rends = top.audio.filter((x) => x.group === v.audioGroup);
      const a = rends.find((x) => x.default) || rends[0];
      if (a) audioUrl = a.url;
    }
    videoUrl = v.url;
    text = await fetchText(videoUrl, signal);
  }
  const check = (m) => {
    if (m.drm) throw new Fail('drm', t('drmBlocked'));
    if (!m.ended) throw new Fail('live', t('hlsLive'));
    if (!m.segments.length) throw new Fail('parse', t('hlsEmpty'));
  };
  const media = parseMediaPlaylist(text, videoUrl);
  check(media);
  const fmp4 = (m) => !!m.map || /\.(m4s|mp4|cmfv|cmfa|m4a)(\?|$)/i.test(m.segments[0].url);
  let audio = null;
  if (audioUrl) {
    audio = parseMediaPlaylist(await fetchText(audioUrl, signal), audioUrl);
    check(audio);
    if (fmp4(media) || fmp4(audio) || /\.(aac|mp3|ac3|ec3)(\?|$)/i.test(audio.segments[0].url)) {
      throw new Fail('need-helper', t('hlsAudioUnsupported'));
    }
  }
  return {
    container: fmp4(media) ? 'fmp4' : 'ts',
    map: media.map,
    separateAudio: !!audio,
    segs: [
      ...media.segments.map((x) => ({ ...x, audio: false })),
      ...(audio ? audio.segments.map((x) => ({ ...x, audio: true })) : []),
    ],
  };
}

class RemuxFailed extends Error {
  constructor(cause) { super(cause?.message || String(cause)); this.cause = cause; }
}

// تحميل الـsegments بالترتيب وكتابتها على OPFS: كما هي (raw) أو بعد التحويل لـMP4 (remux)
async function download(jobId, plan, mode, jobSignal, state) {
  const ctrl = new AbortController();
  const signal = ctrl.signal;
  const onAbort = () => ctrl.abort();
  jobSignal.addEventListener('abort', onAbort);

  const ext = mode === 'remux' || plan.container === 'fmp4' ? 'mp4' : 'ts';
  const root = await navigator.storage.getDirectory();
  state.fileName = `${jobId}.${ext}`;
  const fh = await root.getFileHandle(state.fileName, { create: true });
  const writable = await fh.createWritable({ keepExistingData: false });
  state.writable = writable;

  // كتابة بمكان صريح دايماً (عشان المحوّل بيرجع يصلّح الهيدر في الآخر)
  let pos = 0;
  const out = {
    write: async (b, p) => {
      if (p === undefined) { await writable.write({ type: 'write', position: pos, data: b }); pos += b.length; }
      else await writable.write({ type: 'write', position: p, data: b });
    },
  };
  const mux = mode === 'remux' ? new TsToMp4(out, { separateAudio: plan.separateAudio }) : null;
  const sink = async (data, seg) => {
    if (!mux) return out.write(data);
    if (seg.audio && data[0] !== 0x47) throw new Fail('need-helper', t('hlsAudioUnsupported'));
    try {
      if (seg.audio) await mux.pushAudio(data); else await mux.push(data);
    } catch (e) { throw new RemuxFailed(e); }
  };

  const keys = new Map();
  const getKey = (uri) => {
    if (!keys.has(uri)) {
      keys.set(uri, fetchBuf(uri, null, signal).then((raw) => crypto.subtle.importKey('raw', raw, { name: 'AES-CBC' }, false, ['decrypt'])));
    }
    return keys.get(uri);
  };
  const decrypt = async (seg, data) => {
    if (!seg.key) return data;
    const k = await getKey(seg.key.uri);
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv: ivFor(seg.key, seg.seq) }, k, data));
  };

  try {
    if (plan.container === 'fmp4' && plan.map) await out.write(await fetchBuf(plan.map.url, plan.map.range, signal));

    const segs = plan.segs;
    const ready = new Map();
    let next = 0, idx = 0, done = 0, bytes = 0, lastPost = 0;
    let failure = null;
    let writeChain = Promise.resolve();
    const flush = () => {
      writeChain = writeChain.then(async () => {
        while (ready.has(next)) {
          const d = ready.get(next);
          ready.delete(next);
          await sink(d, segs[next]);
          next++;
        }
      });
      return writeChain;
    };
    const started = Date.now();
    const worker = async () => {
      while (idx < segs.length && !signal.aborted) {
        while (idx - next > MAX_AHEAD && !signal.aborted) await new Promise((r) => setTimeout(r, 50));
        if (signal.aborted) break;
        const i = idx++;
        const seg = segs[i];
        const data = await decrypt(seg, await fetchBuf(seg.url, seg.range, signal));
        ready.set(i, data);
        done++;
        bytes += data.byteLength;
        await flush();
        if (Date.now() - lastPost > 500 || done === segs.length) {
          lastPost = Date.now();
          const secs = (Date.now() - started) / 1000;
          const rate = bytes / Math.max(secs, 0.1);
          post({
            type: 'hls-progress', jobId,
            percent: Math.min(99.9, (done / segs.length) * 100),
            downloaded: bytes, total: (bytes / done) * segs.length,
            speed: rate > 1048576 ? `${(rate / 1048576).toFixed(1)}MiB/s` : `${Math.round(rate / 1024)}KiB/s`,
            eta: fmtEta(((segs.length - done) * secs) / done),
          });
        }
      }
    };
    const guarded = () => worker().catch((e) => { if (!failure) failure = e; ctrl.abort(); });
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, segs.length) }, guarded));
    if (failure) throw failure;
    await flush();
    if (jobSignal.aborted) throw new Fail('canceled', 'CANCELED');
    let info = null;
    if (mux) {
      try { info = await mux.finish(); } catch (e) { throw new RemuxFailed(e); }
    }
    await writable.close();
    state.writable = null;
    return { fh, ext, info };
  } catch (e) {
    try { await writable.abort(); } catch {}
    state.writable = null;
    try { await root.removeEntry(state.fileName); } catch {}
    state.fileName = null;
    throw e;
  } finally {
    jobSignal.removeEventListener('abort', onAbort);
  }
}

async function run(msg) {
  const { jobId } = msg;
  const ctrl = new AbortController();
  const signal = ctrl.signal;
  const state = { ctrl, fileName: null, blobUrl: null, writable: null };
  jobs.set(jobId, state);
  try {
    const plan = await makePlan(msg, signal);
    const wantMp4 = msg.remux !== false;
    let mode = plan.container === 'ts' && (wantMp4 || plan.separateAudio) ? 'remux' : 'raw';
    let note = '';
    let result;
    try {
      result = await download(jobId, plan, mode, signal, state);
    } catch (e) {
      if (!(e instanceof RemuxFailed) || signal.aborted) throw e;
      if (plan.separateAudio) throw new Fail('need-helper', t('remuxFailed', e.message));
      // المحوّل ما عرفش يتعامل مع الصيغة: نحمّل TS زي ما هو
      console.warn('[Hudhud] remux failed, falling back to TS:', e.cause || e);
      note = t('savedAsTs', e.message);
      mode = 'raw';
      post({ type: 'hls-progress', jobId, percent: 0, downloaded: 0, total: 0, speed: '', eta: '' });
      result = await download(jobId, plan, mode, signal, state);
    }
    const file = await result.fh.getFile();
    state.blobUrl = URL.createObjectURL(file);
    post({ type: 'hls-ready', jobId, url: state.blobUrl, ext: result.ext, size: file.size, converted: mode === 'remux', note, info: result.info });
  } catch (e) {
    await cleanup(jobId);
    const canceled = signal.aborted || e.code === 'canceled';
    post({ type: 'hls-error', jobId, canceled, code: e.code || 'error', message: canceled ? 'CANCELED' : (e.message || String(e)) });
  }
}

// ───── دمج صورة + صوت (فيسبوك/انستجرام) في MP4 واحد ─────
async function runMerge(msg) {
  const { jobId, videoUrl, audioUrl, fallbackUrl } = msg;
  const ctrl = new AbortController();
  const signal = ctrl.signal;
  const state = { ctrl, fileName: null, blobUrl: null, writable: null };
  jobs.set(jobId, state);
  const root = await navigator.storage.getDirectory();
  let lastErr = null;
  for (let attempt = 1; attempt <= 2 && !signal.aborted; attempt++) {
    try {
      state.fileName = `${jobId}.mp4`;
      const fh = await root.getFileHandle(state.fileName, { create: true });
      const writable = await fh.createWritable({ keepExistingData: false });
      state.writable = writable;
      let pos = 0;
      const out = {
        write: async (b, p) => {
          if (p === undefined) { await writable.write({ type: 'write', position: pos, data: b }); pos += b.length; }
          else await writable.write({ type: 'write', position: p, data: b });
        },
      };
      const open = (url) => async (start = 0) => {
        const r = await fetch(url, { credentials: 'include', signal, headers: start ? { Range: `bytes=${start}-` } : undefined });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r;
      };
      const prog = { video: [0, 0], audio: [0, 0] };
      const started = Date.now();
      let lastPost = 0;
      const onProgress = (kind) => (bytes, total) => {
        prog[kind] = [bytes, total || 0];
        if (Date.now() - lastPost < 500) return;
        lastPost = Date.now();
        const got = prog.video[0] + prog.audio[0];
        const tot = prog.video[1] + (prog.audio[1] || prog.video[1] * 0.08);
        const rate = got / Math.max((Date.now() - started) / 1000, 0.1);
        post({
          type: 'hls-progress', jobId,
          percent: tot ? Math.min(99.9, (got / tot) * 100) : -1,
          downloaded: got, total: tot,
          speed: rate > 1048576 ? `${(rate / 1048576).toFixed(1)}MiB/s` : `${Math.round(rate / 1024)}KiB/s`,
          eta: tot && rate ? fmtEta((tot - got) / rate) : '',
        });
      };
      const merger = new Mp4Merger(out);
      await merger.addSource({ open: open(videoUrl), kind: 'video', onProgress: onProgress('video') });
      await merger.addSource({ open: open(audioUrl), kind: 'audio', onProgress: onProgress('audio') });
      const info = await merger.finish();
      await writable.close();
      state.writable = null;
      const file = await fh.getFile();
      state.blobUrl = URL.createObjectURL(file);
      post({ type: 'hls-ready', jobId, url: state.blobUrl, ext: 'mp4', size: file.size, converted: true, info });
      return;
    } catch (e) {
      lastErr = e;
      try { if (state.writable) await state.writable.abort(); } catch {}
      state.writable = null;
      try { await root.removeEntry(state.fileName); } catch {}
      // نعيد مرة واحدة بس لو المشكلة في النت (مش في صيغة الملف)
      if (e.code === 'unsupported' || signal.aborted) break;
    }
  }
  await cleanup(jobId);
  const canceled = signal.aborted;
  post({
    type: 'hls-error', jobId, canceled, code: canceled ? 'canceled' : 'merge-failed', fallbackUrl,
    message: canceled ? 'CANCELED' : (lastErr?.message || String(lastErr)),
  });
}

// ───── الصور المصغّرة: frame حقيقي من الفيديو ─────
// بنحمّل أول حتة صغيرة بس (مش الفيديو كله) ونشغّلها في <video> مخفي وناخد منها صورة.

async function fetchHead(url, maxBytes, signal, useRange = true) {
  const r = await fetch(url, { credentials: 'include', signal, headers: useRange ? { Range: `bytes=0-${maxBytes - 1}` } : undefined });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  // لو السيرفر تجاهل الـRange، بنقطع القراية بعد الحجم المطلوب
  const reader = r.body.getReader();
  const parts = [];
  let got = 0;
  while (got < maxBytes) {
    const { value, done } = await reader.read();
    if (done) break;
    parts.push(value);
    got += value.length;
  }
  reader.cancel().catch(() => {});
  const out = new Uint8Array(Math.min(got, maxBytes));
  let o = 0;
  for (const p of parts) { const k = Math.min(p.length, out.length - o); out.set(p.subarray(0, k), o); o += k; if (o >= out.length) break; }
  return out;
}

function frameFromBlob(blob) {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.preload = 'auto';
    const url = URL.createObjectURL(blob);
    let finished = false;
    const done = (val, err) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      v.removeAttribute('src');
      try { v.load(); } catch {}
      URL.revokeObjectURL(url);
      if (err) reject(err); else resolve(val);
    };
    const timer = setTimeout(() => done(null, new Error('timeout')), 10_000);
    const grab = () => {
      try {
        if (!v.videoWidth) return done(null, new Error('no video frame'));
        const w = 240;
        const h = Math.max(1, Math.round((w * v.videoHeight) / v.videoWidth));
        const c = document.createElement('canvas');
        c.width = w;
        c.height = Math.min(h, 427);
        c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
        done(c.toDataURL('image/jpeg', 0.72));
      } catch (e) { done(null, e); }
    };
    v.onerror = () => done(null, new Error('decode failed'));
    v.onloadeddata = () => {
      // نتجنب أول frame (غالباً أسود): نروح لثانية ونص لو متاحة في الجزء اللي اتحمّل
      const end = v.buffered.length ? v.buffered.end(v.buffered.length - 1) : 0;
      const target = Math.min(1.5, end * 0.5);
      if (target > 0.2) { v.onseeked = grab; v.currentTime = target; } else grab();
    };
    v.src = url;
  });
}

// TS → MP4 في الرام (لـsegment واحد بس)
async function tsToMp4Bytes(ts) {
  const writes = [];
  let pos = 0, size = 0;
  const mux = new TsToMp4({
    write: async (b, p) => {
      const at = p === undefined ? pos : p;
      writes.push([at, b.slice()]);
      if (p === undefined) pos += b.length;
      size = Math.max(size, at + b.length);
    },
  });
  await mux.push(ts);
  await mux.finish();
  const out = new Uint8Array(size);
  for (const [at, b] of writes) out.set(b, at);
  return out;
}

async function hlsThumbBlob(url, signal) {
  let text = await fetchText(url, signal);
  const top = parseM3U8(text, url);
  if (!top) throw new Error('bad m3u8');
  let mediaUrl = url;
  if (top.type === 'master') {
    // أقل جودة ≥ 360 (أسرع، وكفاية لصورة صغيرة)
    const vs = top.variants;
    const v = [...vs].reverse().find((x) => (x.height || 0) >= 360) || vs[vs.length - 1];
    mediaUrl = v.url;
    text = await fetchText(mediaUrl, signal);
  }
  const media = parseMediaPlaylist(text, mediaUrl);
  if (media.drm || !media.segments.length) throw new Error('no usable segment');
  const n = media.segments.length;
  const seg = media.segments[media.ended ? Math.min(n - 1, Math.floor(n * 0.1)) : n - 1];
  let data = await fetchBuf(seg.url, seg.range, signal);
  if (seg.key) {
    const raw = await fetchBuf(seg.key.uri, null, signal);
    const k = await crypto.subtle.importKey('raw', raw, { name: 'AES-CBC' }, false, ['decrypt']);
    data = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv: ivFor(seg.key, seg.seq) }, k, data));
  }
  if (media.map) {
    const init = await fetchBuf(media.map.url, media.map.range, signal);
    return new Blob([init, data], { type: 'video/mp4' });
  }
  return new Blob([await tsToMp4Bytes(data)], { type: 'video/mp4' });
}

async function makeThumb(item) {
  const signal = AbortSignal.timeout(20_000);
  let blob;
  if (item.kind === 'hls') {
    blob = await hlsThumbBlob(item.url, signal);
  } else if (item.split) {
    const u = item.variants?.[item.variants.length - 1]?.url || item.url; // أصغر جودة
    const sep = u.includes('?') ? '&' : '?';
    blob = new Blob([await fetchHead(u + sep + 'bytestart=0&byteend=1499999', 1_500_000, signal, false)], { type: 'video/mp4' });
  } else if (item.kind === 'direct') {
    blob = new Blob([await fetchHead(item.url, 2_500_000, signal)], { type: item.mime && item.mime.startsWith('video/') ? item.mime : 'video/mp4' });
  } else {
    return null;
  }
  return frameFromBlob(blob);
}

function fmtEta(s) {
  if (!isFinite(s)) return '';
  s = Math.round(s);
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

async function cleanup(jobId) {
  const st = jobs.get(jobId);
  if (!st) return;
  jobs.delete(jobId);
  if (st.writable) { try { await st.writable.abort(); } catch {} }
  if (st.blobUrl) URL.revokeObjectURL(st.blobUrl);
  if (st.fileName) {
    try { await (await navigator.storage.getDirectory()).removeEntry(st.fileName); } catch {}
  }
}

// ملفات قديمة فضلت من تحميلات اتقطعت
(async () => {
  try {
    const root = await navigator.storage.getDirectory();
    for await (const [name] of root.entries()) if (!jobs.has(name.split('.')[0])) await root.removeEntry(name).catch(() => {});
  } catch {}
})();

chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
  if (msg?.target !== 'offscreen') return false;
  if (msg.type === 'thumb') {
    makeThumb(msg.item).then((t) => sendResponse(t || null), (e) => { console.warn('[Hudhud] thumb', e?.message || e); sendResponse(null); });
    return true;
  }
  if (msg.type === 'hls-start') (msg.op === 'merge' ? runMerge : run)(msg);
  else if (msg.type === 'hls-cancel') jobs.get(msg.jobId)?.ctrl.abort();
  else if (msg.type === 'hls-cleanup') cleanup(msg.jobId);
  else if (msg.type === 'hls-count') { sendResponse(jobs.size); return true; }
  sendResponse(true);
  return false;
});
