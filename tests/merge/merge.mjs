// node merge.mjs video.mp4 audio.mp4 out.mp4
import fs from 'node:fs';
import { Readable } from 'node:stream';
const { Mp4Merger } = await import(new URL('../../extension/lib/mp4merge.js', import.meta.url));
const [, , vf, af, of] = process.argv;
const opener = (path) => async (start = 0) => {
  const size = fs.statSync(path).size;
  // نقرا على حتت صغيرة عشان نختبر الـstreaming
  const body = Readable.toWeb(fs.createReadStream(path, { start, highWaterMark: 4096 + Math.floor(Math.random() * 30000) }));
  return { ok: true, status: start ? 206 : 200, headers: new Headers({ 'content-length': String(size - start) }), body };
};
const fd = fs.openSync(of, 'w');
let pos = 0;
const m = new Mp4Merger({ write: async (b, p) => { if (p === undefined) { fs.writeSync(fd, b, 0, b.length, pos); pos += b.length; } else fs.writeSync(fd, b, 0, b.length, p); } });
const t0 = Date.now();
await m.addSource({ open: opener(vf), kind: 'video' });
if (af !== '-') await m.addSource({ open: opener(af), kind: 'audio' });
const info = await m.finish();
fs.closeSync(fd);
console.log(JSON.stringify({ ...info, ms: Date.now() - t0 }));
