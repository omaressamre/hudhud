import asyncio, json, os, shutil
from playwright.async_api import async_playwright
from common import EXT as EXT_PATH, HOST, SITE, SHOTS, EXT_ID
EXT=EXT_PATH; PROFILE='/tmp/vs-prof4'; OUT='/tmp/vsnative'
shutil.rmtree(PROFILE, ignore_errors=True); shutil.rmtree(OUT, ignore_errors=True)
os.makedirs(PROFILE+'/NativeMessagingHosts')
json.dump({"name":"com.hudhud.helper","description":"Hudhud Helper","path":HOST,"type":"stdio",
  "allowed_origins":["chrome-extension://gdcallopdofegjbibhflneideofehmpk/"]}, open(PROFILE+'/NativeMessagingHosts/com.hudhud.helper.json','w'))
async def main():
  async with async_playwright() as p:
    ctx = await p.chromium.launch_persistent_context(PROFILE, executable_path='/usr/bin/google-chrome', headless=True,
      args=['--headless=new', f'--disable-extensions-except={EXT}', f'--load-extension={EXT}'])
    sw = ctx.service_workers[0] if ctx.service_workers else await ctx.wait_for_event('serviceworker')
    await asyncio.sleep(1.5); ext=sw.url.split('/')[2]
    page = await ctx.new_page(); await page.goto('http://127.0.0.1:8765/index.html'); await page.wait_for_timeout(2500)
    tab = await sw.evaluate("(async()=> (await chrome.tabs.query({url:'http://127.0.0.1:8765/*'}))[0].id)()")
    await sw.evaluate("chrome.cookies.set({url:'http://127.0.0.1:8765/', name:'sess', value:'abc123'})")
    o = await ctx.new_page(); await o.goto(f'chrome-extension://{ext}/options.html'); await o.wait_for_timeout(500)
    await o.evaluate("chrome.storage.local.set({settings:{subdir:'Videos',template:'%title',maxLength:64,minSizeMB:1,history:true,defaultEngine:'native',nativeDir:'/tmp/vsnative',rules:[]}})")
    M = lambda m: o.evaluate(f"chrome.runtime.sendMessage({json.dumps(m)})")
    print('nativeInfo', await M({'type':'nativeInfo'}))
    st = (await M({'type':'getState','tabId':tab}))['data']
    for i in st['items']: print(' item', i['kind'], i['url'].split('/')[-1], i['engines'], i['suggestedName'])
    byname = {i['url'].split('/')[-1]: i for i in st['items']}
    hls = byname['master.m3u8']
    print('dl hls', (await M({'type':'download','tabId':tab,'itemId':hls['id'],'baseName':'حلقة HLS','engine':'native','variant':0}))['ok'])
    print('dl direct(browser)', (await M({'type':'download','tabId':tab,'itemId':byname['big.mp4']['id'],'baseName':'direct-browser','engine':'browser'}))['ok'])
    slow = await M({'type':'download','tabId':tab,'itemId':byname['slow-big.mp4']['id'],'baseName':'slow','engine':'native'})
    print('dl fail', (await M({'type':'download','tabId':tab,'itemId':byname['fail-big.mp4']['id'],'baseName':'bad','engine':'native'}))['ok'])
    pr = await M({'type':'probePage','tabId':tab}); print('probe', pr)
    print('dl page audio', (await M({'type':'downloadPage','tabId':tab,'baseName':pr['data']['suggestedName'],'audioOnly':True}))['ok'])
    await o.wait_for_timeout(1500)
    pop = await ctx.new_page(); await pop.set_viewport_size({'width':400,'height':720})
    await pop.goto(f'chrome-extension://{ext}/popup.html?tabId={tab}'); await pop.wait_for_timeout(1200)
    btn = await pop.query_selector('#empty .btn')
    if btn: await btn.click(); await pop.wait_for_timeout(2500)
    await pop.screenshot(path=SHOTS+'/popup2.png')
    print('cancel', await M({'type':'cancelJob','jobId':slow['data']['jobId']}))
    await o.wait_for_timeout(2500)
    jobs = (await o.evaluate("chrome.storage.local.get('jobs')"))['jobs']
    for j in jobs: print(' job', j['engine'], j['state'], j.get('error'), j.get('file') or j['path'], j.get('quality'))
    await o.reload(); await o.wait_for_timeout(1500); await o.screenshot(path=SHOTS+'/options2.png', full_page=True)
    await ctx.close()
asyncio.run(main())
