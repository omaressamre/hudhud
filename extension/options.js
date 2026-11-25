import { DEFAULT_SETTINGS } from './lib/naming.js';
import { installer, platformReady, currentOs } from './lib/platform.js';
import { initI18n, applyI18n, applyTheme, t } from './lib/i18n.js';
import { CONFIG, releaseAsset } from './lib/config.js';
import { icon, mascot } from './ui/icons.js';

const $ = (s) => document.querySelector(s);
const EXAMPLE = [{ match: 'example.com', template: '%hostname - %selector', selector: 'h1', directory: 'Example', maxLength: 80, replace: [{ from: '/\\s*\\|\\s*Example$/', to: '' }] }];
const BOOL = ['history', 'notifications', 'hlsToMp4', 'subs', 'embedMeta', 'embedThumb', 'autoUpdate'];
const TEXT = ['subdir', 'nativeDir', 'defaultEngine', 'rateLimit', 'subLangs', 'template', 'uiLang', 'theme'];
const NUM = ['maxConcurrent', 'minSizeMB', 'maxLength'];

let current = {};
let toastTimer = null;
function toast(text, ok = true) {
  const s = $('#toast');
  s.textContent = text;
  s.classList.toggle('err', !ok);
  clearTimeout(toastTimer);
  if (ok) toastTimer = setTimeout(() => { s.textContent = ''; }, 2200);
}

function validateRules(rules) {
  if (!Array.isArray(rules)) throw new Error(t('ruleNotArray'));
  rules.forEach((r, i) => {
    if (!r || typeof r !== 'object') throw new Error(t('ruleNotObject', i + 1));
    if (!r.match) throw new Error(t('ruleNoMatch', i + 1));
    if (r.replace && !Array.isArray(r.replace)) throw new Error(t('ruleReplace', i + 1));
  });
}

function fill(s) {
  for (const k of BOOL) $('#' + k).checked = !!s[k];
  for (const k of TEXT) $('#' + k).value = s[k] ?? '';
  for (const k of NUM) $('#' + k).value = s[k];
  $('#rules').value = JSON.stringify(s.rules, null, 2);
}

function collect() {
  const v = (id) => $('#' + id).value.trim();
  const rate = v('rateLimit');
  return {
    ...current,
    subdir: v('subdir'),
    nativeDir: v('nativeDir'),
    defaultEngine: v('defaultEngine'),
    rateLimit: /^\d+(\.\d+)?[KkMm]?$/.test(rate) ? rate : '',
    subLangs: v('subLangs').replace(/\s+/g, '') || 'ar,en',
    template: v('template') || '%title',
    uiLang: v('uiLang'),
    theme: v('theme'),
    maxConcurrent: Math.min(10, Math.max(1, Number(v('maxConcurrent')) || 3)),
    minSizeMB: Math.max(0, Number(v('minSizeMB')) || 0),
    maxLength: Math.min(200, Math.max(10, Number(v('maxLength')) || 64)),
    ...Object.fromEntries(BOOL.map((k) => [k, $('#' + k).checked])),
  };
}

async function save() {
  let rules;
  try {
    rules = JSON.parse($('#rules').value.trim() || '[]');
    validateRules(rules);
    $('#rulesErr').textContent = '';
  } catch (e) {
    $('#rulesErr').textContent = t('rulesInvalid', e.message);
    return;
  }
  const next = { ...collect(), rules };
  if (next.nativeDir && !/^(\/|[a-zA-Z]:[\\/]|\\\\)/.test(next.nativeDir)) return toast(t('pathAbsolute'), false);
  const langChanged = next.uiLang !== current.uiLang, themeChanged = next.theme !== current.theme;
  current = next;
  await chrome.storage.local.set({ settings: next });
  if (langChanged) { await initI18n(next.uiLang); applyI18n(); renderStatic(); loadNative(); }
  if (themeChanged) await applyTheme(next.theme);
  toast(t('saved'));
}

async function send(msg) {
  const r = await chrome.runtime.sendMessage(msg);
  if (!r?.ok) throw new Error(r?.error || t('errGeneric'));
  return r.data;
}

async function loadNative() {
  await platformReady();
  const st = $('#nativeStatus');
  let info = null;
  try { info = await send({ type: 'nativeInfo' }); } catch {}
  ['#btnChoose', '#btnResetDir', '#btnUpdate'].forEach((s) => { $(s).disabled = !info; });
  $('#btnUpdate').hidden = !info;
  $('#btnGetHelper').hidden = !!info;
  $('#btnGetHelper').href = releaseAsset(currentOs());
  if (!info) {
    st.className = 'stat bad';
    st.textContent = t('helperNotInstalled', installer());
    st.dir = 'auto';
    return;
  }
  const missing = [!info.ytdlp && 'yt-dlp', !info.ffmpeg && 'ffmpeg', !info.deno && 'Deno'].filter(Boolean);
  st.className = 'stat ' + (missing.length ? 'warn' : 'ok');
  st.dir = 'auto';
  st.textContent = t('connected', info.version, info.ytdlp || '—') + (missing.length ? ' · ' + t('missingTool', missing.join(', ')) : '');
  $('#updateStatus').textContent = info.version < '0.8.0' ? t('helperOld', installer()) : '';
  $('#nativeDir').placeholder = `${info.defaultDir} ${t('defaultSuffix')}`;
}

function renderStatic() {
  $('#ver').textContent = t('version', chrome.runtime.getManifest().version);
  $('#rateLimit').placeholder = t('noLimit');
}

function wire() {
  for (const k of [...BOOL, 'defaultEngine', 'maxConcurrent', 'uiLang', 'theme']) $('#' + k).addEventListener('change', save);
  for (const k of ['subdir', 'nativeDir', 'rateLimit', 'subLangs', 'template', 'minSizeMB', 'maxLength', 'rules']) $('#' + k).addEventListener('change', save);
  $('#btnChoose').addEventListener('click', async () => {
    try {
      const r = await send({ type: 'chooseFolder' });
      if (r.path) { $('#nativeDir').value = r.path; await save(); }
    } catch (e) { toast(e.message, false); }
  });
  $('#btnResetDir').innerHTML = icon('x');
  $('#btnResetDir').addEventListener('click', async () => { $('#nativeDir').value = ''; await save(); });
  $('#btnUpdate').addEventListener('click', async () => {
    const s = $('#updateStatus');
    $('#btnUpdate').disabled = true;
    s.textContent = t('updating');
    try {
      const r = await send({ type: 'updateYtdlp' });
      s.textContent = t('updated', r.ytdlp || r.output);
      loadNative();
    } catch (e) {
      s.textContent = e.message;
    } finally {
      $('#btnUpdate').disabled = false;
    }
  });
  $('#btnExample').addEventListener('click', () => { $('#rules').value = JSON.stringify(EXAMPLE, null, 2); save(); });
  // nav highlight
  const links = [...document.querySelectorAll('.nav a')];
  const obs = new IntersectionObserver((ents) => {
    for (const e of ents) if (e.isIntersecting) links.forEach((a) => a.classList.toggle('on', a.hash === '#' + e.target.id));
  }, { rootMargin: '-120px 0px -60% 0px' });
  document.querySelectorAll('.main > section').forEach((s) => obs.observe(s));
  $('#supportTop').href = '#about'; $('#supportTop').removeAttribute('target');
  $('#supportTop').insertAdjacentHTML('afterbegin', icon('heart'));
  $('#btnInstapay').href = CONFIG.instapay;
  $('#srcLink').href = `https://github.com/${CONFIG.repo}`;
  $('#privacyLink').href = CONFIG.site + 'privacy.html';
  $('.mascot-slot').append(mascot('neutral', 110));
}

async function init() {
  const { settings } = await chrome.storage.local.get('settings');
  current = { ...DEFAULT_SETTINGS, ...(settings || {}) };
  await Promise.all([initI18n(current.uiLang), applyTheme(current.theme)]);
  applyI18n();
  renderStatic();
  fill(current);
  wire();
  loadNative();
  // deep link (e.g. options.html#about from the popup): scroll once the page has its final height
  if (location.hash) requestAnimationFrame(() => document.querySelector(location.hash)?.scrollIntoView({ block: 'start' }));
}
init();
