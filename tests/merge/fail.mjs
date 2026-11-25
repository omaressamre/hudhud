import fs from 'node:fs';
import { Readable } from 'node:stream';
const { Mp4Merger } = await import(new URL('../../extension/lib/mp4merge.js', import.meta.url));
const open = (path, noRange) => async (start = 0) => ({ ok: true, status: start && !noRange ? 206 : 200, headers: new Headers(), body: Readable.toWeb(fs.createReadStream(path, { start: noRange ? 0 : start })) });
const sink = { write: async () => {} };
for (const [name, src] of [
  ['DRM', { open: open('c/drm_v.mp4'), kind: 'video' }],
  ['audio file has no audio', { open: open('c/fb_v.mp4'), kind: 'audio' }],
  ['truncated', { open: open('c/tr_v.mp4'), kind: 'video' }],
  ['moov-at-end, no Range support', { open: open('c/me_v.mp4', true), kind: 'video' }],
  ['not mp4 at all', { open: open('merge.mjs'), kind: 'video' }],
]) {
  try { const m = new Mp4Merger(sink); await m.addSource(src); await m.finish(); console.log('  ', name, '→ (no error)'); }
  catch (e) { console.log('  ', name, '→', e.code || 'error', ':', e.message); }
}
