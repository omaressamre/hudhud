# Firefox end-to-end test (runs in CI: Firefox + geckodriver + selenium).
#   HH_FF_EXT   built Firefox extension dir   (default /tmp/hh-firefox)
#   HH_SITE     fixture site from tests/fixtures/gen.sh, served on :8765
#   HH_HOST     helper binary; registered for Firefox in ~/.mozilla/native-messaging-hosts
# Checks: extension loads, pages render translated, the helper connects over native messaging,
# HLS → MP4 works through the offscreen iframe, and a direct file downloads.
import json, os, subprocess, sys, time, tempfile
from selenium import webdriver
from selenium.webdriver.firefox.options import Options
from selenium.webdriver.firefox.service import Service

EXT = os.environ.get('HH_FF_EXT', '/tmp/hh-firefox')
HOST = os.environ.get('HH_HOST', '/tmp/hhhost/hudhud-helper')
GECKO_ID = 'hudhud@omaressamre.github.io'
UUID = '6f1b0d2e-5a4c-4c1e-9b7a-1d2c3e4f5a6b'
BASE = f'moz-extension://{UUID}'
DL = tempfile.mkdtemp(prefix='hh-ff-dl-')
LOG = '/tmp/hh-geckodriver.log'
failures = []

def check(name, ok, detail=''):
  print(('PASS ' if ok else 'FAIL ') + name + (f' — {detail}' if detail else ''))
  if not ok: failures.append(name)

# native messaging host for Firefox
nm = os.path.expanduser('~/.mozilla/native-messaging-hosts'); os.makedirs(nm, exist_ok=True)
json.dump({'name': 'com.hudhud.helper', 'description': 'Hudhud Helper', 'path': HOST, 'type': 'stdio',
           'allowed_extensions': [GECKO_ID]}, open(f'{nm}/com.hudhud.helper.json', 'w'))

o = Options()
o.add_argument('-headless')
for k, v in {
  'extensions.webextensions.uuids': json.dumps({GECKO_ID: UUID}),
  'browser.download.folderList': 2, 'browser.download.dir': DL, 'browser.download.useDownloadDir': True,
  'browser.download.always_ask_before_handling_new_types': False,
  'browser.helperApps.neverAsk.saveToDisk': 'video/mp4,application/octet-stream',
  'devtools.console.stdout.content': True, 'browser.dom.window.dump.enabled': True,
  'extensions.logging.enabled': True, 'intl.locale.requested': 'en-US',
}.items():
  o.set_preference(k, v)
d = webdriver.Firefox(options=o, service=Service(log_output=LOG))
d.set_script_timeout(60)

def ext_tab(page):
  """WebDriver can't navigate to moz-extension:// URLs, but an extension page can open its own pages."""
  d.switch_to.window(EXT_HANDLE)
  d.execute_async_script("const cb=arguments[1]; chrome.tabs.update({url: chrome.runtime.getURL(arguments[0])}).then(()=>cb(1), e=>cb(String(e)))", page)
  time.sleep(2)

def ext_call(msg):
  return d.execute_async_script('const cb = arguments[arguments.length-1]; chrome.runtime.sendMessage(arguments[0]).then(cb, (e) => cb({ok:false, error:String(e)}));', msg)

try:
  d.install_addon(EXT, temporary=True)  # selenium zips the folder
  # the extension opens its welcome page on install: use that tab as our way in
  EXT_HANDLE = None
  for _ in range(20):
    for h in d.window_handles:
      d.switch_to.window(h)
      if d.current_url.startswith('moz-extension://'): EXT_HANDLE = h; break
    if EXT_HANDLE: break
    time.sleep(0.5)
  check('welcome page opens on install', EXT_HANDLE is not None, str([d.current_url]))
  if not EXT_HANDLE: raise SystemExit
  BASE = d.current_url.split('/welcome.html')[0]

  # 1) pages render, strings translated
  ext_tab('options.html')
  ver = d.execute_script("return document.querySelector('#ver')?.textContent || ''")
  check('options renders', 'Version' in ver or 'النسخة' in ver, ver)
  ext_tab('popup.html')
  check('popup renders', d.execute_script("return !!document.querySelector('.popup') && document.body.innerText.length > 20"))

  # 2) helper over native messaging
  ext_tab('options.html')
  info = ext_call({'type': 'nativeInfo'})
  check('helper connects', bool(info.get('ok') and info.get('data', {}).get('version')), json.dumps(info)[:200])

  # 3) HLS → MP4 in the browser engine (offscreen iframe) and 4) a direct file
  results = {}
  for page, kind in (('hlspage.html', 'hls'), ('directpage.html', 'direct')):
    d.switch_to.new_window('tab'); d.get(f'http://127.0.0.1:8765/{page}'); time.sleep(3)
    ext_tab('options.html')
    tab = d.execute_async_script("const cb=arguments[0]; chrome.tabs.query({url:'http://127.0.0.1/*'}).then(t=>cb(t.filter(x=>x.url.includes('%s')).map(x=>x.id)[0]))" % page)
    st = ext_call({'type': 'getState', 'tabId': tab})
    items = (st.get('data') or {}).get('items', [])
    item = next((i for i in items if (kind == 'hls') == ('m3u8' in i['url'])), None)
    check(f'{kind}: detected', item is not None, json.dumps([i['url'] for i in items]))
    if item:
      r = ext_call({'type': 'download', 'tabId': tab, 'itemId': item['id'], 'baseName': f'ff-{kind}', 'engine': 'browser'})
      check(f'{kind}: download starts', bool(r.get('ok')), json.dumps(r)[:200])
      results[kind] = item['id']

  deadline = time.time() + 90
  jobs = []
  while time.time() < deadline:
    d.switch_to.window(EXT_HANDLE)
    jobs = d.execute_async_script("const cb=arguments[0]; chrome.storage.local.get('jobs').then(r=>cb(r.jobs||[]))")
    if jobs and all(j['state'] in ('complete', 'interrupted') for j in jobs): break
    time.sleep(2)
  for j in jobs:
    print(' job', j.get('mode'), j['state'], j.get('error'), j.get('file'))
  files = [os.path.join(r, f) for r, _, fs in os.walk(DL) for f in fs]
  print(' files', files)
  for kind in results:
    f = next((x for x in files if os.path.basename(x).startswith(f'ff-{kind}') and x.endswith('.mp4')), None)
    dur = None
    if f:
      out = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f], capture_output=True, text=True)
      try: dur = float(out.stdout.strip())
      except ValueError: pass
    check(f'{kind}: playable mp4', bool(dur and dur > 3), f'{f} {dur}')
except SystemExit:
  pass
finally:
  d.quit()
  if failures:
    print('--- geckodriver/firefox log (tail) ---')
    print(''.join(open(LOG, errors='replace').readlines()[-120:]))

sys.exit(1 if failures else 0)
