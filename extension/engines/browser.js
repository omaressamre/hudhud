// محرك المتصفح: بيحمّل جوه كروم/إيدج نفسه من غير أي برنامج خارجي.
import { t } from '../lib/i18n.js';
// - ملفات مباشرة (mp4/webm/...): chrome.downloads على طول، والكوكيز بتتبعت تلقائياً.
// - فيسبوك/انستجرام (صورة + صوت منفصلين): offscreen بيدمجهم في MP4 واحد (lib/mp4merge.js).
// - HLS: offscreen document بيجمع الـsegments (وبيفك تشفير AES-128) في ملف واحد على OPFS،
//   وبيحوّل TS لـMP4 (lib/ts2mp4.js) — حتى لو الصوت في playlist منفصل.

let creating = null;

// Firefox has no offscreen API, but its background is a page with a DOM:
// the same offscreen.html runs in a hidden iframe there and gets the same messages.
async function ensureFrame() {
  if (document.getElementById('hh-offscreen')) return;
  if (!creating) {
    creating = new Promise((resolve) => {
      const f = document.createElement('iframe');
      f.id = 'hh-offscreen';
      f.src = chrome.runtime.getURL('offscreen.html');
      f.addEventListener('load', () => setTimeout(resolve, 50), { once: true });
      document.body.appendChild(f);
    }).finally(() => { creating = null; });
  }
  await creating;
}

export async function ensureOffscreen() {
  if (!chrome.offscreen) return ensureFrame();
  if (await chrome.offscreen.hasDocument()) return;
  if (!creating) {
    creating = chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['BLOBS'],
      justification: 'Assemble HLS video segments into a single downloadable file',
    }).finally(() => { creating = null; });
  }
  await creating;
}

// قاعدة مؤقتة بتحط Referer/Origin بتوع الصفحة على طلبات الإضافة (مواقع كتير بترفض من غيرهم)
function ruleIdFor(jobId) {
  let h = 7;
  for (const c of jobId) h = (h * 31 + c.charCodeAt(0)) % 1_000_000_000;
  return h + 1;
}

export async function addHeaderRule(jobId, pageUrl) {
  if (!/^https?:/i.test(pageUrl || '')) return;
  const id = ruleIdFor(jobId);
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [id],
      addRules: [{
        id,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          requestHeaders: [
            { header: 'referer', operation: 'set', value: pageUrl },
            { header: 'origin', operation: 'set', value: new URL(pageUrl).origin },
          ],
        },
        condition: { initiatorDomains: [new URL(chrome.runtime.getURL('')).hostname], resourceTypes: ['xmlhttprequest', 'other'] },
      }],
    });
  } catch (e) { console.warn('[Hudhud] header rule', e); }
}

export async function removeHeaderRule(jobId) {
  try { await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ruleIdFor(jobId)] }); } catch {}
}

export const browserEngine = {
  id: 'browser',
  get label() { return t('browser'); },

  async available() { return true; },

  canHandle(item) {
    if (item.drm) return false;
    if (item.kind === 'direct') return true;
    return item.kind === 'hls' && !item.live;
  },

  async download(item, { path, variant = 0, jobId, pageUrl, settings = {} }) {
    if (item.kind === 'hls') {
      await ensureOffscreen();
      await addHeaderRule(jobId, pageUrl);
      await chrome.runtime.sendMessage({
        target: 'offscreen', type: 'hls-start', jobId,
        url: item.url, height: item.variants?.[variant]?.height || 0,
        remux: settings.hlsToMp4 !== false,
      });
      return { offscreen: true };
    }
    const url = item.split ? (item.variants?.[variant]?.url || item.url) : item.url;
    if (item.split && item.audio?.url) {
      // فيسبوك/انستجرام: الصورة والصوت بيتدمجوا في MP4 واحد جوه المتصفح (lib/mp4merge.js)
      await ensureOffscreen();
      await addHeaderRule(jobId, pageUrl);
      await chrome.runtime.sendMessage({
        target: 'offscreen', type: 'hls-start', op: 'merge', jobId,
        videoUrl: url, audioUrl: item.audio.url, fallbackUrl: url,
      });
      return { offscreen: true };
    }
    const downloadId = await chrome.downloads.download({
      url,
      filename: path,
      conflictAction: 'uniquify',
      saveAs: false,
    });
    return { downloadId };
  },
};
