import asyncio, shutil
from playwright.async_api import async_playwright
from common import EXT as EXT_PATH, HOST, SITE, SHOTS, EXT_ID
EXT=EXT_PATH; PROFILE='/tmp/vs-prof3'
shutil.rmtree(PROFILE, ignore_errors=True)
async def main():
  async with async_playwright() as p:
    ctx = await p.chromium.launch_persistent_context(PROFILE, executable_path='/usr/bin/google-chrome', headless=True,
      args=['--headless=new', f'--disable-extensions-except={EXT}', f'--load-extension={EXT}'])
    sw = ctx.service_workers[0] if ctx.service_workers else await ctx.wait_for_event('serviceworker')
    await asyncio.sleep(1.5)
    ext_id = sw.url.split('/')[2]
    page = await ctx.new_page(); await page.goto('http://127.0.0.1:8765/index.html'); await page.wait_for_timeout(2500)
    tab_id = await sw.evaluate("(async()=> (await chrome.tabs.query({url:'http://127.0.0.1:8765/*'}))[0].id)()")
    pop = await ctx.new_page(); await pop.set_viewport_size({'width':400,'height':520})
    await pop.goto(f'chrome-extension://{ext_id}/popup.html?tabId={tab_id}'); await pop.wait_for_timeout(1500)
    await pop.screenshot(path=SHOTS+'/popup.png')
    o = await ctx.new_page(); await o.set_viewport_size({'width':900,'height':900})
    await o.goto(f'chrome-extension://{ext_id}/options.html'); await o.wait_for_timeout(800)
    await o.screenshot(path=SHOTS+'/options.png', full_page=True)
    await ctx.close()
asyncio.run(main())
