import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
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
console.log('detect + naming tests passed');

// ── locales: same keys in every language, placeholders match
const loc = (l) => JSON.parse(fs.readFileSync(HERE + `../extension/_locales/${l}/messages.json`, 'utf8'));
const ar = loc('ar'), en = loc('en');
assert.deepEqual(Object.keys(ar).sort(), Object.keys(en).sort());
for (const k of Object.keys(ar)) {
  const ph = (s) => (s.match(/\$\d/g) || []).sort().join();
  assert.equal(ph(ar[k].message), ph(en[k].message), `placeholders differ in ${k}`);
}
const manifest = JSON.parse(fs.readFileSync(HERE + '../extension/manifest.json', 'utf8'));
for (const m of JSON.stringify(manifest).match(/__MSG_(\w+)__/g)) assert.ok(en[m.slice(6, -2)], m);
console.log('locale tests passed');

// ── Firefox manifest
const { firefoxManifest, GECKO_ID } = await import('../scripts/firefox-manifest.mjs');
const ff = firefoxManifest(manifest);
assert.equal(ff.browser_specific_settings.gecko.id, GECKO_ID);
assert.deepEqual(ff.background, { scripts: ['background.js'], type: 'module' });
assert.ok(!ff.key && !ff.minimum_chrome_version && !ff.permissions.includes('offscreen'));
assert.ok(ff.permissions.includes('nativeMessaging') && ff.version === manifest.version);
console.log('firefox manifest tests passed');

// ── diagnostics: no personal data
const { scrubError, browserName, formatDiagnostics } = await import(L + 'diagnostics.js');
const scrubbed = scrubError('ERROR: https://www.youtube.com/watch?v=abc123 failed writing C:\\Users\\Omar\\Videos\\my clip.mp4 and /home/omar/x.mp4 for a@b.com');
assert.ok(!/abc123|Omar|omar|a@b\.com|watch/.test(scrubbed), scrubbed);
assert.ok(scrubbed.includes('<url www.youtube.com>') && scrubbed.includes('<path>') && scrubbed.includes('<email>'), scrubbed);
assert.equal(scrubError(''), '');
assert.equal(browserName({ ua: 'Mozilla/5.0 Chrome/131.0.0.0 Safari/537.36 Edg/131.0.2903.70' }), 'Edge 131.0.2903.70');
assert.equal(browserName({ brands: [{ brand: 'Google Chrome', version: '131' }] }), 'Chrome 131');
assert.equal(browserName({ ua: 'Chrome/131.0.0.0', isBrave: true }), 'Brave (Chromium 131.0.0.0)');
assert.equal(browserName({ firefox: '133.0' }), 'Firefox 133.0');
const diag = formatDiagnostics({
  extVersion: '0.9.6', browser: 'Chrome 131', os: 'win', arch: 'x86-64', uiLang: 'ar', managed: true, firefox: false,
  helper: { version: '0.9.6', ytdlp: '2026.11.01', ffmpeg: true, deno: false, os: 'windows', defaultDir: 'C:\\Users\\Omar\\Downloads', extDir: 'C:\\Users\\Omar\\AppData\\Local\\Hudhud\\extension', installId: 'secret-id' },
  settings: { defaultEngine: 'native', maxConcurrent: 3, hlsToMp4: true },
  lastError: { error: 'HTTP 403 on https://x.com/a/b', engine: 'native', kind: 'page', host: 'x.com', at: 0 },
});
assert.ok(diag.includes('Helper: 0.9.6') && diag.includes('Deno: no') && diag.includes('One-click updates: yes') && diag.includes('<url x.com>'), diag);
assert.ok(!/Omar|secret-id|AppData/.test(diag), diag);
assert.ok(formatDiagnostics({ extVersion: '1', browser: 'x', os: 'mac', helper: null }).includes('Helper: not connected'));
console.log('diagnostics tests passed');
