import asyncio, json, os, shutil
from playwright.async_api import async_playwright
from common import EXT as EXT_PATH, HOST, SITE, SHOTS, EXT_ID
EXT=EXT_PATH; PROFILE='/tmp/vs-prof7'; OUT='/tmp/vsnative'
shutil.rmtree(PROFILE, ignore_errors=True); shutil.rmtree(OUT, ignore_errors=True)
os.makedirs(PROFILE+'/NativeMessagingHosts')
json.dump({"name":"com.hudhud.helper","description":"x","path":HOST,"type":"stdio",
  "allowed_origins":["chrome-extension://gdcallopdofegjbibhflneideofehmpk/"]}, open(PROFILE+'/NativeMessagingHosts/com.hudhud.helper.json','w'))
async def main():
  async with async_playwright() as p:
    ctx = await p.chromium.launch_persistent_context(PROFILE, executable_path='/usr/bin/google-chrome', headless=True,
      args=['--headless=new', '--no-proxy-server', f'--disable-extensions-except={EXT}', f'--load-extension={EXT}'])
    sw = ctx.service_workers[0] if ctx.service_workers else await ctx.wait_for_event('serviceworker')
    await asyncio.sleep(1.5); ext=sw.url.split('/')[2]
    page = await ctx.new_page(); await page.goto('http://127.0.0.1:8765/index.html?list=PL1'); await page.wait_for_timeout(2000)
    tab = await sw.evaluate("(async()=> (await chrome.tabs.query({url:'http://127.0.0.1:8765/*'}))[0].id)()")
    o = await ctx.new_page(); await o.goto(f'chrome-extension://{ext}/options.html'); await o.wait_for_timeout(300)
    await o.evaluate("chrome.storage.local.set({settings:{nativeDir:'/tmp/vsnative', subs:true, embedThumb:true, maxConcurrent:2}})")
    print('menus:', await sw.evaluate("new Promise(r=>chrome.contextMenus.removeAll(()=>r('ok')))") and 'ok')
    r1 = await sw.evaluate(f"__hudhud.contextDownload({{menuItemId:'hh-page', pageUrl:'http://127.0.0.1:8765/index.html?list=PL1'}}, {{id:{tab}}}).then(()=>'ok',e=>'ERR '+e.message)")
    r2 = await sw.evaluate(f"__hudhud.contextDownload({{menuItemId:'hh-media', srcUrl:'http://127.0.0.1:8765/big.mp4', pageUrl:'http://127.0.0.1:8765/index.html'}}, {{id:{tab}}}).then(()=>'ok',e=>'ERR '+e.message)")
    r3 = await sw.evaluate(f"__hudhud.contextDownload({{menuItemId:'hh-link', linkUrl:'https://x.com/playlist-test', pageUrl:'http://127.0.0.1:8765/'}}, {{id:{tab}}}).then(()=>'ok',e=>'ERR '+e.message)")
    print('ctx', r1, r2, r3)
    pop = await ctx.new_page(); await pop.set_viewport_size({'width':400,'height':600})
    await pop.goto(f'chrome-extension://{ext}/popup.html?tabId={tab}'); await pop.wait_for_timeout(1000)
    btn = await pop.query_selector('#empty .btn')
    if btn: await btn.click(); await pop.wait_for_timeout(2500)
    await pop.screenshot(path=SHOTS+'/popup5.png')
    await pop.wait_for_timeout(3500)
    await pop.evaluate("document.querySelector('#jobs').scrollIntoView()"); await pop.screenshot(path=SHOTS+'/popup5b.png')
    for j in (await o.evaluate("chrome.storage.local.get('jobs')"))['jobs']: print(' job', j['engine'], j['state'], j.get('error'), j.get('file'), j.get('files'))
    await o.reload(); await o.wait_for_timeout(1200); await o.screenshot(path=SHOTS+'/options5.png', full_page=True)
    await ctx.close()
asyncio.run(main())
