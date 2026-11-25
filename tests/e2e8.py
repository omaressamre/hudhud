import asyncio, json, os, shutil, base64, io
from playwright.async_api import async_playwright
from PIL import Image, ImageStat
from common import EXT as EXT_PATH, HOST, SITE, SHOTS, EXT_ID
EXT=EXT_PATH; PROFILE='/tmp/vs-prof10'
shutil.rmtree(PROFILE, ignore_errors=True)
os.makedirs(PROFILE+'/NativeMessagingHosts')
json.dump({"name":"com.hudhud.helper","description":"x","path":HOST,"type":"stdio",
  "allowed_origins":["chrome-extension://gdcallopdofegjbibhflneideofehmpk/"]}, open(PROFILE+'/NativeMessagingHosts/com.hudhud.helper.json','w'))
env = {k:v for k,v in os.environ.items() if 'proxy' not in k.lower()}
def describe(t):
    if not t: return 'NONE'
    if t.startswith('data:'):
        im = Image.open(io.BytesIO(base64.b64decode(t.split(',',1)[1])))
        st = ImageStat.Stat(im.convert('L'))
        return f'FRAME {im.size[0]}x{im.size[1]} stddev={st.stddev[0]:.0f}'
    return 'URL ' + t.split('/')[-1]
async def main():
  async with async_playwright() as p:
    ctx = await p.chromium.launch_persistent_context(PROFILE, executable_path='/usr/bin/google-chrome', headless=True, env=env,
      args=['--headless=new', '--no-proxy-server', '--host-resolver-rules=MAP www.youtube.com 127.0.0.1, MAP i.ytimg.com 127.0.0.1, MAP *.fbcdn.net 127.0.0.1, MAP *.cdninstagram.com 127.0.0.1', f'--disable-extensions-except={EXT}', f'--load-extension={EXT}'])
    sw = ctx.service_workers[0] if ctx.service_workers else await ctx.wait_for_event('serviceworker')
    await asyncio.sleep(1.5); ext=sw.url.split('/')[2]
    o = await ctx.new_page(); await o.goto(f'chrome-extension://{ext}/options.html'); await o.wait_for_timeout(300)
    await o.evaluate("chrome.storage.local.set({settings:{nativeDir:'/tmp/vsnative'}})")
    M = lambda m: o.evaluate(f"chrome.runtime.sendMessage({json.dumps(m)})")

    print('=== YouTube')
    yt = await ctx.new_page(); await yt.goto('http://www.youtube.com:8765/watch?v=abcDEF12345&list=PLx'); await yt.wait_for_timeout(1500)
    tab = await sw.evaluate("(async()=> (await chrome.tabs.query({url:'*://www.youtube.com/*'}))[0].id)()")
    print(' badge:', await sw.evaluate(f"chrome.action.getBadgeText({{tabId:{tab}}})"))
    st = (await M({'type':'getState','tabId':tab}))['data']
    for i in st['items']: print(' item', i['kind'], i.get('ytId'), repr(i.get('title')), i['engines'], i['suggestedName'], (i.get('thumb') or '')[-25:])
    r = await M({'type':'probeItem','tabId':tab,'itemId':st['items'][0]['id']}); print(' probe ok:', r.get('ok'))
    st = (await M({'type':'getState','tabId':tab}))['data']; it = st['items'][0]
    print(' after probe:', it.get('variants'), it.get('duration'), it.get('playlistCount'), repr(it.get('title')))
    # تنقّل جوه الصفحة (SPA) لفيديو تاني
    await yt.evaluate("history.pushState({}, '', '/shorts/ZZZshort999')"); await yt.evaluate("document.title='Second Short - YouTube'"); await yt.wait_for_timeout(1200)
    st = (await M({'type':'getState','tabId':tab}))['data']
    print(' after SPA nav:', [(i['ytId'], i.get('short'), i.get('title')) for i in st['items']])
    r = await M({'type':'downloadPage','tabId':tab,'url':st['items'][0]['url'],'baseName':st['items'][0]['suggestedName'],'height':0,'audioFormat':''})
    print(' download:', r.get('ok'), r.get('error'))
    pop = await ctx.new_page(); await pop.set_viewport_size({'width':400,'height':420})
    await yt.evaluate("history.pushState({}, '', '/watch?v=abcDEF12345&list=PLx')"); await yt.wait_for_timeout(800)
    await pop.goto(f'chrome-extension://{ext}/popup.html?tabId={tab}'); await pop.wait_for_timeout(2500)
    await pop.screenshot(path=SHOTS+'/popup_yt.png')

    print('=== Thumbnails')
    tp = await ctx.new_page(); await tp.goto('http://127.0.0.1:8765/thumbs.html'); await tp.wait_for_timeout(2500)
    sp = await ctx.new_page(); await sp.goto('http://127.0.0.1:8765/stories2.html'); await sp.wait_for_timeout(3000)
    for url in ('http://127.0.0.1:8765/thumbs.html', 'http://127.0.0.1:8765/stories2.html'):
      t = await sw.evaluate(f"(async()=> (await chrome.tabs.query({{url:'{url}'}}))[0].id)()")
      await M({'type':'makeThumbs','tabId':t})
      await o.wait_for_timeout(1000)
      st = (await M({'type':'getState','tabId':t}))['data']
      for i in st['items']: print(f"  {i['kind']:<6} {i['url'].split('8765')[1][:28]:<28} → {describe(i.get('thumb'))}")
      if url.endswith('thumbs.html'):
        await pop.goto(f'chrome-extension://{ext}/popup.html?tabId={t}'); await pop.set_viewport_size({'width':400,'height':600}); await pop.wait_for_timeout(1500)
        await pop.screenshot(path=SHOTS+'/popup_thumbs.png')
    await ctx.close()
asyncio.run(main())
