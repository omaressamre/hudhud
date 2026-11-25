import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
const HERE = fileURLToPath(new URL('.', import.meta.url));
const L = HERE + '../extension/lib/';
const SITE = process.env.HH_SITE || HERE + '.fixtures/site';
const REMUX = process.env.HH_REMUX || HERE + '.fixtures/remux';
const { classify, itemId, extFor } = await import(L + 'detect.js');
const { parseM3U8 } = await import(L + 'hls.js');
const { buildBaseName, buildPath, findRule, sanitizeSegment } = await import(L + 'naming.js');
const H = (o) => Object.entries(o).map(([name, value]) => ({ name, value }));

assert.equal(classify('https://a.com/v.mp4', H({ 'Content-Type': 'video/mp4', 'Content-Length': '5000000' })).kind, 'direct');
assert.equal(classify('https://a.com/v.mp4', H({ 'Content-Type': 'video/mp4', 'Content-Length': '5000' })), null);
assert.equal(classify('https://a.com/v', H({ 'Content-Type': 'video/mp4', 'Content-Range': 'bytes 0-1/90000000' })).size, 90000000);
assert.equal(classify('https://a.com/x/master.m3u8?t=1', []).kind, 'hls');
assert.equal(classify('https://a.com/p', H({ 'content-type': 'application/dash+xml' })).kind, 'dash');
assert.equal(classify('https://a.com/seg1.ts', H({ 'content-type': 'video/mp2t' })), null);
assert.equal(classify('https://r1.googlevideo.com/videoplayback?x', H({ 'content-type': 'video/mp4' })), null);
assert.equal(classify('https://a.com/page.html', H({ 'content-type': 'text/html' })), null);
assert.equal(itemId('https://a.com/v.mp4?range=0-100'), itemId('https://a.com/v.mp4?range=500-900'));
assert.equal(extFor('https://a.com/v.webm?x', 'video/webm'), 'webm');
assert.equal(extFor('https://a.com/v', 'video/mp4'), 'mp4');

const master = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="ar",URI="audio/ar.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,CODECS="avc1.4d401e,mp4a.40.2"
360/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080
1080/index.m3u8`;
const m = parseM3U8(master, 'https://cdn.x.com/v/master.m3u8');
assert.equal(m.type, 'master');
assert.equal(m.variants[0].height, 1080);
assert.equal(m.variants[0].url, 'https://cdn.x.com/v/1080/index.m3u8');
assert.equal(m.audio[0].url, 'https://cdn.x.com/v/audio/ar.m3u8');
const media = parseM3U8('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="k"\n#EXTINF:10.0,\na.ts\n#EXTINF:5.5,\nb.ts\n#EXT-X-ENDLIST', 'https://x/');
assert.deepEqual([media.type, media.duration, media.segments, media.encrypted, media.live], ['media', 16, 2, 'AES-128', false]);
assert.equal(parseM3U8('<html>', 'https://x/'), null);

assert.equal(sanitizeSegment('a/b:c*?"<>|. '), 'a b c');
assert.equal(sanitizeSegment('CON'), '_CON');
const rules = [{ match: 'example.com', template: '%hostname - %title', directory: 'Ex/../Sub', replace: [{ from: '/\\s*\\|\\s*Example$/', to: '' }] }];
const r = findRule(rules, 'https://www.example.com/watch/1');
assert.ok(r);
assert.equal(findRule(rules, 'https://notexample.com/'), null);
const name = buildBaseName({ title: 'فيلم: الحلقة 1 | Example', pageUrl: 'https://www.example.com/w' }, {}, r);
assert.equal(name, 'example.com - فيلم الحلقة 1');
assert.equal(buildPath(name, 'mp4', { subdir: 'Videos' }, r), 'Videos/Ex/Sub/example.com - فيلم الحلقة 1.mp4');
assert.equal(Array.from(buildBaseName({ title: 'ا'.repeat(100) }, { maxLength: 64 }, null)).length, 64);
assert.equal(buildBaseName({ title: '' }, {}, null), 'video');
console.log('all tests passed');

// ── v0.3: mp4 sniff + pairing ──
import fs from 'node:fs';
const { sniffMp4 } = await import(L + 'mp4.js');
const { pairItems } = await import(L + 'pair.js');
const ab = (p, n = 65536) => { const b = fs.readFileSync(p).subarray(0, n); return b.buffer.slice(b.byteOffset, b.byteOffset + b.length); };
const sv = sniffMp4(ab(SITE + '/fb/v.mp4'));
assert.equal(sv.tracks[0].type, 'video'); assert.equal(sv.tracks[0].height, 360);
assert.equal(sniffMp4(ab(SITE + '/fb/a.mp4')).tracks[0].type, 'audio');
assert.equal(sniffMp4(ab(SITE + '/fb/a2.mp4', 1e9)).duration, 6);
assert.equal(sniffMp4(new TextEncoder().encode('<html>hello world</html>').buffer), null);
const t0 = 1_000_000;
const P = pairItems([
  { id: 'v1', split: true, track: 'video', assetId: '1', height: 720, detectedAt: t0, url: 'v1' },
  { id: 'v1b', split: true, track: 'video', assetId: '1', height: 360, detectedAt: t0 + 5, url: 'v1b' },
  { id: 'v2', split: true, track: 'video', detectedAt: t0 + 100, duration: 10, url: 'v2' },
  { id: 'a2', split: true, track: 'audio', detectedAt: t0 + 50, duration: 10.4, url: 'a2' },
  { id: 'a1', split: true, track: 'audio', assetId: '1', detectedAt: t0 + 900, url: 'a1' },
  { id: 'a9', split: true, track: 'audio', detectedAt: t0 + 99999, duration: 3, url: 'a9' },
  { id: 'd', kind: 'direct', detectedAt: t0, url: 'd' },
]);
const byId = Object.fromEntries(P.map((i) => [i.id, i]));
assert.equal(byId.v1.audio.id, 'a1');
assert.deepEqual(byId.v1.variants.map((v) => v.height), [720, 360]);
assert.equal(byId.v2.audio.id, 'a2');
assert.ok(byId.a9.audioOnly);
assert.ok(byId.d && !byId.a1 && !byId.v1b);
console.log('v0.3 tests passed');
const { parseMediaPlaylist, ivFor } = await import(L + 'hls.js');
const mp = parseMediaPlaylist(fs.readFileSync(SITE + '/hls2/br/index.m3u8', 'utf8'), 'http://h/br/index.m3u8');
assert.equal(mp.segments[1].range.start, mp.segments[0].range.end + 1);
assert.ok(mp.ended && !mp.drm);
assert.deepEqual(Array.from(ivFor({ iv: null }, 5)).slice(-2), [0, 5]);
assert.deepEqual(Array.from(ivFor({ iv: '0x0102' }, 0)).slice(-2), [1, 2]);
assert.ok(parseMediaPlaylist('#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://x"\n#EXTINF:1,\na.ts\n', 'http://h/').drm);
console.log('hls tests passed');
const { TsToMp4, splitNals, parseSps } = await import(L + 'ts2mp4.js');
{
  const chunks = []; let pos = 0;
  const mux = new TsToMp4({ write: async (b, p) => { chunks.push([p ?? pos, b]); if (p === undefined) pos += b.length; } });
  for (const f of fs.readdirSync(REMUX + '/t1').filter((x) => x.endsWith('.ts')).sort()) await mux.push(new Uint8Array(fs.readFileSync(REMUX + '/t1/' + f)));
  const info = await mux.finish();
  assert.equal(info.video.frames, 250); assert.equal(info.audio.frames, 470); assert.equal(info.video.width, 640);
  assert.deepEqual(splitNals(Uint8Array.of(0, 0, 0, 1, 0x67, 1, 0, 0, 1, 0x68, 2)).map((n) => n[0]), [0x67, 0x68]);
}
console.log('remux tests passed');
