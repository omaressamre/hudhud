import asyncio, json, os, shutil, subprocess
from playwright.async_api import async_playwright
from common import EXT as EXT_PATH, HOST, SITE, SHOTS, EXT_ID
EXT=EXT_PATH; PROFILE='/tmp/vs-prof8'; DL='/tmp/vs-dl8'
shutil.rmtree(PROFILE, ignore_errors=True); shutil.rmtree(DL, ignore_errors=True); os.makedirs(DL)
def md5(f, sel): return [l.split(',')[-1].strip() for l in subprocess.run(['ffmpeg','-v','error','-i',f,'-map',sel,'-f','framemd5','-'],capture_output=True,text=True).stdout.splitlines() if l and not l.startswith('#')]
async def main():
  async with async_playwright() as p:
    ctx = await p.chromium.launch_persistent_context(PROFILE, executable_path='/usr/bin/google-chrome', headless=True, accept_downloads=True, downloads_path=DL,
      args=['--headless=new', '--no-proxy-server', f'--disable-extensions-except={EXT}', f'--load-extension={EXT}'])
    sw = ctx.service_workers[0] if ctx.service_workers else await ctx.wait_for_event('serviceworker')
    await asyncio.sleep(1.5); ext=sw.url.split('/')[2]
    page = await ctx.new_page(); await page.goto('http://127.0.0.1:8765/rxpage.html'); await page.wait_for_timeout(3000)
    tab = await sw.evaluate("(async()=> (await chrome.tabs.query({url:'http://127.0.0.1:8765/*'}))[0].id)()")
    o = await ctx.new_page(); await o.goto(f'chrome-extension://{ext}/options.html'); await o.wait_for_timeout(300)
    M = lambda m: o.evaluate(f"chrome.runtime.sendMessage({json.dumps(m)})")
    st = (await M({'type':'getState','tabId':tab}))['data']
    names = {}
    for i in st['items']:
      key = i['url'].split('8765')[1]
      name = key.strip('/').replace('/','_').replace('.m3u8','')
      names[name] = key
      r = await M({'type':'download','tabId':tab,'itemId':i['id'],'baseName':name,'engine':'browser'})
      if not r.get('ok'): print(' dl FAIL', key, r.get('error'))
    for _ in range(60):
      await o.wait_for_timeout(1000)
      jobs = (await o.evaluate("chrome.storage.local.get('jobs')"))['jobs']
      if all(j['state'] != 'in_progress' for j in jobs) and len(jobs) == len(st['items']): break
    for j in sorted(jobs, key=lambda j: j['path']):
      key = names.get(j['path'].rsplit('.',1)[0])
      f = j.get('file'); line = f"{j['path']:<28} {j['state']:<11} {j.get('note') or j.get('error') or ''}"
      if f and os.path.exists(f):
        pr = json.loads(subprocess.run(['ffprobe','-v','error','-show_entries','format=format_name,duration:stream=codec_type','-of','json',f],capture_output=True,text=True).stdout)
        fmt = pr['format']['format_name'].split(',')[0]; dur = float(pr['format']['duration'])
        src = 'http://127.0.0.1:8765' + key
        ref_v = md5(src, '0:v:0'); got_v = md5(f, '0:v:0')
        same = got_v == ref_v
        line += f" | {fmt} {dur:.2f}s streams={[s['codec_type'] for s in pr['streams']]} video={'IDENTICAL' if same else 'DIFF %d/%d' % (len(got_v), len(ref_v))}"
        if any(s['codec_type']=='audio' for s in pr['streams']):
          ra = subprocess.run(['ffmpeg','-v','error','-i',src,'-map','0:a:0','-f','md5','-'],capture_output=True,text=True).stdout.strip()
          ga = subprocess.run(['ffmpeg','-v','error','-i',f,'-map','0:a:0','-f','md5','-'],capture_output=True,text=True).stdout.strip()
          line += ' audio=' + ('IDENTICAL' if ra == ga else 'DIFF')
      print(line)
    print('opfs left:', await o.evaluate("(async()=>{const r=await navigator.storage.getDirectory(); const n=[]; for await (const [k] of r.entries()) n.push(k); return n})()"))
    await ctx.close()
asyncio.run(main())
