import asyncio, json, os, shutil
from playwright.async_api import async_playwright
from common import EXT as EXT_PATH, HOST, SITE, SHOTS, EXT_ID
EXT=EXT_PATH; DL='/tmp/vs-dl'; PROFILE='/tmp/vs-prof'
shutil.rmtree(PROFILE, ignore_errors=True); shutil.rmtree(DL, ignore_errors=True); os.makedirs(DL)
async def main():
  async with async_playwright() as p:
    ctx = await p.chromium.launch_persistent_context(PROFILE, executable_path='/usr/bin/google-chrome', headless=True,
      args=['--headless=new', f'--disable-extensions-except={EXT}', f'--load-extension={EXT}'], accept_downloads=True, downloads_path=DL)
    sw = ctx.service_workers[0] if ctx.service_workers else await ctx.wait_for_event('serviceworker')
    ext_id = sw.url.split('/')[2]; print('ext id', ext_id)
    errs=[]
    await asyncio.sleep(1.5)
    page = await ctx.new_page(); page.on('console', lambda m: errs.append(m.text) if m.type=='error' else None)
    await page.goto('http://127.0.0.1:8765/index.html'); await page.wait_for_timeout(2500)
    print("SESSION", json.dumps(await sw.evaluate("chrome.storage.session.get(null)"))[:600])
    tab_id = await sw.evaluate("(async()=> (await chrome.tabs.query({url:'http://127.0.0.1:8765/*'}))[0].id)()")
    opt = await ctx.new_page(); await opt.goto(f'chrome-extension://{ext_id}/options.html')
    await opt.evaluate("chrome.storage.local.set({settings:{subdir:'Videos',template:'%title',maxLength:64,minSizeMB:1,history:true,defaultEngine:'browser',rules:[{match:'127.0.0.1',template:'%hostname - %selector',selector:'h1',directory:'Test'}]}})")
    st = await opt.evaluate(f"chrome.runtime.sendMessage({{type:'getState', tabId:{tab_id}}})")
    print(json.dumps([{k:i.get(k) for k in ('kind','url','size','variants','suggestedName','engines')} for i in st['data']['items']], ensure_ascii=False, indent=1))
    print('engines', st['data']['engines'])
    badge = await sw.evaluate(f"chrome.action.getBadgeText({{tabId:{tab_id}}})"); print('badge', badge)
    direct = [i for i in st['data']['items'] if i['kind']=='direct'][0]
    r = await opt.evaluate(f"chrome.runtime.sendMessage({{type:'download', tabId:{tab_id}, itemId:'{direct['id']}', baseName:{json.dumps(direct['suggestedName'])}, engine:'browser'}})")
    print('download', r['ok'], r.get('data',{}).get('path'), r.get('error'))
    hls = [i for i in st['data']['items'] if i['kind']=='hls'][0]
    r2 = await opt.evaluate(f"chrome.runtime.sendMessage({{type:'download', tabId:{tab_id}, itemId:'{hls['id']}', baseName:'x'}})")
    print('hls download', r2)
    await opt.wait_for_timeout(3000)
    jobs = await opt.evaluate("chrome.storage.local.get('jobs')"); print('job', {k:jobs['jobs'][0].get(k) for k in ('state','file','path')})
    # popup render check
    pop = await ctx.new_page(); await pop.set_viewport_size({'width':400,'height':600})
    await pop.goto(f'chrome-extension://{ext_id}/popup.html'); await pop.wait_for_timeout(1500)
    print('popup text:', (await pop.inner_text('body'))[:300].replace('\n',' | '))
    print('page errors', errs)
    await ctx.close()
asyncio.run(main())
