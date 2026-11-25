import asyncio, json, os, shutil, subprocess
from playwright.async_api import async_playwright
from common import EXT as EXT_PATH, HOST, SITE, SHOTS, EXT_ID
EXT=EXT_PATH; PROFILE='/tmp/vs-prof11'
shutil.rmtree(PROFILE, ignore_errors=True); os.makedirs(PROFILE+'/NativeMessagingHosts')
# نفس الـmanifest اللي install.sh كتبه
shutil.copy(os.environ.get('HH_INSTALL_HOME','/tmp/fh2')+'/.config/google-chrome/NativeMessagingHosts/com.hudhud.helper.json', PROFILE+'/NativeMessagingHosts/')
env = {k:v for k,v in os.environ.items() if 'proxy' not in k.lower()}; env['HOME'] = os.environ.get('HH_INSTALL_HOME','/tmp/fh2')
async def main():
  async with async_playwright() as p:
    ctx = await p.chromium.launch_persistent_context(PROFILE, executable_path='/usr/bin/google-chrome', headless=True, env=env,
      args=['--headless=new', '--no-proxy-server', f'--disable-extensions-except={EXT}', f'--load-extension={EXT}'])
    sw = ctx.service_workers[0] if ctx.service_workers else await ctx.wait_for_event('serviceworker')
    await asyncio.sleep(1.5); ext=sw.url.split('/')[2]
    page = await ctx.new_page(); await page.goto('http://127.0.0.1:8765/index.html'); await page.wait_for_timeout(2000)
    tab = await sw.evaluate("(async()=> (await chrome.tabs.query({url:'http://127.0.0.1:8765/*'}))[0].id)()")
    o = await ctx.new_page(); await o.goto(f'chrome-extension://{ext}/options.html'); await o.wait_for_timeout(300)
    M = lambda m: o.evaluate(f"chrome.runtime.sendMessage({json.dumps(m)})")
    info = (await M({'type':'nativeInfo'}))['data']; print('nativeInfo:', {k: info[k] for k in ('version','os','ytdlp','ffmpeg','deno','defaultDir')})
    r = await M({'type':'downloadPage','tabId':tab,'url':'http://127.0.0.1:8765/index.html','baseName':'linux-test','height':0}); print('download:', r.get('ok'), r.get('error'))
    r2 = await M({'type':'downloadPage','tabId':tab,'url':'https://x.com/childtest-slow','baseName':'cancel-me','height':0})
    await o.wait_for_timeout(2500)
    before = subprocess.run(['pgrep','-f','sleep 313'],capture_output=True,text=True).stdout.split()
    await M({'type':'cancelJob','jobId':r2['data']['jobId']}); await o.wait_for_timeout(2500)
    after = subprocess.run(['pgrep','-f','sleep 313'],capture_output=True,text=True).stdout.split()
    print(f'child process before cancel: {len(before)}, after cancel: {len(after)}')
    await o.wait_for_timeout(1500)
    for j in (await o.evaluate("chrome.storage.local.get('jobs')"))['jobs']: print(' job', j['state'], j.get('error'), j.get('file'))
    done = [j for j in (await o.evaluate("chrome.storage.local.get('jobs')"))['jobs'] if j['state']=='complete'][0]
    print('reveal:', await M({'type':'revealJob','jobId':done['jobId']}))
    print('chooseFolder:', await M({'type':'chooseFolder'}))
    await o.reload(); await o.wait_for_timeout(1500)
    print('options status:', await o.inner_text('#nativeStatus'))
    print('nativeDir editable:', await o.evaluate("!document.querySelector('#nativeDir').readOnly"))
    await ctx.close()
asyncio.run(main())
