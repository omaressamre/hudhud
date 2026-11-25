import subprocess, struct, json, threading, time, os
from common import EXT as EXT_PATH, HOST, SITE, SHOTS, EXT_ID
p = subprocess.Popen([HOST], stdin=subprocess.PIPE, stdout=subprocess.PIPE, env={**os.environ, 'HOME': '/tmp/vshome'})
msgs=[]
def rd():
    while True:
        h=p.stdout.read(4)
        if len(h)<4: break
        msgs.append(json.loads(p.stdout.read(struct.unpack('<I',h)[0])))
threading.Thread(target=rd,daemon=True).start()
def send(o):
    b=json.dumps(o).encode(); p.stdin.write(struct.pack('<I',len(b))+b); p.stdin.flush()
send({'id':'c','cmd':'config','maxConcurrent':1})
time.sleep(0.2)
send({'id':'m','cmd':'merge','jobId':'merge1','url':'http://127.0.0.1:8765/fb/v.mp4','audioUrl':'http://127.0.0.1:8765/fb/a.mp4','name':'ستوري','userAgent':'UA','referer':'https://www.instagram.com/'})
send({'id':'p','cmd':'download','jobId':'pl','url':'https://x.com/playlist-test','name':'قايمة','playlist':True,'audioFormat':'mp3','subs':True,'embedMeta':True,'embedThumb':True,'rateLimit':'2M'})
send({'id':'q','cmd':'download','jobId':'q3','url':'https://x.com/slow','name':'queued-then-cancel'})
time.sleep(0.5); send({'id':'x','cmd':'cancel','jobId':'q3'})
time.sleep(6)
send({'id':'i','cmd':'ping'}); time.sleep(0.5)
p.stdin.close(); p.wait(timeout=20)
for m in msgs:
    if m.get('event')=='progress' and m.get('jobId')!='pl': continue
    if m.get('event')=='progress': m={k:m.get(k) for k in ('jobId','percent','item','items')}
    print(m)
