import { platformReady, currentOs, installer } from './lib/platform.js';
import { initI18n, applyI18n, applyTheme, t, tn, fmtNum } from './lib/i18n.js';
import { CONFIG, openReleaseAsset } from './lib/config.js';
import { icon, iconEl, mascot } from './ui/icons.js';

const $ = (s) => document.querySelector(s);
function el(tag, props = {}, children = []) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of [].concat(children)) if (c != null && c !== false) n.append(c);
  return n;
}
const btn = (kind, label, onclick, extra = {}) => el('button', { class: `btn btn-${kind}`, onclick, ...extra }, [label]);

export function fmtSize(b) {
  if (!b) return '';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return `${b.toFixed(i > 1 ? 1 : 0)} ${u[i]}`;
}
export function fmtDur(s) {
  if (!s) return '';
  s = Math.round(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(sec).padStart(2, '0');
}
async function send(msg) {
  const r = await chrome.runtime.sendMessage(msg);
  if (!r?.ok) throw new Error(r?.error || t('errGeneric'));
  return r.data;
}
const basename = (p) => String(p || '').split(/[\\/]/).pop();

let tabId = null;
let state = null;       // getState
let jobs = [];
let local = {};         // stats, helperUpdate, dismissed
const names = new Map();     // edited file names
const picked = new Map();    // chosen quality per item
const openOpts = new Set();  // items with options expanded
const thumbAsked = new Set();
const probeAsked = new Set();
let scanning = false, scanError = '';
let playlistChecked = new Map();
const keys = {};

const hasNative = () => !!state?.engines.some((e) => e.id === 'native' && e.available);
const OS_LABEL = { win: 'Windows', mac: 'macOS', linux: 'Linux' };
let osPick = null;

// ───────── banners: support, update, helper ─────────
function renderBanners() {
  const out = [];
  const st = local.stats || {};
  const doneCount = st.completed || 0;
  const nextAt = st.nextSupportAt || CONFIG.supportAfter;
  if (doneCount >= nextAt) {
    out.push(banner('support', 'heart', t('supportTitle', fmtNum(doneCount)), t('supportBody'),
      btn('primary', t('support'), () => openSupport()),
      () => chrome.storage.local.set({ stats: { ...st, nextSupportAt: doneCount + 50 } })));
  }
  if (justUpdated) out.push(banner('info', 'check', t(justUpdatedHelper ? 'helperUpdatedTo' : 'updatedTo', justUpdated), null, null, () => { justUpdated = ''; renderBanners(); }));
  const up = local.helperUpdate;
  if (up && up.latest && !up.managed && !managedChecked) {
    managedChecked = true;
    send({ type: 'refreshManaged' }).catch(() => {});
  }
  // No update yet, but Chrome loads Hudhud from another folder than the installer's: say so now,
  // so the next update is one click (dismissible).
  if (!(up && up.latest) && install && !install.managed && install.extDir && !local.dismissedMove) {
    out.push(banner('info', 'refresh', t('moveTitle'), t('moveBody'),
      el('div', { class: 'copy-row' }, [el('bdi', { class: 'path', text: install.extDir }),
        btn('secondary', t('copyPath'), (e) => { navigator.clipboard.writeText(install.extDir); e.currentTarget.textContent = '✓'; })]),
      () => chrome.storage.local.set({ dismissedMove: true })));
  }
  if (up && up.latest && up.latest !== local.dismissedUpdate) {
    // installed with the installer, but Chrome loads the extension from another folder
    if (!up.managed && up.extDir) {
      out.push(banner('info', 'refresh', t('updateTitle', up.latest), t('updateMoveBody'),
        el('div', { class: 'copy-row' }, [el('bdi', { class: 'path', text: up.extDir }),
          btn('secondary', t('copyPath'), (e) => { navigator.clipboard.writeText(up.extDir); e.currentTarget.textContent = '✓'; })]),
        () => chrome.storage.local.set({ dismissedUpdate: up.latest })));
    } else {
    const action = up.managed
      ? btn('primary', updating ? t('updating') : t('updateNow'), (e) => runSelfUpdate(e.currentTarget), updating ? { class: 'btn btn-primary', disabled: true } : undefined)
      : btn('primary', t('updateCta'), () => openReleaseAsset(currentOs()));
    out.push(banner('info', 'refresh', t(up.helperOnly ? 'updateHelperTitle' : 'updateTitle', up.latest), t(up.managed ? 'updateBodyManaged' : 'updateBody'), action,
      updating ? null : () => chrome.storage.local.set({ dismissedUpdate: up.latest })));
    }
  }
  const needHelper = state && !hasNative() && state.items.some((i) => i.kind === 'page' || (!i.engines.length && !i.drm));
  if (needHelper) out.push(helperBanner());
  const k = JSON.stringify([doneCount, nextAt, up, updating, justUpdated, install, local.dismissedMove, local.dismissedUpdate, needHelper, osPick, state?.items.find((i) => i.kind === 'page')?.site]);
  if (k === keys.banners) return;
  keys.banners = k;
  $('#banners').replaceChildren(...out);
}
function banner(kind, ic, title, body, action, onClose) {
  return el('div', { class: `banner ${kind}` }, [
    el('span', { class: 'ic', html: icon(ic) }),
    el('div', { class: 'txt' }, [el('b', { text: title }), body ? el('p', { text: body }) : null, action]),
    onClose ? el('button', { class: 'close', title: t('dismiss'), html: icon('x'), onclick: onClose }) : null,
  ]);
}
function helperBanner() {
  const page = state.items.find((i) => i.kind === 'page');
  const os = osPick || currentOs();
  const wrap = el('div', { class: 'list' });
  wrap.append(banner('warning', 'plug', page ? t('helperTitle', page.site || 'YouTube') : t('helperTitleGeneric'), t('helperBody')));
  const picker = el('div', { class: 'os' });
  for (const id of ['win', 'mac', 'linux']) {
    picker.append(el('button', { class: id === os ? 'on' : '', onclick: () => { osPick = id; renderBanners(); } }, [
      iconEl(id), OS_LABEL[id], el('small', { text: id === currentOs() ? t('yourSystem') : '' }),
    ]));
  }
  wrap.append(picker);
  wrap.append(btn('primary', t('helperDownload', OS_LABEL[os]), () => openReleaseAsset(os), { class: 'btn btn-primary wide' }));
  const file = os === 'mac' ? 'install.command' : os === 'win' ? 'install.bat' : 'install.sh';
  wrap.append(el('div', { class: 'steps' }, [el('span', { text: t('helperStep1', file) }), el('span', { text: t('helperStep2') }), el('span', { text: t('helperStep3') })]));
  return wrap;
}
let updating = false;
let justUpdated = '';
let managedChecked = false;
let install = null; // { managed, extDir } from the background, once per popup
send({ type: 'installStatus' }).then((s) => { install = s; renderBanners(); }).catch(() => {});
let justUpdatedHelper = false;
async function runSelfUpdate() {
  updating = true; renderBanners();
  try {
    const res = await send({ type: 'selfUpdate' });
    // Chrome: the extension reloads itself in a moment, which closes this popup.
    // Firefox: only the helper was replaced; show the result here.
    if (res?.helperOnly) { updating = false; justUpdated = res.version; justUpdatedHelper = true; renderBanners(); }
  } catch (e) {
    updating = false; renderBanners();
    flash(t('updateFailed', e.message), true);
  }
}
function openSupport() { chrome.tabs.create({ url: chrome.runtime.getURL('options.html#about') }); }

// ───────── outcome block: done / error (last finished job, when nothing is running) ─────────
function renderOutcome() {
  const running = jobs.some((j) => j.state === 'in_progress');
  const last = jobs.filter((j) => j.endedAt).sort((a, b) => b.endedAt - a.endedAt)[0];
  const fresh = last && Date.now() - last.endedAt < 90_000 && !local.ackOutcome?.includes(last.jobId);
  let node = null;
  if (!running && fresh && last.state === 'complete') {
    const n = jobs.filter((j) => j.state === 'complete' && Date.now() - j.endedAt < 90_000).length;
    node = el('div', { class: 'block done' }, [
      mascot('done', 104), el('h3', { text: t('doneTitle') }),
      n > 1 ? el('p', { text: t('filesN', fmtNum(n)) }) : null,
      el('div', { class: 'acts' }, [
        btn('ghost', t('clearList'), clearFinished),
        btn('primary', t('openDownloads'), () => send({ type: 'openFolder' }).catch(() => {})),
      ]),
    ]);
  } else if (!running && fresh && last.state === 'interrupted' && last.error !== 'CANCELED') {
    const acts = [];
    if (last.req) acts.push(btn('primary', t('retry'), () => retry(last.jobId)));
    if (last.req && last.engine === 'browser' && hasNative()) acts.push(btn('secondary', t('useHelper'), () => retry(last.jobId, 'native')));
    node = el('div', { class: 'block error' }, [
      mascot('error', 104), el('h3', { text: t('errorTitle') }), el('p', { text: jobError(last) }),
      acts.length ? el('div', { class: 'acts' }, acts) : null,
    ]);
  }
  const k = node ? last.jobId + last.state + running : '';
  if (k === keys.outcome) return;
  keys.outcome = k;
  $('#outcome').replaceChildren(...(node ? [node] : []));
}
async function clearFinished() {
  await send({ type: 'clearJobs' }).catch(() => {});
  await loadJobs();
}
async function retry(jobId, engine) {
  try { await send({ type: 'retryJob', jobId, engine }); } catch (e) { flash(e.message, true); }
  await loadJobs();
}
function jobError(j) {
  if (j.error === 'CANCELED') return t('jobCanceled');
  return j.error || t('jobStopped');
}

// ───────── status line ─────────
function renderStatus() {
  const s = $('#status');
  if (!state) { s.hidden = true; return; }
  const page = state.items.find((i) => i.kind === 'page');
  const running = jobs.filter((j) => j.state === 'in_progress').length;
  let text = '', busy = false;
  if (scanning) { text = t('scanning'); busy = true; }
  else if (page) text = page.isPlaylist ? t('playlistOnly', fmtNum(page.playlistCount)) : (page.probed || !hasNative() ? t('pageReady', page.site || 'YouTube') : t('pageProbing', page.site || 'YouTube'));
  else if (state.items.length) text = tn('found', state.items.length);
  else if (running) { text = tn('running', running); busy = true; }
  s.hidden = !text;
  s.classList.toggle('busy', busy);
  s.querySelector('span').textContent = text;
}

// ───────── quality menu ─────────
function openMenu(anchor, options, current, onPick) {
  const m = $('#menu');
  m.replaceChildren(...options.map((o) => o === '-' ? el('hr') : el('button', { class: o.value === current ? 'on' : '', onclick: () => { closeMenu(); onPick(o.value); } }, [
    el('span', { class: 'l' }, [o.value === current ? iconEl('check') : null, o.label]),
    el('span', { class: 'r', text: o.hint || '' }),
  ])));
  m.hidden = false;
  const r = anchor.getBoundingClientRect();
  const h = m.offsetHeight, w = m.offsetWidth;
  const top = r.top - h - 6 > 8 ? r.top - h - 6 : Math.min(r.bottom + 6, innerHeight - h - 8);
  const rtl = document.dir === 'rtl';
  m.style.top = Math.max(8, top) + 'px';
  m.style.left = Math.max(8, Math.min(innerWidth - w - 8, rtl ? r.right - w : r.left)) + 'px';
  setTimeout(() => addEventListener('click', closeMenu, { once: true }), 0);
}
function closeMenu() { $('#menu').hidden = true; }

function pageOptions(it) {
  const opts = (it.variants?.length ? it.variants : [{ height: 0, label: t('bestQuality') }])
    .map((v) => ({ value: 'v' + (v.height || 0), label: v.height ? `${v.height}p` + (v.height >= 2160 ? ' · 4K' : '') : t('bestQuality'), hint: v.height >= 1440 ? 'WebM' : v.height ? 'MP4' : '' }));
  if (it.hasAudio !== false) opts.push('-', { value: 'mp3', label: t('audioMp3') }, { value: 'm4a', label: t('audioM4a') });
  return opts;
}

// ───────── page card (YouTube & yt-dlp sites) ─────────
function renderPage() {
  const it = state?.items.find((i) => i.kind === 'page');
  const k = it ? JSON.stringify([it.id, it.title, it.thumb, it.duration, it.variants?.length, it.playlistCount, it.probed, it.probeError, hasNative(), picked.get(it.id), openOpts.has(it.id), playlistChecked.get(it.id), local.dismissedPlaylist?.includes(it.id)]) : '';
  if (k === keys.page) return;
  keys.page = k;
  const box = $('#pageCard');
  if (!it) { box.replaceChildren(); return; }
  const out = [];
  if (it.playlistCount > 0 && !it.isPlaylist && !local.dismissedPlaylist?.includes(it.id)) {
    out.push(banner('info', 'info', t('playlistInfoTitle'), t('playlistInfoBody'), btn('secondary', t('gotIt'), () => dismissPlaylist(it.id))));
  }
  const opts = pageOptions(it);
  if (!picked.has(it.id) || !opts.some((o) => o.value === picked.get(it.id))) picked.set(it.id, opts[0].value);
  const cur = opts.find((o) => o.value === picked.get(it.id));
  const q = el('button', { class: 'qsel', onclick: (e) => { e.stopPropagation(); openMenu(q, opts, picked.get(it.id), (v) => { picked.set(it.id, v); keys.page = ''; renderPage(); }); } }, [cur.label, iconEl('chevron')]);
  const name = el('input', { class: 'input name', placeholder: t('fileNameHint'), value: names.get(it.id) ?? '', title: t('fileName') });
  name.addEventListener('input', () => names.set(it.id, name.value));
  const note = el('div', { class: 'note' + (it.probeError ? ' err' : ''), text: it.probeError ? `${t('errQualities')}: ${it.probeError}` : it.live ? t('liveNote') : '' });
  const dlBtn = btn('primary', t('download'), async () => {
    dlBtn.disabled = true;
    const v = picked.get(it.id);
    try {
      await send({
        type: 'downloadPage', tabId, url: it.url,
        baseName: name.value.trim(),
        height: v.startsWith('v') ? Number(v.slice(1)) : 0,
        audioFormat: v === 'mp3' || v === 'm4a' ? v : '',
        playlist: it.isPlaylist || !!playlistChecked.get(it.id),
      });
      flash(t('started'));
      loadJobs();
    } catch (e) { note.className = 'note err'; note.textContent = e.message; }
    setTimeout(() => { dlBtn.disabled = false; }, 1200);
  }, { disabled: !hasNative() });
  const cover = el('div', { class: 'cover' + (it.short ? ' short' : '') }, [
    it.thumb ? el('img', { src: it.thumb, alt: '', referrerpolicy: 'no-referrer', onerror: (e) => e.target.remove() }) : null,
    it.duration ? el('span', { class: 'dur', text: fmtDur(it.duration) }) : null,
  ]);
  const card = el('div', { class: 'page' + (openOpts.has(it.id) ? ' open' : '') }, [
    cover,
    el('div', { class: 'title', text: it.title || it.suggestedName || it.url }),
    el('div', { class: 'sub', text: [it.channel, it.site, it.short ? t('shorts') : ''].filter(Boolean).join(' · ') }),
    name,
    el('div', { class: 'acts' }, [q, el('button', { class: 'icon-btn', title: t('more'), html: icon('more'), onclick: () => { openOpts.has(it.id) ? openOpts.delete(it.id) : openOpts.add(it.id); keys.page = ''; renderPage(); } }), el('span', { class: 'grow' }), dlBtn]),
  ]);
  out.push(card);
  if (it.playlistCount > 0 && !it.isPlaylist) {
    const cb = el('input', { type: 'checkbox' });
    cb.checked = !!playlistChecked.get(it.id);
    cb.addEventListener('change', () => playlistChecked.set(it.id, cb.checked));
    out.push(el('div', { class: 'checkrow' }, [el('label', { class: 'check' }, [cb, t('playlistAll', fmtNum(it.playlistCount))])]));
  }
  out.push(note);
  box.replaceChildren(...out);
}
async function dismissPlaylist(id) {
  const list = [...(local.dismissedPlaylist || []), id].slice(-50);
  await chrome.storage.local.set({ dismissedPlaylist: list });
  local.dismissedPlaylist = list;
  keys.page = '';
  renderPage();
}

// ───────── detected items ─────────
function itemMeta(it, host) {
  const chips = [];
  const quality = it.variants?.[0]?.label;
  if (quality) chips.push(el('bdi', { text: quality }));
  if (it.live) chips.push(el('span', { class: 'chip live', text: t('live') }));
  if (it.split || it.audio) chips.push(el('span', { class: 'chip story', text: t('withAudio') }));
  else if (it.kind === 'hls' && it.engines.includes('browser') && state.settings.hlsToMp4) chips.push(el('span', { class: 'chip stream', text: 'HLS → MP4' }));
  else if (it.audioOnly) chips.push(el('span', { class: 'chip', text: t('audioOnly') }));
  else chips.push(el('span', { class: 'chip', text: (it.kind === 'direct' ? (it.ext || 'mp4') : it.kind).toUpperCase() }));
  const size = it.kind === 'direct' && !it.split ? fmtSize(it.size) : '';
  if (size) chips.push(el('bdi', { text: size }));
  if (host) chips.push(el('bdi', { text: host }));
  return chips;
}
function renderItems() {
  const items = (state?.items || []).filter((i) => i.kind !== 'page');
  const k = JSON.stringify(items.map((i) => [i.id, i.variants?.length, i.size, i.thumb, i.title, i.engines, i.drm, openOpts.has(i.id)])) + hasNative() + state?.settings.defaultEngine;
  if (k === keys.items) return;
  keys.items = k;
  const box = $('#items');
  const nodes = [];
  if (items.length && state.items.some((i) => i.kind === 'page')) nodes.push(el('div', { class: 'label', text: t('otherVideos', fmtNum(items.length)) }));
  for (const it of items) nodes.push(itemCard(it));
  box.replaceChildren(...nodes);
}
function itemCard(it) {
  let host = '';
  try { host = new URL(it.url).hostname.replace(/^www\./, ''); } catch {}
  const thumb = el('div', { class: 'thumb' + (it.kind === 'hls' ? ' kind-hls' : it.split ? ' kind-split' : '') });
  if (it.thumb) {
    const img = el('img', { src: it.thumb, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' });
    img.addEventListener('error', () => img.remove());
    thumb.append(img);
  } else thumb.insertAdjacentHTML('beforeend', icon('play', 'ph'));
  if (it.live) thumb.append(el('span', { class: 'dur', text: '● ' + t('live') }));
  else if (it.duration) thumb.append(el('span', { class: 'dur', text: fmtDur(it.duration) }));

  const title = it.title || it.suggestedName || host;
  const note = el('div', { class: 'note' });
  let blocked = '';
  if (it.drm) blocked = t('drmBlocked');
  else if (!it.engines.length) blocked = t('errNeedsHelper', installer());
  if (blocked) { note.className = 'note err'; note.textContent = blocked; }

  // options: name, quality, engine
  const name = el('input', { class: 'input', value: names.get(it.id) ?? it.suggestedName, title: t('fileName') });
  name.addEventListener('input', () => names.set(it.id, name.value));
  let quality = null;
  if (it.variants?.length > 1) {
    quality = el('select', { class: 'select', title: t('quality') }, it.variants.map((v, i) => el('option', { value: i, text: v.label })));
    if (picked.has(it.id)) quality.value = picked.get(it.id);
    quality.addEventListener('change', () => picked.set(it.id, quality.value));
  }
  let engine = null;
  if (it.engines.length > 1) {
    engine = el('select', { class: 'select', title: t('engine') }, it.engines.map((e) => el('option', { value: e, text: t(e === 'native' ? 'helper' : 'browser'), selected: e === state.settings.defaultEngine })));
  }
  const hint = () => {
    if (blocked) return;
    const eng = engine ? engine.value : it.engines[0];
    note.className = 'note';
    note.textContent = it.live ? t('liveNote') : eng === 'browser' && it.audio ? t('mergeNote') : eng === 'browser' && it.kind === 'hls' && !state.settings.hlsToMp4 ? t('tsNote') : '';
  };
  engine?.addEventListener('change', hint);
  hint();
  const copy = el('button', { class: 'icon-btn', title: t('copyLink'), html: icon('link') });
  copy.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(it.url); flash(t('copied')); } catch {}
  });

  const dl = el('button', { class: 'dl', title: t('download'), html: icon('download'), disabled: !!blocked });
  dl.addEventListener('click', async () => {
    dl.disabled = true;
    try {
      await send({
        type: 'download', tabId, itemId: it.id,
        baseName: name.value.trim() || it.suggestedName,
        engine: engine ? engine.value : it.engines[0],
        variant: quality ? Number(quality.value) : 0,
      });
      note.className = 'note ok';
      note.textContent = t('started');
      loadJobs();
    } catch (e) {
      note.className = 'note err';
      note.textContent = e.message;
    }
    setTimeout(() => { dl.disabled = !!blocked; }, 1200);
  });
  const card = el('div', { class: 'item' + (openOpts.has(it.id) ? ' open' : '') });
  const info = el('div', { class: 'info', title: it.url, onclick: () => { card.classList.toggle('open'); card.classList.contains('open') ? openOpts.add(it.id) : openOpts.delete(it.id); } }, [
    el('div', { class: 'title', text: title }),
    el('div', { class: 'meta' }, itemMeta(it, host)),
  ]);
  card.append(
    el('div', { class: 'row' }, [thumb, info, dl]),
    el('div', { class: 'opts' }, [name, quality, engine, copy]),
    note,
  );
  return card;
}

// ───────── empty state ─────────
function renderEmpty() {
  const show = state && !state.items.length && !jobs.some((j) => j.state === 'in_progress') && !$('#outcome').children.length;
  const k = show ? 'e' + hasNative() + scanning + scanError + state.notWeb : '';
  if (k === keys.empty) return;
  keys.empty = k;
  if (!show) { $('#empty').replaceChildren(); return; }
  const acts = [];
  if (!state.notWeb) {
    acts.push(hasNative()
      ? btn('secondary', t('scanAgain'), scan, { disabled: scanning })
      : btn('secondary', t('reloadPage'), () => { chrome.tabs.reload(tabId); window.close(); }));
  }
  $('#empty').replaceChildren(el('div', { class: 'block' }, [
    mascot('sleepy', 120),
    el('h3', { text: t('emptyTitle') }),
    el('p', { text: state.notWeb ? t('notWebPage') : t('emptyBody') }),
    scanError ? el('p', { class: 'note err', text: scanError }) : null,
    el('div', { class: 'acts' }, acts),
    el('p', { class: 'tip', text: t('emptyTip') }),
  ]));
}
async function scan() {
  scanning = true; scanError = '';
  renderAll();
  try { await send({ type: 'probePage', tabId }); } catch (e) { scanError = e.message; }
  scanning = false;
  await loadState();
}

// ───────── jobs ─────────
async function jobView(j) {
  let pct = j.state === 'complete' ? 100 : Math.max(0, Math.round(j.percent || 0));
  let status = '', detail = '', track = '', cls = '', pctText = '';
  if (j.state === 'complete') {
    status = t('jobDone'); track = 'done'; cls = 'ok';
    detail = [j.quality === 'AUDIO' ? t('audioOnly') : j.quality, j.files > 1 ? t('filesN', fmtNum(j.files)) : '', j.noAudio ? t('noAudio') : '', j.note].filter(Boolean).join(' · ');
  } else if (j.state === 'interrupted') {
    status = j.error === 'CANCELED' ? t('jobCanceled') : t('jobStopped'); track = 'error'; cls = 'err';
    detail = j.error === 'CANCELED' ? '' : (j.error || '');
  } else if (j.queued) {
    status = t('jobQueued'); detail = t('jobQueuedDetail'); track = 'queued';
  } else if (j.engine === 'browser' && j.downloadId != null) {
    const [d] = await chrome.downloads.search({ id: j.downloadId });
    status = t('jobDownloading');
    if (d) {
      if (d.totalBytes > 0) pct = Math.round((d.bytesReceived / d.totalBytes) * 100);
      detail = d.totalBytes > 0 ? `${fmtSize(d.bytesReceived)} / ${fmtSize(d.totalBytes)}` : fmtSize(d.bytesReceived);
      if (d.paused) status = t('jobPaused');
    }
    pctText = d?.totalBytes > 0 ? pct + '%' : '';
  } else if (j.merging || (j.percent >= 100 && j.speed !== undefined)) {
    status = j.merging ? t('jobMerging') : t('jobProcessing'); track = 'processing';
    detail = j.engine === 'native' ? 'ffmpeg' : '';
  } else {
    status = t('jobDownloading');
    const known = j.percent >= 0 && j.speed !== undefined;
    pctText = known || j.mode === 'hls' ? pct + '%' : '';
    detail = [j.items > 1 ? t('itemOf', j.item, j.items) : '', !known ? fmtSize(j.downloaded) : '', j.speed, j.eta ? t('timeLeft', j.eta) : '', j.part > 1 ? t('partN', j.part) : ''].filter(Boolean).join(' · ');
    if (!detail && j.state === 'in_progress' && !j.percent) status = t('starting');
  }
  let act;
  if (j.state === 'in_progress') act = el('button', { class: 'act', title: t('cancel'), html: icon('x'), onclick: () => send({ type: 'cancelJob', jobId: j.jobId }).catch((e) => flash(e.message, true)) });
  else if (j.state === 'complete') act = el('button', { class: 'act folder', title: t('showInFolder'), html: icon('folder'), onclick: () => send({ type: 'revealJob', jobId: j.jobId }).catch((e) => flash(e.message, true)) });
  else if (j.req && j.error !== 'CANCELED') act = el('button', { class: 'act retry', title: t('retry'), html: icon('retry'), onclick: () => retry(j.jobId) });
  else act = el('button', { class: 'act', title: t('remove'), html: icon('x'), onclick: () => send({ type: 'removeJob', jobId: j.jobId }).then(loadJobs).catch(() => {}) });
  const name = (j.file ? basename(j.file) : j.title || basename(j.path));
  return el('div', { class: `job ${cls}` }, [
    el('div', { class: 'r1' }, [el('div', { class: 'name', text: name, title: j.file || j.path || '' }), act]),
    el('div', { class: 'track ' + track }, [el('i', { style: `width:${track === 'queued' ? 0 : pct}%` })]),
    el('div', { class: 'r2' }, [el('span', { class: 'st' }, [status, pctText ? el('span', { class: 'pct', text: pctText }) : null]), el('span', { class: 'det', text: detail, title: detail })]),
  ]);
}
async function renderJobs() {
  const list = jobs.slice(0, 8);
  $('#jobsWrap').hidden = !list.length;
  const nodes = await Promise.all(list.map(jobView));
  $('#jobs').replaceChildren(...nodes);
}

// ───────── messages ─────────
let flashTimer = null;
function flash(msg, err = false) {
  const s = $('#status');
  s.hidden = false;
  s.querySelector('span').textContent = msg;
  s.classList.toggle('busy', !err);
  clearTimeout(flashTimer);
  flashTimer = setTimeout(renderStatus, 2500);
}

// ───────── data ─────────
async function loadState() {
  try {
    state = await send({ type: 'getState', tabId });
  } catch (e) {
    state = { items: [], engines: [], settings: {}, notWeb: true };
  }
  requestExtras();
  renderAll();
}
async function loadJobs() {
  const r = await chrome.storage.local.get(['jobs', 'stats', 'helperUpdate', 'dismissedUpdate', 'dismissedPlaylist', 'justUpdated', 'dismissedMove']);
  // only the new version shows it (the old popup also sees the key just before the reload)
  if (r.justUpdated && r.justUpdated === chrome.runtime.getManifest().version) {
    justUpdated = r.justUpdated;
    chrome.storage.local.remove('justUpdated');
  }
  jobs = r.jobs || [];
  local = r;
  renderAll();
}
function requestExtras() {
  if (!state) return;
  if (state.items.some((i) => !i.thumb && !i.thumbTried && !thumbAsked.has(i.id))) {
    state.items.forEach((i) => thumbAsked.add(i.id));
    send({ type: 'makeThumbs', tabId }).catch(() => {});
  }
  for (const it of state.items) {
    if (it.kind === 'page' && hasNative() && !it.probed && !probeAsked.has(it.id)) {
      probeAsked.add(it.id);
      send({ type: 'probeItem', tabId, itemId: it.id }).catch(() => {});
    }
  }
}
function renderAll() {
  renderBanners();
  renderOutcome();
  renderStatus();
  renderPage();
  renderItems();
  renderEmpty();
  renderJobs();
}

async function init() {
  await Promise.all([initI18n(), applyTheme(), platformReady()]);
  applyI18n();
  $('#btnSettings').innerHTML = icon('sliders');
  $('#btnSettings').onclick = () => chrome.runtime.openOptionsPage();
  $('#btnSupport').insertAdjacentHTML('afterbegin', icon('heart'));
  $('#btnSupport').onclick = (e) => { e.preventDefault(); openSupport(); };
  $('#ver').textContent = 'v' + chrome.runtime.getManifest().version;
  const forced = Number(new URLSearchParams(location.search).get('tabId')); // tests: popup.html?tabId=123
  if (forced) tabId = forced;
  else {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    tabId = tab?.id;
  }
  await Promise.all([loadState(), loadJobs()]);
  setInterval(loadState, 2000);
  setInterval(loadJobs, 1000);
  chrome.storage.onChanged.addListener((c, area) => {
    if (area === 'local' && c.settings) location.reload();
  });
}

init();
