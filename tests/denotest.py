import subprocess, struct, json, threading, time, os, sys
from common import EXT as EXT_PATH, HOST, SITE, SHOTS, EXT_ID
def run():
    p = subprocess.Popen([HOST], stdin=subprocess.PIPE, stdout=subprocess.PIPE, env={**os.environ, 'HOME': '/tmp/vshome'})
    out=[]
    def rd():
        while True:
            h=p.stdout.read(4)
            if len(h)<4: break
            out.append(json.loads(p.stdout.read(struct.unpack('<I',h)[0])))
    threading.Thread(target=rd,daemon=True).start()
    for o in [{'id':'1','cmd':'ping'},{'id':'2','cmd':'download','jobId':'y','url':'https://www.youtube.com/watch?v=ytfail','name':'yt'},{'id':'3','cmd':'probe','url':'https://www.youtube.com/watch?v=ytfail'}]:
        b=json.dumps(o).encode(); p.stdin.write(struct.pack('<I',len(b))+b); p.stdin.flush()
    time.sleep(3); p.stdin.close(); p.wait()
    for m in out:
        if m.get('id')=='1': print('  deno:', m['deno'])
        if m.get('event') in ('error','done') or m.get('id')=='3': print(' ', {k:m.get(k) for k in ('event','message','ok','error','title')})
print('-- without deno'); run()
open(''+os.path.dirname(HOST)+'/deno','w').write('#!/bin/sh\n'); os.chmod(''+os.path.dirname(HOST)+'/deno',0o755)
print('-- with deno'); run()
os.remove(''+os.path.dirname(HOST)+'/deno')
