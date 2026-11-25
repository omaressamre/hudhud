# Visual check of popup / options / welcome in ar+en, light+dark.
import asyncio, shutil, sys, os, json
from playwright.async_api import async_playwright
HERE = os.path.dirname(os.path.abspath(__file__))
EXT = os.path.join(HERE, '..', 'extension'); OUT = sys.argv[1] if len(sys.argv) > 1 else '/tmp/hh-shots'
PAGES = sys.argv[2].split(',') if len(sys.argv) > 2 else ['index.html']
os.makedirs(OUT, exist_ok=True)
async def main():
  async with async_playwright() as p:
    prof = '/tmp/hh-ui-prof'; shutil.rmtree(prof, ignore_errors=True)
    ctx = await p.chromium.launch_persistent_context(prof, executable_path='/usr/bin/google-chrome', headless=True,
      args=['--headless=new', f'--disable-extensions-except={EXT}', f'--load-extension={EXT}'])
    sw = ctx.service_workers[0] if ctx.service_workers else await ctx.wait_for_event('serviceworker')
    await asyncio.sleep(1.5)
    ext = sw.url.split('/')[2]
    for pg in ctx.pages:
      if 'welcome' in pg.url: await pg.close()
    tabs = {}
    for name in PAGES:
      page = await ctx.new_page(); await page.goto(f'http://127.0.0.1:8765/{name}'); await page.wait_for_timeout(2500)
      tabs[name] = await sw.evaluate(f"(async()=> (await chrome.tabs.query({{url:'http://127.0.0.1:8765/{name}*'}}))[0].id)()")
    for lang in ['ar', 'en']:
      for theme in ['light', 'dark']:
        await sw.evaluate(f"chrome.storage.local.get('settings').then(r=>chrome.storage.local.set({{settings:{{...(r.settings||{{}}), uiLang:'{lang}', theme:'{theme}'}}}}))")
        await asyncio.sleep(0.4)
        for name, tid in tabs.items():
          pop = await ctx.new_page(); await pop.set_viewport_size({'width': 380, 'height': 600})
          await pop.goto(f'chrome-extension://{ext}/popup.html?tabId={tid}'); await pop.wait_for_timeout(2200)
          await pop.screenshot(path=f'{OUT}/popup-{name.split(".")[0]}-{lang}-{theme}.png', full_page=True); await pop.close()
        if '--pages' in sys.argv:
          for pname, w, h in [('options', 1200, 900), ('welcome', 1280, 820)]:
            o = await ctx.new_page(); await o.set_viewport_size({'width': w, 'height': h})
            await o.goto(f'chrome-extension://{ext}/{pname}.html'); await o.wait_for_timeout(1200)
            await o.screenshot(path=f'{OUT}/{pname}-{lang}-{theme}.png', full_page=pname == 'options'); await o.close()
    await ctx.close()
asyncio.run(main())
