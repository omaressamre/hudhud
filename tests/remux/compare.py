# python3 compare.py <dir with index.m3u8>  → يقارن تحويلنا بتحويل ffmpeg
import subprocess, json, sys, os, hashlib
d = sys.argv[1]; chunk = sys.argv[2] if len(sys.argv) > 2 else '0'
m3u8 = os.path.join(d, 'index.m3u8'); ours = os.path.join(d, 'ours.mp4'); ref = os.path.join(d, 'ref.mp4')
r = subprocess.run(['node', __import__('os').path.join(__import__('os').path.dirname(__import__('os').path.abspath(__file__)),'remux.mjs'), m3u8, ours, chunk], capture_output=True, text=True)
if r.returncode: print('REMUX FAILED', r.stderr[-600:]); sys.exit(1)
info = json.loads(r.stdout)
subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-allowed_extensions', 'ALL', '-i', m3u8, '-c', 'copy', ref], check=True)
def probe(f):
    o = json.loads(subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'stream=codec_type,codec_name,start_time,duration,nb_frames,width,height,sample_rate,channels:format=duration', '-of', 'json', f], capture_output=True, text=True).stdout)
    return {s['codec_type']: s for s in o['streams']}, float(o['format']['duration'])
def md5s(f, sel):
    out = subprocess.run(['ffmpeg', '-v', 'error', '-i', f, '-map', sel, '-f', 'framemd5', '-'], capture_output=True, text=True)
    return [l.split(',')[-1].strip() for l in out.stdout.splitlines() if l and not l.startswith('#')], out.stderr.strip()[:300]
def pcm(f):
    out = subprocess.run(['ffmpeg', '-v', 'error', '-i', f, '-map', '0:a:0', '-f', 's16le', '-'], capture_output=True)
    return out.stdout
so, do = probe(ours); sr, dr = probe(ref)
ok = True; notes = []
for t in sr:
    if t not in so: ok = False; notes.append(f'missing {t}'); continue
    a, b = so[t], sr[t]
    for k in ('codec_name', 'width', 'height', 'sample_rate', 'channels'):
        if k in b and a.get(k) != b.get(k): ok = False; notes.append(f'{t}.{k} {a.get(k)}!={b.get(k)}')
    if abs(float(a.get('duration', 0)) - float(b.get('duration', 0))) > 0.06: ok = False; notes.append(f"{t} dur {a.get('duration')} vs {b.get('duration')}")
    if t == 'video':
        ma, ea = md5s(ours, '0:v:0'); mb, eb = md5s(ref, '0:v:0')
        if ma != mb: ok = False; notes.append(f'video frames differ: ours={len(ma)} ref={len(mb)} firstdiff={next((i for i,(x,y) in enumerate(zip(ma,mb)) if x!=y), None)} {ea}')
        else: notes.append(f'video {len(ma)} frames identical')
    if t == 'audio':
        pa, pb = pcm(ours), pcm(ref)
        n = min(len(pa), len(pb)); same = pa[:n] == pb[:n] and abs(len(pa) - len(pb)) < 8192
        if not same: ok = False; notes.append(f'audio pcm differs len {len(pa)} vs {len(pb)}')
        else: notes.append('audio pcm identical')
if 'video' in sr and 'audio' in sr and 'video' in so and 'audio' in so:
    off_o = float(so['video'].get('start_time', 0)) - float(so['audio'].get('start_time', 0))
    off_r = float(sr['video'].get('start_time', 0)) - float(sr['audio'].get('start_time', 0))
    if abs(off_o - off_r) > 0.045: ok = False
    notes.append(f'av offset ours={off_o:.3f} ref={off_r:.3f}')
notes.append(f'dur ours={do:.3f} ref={dr:.3f}')
print(('PASS ' if ok else 'FAIL ') + d, '|', '; '.join(notes), '|', info.get('ms'), 'ms', 'disc=%d' % info.get('discontinuities', 0))
