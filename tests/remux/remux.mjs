// node remux.mjs <playlist.m3u8 | file.ts> <out.mp4> [chunkBytes]
import fs from 'node:fs';
import path from 'node:path';
const { TsToMp4 } = await import(new URL('../../extension/lib/ts2mp4.js', import.meta.url));
const [, , input, output, chunkArg] = process.argv;
let segs;
if (input.endsWith('.m3u8')) {
  const dir = path.dirname(input);
  segs = fs.readFileSync(input, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((l) => path.join(dir, l));
} else segs = [input];
const fd = fs.openSync(output, 'w');
let pos = 0;
const mux = new TsToMp4({
  write: async (b, position) => {
    if (position === undefined) { fs.writeSync(fd, b, 0, b.length, pos); pos += b.length; }
    else fs.writeSync(fd, b, 0, b.length, position);
  },
});
const chunk = Number(chunkArg) || 0;
const t0 = Date.now();
for (const s of segs) {
  const data = new Uint8Array(fs.readFileSync(s));
  if (!chunk) await mux.push(data);
  else for (let i = 0; i < data.length; i += chunk) await mux.push(data.subarray(i, i + chunk)); // أحجام عشوائية تختبر الحتت المتقطعة
}
const info = await mux.finish();
fs.closeSync(fd);
console.log(JSON.stringify({ ...info, ms: Date.now() - t0, segs: segs.length, maxRssMB: Math.round(process.resourceUsage().maxRSS / 1024) }));
