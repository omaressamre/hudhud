import { classify, itemId, extFor } from './lib/detect.js';
import { sniffMp4 } from './lib/mp4.js';
import { pairItems } from './lib/pair.js';
import { parseM3U8, qualityLabel } from './lib/hls.js';
import { DEFAULT_SETTINGS, findRule, buildBaseName, buildPath, buildRelDir, sanitizeSegment } from './lib/naming.js';
import { getEngine, engineStatus } from './engines/index.js';
import { removeHeaderRule, addHeaderRule, ensureOffscreen } from './engines/browser.js';
import { onNativeEvent, nativeInfo, request as nativeRequest, cookiesFor, setNativeConfig, disconnectNative } from './engines/native.js';
import { installer, IS_FIREFOX } from './lib/platform.js';
import { initI18n, t, resolveLang } from './lib/i18n.js';
import { latestReleaseApi } from './lib/config.js';
import { formatDiagnostics, browserName } from './lib/diagnostics.js';
import { friendlyError } from './lib/errors.js';
import { notesFor } from './lib/changelog.js';
import { fmtSize } from './lib/format.js';

let i18nReady = initI18n();
async function tt(key, ...a) { await i18nReady; return t(key, ...a); }

// ───────────── الإعدادات ─────────────
let settingsCache = null;
async function getSettings() {
  if (!settingsCache) {
    const { settings } = await chrome.storage.local.get('settings');
    settingsCache = { ...DEFAULT_SETTINGS, ...(settings || {}) };
    setNativeConfig({ maxConcurrent: settingsCache.maxConcurrent, autoUpdate: settingsCache.autoUpdate, lang: resolveLang(settingsCache.uiLang) });
  }
  return settingsCache;
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) {
    settingsCache = null;
    const o = changes.settings.oldValue || {}, n = changes.settings.newValue || {};
    if (o.uiLang !== n.uiLang) {
      i18nReady = initI18n(n.uiLang).then(buildMenus);
      chrome.runtime.sendMessage({ target: 'offscreen', type: 'lang' }).catch(() => {});
    }
  }
});

// ───────────── حالة كل تاب (محفوظة في storage.session عشان الـworker بيقفل) ─────────────
const locks = new Map();
function withTab(tabId, fn) {
  const prev = locks.get(tabId) || Promise.resolve();
  const next = prev
    .then(async () => {
      const key = 'tab:' + tabId;
      const cur = (await chrome.storage.session.get(key))[key] || { items: {}, children: [] };
      const changed = await fn(cur);
      if (changed !== false) {
        await chrome.storage.session.set({ [key]: cur });
        updateBadge(tabId, cur);
      }
      return cur;
    })
    .catch((e) => console.warn('[Hudhud]', e));
  locks.set(tabId, next);
  return next;
}

async function readTab(tabId) {
  const key = 'tab:' + tabId;
  return (await chrome.storage.session.get(key))[key] || { items: {}, children: [] };
}

function resetTab(tabId, pageUrl) {
  return withTab(tabId, (cur) => {
    cur.items = {};
    cur.children = [];
    cur.pageUrl = pageUrl;
  });
}

// Toolbar icon: crest folded (idle) when nothing was found, raised (active) when videos are on the page.
// The dark set is used when the system/browser prefers a dark theme (reported by pages and the popup).
let darkScheme = false;
const schemeReady = chrome.storage.session.get('scheme').then((r) => { darkScheme = !!r.scheme; }).catch(() => {});
function iconPaths(active) {
  const base = `icons/${active ? 'active' : 'idle'}-${darkScheme ? 'dark' : 'light'}-`;
  return { 16: base + '16.png', 32: base + '32.png', 48: base + '48.png', 128: base + '128.png' };
}
async function updateBadge(tabId, cur) {
  await schemeReady;
  const n = pairItems(Object.values(cur.items).filter((i) => !i.pending)).length;
  const active = n > 0;
  chrome.action.setBadgeText({ tabId, text: active ? String(n) : '' }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#EE6A4D' }).catch(() => {});
  chrome.action.setBadgeTextColor?.({ tabId, color: '#FFFFFF' })?.catch?.(() => {});
  chrome.action.setIcon({ tabId, path: iconPaths(active) }).catch(() => {});
}
async function setScheme(dark) {
  if (dark === darkScheme) return;
  darkScheme = dark;
  await chrome.storage.session.set({ scheme: dark });
  chrome.action.setIcon({ path: iconPaths(false) }).catch(() => {});
  const all = await chrome.storage.session.get(null);
  for (const [k, v] of Object.entries(all)) if (k.startsWith('tab:')) updateBadge(Number(k.slice(4)), v);
}
schemeReady.then(() => chrome.action.setIcon({ path: iconPaths(false) }).catch(() => {}));

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove('tab:' + tabId);
  locks.delete(tabId);
});

// ───────────── الاكتشاف من الشبكة ─────────────
chrome.webRequest.onBeforeRequest.addListener(
  (d) => { if (d.tabId >= 0 && d.frameId === 0) resetTab(d.tabId, d.url); },
  { urls: ['<all_urls>'], types: ['main_frame'] }
);

chrome.webRequest.onHeadersReceived.addListener(
  (d) => {
    if (d.tabId < 0 || d.statusCode >= 400) return;
    handleResponse(d).catch((e) => console.warn('[Hudhud]', e));
  },
  { urls: ['<all_urls>'], types: ['media', 'xmlhttprequest', 'object', 'other'] },
  ['responseHeaders']
);

async function handleResponse(d) {
  const settings = await getSettings();
  const c = classify(d.url, d.responseHeaders, { minSize: settings.minSizeMB * 1024 * 1024 });
  if (!c) return;
  await addItem(d.tabId, d.url, c, d.initiator || d.documentUrl);
}

async function addItem(tabId, rawUrl, c, origin) {
  const url = c.url || rawUrl;
  const id = itemId(url);
  let isNew = false;
  await withTab(tabId, (cur) => {
    if (cur.children.includes(url)) return false;
    const ex = cur.items[id];
    if (ex) {
      if (c.size && (!ex.size || c.size > ex.size)) { ex.size = c.size; return; }
      return false;
    }
    isNew = true;
    cur.items[id] = {
      id, url, kind: c.kind, mime: c.mime, size: c.size,
      ext: c.kind === 'direct' ? extFor(url, c.mime) : 'mp4',
      origin: origin || null,
      detectedAt: Date.now(),
      pending: c.kind !== 'direct' || !!c.split,
    };
    if (c.split) Object.assign(cur.items[id], { split: true, track: c.track, height: c.height, assetId: c.assetId });
  });
  if (isNew && c.split) inspectSplit(tabId, id, url);
  if (isNew && c.kind === 'hls') inspectHls(tabId, id, url);
  if (isNew && c.kind === 'dash') inspectDash(tabId, id, url);
}

async function fetchText(url) {
  const r = await fetch(url, { credentials: 'include', cache: 'force-cache' });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.text();
}

// فيسبوك/انستجرام: نقرا أول 64KB من الملف عشان نعرف صورة ولا صوت والأبعاد والمدة
async function inspectSplit(tabId, id, url) {
  let info = null;
  try {
    const sep = url.includes('?') ? '&' : '?';
    const r = await fetch(url + sep + 'bytestart=0&byteend=65535', { credentials: 'include' });
    if (r.ok) info = sniffMp4(await r.arrayBuffer());
  } catch {}
  await withTab(tabId, (cur) => {
    const it = cur.items[id];
    if (!it) return false;
    delete it.pending;
    if (!info) return;
    const v = info.tracks.find((t) => t.type === 'video');
    it.track = v ? 'video' : 'audio';
    if (v && v.height) it.height = v.height;
    if (v && v.width) it.width = v.width;
    if (info.duration) it.duration = info.duration;
    if (it.track === 'audio') { it.mime = 'audio/mp4'; it.ext = 'm4a'; }
  });
}

async function inspectHls(tabId, id, url) {
  let parsed = null, failed = false;
  try { parsed = parseM3U8(await fetchText(url), url); } catch { failed = true; }
  await withTab(tabId, (cur) => {
    const it = cur.items[id];
    if (!it) return false;
    delete it.pending;
    if (failed) { it.note = t('errQualities'); return; }
    if (!parsed) { delete cur.items[id]; return; }
    if (parsed.type === 'master') {
      it.variants = parsed.variants.map((v) => ({ url: v.url, height: v.height, bandwidth: v.bandwidth, label: qualityLabel(v) }));
      it.separateAudio = parsed.audio.length > 0;
      const kids = [...parsed.variants.map((v) => v.url), ...parsed.audio.map((a) => a.url)];
      cur.children.push(...kids);
      // لو جودة فرعية اتسجلت قبل الـmaster، نشيلها
      for (const [k, other] of Object.entries(cur.items)) if (k !== id && kids.includes(other.url)) delete cur.items[k];
    } else {
      if (cur.children.includes(url)) { delete cur.items[id]; return; }
      it.duration = parsed.duration;
      it.live = parsed.live;
      if (parsed.encrypted === 'SAMPLE-AES' || parsed.encrypted === 'SAMPLE-AES-CTR') it.drm = true;
      else if (parsed.encrypted) it.encrypted = parsed.encrypted;
    }
  });
}

async function inspectDash(tabId, id, url) {
  let text = null;
  try { text = await fetchText(url); } catch {}
  await withTab(tabId, (cur) => {
    const it = cur.items[id];
    if (!it) return false;
    delete it.pending;
    if (!text) { it.note = t('errQualities'); return; }
    if (/<ContentProtection/i.test(text)) it.drm = true;
    const heights = [...new Set([...text.matchAll(/\bheight="(\d+)"/g)].map((m) => Number(m[1])))].sort((a, b) => b - a);
    it.variants = heights.map((h) => ({ height: h, label: h + 'p' }));
    it.separateAudio = /mimeType="audio\//i.test(text);
    const dur = /mediaPresentationDuration="PT(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?"/.exec(text);
    if (dur) it.duration = Math.round((+dur[1] || 0) * 3600 + (+dur[2] || 0) * 60 + (+dur[3] || 0));
    it.live = /type="dynamic"/.test(text);
  });
}

// ───────────── عناصر <video> من الصفحة ─────────────
async function addElementUrls(tabId, urls) {
  const settings = await getSettings();
  for (const url of urls) {
    let c = classify(url, [], { minSize: settings.minSizeMB * 1024 * 1024 });
    if (!c) {
      // <video src> من غير امتداد واضح: نعتبره ملف مباشر
      if (/\.(ts|m4s)(\?|$)/i.test(url)) continue;
      c = { kind: 'direct', mime: 'video/mp4', size: null };
    }
    await addItem(tabId, url, c, null);
  }
}

// ───────────── معلومات الصفحة (للتسمية) ─────────────
async function pageMeta(tabId, selector) {
  try {
    const r = await chrome.tabs.sendMessage(tabId, { type: 'meta', selector: selector || null }, { frameId: 0 });
    if (r && r.title) return r;
  } catch {}
  try {
    const tab = await chrome.tabs.get(tabId);
    return { title: tab.title, pageUrl: tab.url, selector: '' };
  } catch {
    return { title: '', pageUrl: '', selector: '' };
  }
}

function sortItems(items) {
  const rank = { page: -1, hls: 0, dash: 1, direct: 2 };
  return items.sort((a, b) => (rank[a.kind] - rank[b.kind]) || ((b.size || 0) - (a.size || 0)) || a.detectedAt - b.detectedAt);
}

async function getState(tabId) {
  const [cur, settings, engines] = await Promise.all([readTab(tabId), getSettings(), engineStatus()]);
  const items = sortItems(pairItems(Object.values(cur.items).filter((i) => !i.pending)));
  const pageUrl = cur.pageUrl || (await chrome.tabs.get(tabId).catch(() => ({}))).url || '';
  const rule = findRule(settings.rules, pageUrl);
  const meta = await pageMeta(tabId, rule && rule.selector);
  for (const it of items) {
    const r = rule || findRule(settings.rules, it.url);
    const title = it.kind === 'page' ? (it.title || cleanTitle(meta.title)) : meta.title;
    it.suggestedName = buildBaseName({ title, pageUrl: meta.pageUrl || pageUrl, url: it.url, selector: meta.selector, quality: it.variants?.[0]?.label || '' }, settings, r);
    it.engines = engines.filter((e) => e.available && getEngine(e.id).canHandle(it)).map((e) => e.id);
  }
  return { items, engines, settings, pageUrl, notWeb: !/^https?:/i.test(pageUrl) };
}

// ───────────── يوتيوب: اكتشاف تلقائي ─────────────
// يوتيوب بيبعت الفيديو حتت صغيرة متشفّرة (googlevideo) مش ملف واحد، فمش بنلقطه من الشبكة.
// بدل كده: أي صفحة فيديو (watch / shorts / live / youtu.be) بتظهر كعنصر "page" بيتحمّل بـyt-dlp.

export function youtubeId(url) {
  try {
    const u = new URL(url);
    const h = u.hostname.replace(/^(www|m|music)\./, '');
    if (h === 'youtu.be') return /^[\w-]{6,}$/.test(u.pathname.slice(1)) ? u.pathname.slice(1) : null;
    if (h === 'youtube.com' || h === 'youtube-nocookie.com') {
      if (u.pathname === '/watch') return u.searchParams.get('v') || null;
      const m = /^\/(shorts|live|embed|v)\/([\w-]{6,})/.exec(u.pathname);
      if (m) return m[2];
    }
  } catch {}
  return null;
}

function cleanTitle(t) {
  return String(t || '').replace(/^\(\d+\)\s*/, '').replace(/\s*-\s*YouTube( Music)?$/i, '').trim();
}

async function syncPageItem(tabId, url, title) {
  const id = youtubeId(url);
  await withTab(tabId, (cur) => {
    let changed = false;
    for (const [k, it] of Object.entries(cur.items)) {
      if (it.kind === 'page' && ((it.ytId && it.ytId !== id) || (!it.ytId && it.pageUrl !== url))) { delete cur.items[k]; changed = true; }
    }
    if (id) {
      const key = 'yt-' + id;
      const ex = cur.items[key];
      if (!ex) {
        cur.items[key] = {
          id: key, kind: 'page', site: 'YouTube', url, ytId: id, ext: 'mp4', detectedAt: Date.now(),
          title: cleanTitle(title) || '', thumb: `https://i.ytimg.com/vi/${id}/mqdefault.jpg`, thumbTried: true,
          short: /\/shorts\//.test(url),
        };
        changed = true;
      } else if (title && !ex.probedTitle && cleanTitle(title) && ex.title !== cleanTitle(title)) {
        ex.title = cleanTitle(title);
        changed = true;
      }
    }
    return changed ? undefined : false;
  });
}

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.url || info.title || info.status === 'complete') {
    const url = info.url || tab.url;
    if (url && (youtubeId(url) || info.url)) syncPageItem(tabId, url, tab.title);
  }
});

// الجودات والعنوان من yt-dlp (بيتحفظوا عشان فتح الإضافة تاني يبقى فوري)
const probeCache = new Map(); // url → { at, data }
async function probeUrl(url) {
  const hit = probeCache.get(url);
  if (hit && Date.now() - hit.at < 30 * 60_000) return hit.data;
  const cookies = await cookiesFor([url]);
  const data = await nativeRequest('probe', { url, userAgent: navigator.userAgent, cookies }, 100_000);
  probeCache.set(url, { at: Date.now(), data });
  if (probeCache.size > 50) probeCache.delete(probeCache.keys().next().value);
  return data;
}

async function probeItem({ tabId, itemId: id }) {
  const cur = await readTab(tabId);
  const it = cur.items[id];
  if (!it || it.kind !== 'page') return null;
  let data = null, error = null;
  try { data = await probeUrl(it.url); } catch (e) { error = String(e.message || e); }
  await withTab(tabId, (c) => {
    const x = c.items[id];
    if (!x) return false;
    x.probed = true;
    if (error) { x.probeError = error; return; }
    delete x.probeError;
    x.variants = (data.heights || []).map((h) => ({ height: h, label: `${h}p`, size: data.sizes?.[h] || null }));
    x.audioSizes = data.audioSizes || null;
    x.duration = data.duration || x.duration;
    x.hasAudio = data.hasAudio;
    x.live = data.live;
    x.playlistCount = data.playlistCount || 0;
    if (data.title) { x.title = data.title; x.probedTitle = true; }
    if (data.uploader || data.channel) x.channel = data.uploader || data.channel;
  });
  return data;
}

// ───────────── الصور المصغّرة ─────────────
// بنطلّع frame حقيقي من الفيديو نفسه (offscreen)، ولو ما نفعش: poster أو og:image بتاع الصفحة.
const thumbRunning = new Set();
async function makeThumbs({ tabId }) {
  if (thumbRunning.has(tabId)) return;
  thumbRunning.add(tabId);
  try {
    const cur = await readTab(tabId);
    const items = pairItems(Object.values(cur.items).filter((i) => !i.pending)).filter((i) => !i.thumb && !i.thumbTried && !i.drm).slice(0, 10);
    if (!items.length) return;
    await withTab(tabId, (c) => { for (const it of items) if (c.items[it.id]) c.items[it.id].thumbTried = true; });
    const meta = await pageMeta(tabId);
    const pageUrl = cur.pageUrl || meta.pageUrl || '';
    await ensureOffscreen();
    const jobKey = `thumbs-${tabId}`;
    await addHeaderRule(jobKey, pageUrl);
    const queue = [...items];
    const worker = async () => {
      while (queue.length) {
        const it = queue.shift();
        let thumb = null;
        if (it.kind !== 'dash' && !it.audioOnly) {
          try {
            thumb = await chrome.runtime.sendMessage({
              target: 'offscreen', type: 'thumb',
              item: { kind: it.kind, url: it.url, mime: it.mime, split: !!it.split, variants: it.variants || null },
            });
          } catch {}
        }
        if (!thumb && meta.image) thumb = meta.image;
        if (thumb) await withTab(tabId, (c) => { if (c.items[it.id]) c.items[it.id].thumb = thumb; else return false; });
      }
    };
    await Promise.all([worker(), worker()]);
    removeHeaderRule(jobKey);
  } catch (e) {
    console.warn('[Hudhud] thumbs', e);
  } finally {
    thumbRunning.delete(tabId);
  }
}

// ───────────── سجل التحميلات (بقفل عشان الكتابات ما تدوسش على بعض) ─────────────
let jobsChain = Promise.resolve();
function updateJobs(fn) {
  jobsChain = jobsChain
    .then(async () => {
      const { jobs = [] } = await chrome.storage.local.get('jobs');
      const out = (await fn(jobs)) || jobs;
      const settings = await getSettings();
      const keep = settings.history ? out : out.filter((j) => j.state === 'in_progress' || Date.now() - (j.endedAt || 0) < 60_000);
      await chrome.storage.local.set({ jobs: keep.slice(0, 200) });
    })
    .catch((e) => console.warn('[Hudhud] jobs', e));
  return jobsChain;
}

function finishJob(j, state, extra = {}) {
  Object.assign(j, extra, { state, endedAt: Date.now() });
  if (state === 'complete') j.percent = 100;
  notify(j);
}

// ───────────── الإشعارات ─────────────
function notify(j) {
  if (j.state === 'complete') bumpStats();
  if (settingsCache && settingsCache.notifications === false) return;
  if (j.error === 'CANCELED' || j.error === 'USER_CANCELED') return;
  const ok = j.state === 'complete';
  const name = String(j.file || j.path || '').split(/[\\/]/).pop();
  const opts = {
    type: 'basic',
    iconUrl: ok ? 'icons/notify-done.png' : 'icons/notify-error.png',
    title: ok ? t('notifDone') : t('notifFailed'),
    message: ok ? (j.files > 1 ? `${name} (${t('filesN', j.files)})` : name) : `${name}\n${friendlyError(j.error, t, installer())}`.slice(0, 250),
    priority: 0,
  };
  // Firefox rejects the buttons key (even when undefined), and throws synchronously
  if (ok && !IS_FIREFOX) opts.buttons = [{ title: t('notifOpen') }];
  try { chrome.notifications.create(j.jobId, opts).catch(() => {}); } catch (e) { console.warn('[Hudhud] notification', e); }
}
async function bumpStats() {
  const { stats = {} } = await chrome.storage.local.get('stats');
  stats.completed = (stats.completed || 0) + 1;
  await chrome.storage.local.set({ stats });
}

function toast(title, message) {
  chrome.notifications.create('', { type: 'basic', iconUrl: 'icons/notify-downloading.png', title, message, priority: 0 }).catch(() => {});
}
chrome.notifications.onButtonClicked?.addListener((id) => {
  revealJob({ jobId: id }).catch(() => {});
  chrome.notifications.clear(id);
});

chrome.notifications.onClicked.addListener((id) => {
  revealJob({ jobId: id }).catch(() => {});
  chrome.notifications.clear(id);
});

// ───────────── قايمة كليك يمين ─────────────
async function buildMenus() {
  await i18nReady;
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'hh-media', title: t('ctxMedia'), contexts: ['video', 'audio'] });
    chrome.contextMenus.create({ id: 'hh-link', title: t('ctxLink'), contexts: ['link'] });
    chrome.contextMenus.create({ id: 'hh-page', title: t('ctxPage'), contexts: ['page'] });
    chrome.contextMenus.create({ id: 'hh-page-mp3', title: t('ctxPageMp3'), contexts: ['page'] });
  });
}
chrome.runtime.onInstalled.addListener((details) => {
  buildMenus();
  if (details.reason === 'install') chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html') });
  checkHelperUpdate(true);
});
chrome.runtime.onStartup.addListener(() => { buildMenus(); checkHelperUpdate(); reconcileJobs().catch(() => {}); });

chrome.contextMenus.onClicked.addListener((info, tab) => {
  contextDownload(info, tab).catch((e) => toast(t('brand'), String(e.message || e)));
});

async function contextDownload(info, tab) {
  const tabId = tab?.id;
  const hasNative = !!(await nativeInfo());
  const needNative = () => {
    if (!hasNative) throw new Error(t('errContextNeedsHelper', installer()));
  };
  if (info.menuItemId === 'hh-media') {
    const src = info.srcUrl || '';
    if (/^https?:/i.test(src)) {
      const c = classify(src, [], { minSize: 0 }) || { kind: 'direct', mime: 'video/mp4' };
      const item = { id: itemId(src), url: c.url || src, kind: c.kind, ext: c.kind === 'direct' ? extFor(src, c.mime) : 'mp4', split: c.split, track: c.track };
      const meta = await pageMeta(tabId);
      const settings = await getSettings();
      const rule = findRule(settings.rules, info.pageUrl);
      const baseName = buildBaseName({ title: meta.title, pageUrl: info.pageUrl, url: src, selector: meta.selector }, settings, rule);
      const engineId = item.kind === 'direct' ? (hasNative && settings.defaultEngine === 'native' ? 'native' : 'browser') : (hasNative ? 'native' : 'browser');
      await startDownload({ tabId, item, baseName, engineId, pageUrl: info.pageUrl });
    } else {
      // blob: (MSE) → نخلّي yt-dlp يجيب الفيديو من لينك الصفحة
      needNative();
      await downloadPage({ tabId, baseName: '', url: info.pageUrl });
    }
  } else if (info.menuItemId === 'hh-link') {
    needNative();
    await downloadPage({ tabId, baseName: '', url: info.linkUrl });
  } else if (info.menuItemId === 'hh-page' || info.menuItemId === 'hh-page-mp3') {
    needNative();
    await downloadPage({ tabId, baseName: '', url: info.pageUrl, audioFormat: info.menuItemId === 'hh-page-mp3' ? 'mp3' : '' });
  }
  toast(t('brand'), t('toastStarted'));
}

// ───────────── التحميل ─────────────
async function startDownload({ tabId, item, baseName, engineId, variant = 0, audioOnly = false, audioFormat = '', playlist = false, pageUrl, expectBytes = 0 }) {
  const settings = await getSettings();
  await i18nReady;
  if (item.drm) throw new Error(t('drmBlocked'));
  const engine = getEngine(engineId || settings.defaultEngine) || getEngine('browser');
  if (!engine.canHandle(item)) {
    throw new Error(item.kind === 'direct' ? t('errEngineUnavailable') : t('errNeedsHelper', installer()));
  }
  if (!(await engine.available())) throw new Error(t('errEngineOffline', engine.label));

  const rule = findRule(settings.rules, pageUrl) || findRule(settings.rules, item.url);
  // اسم فاضي مع yt-dlp = يسمّي بعنوان الفيديو
  const titleMode = engine.id === 'native' && item.kind === 'page' && !String(baseName || '').trim();
  const name = titleMode ? '' : (sanitizeSegment(baseName) || 'video');
  const relDir = buildRelDir(settings, rule);
  // not enough free space for the expected size: say so now instead of failing halfway
  if (engine.id === 'native' && expectBytes > 0) {
    let free = 0;
    try { free = (await nativeRequest('space', { baseDir: settings.nativeDir || '', relDir }))?.free || 0; } catch {} // older helper: no check
    if (free > 0 && free < expectBytes * 1.1) throw new Error(t('errNoSpace', fmtSize(expectBytes), fmtSize(free)));
  }
  const ext = engine.id === 'native'
    ? (audioFormat === 'mp3' ? 'mp3' : (audioOnly || audioFormat === 'm4a' || item.audioOnly) ? 'm4a' : 'mp4')
    : item.ext;
  const shownName = name || sanitizeSegment(item.title || '') || (playlist ? 'Playlist' : t('videoTitle'));
  const path = buildPath(shownName, ext, settings, rule);
  const jobId = crypto.randomUUID();

  const job = {
    jobId, engine: engine.id, downloadId: null, path, title: name, autoName: titleMode, url: item.url, pageUrl,
    kind: item.kind, playlist,
    mode: engine.id === 'browser' && (item.kind === 'hls' || (item.split && item.audio)) ? 'hls' : undefined,
    quality: audioFormat ? audioFormat.toUpperCase() : audioOnly ? 'AUDIO' : (item.variants?.[variant]?.label || ''),
    req: { tabId, item, baseName, engineId: engine.id, variant, audioOnly, audioFormat, playlist, pageUrl },
    noAudio: false,
    state: 'in_progress', percent: 0, startedAt: Date.now(),
  };
  await updateJobs((jobs) => [job, ...jobs]);

  try {
    const res = await engine.download(item, { jobId, path, relDir, baseName: name, variant, pageUrl, settings, audioOnly, audioFormat, playlist });
    if (res.queued) await updateJobs((jobs) => { const j = jobs.find((x) => x.jobId === jobId); if (j) j.queued = true; });
    if (res.downloadId != null) {
      const [d] = await chrome.downloads.search({ id: res.downloadId });
      await updateJobs((jobs) => {
        const j = jobs.find((x) => x.jobId === jobId);
        if (!j) return;
        j.downloadId = res.downloadId;
        const early = earlyDownloads.get(res.downloadId);
        earlyDownloads.delete(res.downloadId);
        const state = early?.state && early.state !== 'in_progress' ? early.state : d?.state;
        if (state && state !== 'in_progress') finishJob(j, state, { file: early?.file || d?.filename, error: early?.error || d?.error });
      });
    }
  } catch (e) {
    await updateJobs((jobs) => jobs.filter((x) => x.jobId !== jobId));
    throw e;
  }
  return job;
}

async function downloadDetected({ tabId, itemId: id, baseName, engine, variant }) {
  const cur = await readTab(tabId);
  const item = pairItems(Object.values(cur.items).filter((i) => !i.pending)).find((i) => i.id === id);
  if (!item) throw new Error(t('errGone'));
  const pageUrl = cur.pageUrl || (await chrome.tabs.get(tabId).catch(() => ({}))).url || '';
  return startDownload({ tabId, item, baseName, engineId: engine, variant, pageUrl });
}

// تحميل الصفحة كلها بـyt-dlp (يوتيوب ومواقع كتير)
async function tabUrl(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!/^https?:/i.test(tab.url || '')) throw new Error(t('errNotWeb'));
  return tab.url;
}

async function probePage({ tabId }) {
  const url = await tabUrl(tabId);
  const cookies = await cookiesFor([url]);
  const r = await nativeRequest('probe', { url, userAgent: navigator.userAgent, cookies }, 100_000);
  const settings = await getSettings();
  const rule = findRule(settings.rules, url);
  const meta = await pageMeta(tabId, rule && rule.selector);
  const suggestedName = buildBaseName({ title: r.title || meta.title, pageUrl: url, url, selector: meta.selector, quality: r.heights?.[0] ? r.heights[0] + 'p' : '' }, settings, rule);
  // keep the result as a "page" item so the popup shows it (and still has it next time it opens)
  if (!youtubeId(url)) {
    await withTab(tabId, (cur) => {
      const key = 'page-' + itemId(url);
      cur.items[key] = {
        id: key, kind: 'page', site: r.extractor || new URL(url).hostname.replace(/^www\./, ''), url, pageUrl: url, ext: 'mp4', detectedAt: Date.now(),
        title: r.isPlaylist ? (r.playlistTitle || r.title || '') : (r.title || ''), thumb: /^https:/.test(r.thumbnail || '') ? r.thumbnail : null, thumbTried: true,
        duration: r.duration, live: r.live, hasAudio: r.hasAudio, isPlaylist: !!r.isPlaylist, playlistCount: r.playlistCount || 0,
        variants: (r.heights || []).map((h) => ({ height: h, label: `${h}p`, size: r.sizes?.[h] || null })), audioSizes: r.audioSizes || null, probed: true, probedTitle: true, channel: r.uploader || r.channel || '',
      };
    });
  }
  return { ...r, suggestedName, pageUrl: url };
}

async function downloadPage({ tabId, baseName, title = '', expectBytes = 0, height = 0, audioOnly = false, audioFormat = '', playlist = false, url: forcedUrl }) {
  const url = forcedUrl || await tabUrl(tabId);
  await i18nReady;
  // the title to show in the list until yt-dlp reports it: from the popup, or from an earlier probe of this URL
  const known = title || probeCache.get(url)?.data?.title || '';
  const item = { kind: 'page', url, title: known, variants: [{ height, label: height ? height + 'p' : t('bestQuality') }] };
  return startDownload({ tabId, item, baseName, engineId: 'native', variant: 0, audioOnly, audioFormat, playlist, pageUrl: url, expectBytes });
}

// أحداث البرنامج المساعد → سجل التحميلات
onNativeEvent((m) => updateJobs((jobs) => {
  const j = jobs.find((x) => x.jobId === m.jobId);
  if (!j) return;
  switch (m.event) {
    case 'queued': j.queued = true; break;
    case 'started': j.dir = m.dir; j.queued = false; break;
    case 'progress':
      Object.assign(j, { percent: m.percent, speed: m.speed, eta: m.eta, downloaded: m.downloaded, total: m.total, part: m.part, item: m.item, items: m.items, queued: false });
      break;
    case 'title':
      // yt-dlp names the file after the video: show that name while it downloads (not for playlists)
      if (j.autoName && !j.playlist && m.title) {
        const clean = sanitizeSegment(m.title);
        if (clean) j.path = j.path.replace(/[^/]*(\.[^./]+)$/, (_, ext) => clean + ext);
      }
      break;
    case 'done': finishJob(j, 'complete', { file: m.file || j.file, files: m.files }); break;
    case 'error': finishJob(j, 'interrupted', { error: m.message }); break;
    case 'canceled': finishJob(j, 'interrupted', { error: 'CANCELED' }); break;
  }
}));

// A small file can finish before the job learns its downloadId (seen in Firefox):
// remember what happened to unknown downloads and apply it when the id arrives.
const earlyDownloads = new Map();
function applyEarlyDownload(j) {
  const e = earlyDownloads.get(j.downloadId);
  if (!e || !e.state || e.state === 'in_progress') return;
  earlyDownloads.delete(j.downloadId);
  finishJob(j, e.state, { file: e.file, error: e.error });
  if (j.mode === 'hls') {
    chrome.runtime.sendMessage({ target: 'offscreen', type: 'hls-cleanup', jobId: j.jobId }).catch(() => {});
    removeHeaderRule(j.jobId);
  }
}

chrome.downloads.onChanged.addListener((delta) => {
  if (!delta.state && !delta.error && !delta.filename) return;
  updateJobs(async (jobs) => {
    const j = jobs.find((x) => x.downloadId === delta.id);
    if (!j) {
      const e = earlyDownloads.get(delta.id) || {};
      if (delta.filename) e.file = delta.filename.current;
      if (delta.error) e.error = delta.error.current;
      if (delta.state) e.state = delta.state.current;
      earlyDownloads.set(delta.id, e);
      setTimeout(() => earlyDownloads.delete(delta.id), 60_000);
      return;
    }
    if (delta.filename) j.file = delta.filename.current;
    if (!j.file && delta.state?.current === 'complete') {
      const [d] = await chrome.downloads.search({ id: delta.id });
      if (d) j.file = d.filename;
    }
    if (delta.error) j.error = delta.error.current;
    if (delta.state && delta.state.current !== 'in_progress') {
      finishJob(j, delta.state.current);
      if (j.mode === 'hls') {
        chrome.runtime.sendMessage({ target: 'offscreen', type: 'hls-cleanup', jobId: j.jobId }).catch(() => {});
        removeHeaderRule(j.jobId);
      }
    }
  });
});

// ───────────── HLS جوه المتصفح (رسائل من offscreen) ─────────────
async function onHlsMessage(m) {
  if (m.type === 'hls-progress') {
    return updateJobs((jobs) => {
      const j = jobs.find((x) => x.jobId === m.jobId);
      if (j && j.state === 'in_progress') Object.assign(j, { percent: m.percent, speed: m.speed, eta: m.eta, downloaded: m.downloaded, total: m.total });
    });
  }
  if (m.type === 'hls-error' && m.code === 'merge-failed' && m.fallbackUrl) {
    // الدمج ما نفعش: نحمّل الصورة لوحدها بدل ما التحميل يفشل خالص
    removeHeaderRule(m.jobId);
    const { jobs = [] } = await chrome.storage.local.get('jobs');
    const j = jobs.find((x) => x.jobId === m.jobId);
    if (!j) return;
    try {
      const downloadId = await chrome.downloads.download({ url: m.fallbackUrl, filename: j.path, conflictAction: 'uniquify', saveAs: false });
      return updateJobs((list) => {
        const x = list.find((y) => y.jobId === m.jobId);
        if (x) { Object.assign(x, { downloadId, mode: undefined, noAudio: true, note: t('errMergeFailed', m.message), percent: 0, speed: undefined }); applyEarlyDownload(x); }
      });
    } catch (e) {
      m = { ...m, message: String(e.message || e) };
    }
  }
  if (m.type === 'hls-error') {
    removeHeaderRule(m.jobId);
    return updateJobs((jobs) => {
      const j = jobs.find((x) => x.jobId === m.jobId);
      if (j) finishJob(j, 'interrupted', { error: m.message, needHelper: m.code === 'need-helper' || m.code === 'live' });
    });
  }
  if (m.type === 'hls-ready') {
    removeHeaderRule(m.jobId);
    const { jobs = [] } = await chrome.storage.local.get('jobs');
    const j = jobs.find((x) => x.jobId === m.jobId);
    if (!j) return chrome.runtime.sendMessage({ target: 'offscreen', type: 'hls-cleanup', jobId: m.jobId }).catch(() => {});
    const path = j.path.replace(/\.[^./]+$/, '.' + m.ext);
    try {
      const downloadId = await chrome.downloads.download({ url: m.url, filename: path, conflictAction: 'uniquify', saveAs: false });
      await updateJobs((list) => {
        const x = list.find((y) => y.jobId === m.jobId);
        if (x) { Object.assign(x, { downloadId, path, percent: 100, speed: '', eta: '', note: m.note || '', converted: !!m.converted }); applyEarlyDownload(x); }
      });
    } catch (e) {
      chrome.runtime.sendMessage({ target: 'offscreen', type: 'hls-cleanup', jobId: m.jobId }).catch(() => {});
      await updateJobs((list) => {
        const x = list.find((y) => y.jobId === m.jobId);
        if (x) finishJob(x, 'interrupted', { error: String(e.message || e) });
      });
    }
  }
}

async function retryJob({ jobId, engine }) {
  const { jobs = [] } = await chrome.storage.local.get('jobs');
  const j = jobs.find((x) => x.jobId === jobId);
  if (!j?.req) throw new Error(t('errJobNotFound'));
  const req = { ...j.req, engineId: engine || j.req.engineId };
  await updateJobs((list) => list.filter((x) => x.jobId !== jobId));
  return startDownload(req);
}

// Helper update check: compare the installed helper with the latest GitHub release (at most twice a day).
/** true when Chrome runs this extension from the Hudhud install folder, so the helper can update it in place */
async function isManagedInstall(info) {
  if (!info?.installId) return false;
  try {
    const r = await fetch(chrome.runtime.getURL('hudhud-install.json'), { cache: 'no-store' });
    return r.ok && (await r.json()).id === info.installId;
  } catch { return false; }
}

async function checkHelperUpdate(force = false) {
  try {
    const { helperUpdateAt = 0 } = await chrome.storage.local.get('helperUpdateAt');
    if (!force && Date.now() - helperUpdateAt < 12 * 3600_000) return null;
    let info = await nativeInfo(true);
    // the first ping after the browser starts can be slow (yt-dlp/antivirus); try once more
    if (!info) { await new Promise((r) => setTimeout(r, 4000)); info = await nativeInfo(true); }
    await chrome.storage.local.set({ helperUpdateAt: Date.now() });
    // the older of the extension and the helper decides (they ship together with one version).
    // Firefox updates the extension itself, so there only the helper counts.
    const ext = chrome.runtime.getManifest().version;
    if (IS_FIREFOX && !info?.version) return null;
    const current = IS_FIREFOX ? info.version : info?.version && cmpVer(info.version, ext) < 0 ? info.version : ext;
    const r = await fetch(latestReleaseApi(), { headers: { Accept: 'application/vnd.github+json' } });
    if (!r.ok) return null;
    const rel = await r.json();
    const latest = String(rel.tag_name || '').replace(/^v/, '');
    const newer = latest && cmpVer(latest, current) > 0;
    const managed = newer && (IS_FIREFOX || (await isManagedInstall(info)));
    // what's new: the release notes (CHANGELOG section) in Arabic and English
    const notes = { ar: notesFor(rel.body, 'ar'), en: notesFor(rel.body, 'en'), url: rel.html_url || '' };
    await chrome.storage.local.set({ helperUpdate: newer ? { latest, current, managed, helperOnly: IS_FIREFOX, extDir: info?.extDir || '', notes } : null });
    return newer ? latest : ''; // '' = up to date, null = couldn't check
  } catch { return null; }
}

/** is Chrome running Hudhud from the installer's folder? (Firefox: always fine) */
async function installStatus() {
  if (IS_FIREFOX) return { managed: true, extDir: '' };
  const info = (await nativeInfo()) || (await nativeInfo(true));
  return { managed: await isManagedInstall(info), extDir: info?.extDir || '' };
}

/** re-check whether one-click update is possible (the popup asks when the banner offers a download) */
async function refreshManaged() {
  const { helperUpdate: up } = await chrome.storage.local.get('helperUpdate');
  if (!up || up.managed) return up;
  const info = (await nativeInfo()) || (await nativeInfo(true));
  const next = { ...up, managed: IS_FIREFOX ? !!info : await isManagedInstall(info), extDir: info?.extDir || '' };
  await chrome.storage.local.set({ helperUpdate: next });
  return next;
}

/** "Copy diagnostics": versions, OS, browser, managed or not, last error. No URLs, titles or paths. */
async function diagnostics() {
  const [settings, plat, info, { jobs = [] }] = await Promise.all([
    getSettings(),
    chrome.runtime.getPlatformInfo().catch(() => ({})),
    nativeInfo(true).catch(() => null),
    chrome.storage.local.get('jobs'),
  ]);
  let firefox = null;
  if (IS_FIREFOX) firefox = (await browser.runtime.getBrowserInfo().catch(() => ({}))).version || '?';
  const isBrave = !!(navigator.brave && (await navigator.brave.isBrave?.().catch(() => false)));
  const brands = navigator.userAgentData?.brands || [];
  const last = jobs.filter((j) => j.state === 'interrupted' && j.error && j.error !== 'CANCELED' && j.error !== 'USER_CANCELED')
    .sort((a, b) => (b.endedAt || 0) - (a.endedAt || 0))[0];
  let host = '';
  try { host = new URL(last?.pageUrl || last?.url || '').hostname; } catch {}
  return formatDiagnostics({
    extVersion: chrome.runtime.getManifest().version,
    browser: browserName({ ua: navigator.userAgent, brands, isBrave, firefox }),
    os: plat.os || '?', arch: plat.arch || '',
    uiLang: settings.uiLang,
    helper: info,
    managed: IS_FIREFOX ? true : await isManagedInstall(info),
    firefox: IS_FIREFOX,
    settings: { defaultEngine: settings.defaultEngine, maxConcurrent: settings.maxConcurrent, hlsToMp4: settings.hlsToMp4 },
    lastError: last ? { error: last.error, engine: last.engine, kind: last.kind, host, at: last.endedAt } : null,
  });
}

/** one-click update: the helper replaces itself and the extension folder, then we reload */
async function selfUpdate() {
  const { jobs = [] } = await chrome.storage.local.get('jobs');
  await reconcileJobs().catch(() => {});
  const { jobs: now = [] } = await chrome.storage.local.get('jobs');
  if (now.some((j) => j.state === 'in_progress')) throw new Error(t('updateBusy'));
  const info = await nativeInfo(true);
  if (IS_FIREFOX) {
    // Firefox keeps the extension up to date; the helper replaces only itself
    const res = await nativeRequest('selfUpdate', { helperOnly: true }, 15 * 60_000);
    disconnectNative(); // the next request starts the new helper
    await chrome.storage.local.set({ helperUpdate: null });
    return { ...res, helperOnly: true };
  }
  if (!(await isManagedInstall(info))) throw new Error(t('updateNotManaged'));
  const res = await nativeRequest('selfUpdate', {}, 15 * 60_000);
  const { helperUpdate: was } = await chrome.storage.local.get('helperUpdate');
  await chrome.storage.local.set({ helperUpdate: null, justUpdated: res?.version || '', justUpdatedNotes: was?.notes || null });
  setTimeout(() => chrome.runtime.reload(), 400);
  return res;
}
function cmpVer(a, b) {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d; }
  return 0;
}

async function cancelJob({ jobId }) {
  const { jobs = [] } = await chrome.storage.local.get('jobs');
  const j = jobs.find((x) => x.jobId === jobId);
  if (!j) return;
  try {
    if (j.engine === 'native') await nativeRequest('cancel', { jobId }, 8000);
    else if (j.downloadId != null) await chrome.downloads.cancel(j.downloadId);
    else if (j.mode === 'hls') await chrome.runtime.sendMessage({ target: 'offscreen', type: 'hls-cancel', jobId });
  } catch (e) { console.warn('[Hudhud] cancel', e); }
  // Cancel always clears the entry, even when nothing was running any more (helper or browser restarted)
  await updateJobs((list) => { const x = list.find((y) => y.jobId === jobId); if (x?.state === 'in_progress') finishJob(x, 'interrupted', { error: 'CANCELED' }); });
}

/**
 * Entries still "in progress" whose download no longer exists anywhere (the browser or the helper
 * restarted, the offscreen page was closed…) are marked stopped, so they can be retried and don't
 * block updates. Runs at startup, when the popup opens and before a self-update.
 */
async function reconcileJobs() {
  const { jobs = [] } = await chrome.storage.local.get('jobs');
  const old = (j) => j.state === 'in_progress' && Date.now() - (j.startedAt || 0) > 15_000;
  const cands = jobs.filter(old);
  if (!cands.length) return;
  let nativeIds = null; // null = couldn't ask (old helper or not running): leave helper jobs alone
  if (cands.some((j) => j.engine === 'native')) {
    try { nativeIds = new Set((await nativeRequest('active', {}, 8000))?.jobs || []); } catch {}
  }
  let offscreen = true;
  if (!IS_FIREFOX && cands.some((j) => j.mode === 'hls')) offscreen = await chrome.offscreen.hasDocument().catch(() => true);
  const dl = {};
  for (const j of cands) if (j.engine !== 'native' && j.downloadId != null) dl[j.jobId] = (await chrome.downloads.search({ id: j.downloadId }).catch(() => []))[0] || null;
  await updateJobs((list) => {
    for (const j of list) {
      if (!old(j)) continue;
      if (j.engine === 'native') {
        if (nativeIds && !nativeIds.has(j.jobId)) finishJob(j, 'interrupted', { error: t('jobLost') });
      } else if (j.downloadId != null) {
        const d = dl[j.jobId];
        if (!d) finishJob(j, 'interrupted', { error: t('jobLost') });
        else if (d.state === 'complete') finishJob(j, 'complete', { file: d.filename });
        else if (d.state === 'interrupted') finishJob(j, 'interrupted', { error: d.error || t('jobLost') });
      } else if (j.mode === 'hls' ? !offscreen : Date.now() - (j.startedAt || 0) > 120_000) {
        finishJob(j, 'interrupted', { error: t('jobLost') });
      }
    }
  });
}

async function openJob({ jobId }) {
  const { jobs = [] } = await chrome.storage.local.get('jobs');
  const j = jobs.find((x) => x.jobId === jobId);
  if (!j?.file) throw new Error(t('errJobNotFound'));
  await nativeRequest('openFile', { file: j.file });
}

async function revealJob({ jobId }) {
  const { jobs = [] } = await chrome.storage.local.get('jobs');
  const j = jobs.find((x) => x.jobId === jobId);
  if (!j) throw new Error(t('errJobNotFound'));
  if (j.engine === 'native') await nativeRequest('reveal', { file: j.file });
  else chrome.downloads.show(j.downloadId);
}

async function openFolder() {
  const settings = await getSettings();
  if (settings.defaultEngine === 'native' && (await nativeInfo())) {
    await nativeRequest('openDir', { baseDir: settings.nativeDir || '' });
  } else {
    chrome.downloads.showDefaultFolder();
  }
}

// ───────────── الرسائل ─────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const reply = (p) => Promise.resolve()
    .then(() => p)
    .then((data) => sendResponse({ ok: true, data }), (e) => sendResponse({ ok: false, error: String(e?.message || e) }));
  if (msg?.target === 'offscreen') return false;
  // messages from our content script may leave tabId out: it's the sender's tab
  if (msg && typeof msg === 'object' && msg.tabId == null && sender.tab) msg.tabId = sender.tab.id;
  if (typeof msg?.type === 'string' && msg.type.startsWith('hls-')) { onHlsMessage(msg); return false; }
  switch (msg?.type) {
    case 'elements':
      if (sender.tab) addElementUrls(sender.tab.id, msg.urls || []);
      return false;
    case 'getState': reply(getState(msg.tabId)); return true;
    case 'download': reply(downloadDetected(msg)); return true;
    case 'probePage': reply(probePage(msg)); return true;
    case 'probeItem': reply(probeItem(msg)); return true;
    case 'makeThumbs': reply(makeThumbs(msg)); return true;
    case 'downloadPage': reply(downloadPage(msg)); return true;
    case 'cancelJob': reply(cancelJob(msg)); return true;
    case 'revealJob': reply(revealJob(msg)); return true;
    case 'openJob': reply(openJob(msg)); return true;
    case 'reconcileJobs': reply(reconcileJobs()); return true;
    case 'openFolder': reply(openFolder()); return true;
    case 'engines': reply(engineStatus()); return true;
    case 'nativeInfo': reply(nativeInfo(true)); return true;
    case 'chooseFolder': reply(nativeRequest('chooseFolder', {}, 600_000)); return true;
    case 'updateYtdlp': reply(nativeRequest('update', {}, 200_000)); return true;
    case 'retryJob': reply(retryJob(msg)); return true;
    case 'removeJob': reply(updateJobs((jobs) => jobs.filter((x) => x.jobId !== msg.jobId))); return true;
    case 'clearJobs': reply(updateJobs((jobs) => jobs.filter((x) => x.state === 'in_progress'))); return true;
    case 'scheme': setScheme(!!msg.dark); return false;
    case 'uiLang': reply(getSettings().then((s) => s.uiLang || 'auto')); return true;
    case 'checkUpdate': reply(checkHelperUpdate(true)); return true;
    case 'selfUpdate': reply(selfUpdate()); return true;
    case 'refreshManaged': reply(refreshManaged()); return true;
    case 'installStatus': reply(installStatus()); return true;
    case 'diagnostics': reply(diagnostics()); return true;
  }
  return false;
});

// للاختبار والتشخيص من DevTools بتاع الـservice worker
globalThis.__hudhud = { contextDownload, getState, startDownload };
