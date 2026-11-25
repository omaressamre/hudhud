import fs from 'node:fs';
const { TsToMp4 } = await import(new URL('../../extension/lib/ts2mp4.js', import.meta.url));
const out = '/tmp/big4g.mp4';
const fd = fs.openSync(out, 'w');
let pos = 0;
const mux = new TsToMp4({ write: async (b, p) => { if (p === undefined) { fs.writeSync(fd, b, 0, b.length, pos); pos += b.length; } else fs.writeSync(fd, b, 0, b.length, p); } });
const segs = fs.readFileSync('t1/index.m3u8', 'utf8').split('\n').filter((l) => l.endsWith('.ts'));
let first = true;
for (const s of segs) {
  await mux.push(new Uint8Array(fs.readFileSync('t1/' + s)));
  if (first) { const GAP = 5 * 2 ** 30; mux.pos += GAP; pos += GAP; first = false; } // نتخطى 5GB (sparse file)
}
console.log(JSON.stringify(await mux.finish()));
fs.closeSync(fd);
