# Screenshots of popup states that need the helper / fake jobs. usage: ui_states.py OUTDIR [ar|en] [light|dark]
import asyncio, json, os, shutil, sys, time
from playwright.async_api import async_playwright
HERE = os.path.dirname(os.path.abspath(__file__)); EXT = os.path.join(HERE, '..', 'extension')
OUT = sys.argv[1]; LANG = sys.argv[2] if len(sys.argv) > 2 else 'ar'; THEME = sys.argv[3] if len(sys.argv) > 3 else 'light'
HOST = os.environ.get('HH_HOST', '/tmp/hhhost/hudhud-helper')
os.makedirs(OUT, exist_ok=True)
env = {k: v for k, v in os.environ.items() if 'proxy' not in k.lower()}
now = int(time.time() * 1000)
EN = {'قهوة تركي ٤ طرق':'Turkish coffee, 4 ways','أسهل ٥ وصفات فطار':'5 easy breakfasts','بلاي ليست: وصفات سريعة':'Playlist: quick recipes','ستوري كافيه الهدهد':'Hoopoe Café story'}
def job(i, **k):
  if LANG == 'en': k['title'] = EN.get(k['title'], k['title'])
  return {'jobId': f'j{i}', 'engine': 'native', 'path': f'Hudhud/clip{i}.mp4', 'title': k.pop('title'), 'state': 'in_progress', 'percent': 0, 'startedAt': now - 60000, **k}
JOBS_RUN = [job(1, title='قهوة تركي ٤ طرق', percent=64, speed='12.4 MB/s', eta='0:08', downloaded=30e6, total=48e6),
            job(2, title='أسهل ٥ وصفات فطار', percent=100, speed=''),
            job(3, title='بلاي ليست: وصفات سريعة', queued=True)]
JOBS_DONE = [job(4, title='قهوة تركي ٤ طرق', state='complete', percent=100, file='/home/me/Downloads/Hudhud/قهوة تركي.mp4', quality='1080p', endedAt=now - 5000),
             job(5, title='أسهل ٥ وصفات فطار', state='complete', percent=100, file='/home/me/Downloads/Hudhud/فطار.mp4', quality='720p', endedAt=now - 9000)]
JOBS_ERR = [job(6, title='ستوري كافيه الهدهد', state='interrupted', engine='browser', percent=30, error='HTTP 403', endedAt=now - 3000, req={'item': {}, 'engineId': 'browser'})]
async def run(with_host):
  async with async_playwright() as p:
    prof = f'/tmp/hh-st-{with_host}'; shutil.rmtree(prof, ignore_errors=True); os.makedirs(prof + '/NativeMessagingHosts')
    if with_host:
      json.dump({"name": "com.hudhud.helper", "description": "x", "path": HOST, "type": "stdio", "allowed_origins": ["chrome-extension://gdcallopdofegjbibhflneideofehmpk/"]}, open(prof + '/NativeMessagingHosts/com.hudhud.helper.json', 'w'))
    ctx = await p.chromium.launch_persistent_context(prof, executable_path='/usr/bin/google-chrome', headless=True, env=env,
      args=['--headless=new', '--no-proxy-server', '--host-resolver-rules=MAP www.youtube.com 127.0.0.1, MAP i.ytimg.com 127.0.0.1', f'--disable-extensions-except={EXT}', f'--load-extension={EXT}'])
    sw = ctx.service_workers[0] if ctx.service_workers else await ctx.wait_for_event('serviceworker')
    await asyncio.sleep(1.5); ext = sw.url.split('/')[2]
    for pg in ctx.pages:
      if 'welcome' in pg.url: await pg.close()
    await sw.evaluate(f"chrome.storage.local.set({{settings:{{uiLang:'{LANG}', theme:'{THEME}', nativeDir:'/tmp/hhnative'}}}})")
    yt = await ctx.new_page(); await yt.goto('http://www.youtube.com:8765/watch?v=abcDEF12345&list=PLx'); await yt.wait_for_timeout(2000)
    tab = await sw.evaluate("(async()=> (await chrome.tabs.query({url:'*://www.youtube.com/*'}))[0].id)()")
    async def shot(name, h=600, setup=None):
      if setup: await sw.evaluate(setup); await asyncio.sleep(0.3)
      pop = await ctx.new_page(); await pop.set_viewport_size({'width': 380, 'height': h})
      await pop.goto(f'chrome-extension://{ext}/popup.html?tabId={tab}'); await pop.wait_for_timeout(3500)
      demo = os.environ.get('HH_DEMO_TITLE_' + LANG.upper())
      if demo: await pop.evaluate("""(t)=>{const w=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);let n;while(n=w.nextNode())if(n.nodeValue.includes('Fake Page Title'))n.nodeValue=n.nodeValue.replace('Fake Page Title',t)}""", demo)
      await pop.screenshot(path=f'{OUT}/{name}-{LANG}-{THEME}.png', full_page=True); return pop
    if with_host:
      await shot('yt')
      pop = await shot('ytmenu')
      await pop.click('.qsel'); await pop.wait_for_timeout(400); await pop.screenshot(path=f'{OUT}/ytmenu-{LANG}-{THEME}.png')
      await shot('jobs', setup=f"chrome.storage.local.set({{jobs:{json.dumps(JOBS_RUN, ensure_ascii=False)}}})")
      await shot('done', setup=f"chrome.storage.local.set({{jobs:{json.dumps(JOBS_DONE, ensure_ascii=False)}}})")
      await shot('error', setup=f"chrome.storage.local.set({{jobs:{json.dumps(JOBS_ERR, ensure_ascii=False)}}})")
      await shot('support', setup="chrome.storage.local.set({jobs:[], stats:{completed:24}, helperUpdate:{latest:'0.9.0', current:'0.8.0'}})")
    else:
      await shot('nohelper')
    await ctx.close()
async def main():
  await run(True); await run(False)
asyncio.run(main())
