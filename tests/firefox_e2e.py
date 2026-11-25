# Firefox end-to-end test (runs in CI: Firefox + geckodriver + selenium).
#   HH_FF_EXT   built Firefox extension dir   (default /tmp/hh-firefox)
#   HH_HOST     helper binary; registered for Firefox in ~/.mozilla/native-messaging-hosts
#   fixtures from tests/fixtures/gen.sh served on 127.0.0.1:8765
# WebDriver can't script moz-extension:// pages, so a test-only content script (added to a copy of the
# build, never shipped) relays messages between the fixture page and the extension.
# Checks: install, welcome page, native messaging, HLS → MP4 via the offscreen iframe, direct download.
import json, os, shutil, subprocess, sys, tempfile, time
from selenium import webdriver
from selenium.webdriver.firefox.options import Options
from selenium.webdriver.firefox.service import Service

SRC = os.environ.get('HH_FF_EXT', '/tmp/hh-firefox')
HOST = os.environ.get('HH_HOST', '/tmp/hhhost/hudhud-helper')
GECKO_ID = 'hudhud@omaressamre.github.io'
DL = tempfile.mkdtemp(prefix='hh-ff-dl-')
LOG = '/tmp/hh-geckodriver.log'
failures = []

def check(name, ok, detail=''):
  print(('PASS ' if ok else 'FAIL ') + name + (f' — {detail}' if detail else ''), flush=True)
  if not ok: failures.append(name)

# test build = release build + bridge content script on the fixture server only
EXT = tempfile.mkdtemp(prefix='hh-ff-ext-'); shutil.rmtree(EXT); shutil.copytree(SRC, EXT)
open(f'{EXT}/test-bridge.js', 'w').write('''
window.addEventListener('message', async (e) => {
  if (e.source !== window || !e.data || !e.data.hhTest) return;
  const { id, msg, storage } = e.data.hhTest;
  let res;
  try { res = storage ? await browser.storage.local.get(storage) : await browser.runtime.sendMessage(msg); }
  catch (err) { res = { ok: false, error: String(err) }; }
  window.postMessage({ hhTestReply: { id, res: JSON.parse(JSON.stringify(res ?? null)) } }, '*');
});
''')
m = json.load(open(f'{EXT}/manifest.json'))
m['content_scripts'].append({'matches': ['http://127.0.0.1/*'], 'js': ['test-bridge.js'], 'run_at': 'document_start'})
json.dump(m, open(f'{EXT}/manifest.json', 'w'), indent=2)

nm = os.path.expanduser('~/.mozilla/native-messaging-hosts'); os.makedirs(nm, exist_ok=True)
json.dump({'name': 'com.hudhud.helper', 'description': 'Hudhud Helper', 'path': HOST, 'type': 'stdio',
           'allowed_extensions': [GECKO_ID]}, open(f'{nm}/com.hudhud.helper.json', 'w'))

o = Options()
o.add_argument('-headless')
for k, v in {
  'browser.download.folderList': 2, 'browser.download.dir': DL, 'browser.download.useDownloadDir': True,
  'browser.download.always_ask_before_handling_new_types': False,
  'browser.helperApps.neverAsk.saveToDisk': 'video/mp4,application/octet-stream',
  'devtools.console.stdout.content': True, 'devtools.console.stdout.chrome': True, 'browser.dom.window.dump.enabled': True,
  'extensions.logging.enabled': True,
}.items():
  o.set_preference(k, v)
d = webdriver.Firefox(options=o, service=Service(log_output=LOG))
d.set_script_timeout(90)

def bridge(msg=None, storage=None):
  return d.execute_async_script('''
    const [payload, cb] = [arguments[0], arguments[arguments.length - 1]];
    const id = Math.random().toString(36).slice(2);
    const on = (e) => { if (e.data && e.data.hhTestReply && e.data.hhTestReply.id === id) { removeEventListener('message', on); cb(e.data.hhTestReply.res); } };
    addEventListener('message', on);
    postMessage({ hhTest: Object.assign({ id }, payload) }, '*');
  ''', {'msg': msg, 'storage': storage})

try:
  d.install_addon(EXT, temporary=True)
  ok = False
  for _ in range(20):
    for h in d.window_handles:
      d.switch_to.window(h)
      if d.current_url.startswith('moz-extension://') and 'welcome.html' in d.current_url: ok = True
    if ok: break
    time.sleep(0.5)
  check('installs and opens the welcome page', ok)

  results = {}
  for page, kind in (('hlspage.html', 'hls'), ('directpage.html', 'direct')):
    d.switch_to.new_window('tab'); d.get(f'http://127.0.0.1:8765/{page}'); time.sleep(3)
    if kind == 'hls':
      info = bridge({'type': 'nativeInfo'})
      check('helper connects over native messaging', bool(info and info.get('ok') and (info.get('data') or {}).get('version')), json.dumps(info)[:200])
    st = bridge({'type': 'getState'})
    items = ((st or {}).get('data') or {}).get('items', [])
    item = next((i for i in items if (kind == 'hls') == ('m3u8' in i['url'])), None)
    check(f'{kind}: detected', item is not None, json.dumps([i['url'] for i in items]))
    if item:
      r = bridge({'type': 'download', 'itemId': item['id'], 'baseName': f'ff-{kind}', 'engine': 'browser'})
      check(f'{kind}: download starts', bool(r and r.get('ok')), json.dumps(r)[:300])
      results[kind] = item['id']
    if item and kind == 'direct':
      r = bridge({'type': 'download', 'itemId': item['id'], 'baseName': 'ff-native', 'engine': 'native'})
      check('native: download starts', bool(r and r.get('ok')), json.dumps(r)[:300])

  deadline = time.time() + 120
  jobs = []
  while time.time() < deadline:
    jobs = (bridge(storage='jobs') or {}).get('jobs') or []
    if jobs and all(j['state'] in ('complete', 'interrupted') for j in jobs): break
    time.sleep(2)
  for j in jobs:
    print(' job', json.dumps({k: j.get(k) for k in ('engine', 'mode', 'state', 'downloadId', 'error', 'file', 'path', 'percent', 'note')}), flush=True)
  check('native: job completes', any(j.get('engine') == 'native' and j['state'] == 'complete' for j in jobs))
  if any(j['state'] != 'complete' for j in jobs):
    failures.append('jobs finish')
    print('FAIL jobs finish')
  files = [os.path.join(r, f) for r, _, fs in os.walk(DL) for f in fs]
  print(' files', files, flush=True)
  for kind in results:
    f = next((x for x in files if os.path.basename(x).startswith(f'ff-{kind}') and x.endswith('.mp4')), None)
    dur = None
    if f:
      out = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f], capture_output=True, text=True)
      try: dur = float(out.stdout.strip())
      except ValueError: pass
    check(f'{kind}: playable mp4', bool(dur and dur > 3), f'{f} {dur}')
finally:
  d.quit()
  if failures:
    print('--- geckodriver/firefox log (tail) ---')
    lines = open(LOG, errors='replace').readlines()
    print(''.join(l for l in lines if 'Hudhud' in l or 'moz-extension' in l or 'Error' in l)[-20000:])

sys.exit(1 if failures else 0)
