import { initI18n, applyI18n, applyTheme, t } from './lib/i18n.js';
import { platformReady, currentOs, installer } from './lib/platform.js';
import { CONFIG, releaseAsset, releasesPage } from './lib/config.js';
import { mascot } from './ui/icons.js';

const $ = (s) => document.querySelector(s);
const OS = { win: 'Windows', mac: 'macOS', linux: 'Linux' };

async function helperState() {
  try {
    const r = await chrome.runtime.sendMessage({ type: 'nativeInfo' });
    return !!(r?.ok && r.data);
  } catch { return false; }
}

async function refresh() {
  const ok = await helperState();
  $('#s2').className = 'step ' + (ok ? 'done' : 'now');
  $('#s2 .n').textContent = ok ? '✓' : (document.dir === 'rtl' ? '٢' : '2');
  $('#s3').className = 'step' + (ok ? ' now' : '');
  $('#s2ok').hidden = !ok;
  document.querySelector('#s2 .acts').hidden = ok;
  return ok;
}

async function init() {
  await Promise.all([initI18n(), applyTheme(), platformReady()]);
  applyI18n();
  const rtl = document.dir === 'rtl';
  $('#s3 .n').textContent = rtl ? '٣' : '3';
  $('#hero').append(mascot('found', 420));
  $('#s2body').textContent = t('step2Body', installer());
  $('#btnHelper').textContent = t('helperDownload', OS[currentOs()] || 'Windows');
  $('#btnHelper').href = releasesPage();
  releaseAsset(currentOs()).then((u) => { $('#btnHelper').href = u; });
  $('#btnOther').href = releasesPage();
  $('#btnTry').href = CONFIG.testVideo;
  if (!(await refresh())) {
    const timer = setInterval(async () => { if (await refresh()) clearInterval(timer); }, 4000);
  }
}
init();
