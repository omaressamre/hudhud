// محرك البرنامج المساعد: hudhud-helper (Windows / macOS / Linux) بيشغّل yt-dlp و ffmpeg
// عن طريق Native Messaging. لو البرنامج مش متسطّب، المحرك ده بيختفي من الواجهة.
//
// البروتوكول (JSON):
//   extension → host : { id, cmd: "ping" | "download" | "cancel" | "probe" | "reveal" | "openDir" | "chooseFolder" | "update", ... }
//   host → extension : { id, ok, ... }                                  رد على الأمر
//                      { jobId, event: "started"|"progress"|"done"|"error"|"canceled", ... }
import { installer } from '../lib/platform.js';
import { t } from '../lib/i18n.js';

export const NATIVE_HOST = 'com.hudhud.helper';

let port = null;
let seq = 0;
let idleTimer = null;
const pending = new Map();
const activeJobs = new Set();
let eventHandler = null;
let infoCache = { at: 0, info: null };
let nativeConfig = null;
let configSent = false;

/** إعدادات بتتبعت للبرنامج المساعد (عدد التحميلات في نفس الوقت، التحديث التلقائي) */
export function setNativeConfig(cfg) {
  nativeConfig = cfg;
  configSent = false;
  if (port) sendConfig();
}

function sendConfig() {
  if (!nativeConfig || configSent) return;
  configSent = true;
  request('config', nativeConfig).catch(() => { configSent = false; });
}

/** الـbackground بيسجّل هنا عشان يستقبل أحداث التحميل (تقدم / خلص / خطأ) */
export function onNativeEvent(fn) { eventHandler = fn; }

function friendly(err) {
  if (/not found|not exist/i.test(err)) return t('nativeMissing', installer());
  if (/forbidden/i.test(err)) return t('nativeForbidden');
  if (/exited/i.test(err)) return t('nativeCrashed');
  return err;
}

function connect() {
  if (port) return port;
  const p = chrome.runtime.connectNative(NATIVE_HOST);
  port = p;
  configSent = false;
  p.onMessage.addListener((msg) => {
    if (msg && msg.id && pending.has(msg.id)) {
      const { resolve, reject, timer } = pending.get(msg.id);
      pending.delete(msg.id);
      clearTimeout(timer);
      if (msg.ok) resolve(msg); else reject(new Error(msg.error || t('nativeError')));
    } else if (msg && msg.jobId && msg.event) {
      if (['done', 'error', 'canceled'].includes(msg.event)) activeJobs.delete(msg.jobId);
      try { eventHandler && eventHandler(msg); } catch (e) { console.warn(e); }
    }
    scheduleIdle();
  });
  p.onDisconnect.addListener(() => {
    const err = friendly(chrome.runtime.lastError?.message || t('nativeDisconnected'));
    if (port === p) port = null;
    for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(new Error(err)); }
    pending.clear();
    for (const jobId of activeJobs) {
      eventHandler && eventHandler({ jobId, event: 'error', message: t('nativeLost') });
    }
    activeJobs.clear();
    infoCache = { at: 0, info: null };
  });
  return p;
}

// نقفل الاتصال لو مفيش تحميلات ولا طلبات لمدة 30 ثانية.
// طول ما الاتصال مفتوح، كروم بيسيب الـservice worker صاحي.
function scheduleIdle() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (port && !activeJobs.size && !pending.size) {
      try { port.disconnect(); } catch {}
      port = null;
    }
  }, 30_000);
}

export function request(cmd, payload = {}, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    let p;
    try { p = connect(); } catch (e) { return reject(new Error(friendly(String(e.message || e)))); }
    const id = `r${++seq}-${Date.now()}`;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(t('nativeTimeout'))); }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    try { p.postMessage({ id, cmd, ...payload }); }
    catch (e) { clearTimeout(timer); pending.delete(id); reject(new Error(friendly(String(e.message || e)))); }
    scheduleIdle();
  });
}

/** معلومات البرنامج (النسخة، yt-dlp، ffmpeg). null لو مش متسطّب */
export async function nativeInfo(force = false) {
  const ttl = infoCache.info ? 60_000 : 10_000;
  if (!force && Date.now() - infoCache.at < ttl) return infoCache.info;
  let info = null;
  try { info = await request('ping', {}, 8_000); } catch {}
  infoCache = { at: Date.now(), info };
  if (info) sendConfig();
  return info;
}

/** الكوكيز بصيغة Netscape اللي yt-dlp بيفهمها */
export async function cookiesFor(urls) {
  const map = new Map();
  for (const u of urls) {
    if (!u || !/^https?:/i.test(u)) continue;
    try {
      for (const c of await chrome.cookies.getAll({ url: u })) map.set(`${c.domain}|${c.path}|${c.name}`, c);
    } catch {}
  }
  if (!map.size) return '';
  const lines = ['# Netscape HTTP Cookie File'];
  for (const c of map.values()) {
    const domain = c.hostOnly ? c.domain.replace(/^\./, '') : (c.domain.startsWith('.') ? c.domain : '.' + c.domain);
    lines.push([
      (c.httpOnly ? '#HttpOnly_' : '') + domain,
      c.hostOnly ? 'FALSE' : 'TRUE',
      c.path || '/',
      c.secure ? 'TRUE' : 'FALSE',
      c.session ? 0 : Math.floor(c.expirationDate || 0),
      c.name,
      String(c.value).replace(/[\t\r\n]/g, ''),
    ].join('\t'));
  }
  return lines.join('\n') + '\n';
}

export const nativeEngine = {
  id: 'native',
  get label() { return t('helper'); },

  async available(force = false) {
    return !!(await nativeInfo(force));
  },

  canHandle(item) {
    // yt-dlp + ffmpeg بيتعاملوا مع direct و HLS و DASH ولينك الصفحة نفسه
    return !item.drm;
  },

  async download(item, { jobId, relDir, baseName, variant = 0, pageUrl, settings, audioOnly, audioFormat, playlist }) {
    const common = {
      jobId,
      referer: pageUrl && pageUrl !== item.url ? pageUrl : '',
      userAgent: navigator.userAgent,
      baseDir: settings.nativeDir || '',
      relDir,
      name: baseName,
    };
    let cmd, payload;
    if (item.split) {
      // فيسبوك/انستجرام: ffmpeg بيدمج الصورة مع الصوت (أو بينضّف الصورة لوحدها)
      cmd = 'merge';
      payload = { url: item.variants?.[variant]?.url || item.url, audioUrl: item.audio?.url || '' };
    } else {
      cmd = 'download';
      payload = {
        url: item.url,
        height: item.variants?.[variant]?.height || 0,
        audioOnly: !!audioOnly || !!item.audioOnly,
        audioFormat: audioFormat || '',
        playlist: !!playlist,
        cookies: await cookiesFor([item.url, pageUrl]),
        subs: !!settings.subs,
        subLangs: settings.subLangs || '',
        embedMeta: !!settings.embedMeta,
        embedThumb: !!settings.embedThumb,
        rateLimit: settings.rateLimit || '',
      };
    }
    activeJobs.add(jobId);
    try {
      const r = await request(cmd, { ...common, ...payload }, 20_000);
      return { jobId, dir: r.dir, queued: r.queued };
    } catch (e) {
      activeJobs.delete(jobId);
      throw e;
    }
  },
};
