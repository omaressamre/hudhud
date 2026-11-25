# One-click update: extension loaded from the install folder, helper swaps both, extension reloads.
# Needs: a Linux install made by install.sh from a bundle zip (HH_INSTALL_HOME, default /tmp/fh4)
#        and the bundle zip itself (HH_BUNDLE, default dist/hudhud-helper-linux.zip).
import asyncio, hashlib, http.server, io, json, os, shutil, threading, zipfile
from playwright.async_api import async_playwright
from common import SHOTS

HOME = os.environ.get('HH_INSTALL_HOME', '/tmp/fh4')
DEST = HOME + '/.local/share/hudhud'
EXT = DEST + '/extension'
BUNDLE = os.environ.get('HH_BUNDLE', os.path.join(os.path.dirname(__file__), '..', 'dist', 'hudhud-helper-linux.zip'))
PROFILE = '/tmp/hh-prof-update'
NEW = '0.9.9'

# fake GitHub release: the same bundle with the extension version bumped
rel = '/tmp/hh-fake-release'; shutil.rmtree(rel, ignore_errors=True); os.makedirs(rel)
buf = io.BytesIO()
with zipfile.ZipFile(BUNDLE) as zin, zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as zout:
  for it in zin.infolist():
    data = zin.read(it)
    if it.filename == 'extension/manifest.json':
      m = json.loads(data); m['version'] = NEW; data = json.dumps(m, indent=2).encode()
    zout.writestr(it, data)
pkg = buf.getvalue()
open(rel + '/hudhud-helper-linux.zip', 'wb').write(pkg)
open(rel + '/SHA256SUMS.txt', 'w').write(f"{hashlib.sha256(pkg).hexdigest()}  hudhud-helper-linux.zip\n")
PORT = 8792
open(rel + '/latest', 'w').write(json.dumps({'tag_name': 'v' + NEW, 'assets': [
  {'name': n, 'browser_download_url': f'http://127.0.0.1:{PORT}/{n}'} for n in ('hudhud-helper-linux.zip', 'SHA256SUMS.txt')]}))
class H(http.server.SimpleHTTPRequestHandler):
  def __init__(s, *a, **k): super().__init__(*a, directory=rel, **k)
  def log_message(s, *a): pass
srv = http.server.ThreadingHTTPServer(('127.0.0.1', PORT), H)
threading.Thread(target=srv.serve_forever, daemon=True).start()

shutil.rmtree(PROFILE, ignore_errors=True); os.makedirs(PROFILE + '/NativeMessagingHosts'); os.makedirs(PROFILE + '/Default')
# users load Hudhud with Developer mode on; without it Chrome disables an unpacked extension when it reloads
json.dump({'extensions': {'ui': {'developer_mode': True}}}, open(PROFILE + '/Default/Preferences', 'w'))
shutil.copy(HOME + '/.config/google-chrome/NativeMessagingHosts/com.hudhud.helper.json', PROFILE + '/NativeMessagingHosts/')
env = {k: v for k, v in os.environ.items() if 'proxy' not in k.lower()}
env['HOME'] = HOME; env['HUDHUD_RELEASE_API'] = f'http://127.0.0.1:{PORT}/latest'

async def main():
  async with async_playwright() as p:
    ctx = await p.chromium.launch_persistent_context(PROFILE, executable_path='/usr/bin/google-chrome', headless=True, env=env,
      args=['--headless=new', '--no-proxy-server', f'--disable-extensions-except={EXT}', f'--load-extension={EXT}'], viewport={'width': 420, 'height': 700})
    sw = ctx.service_workers[0] if ctx.service_workers else await ctx.wait_for_event('serviceworker')
    await asyncio.sleep(1.5); ext = sw.url.split('/')[2]
    print('version before:', await sw.evaluate('chrome.runtime.getManifest().version'))
    pop = await ctx.new_page()
    await pop.goto(f'chrome-extension://{ext}/popup.html'); await pop.wait_for_timeout(800)
    info = (await pop.evaluate("chrome.runtime.sendMessage({type:'nativeInfo'})"))['data']
    print('helper:', info['version'], 'installId set:', bool(info.get('installId')), 'extVersion:', info.get('extVersion'))
    await pop.evaluate(f"chrome.storage.local.set({{helperUpdate: {{latest: '{NEW}', current: '0.8.1', managed: true}}}})")
    await pop.reload(); await pop.wait_for_timeout(1500)
    await pop.screenshot(path=f'{SHOTS}/update-banner.png')
    btn = pop.locator('.banner.info .btn-primary')
    print('button:', await btn.inner_text())
    await btn.click()
    # the extension reloads itself; wait for the new service worker
    for _ in range(60):
      await asyncio.sleep(1)
      sws = [w for w in ctx.service_workers if ext in w.url]
      try:
        v = await sws[-1].evaluate('chrome.runtime.getManifest().version') if sws else None
      except Exception:
        v = None
      if v == NEW: break
    print('version after:', v)
    print('files:', json.load(open(EXT + '/manifest.json'))['version'], open(EXT + '/hudhud-install.json').read().strip() == '{"id":"%s"}' % open(DEST + '/install-id').read().strip())
    pop2 = await ctx.new_page(); await pop2.goto(f'chrome-extension://{ext}/popup.html'); await pop2.wait_for_timeout(1200)
    print('banner:', await pop2.locator('.banner.info b').first.inner_text() if await pop2.locator('.banner.info').count() else None)
    await pop2.screenshot(path=f'{SHOTS}/update-done.png')
    print('leftovers:', [n for n in os.listdir(DEST) if n.endswith('.old') or n in ('.update', 'extension.old')])
    await ctx.close()
  srv.shutdown()
asyncio.run(main())
