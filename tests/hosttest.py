import subprocess, struct, json, threading, time, os
from common import EXT as EXT_PATH, HOST, SITE, SHOTS, EXT_ID
p = subprocess.Popen([HOST, 'chrome-extension://x/'], stdin=subprocess.PIPE, stdout=subprocess.PIPE, env={**os.environ, 'HOME': '/tmp/vshome'})
msgs = []
def reader():
    while True:
        h = p.stdout.read(4)
        if len(h) < 4: break
        n = struct.unpack('<I', h)[0]; msgs.append(json.loads(p.stdout.read(n)))
threading.Thread(target=reader, daemon=True).start()
def send(o):
    b = json.dumps(o).encode(); p.stdin.write(struct.pack('<I', len(b)) + b); p.stdin.flush()
send({'id': '1', 'cmd': 'ping'})
send({'id': '2', 'cmd': 'download', 'jobId': 'j1', 'url': 'https://x.com/v.m3u8', 'name': 'فيديو: تجربة 100%', 'relDir': 'Videos/../Sub', 'height': 720, 'cookies': '# Netscape HTTP Cookie File\n.x.com\tTRUE\t/\tFALSE\t0\ta\tb\n', 'referer': 'https://x.com/page', 'userAgent': 'UA'})
send({'id': '3', 'cmd': 'download', 'jobId': 'j2', 'url': 'https://fail.com/x', 'name': 'bad'})
send({'id': '4', 'cmd': 'download', 'jobId': 'j3', 'url': 'https://slow.com/x', 'name': 'slow'})
send({'id': '5', 'cmd': 'probe', 'url': 'https://x.com/watch'})
send({'id': '6', 'cmd': 'download', 'jobId': 'j4', 'url': 'javascript:alert(1)', 'name': 'x'})
time.sleep(1.5); send({'id': '7', 'cmd': 'cancel', 'jobId': 'j3'})
time.sleep(2.5)
p.stdin.close(); p.wait(timeout=10)
for m in msgs:
    if m.get('event') == 'progress' and m['jobId'] == 'j1' and m['percent'] not in (100.0,): continue
    print(m)
print('files:', [os.path.join(d, f) for d, _, fs in os.walk('/tmp/vshome') for f in fs])
