import asyncio, json, os, shutil, sys
from playwright.async_api import async_playwright
from common import EXT as EXT_PATH, HOST, SITE, SHOTS, EXT_ID
EXT=EXT_PATH; PROFILE='/tmp/vs-prof5'; OUT='/tmp/vsnative'
shutil.rmtree(PROFILE, ignore_errors=True); shutil.rmtree(OUT, ignore_errors=True)
os.makedirs(PROFILE+'/NativeMessagingHosts')
json.dump({"name":"com.hudhud.helper","description":"x","path":HOST,"type":"stdio",
  "allowed_origins":["chrome-extension://gdcallopdofegjbibhflneideofehmpk/"]}, open(PROFILE+'/NativeMessagingHosts/com.hudhud.helper.json','w'))
env = {k:v for k,v in os.environ.items() if 'proxy' not in k.lower()}
def ensure_hosts():
    h=open('/etc/hosts').read()
    if 'fbcdn' not in h: open('/etc/hosts','a').write('\n127.0.0.1 video.test.fbcdn.net scontent.test.cdninstagram.com\n')
ensure_hosts()
async def main():
  async with async_playwright() as p:
    ctx = await p.chromium.launch_persistent_context(PROFILE, executable_path='/usr/bin/google-chrome', headless=True, env=env,
      args=['--headless=new', '--no-proxy-server', '--host-resolver-rules=MAP *.fbcdn.net 127.0.0.1, MAP *.cdninstagram.com 127.0.0.1', f'--disable-extensions-except={EXT}', f'--load-extension={EXT}'])
    sw = ctx.service_workers[0] if ctx.service_workers else await ctx.wait_for_event('serviceworker')
    await asyncio.sleep(1.5); ext=sw.url.split('/')[2]
    page = await ctx.new_page(); await page.goto('http://127.0.0.1:8765/stories.html'); await page.wait_for_timeout(3000)
    tab = await sw.evaluate("(async()=> (await chrome.tabs.query({url:'http://127.0.0.1:8765/*'}))[0].id)()")
    o = await ctx.new_page(); await o.goto(f'chrome-extension://{ext}/options.html'); await o.wait_for_timeout(500)
    await o.evaluate("chrome.storage.local.set({settings:{nativeDir:'/tmp/vsnative', defaultEngine:'native'}})")
    M = lambda m: o.evaluate(f"chrome.runtime.sendMessage({json.dumps(m)})")
    raw = await sw.evaluate(f"chrome.storage.session.get('tab:{tab}')")
    for i in list(raw.values())[0]['items'].values(): print(' raw', i['url'].split('/')[-1][:12], i.get('track'), i.get('height'), i.get('duration'), i.get('assetId'))
    st = (await M({'type':'getState','tabId':tab}))['data']
    print('badge', await sw.evaluate(f"chrome.action.getBadgeText({{tabId:{tab}}})"))
    for i in st['items']: print(' item', i['url'].split('/')[-1][:10], 'audio=' + (i.get('audio') or {}).get('url','-').split('/')[-1][:10], i.get('variants'), i['engines'])
    for n, i in enumerate(st['items']):
      r = await M({'type':'download','tabId':tab,'itemId':i['id'],'baseName':f'story{n}','engine':'native'})
      print(' dl', r.get('ok'), r.get('error'))
    await o.wait_for_timeout(4000)
    for j in (await o.evaluate("chrome.storage.local.get('jobs')"))['jobs']: print(' job', j['state'], j.get('error'), j.get('file'))
    pop = await ctx.new_page(); await pop.set_viewport_size({'width':400,'height':600})
    await pop.goto(f'chrome-extension://{ext}/popup.html?tabId={tab}'); await pop.wait_for_timeout(1200)
    await pop.screenshot(path=SHOTS+'/popup3.png')
    await ctx.close()
asyncio.run(main())
