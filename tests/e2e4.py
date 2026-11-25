import asyncio, json, os, shutil, subprocess
from playwright.async_api import async_playwright
from common import EXT as EXT_PATH, HOST, SITE, SHOTS, EXT_ID
EXT=EXT_PATH; PROFILE='/tmp/vs-prof6'; DL='/tmp/vs-dl6'
shutil.rmtree(PROFILE, ignore_errors=True); shutil.rmtree(DL, ignore_errors=True); os.makedirs(DL)
async def main():
  async with async_playwright() as p:
    ctx = await p.chromium.launch_persistent_context(PROFILE, executable_path='/usr/bin/google-chrome', headless=True, accept_downloads=True, downloads_path=DL,
      args=['--headless=new', '--no-proxy-server', f'--disable-extensions-except={EXT}', f'--load-extension={EXT}'])
    sw = ctx.service_workers[0] if ctx.service_workers else await ctx.wait_for_event('serviceworker')
    await asyncio.sleep(1.5); ext=sw.url.split('/')[2]
    page = await ctx.new_page(); await page.goto('http://127.0.0.1:8765/hlspage.html'); await page.wait_for_timeout(2500)
    tab = await sw.evaluate("(async()=> (await chrome.tabs.query({url:'http://127.0.0.1:8765/*'}))[0].id)()")
    o = await ctx.new_page(); await o.goto(f'chrome-extension://{ext}/options.html'); await o.wait_for_timeout(300)
    M = lambda m: o.evaluate(f"chrome.runtime.sendMessage({json.dumps(m)})")
    st = (await M({'type':'getState','tabId':tab}))['data']
    for i in st['items']:
      r = await M({'type':'download','tabId':tab,'itemId':i['id'],'baseName':i['url'].split('/')[-2]+'-'+i['url'].split('/')[-1].split('.')[0],'engine':'browser'})
      print(' dl', i['url'].split('8765')[1], i['engines'], r.get('ok'), r.get('error'))
    await o.wait_for_timeout(8000)
    for j in (await o.evaluate("chrome.storage.local.get('jobs')"))['jobs']:
      print(' job', j['state'], j.get('mode'), j['path'], j.get('error'), j.get('file'))
      f = j.get('file')
      if f and os.path.exists(f):
        out = subprocess.run(['ffprobe','-v','error','-show_entries','format=duration,format_name:stream=codec_name','-of','csv=p=0',f],capture_output=True,text=True)
        print('    ffprobe:', out.stdout.replace('\n',' '), out.stderr[:200])
    print('opfs left:', await o.evaluate("(async()=>{const r=await navigator.storage.getDirectory(); const n=[]; for await (const [k] of r.entries()) n.push(k); return n})()"))
    await ctx.close()
asyncio.run(main())
