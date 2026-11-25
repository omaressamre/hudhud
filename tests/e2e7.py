import asyncio, json, os, shutil, subprocess
from playwright.async_api import async_playwright
from common import EXT as EXT_PATH, HOST, SITE, SHOTS, EXT_ID
EXT=EXT_PATH; PROFILE='/tmp/vs-prof9'; DL='/tmp/vs-dl9'
shutil.rmtree(PROFILE, ignore_errors=True); shutil.rmtree(DL, ignore_errors=True); os.makedirs(DL)
env = {k:v for k,v in os.environ.items() if 'proxy' not in k.lower()}
def md5(f, sel): return [l.split(',')[-1].strip() for l in subprocess.run(['ffmpeg','-v','error','-i',f,'-map',sel,'-f','framemd5','-'],capture_output=True,text=True).stdout.splitlines() if l and not l.startswith('#')]
def pcm(f): return subprocess.run(['ffmpeg','-v','error','-i',f,'-map','0:a:0','-f','s16le','-'],capture_output=True).stdout
def ensure_hosts():
    h=open('/etc/hosts').read()
    if 'fbcdn' not in h: open('/etc/hosts','a').write('\n127.0.0.1 video.test.fbcdn.net scontent.test.cdninstagram.com\n')
ensure_hosts()
async def main():
  async with async_playwright() as p:
    ctx = await p.chromium.launch_persistent_context(PROFILE, executable_path='/usr/bin/google-chrome', headless=True, accept_downloads=True, downloads_path=DL, env=env,
      args=['--headless=new', '--no-proxy-server', '--host-resolver-rules=MAP *.fbcdn.net 127.0.0.1, MAP *.cdninstagram.com 127.0.0.1', f'--disable-extensions-except={EXT}', f'--load-extension={EXT}'])
    sw = ctx.service_workers[0] if ctx.service_workers else await ctx.wait_for_event('serviceworker')
    await asyncio.sleep(1.5); ext=sw.url.split('/')[2]
    page = await ctx.new_page(); await page.goto('http://127.0.0.1:8765/stories2.html'); await page.wait_for_timeout(3500)
    tab = await sw.evaluate("(async()=> (await chrome.tabs.query({url:'http://127.0.0.1:8765/*'}))[0].id)()")
    o = await ctx.new_page(); await o.goto(f'chrome-extension://{ext}/options.html'); await o.wait_for_timeout(300)
    M = lambda m: o.evaluate(f"chrome.runtime.sendMessage({json.dumps(m)})")
    st = (await M({'type':'getState','tabId':tab}))['data']
    print('items:', [(i['url'].split('/')[-1][:8], bool(i.get('audio')), (i.get('audio') or {}).get('url','').split('/')[-1][:8]) for i in st['items']])
    for i in st['items']:
      name = i['url'].split('/')[-1].split('_')[0]
      r = await M({'type':'download','tabId':tab,'itemId':i['id'],'baseName':'story-'+name,'engine':'browser'})
      if not r.get('ok'): print('dl FAIL', r.get('error'))
    for _ in range(40):
      await o.wait_for_timeout(1000)
      jobs = (await o.evaluate("chrome.storage.local.get('jobs')"))['jobs']
      if jobs and all(j['state'] != 'in_progress' for j in jobs): break
    for j in sorted(jobs, key=lambda j: j['path']):
      n = j['path'].split('-')[1].split('.')[0]
      f = j.get('file'); line = f"{j['path']:<16} {j['state']:<9} {j.get('note','')}"
      if f and os.path.exists(f):
        streams = subprocess.run(['ffprobe','-v','error','-show_entries','stream=codec_type,codec_name','-of','csv=p=0',f],capture_output=True,text=True).stdout.split()
        src_v = SITE+f'/fb2/{n}_v.mp4'; src_a = SITE+f'/fb2/{n}_a.mp4'
        line += f" | {streams} video={'IDENTICAL' if md5(f,'0:v:0')==md5(src_v,'0:v:0') else 'DIFF'}"
        if any('audio' in s for s in streams):
          a, b = pcm(f), pcm(src_a); line += f" audio={'IDENTICAL' if a[:len(b)]==b and len(a)-len(b) < 4000 else 'DIFF'}"
      print(line)
    print('opfs left:', await o.evaluate("(async()=>{const r=await navigator.storage.getDirectory(); const n=[]; for await (const [k] of r.entries()) n.push(k); return n})()"))
    await ctx.close()
asyncio.run(main())
