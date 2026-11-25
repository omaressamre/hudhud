import subprocess, json, sys, os
def run(cmd): return subprocess.run(cmd, capture_output=True, text=True)
def probe(f):
    o = json.loads(run(['ffprobe','-v','error','-show_entries','stream=codec_type,codec_name,start_time,duration,nb_frames,width,height:format=duration','-of','json',f]).stdout)
    return {s['codec_type']: s for s in o['streams']}, float(o['format'].get('duration', 0))
def md5s(f, sel): return [l.split(',')[-1].strip() for l in run(['ffmpeg','-v','error','-i',f,'-map',sel,'-f','framemd5','-']).stdout.splitlines() if l and not l.startswith('#')]
def pcm(f): return subprocess.run(['ffmpeg','-v','error','-i',f,'-map','0:a:0','-f','s16le','-'], capture_output=True).stdout
names = sys.argv[1:]
for n in names:
    v, a, o, r = f'c/{n}_v.mp4', f'c/{n}_a.mp4', f'c/{n}_ours.mp4', f'c/{n}_ref.mp4'
    if not os.path.exists(v): print('SKIP', n); continue
    res = run(['node', 'merge.mjs', v, a, o])
    if res.returncode: print('FAIL', n, res.stderr.strip().splitlines()[-3:]); continue
    info = json.loads(res.stdout)
    run(['ffmpeg','-hide_banner','-loglevel','error','-y','-i',v,'-i',a,'-map','0:v','-map','1:a','-c','copy',r])
    so, do = probe(o); sr, dr = probe(r)
    ok, notes = True, []
    mv, rv = md5s(o,'0:v:0'), md5s(r,'0:v:0')
    if mv != rv: ok = False; notes.append(f'video DIFF {len(mv)}/{len(rv)}')
    else: notes.append(f'video {len(mv)} identical')
    pa, pb = pcm(o), pcm(r)
    if pa != pb: ok = False; notes.append(f'audio DIFF {len(pa)}/{len(pb)}')
    else: notes.append('audio identical')
    for t in ('video','audio'):
        da, db = float(so[t].get('duration',0)), float(sr[t].get('duration',0))
        if abs(da-db) > 0.05: ok = False; notes.append(f'{t} dur {da} vs {db}')
    off_o = float(so['video'].get('start_time',0)) - float(so['audio'].get('start_time',0))
    off_r = float(sr['video'].get('start_time',0)) - float(sr['audio'].get('start_time',0))
    if abs(off_o - off_r) > 0.034: ok = False
    notes.append(f'av {off_o:.3f}/{off_r:.3f}')
    notes.append(f"{so['video']['codec_name']}+{so['audio']['codec_name']}")
    print(('PASS ' if ok else 'FAIL ') + n, '|', '; '.join(notes), '|', info['ms'], 'ms')
