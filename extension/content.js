// بيدوّر على عناصر <video>/<audio> في الصفحة، وبيدّي عنوان الصفحة للتسمية الذكية.
(() => {
  if (window.__hudhudLoaded) return;
  window.__hudhudLoaded = true;

  const seen = new Set();

  function send(msg) {
    try { chrome.runtime.sendMessage(msg).catch(() => {}); } catch {}
  }

  // light/dark toolbar icon: tell the extension what the system prefers (top frame only, once + on change)
  if (window === window.top) {
    try {
      const mq = matchMedia('(prefers-color-scheme: dark)');
      send({ type: 'scheme', dark: mq.matches });
      mq.addEventListener('change', () => send({ type: 'scheme', dark: mq.matches }));
    } catch {}
  }

  function scan() {
    const urls = [];
    document.querySelectorAll('video, audio, video source, audio source').forEach((el) => {
      const s = el.currentSrc || el.src;
      if (s && /^https?:/i.test(s) && !seen.has(s)) { seen.add(s); urls.push(s); }
    });
    if (urls.length) send({ type: 'elements', urls, pageUrl: location.href });
  }

  let timer = null;
  const schedule = () => { if (!timer) timer = setTimeout(() => { timer = null; scan(); }, 800); };

  scan();
  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
  document.addEventListener('play', schedule, true);
  document.addEventListener('loadedmetadata', schedule, true);

  function bestTitle() {
    const pick = (sel) => document.querySelector(sel)?.getAttribute('content')?.trim();
    return pick('meta[property="og:title"]') || pick('meta[name="twitter:title"]') || document.title || '';
  }

  // صورة احتياطية للفيديو: og:image أو poster بتاع أكبر <video>
  function bestImage() {
    const abs = (u) => { try { return u ? new URL(u, location.href).href : ''; } catch { return ''; } };
    const pick = (sel) => abs(document.querySelector(sel)?.getAttribute('content')?.trim());
    let poster = '';
    let best = 0;
    document.querySelectorAll('video[poster]').forEach((v) => {
      const area = (v.clientWidth || 1) * (v.clientHeight || 1);
      if (area > best) { best = area; poster = abs(v.getAttribute('poster')); }
    });
    const img = poster || pick('meta[property="og:image"]') || pick('meta[name="twitter:image"]');
    return /^https?:/i.test(img) ? img : '';
  }

  if (window.top === window) {
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg?.type === 'meta') {
        let selector = '';
        if (msg.selector) {
          try { selector = document.querySelector(msg.selector)?.textContent?.trim() || ''; } catch {}
        }
        sendResponse({ title: bestTitle(), pageUrl: location.href, selector, image: bestImage() });
      }
    });
  }
})();
