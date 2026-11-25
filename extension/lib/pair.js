// ربط ملفات الصورة بملفات الصوت (فيسبوك/انستجرام بيبعتوهم منفصلين).
// الأولوية: نفس رقم الأصل (assetId) ← نفس المدة تقريباً ← أقرب توقيت.

const MAX_GAP_MS = 15_000;

function sameDuration(a, b) {
  return a.duration && b.duration && Math.abs(a.duration - b.duration) <= 1;
}

function score(v, a) {
  if (v.assetId && a.assetId) return v.assetId === a.assetId ? 0 : Infinity;
  const gap = Math.abs(v.detectedAt - a.detectedAt);
  if (v.duration && a.duration) return sameDuration(v, a) ? 1 + gap / 1e9 : Infinity;
  return gap <= MAX_GAP_MS ? 2 + gap / 1e9 : Infinity;
}

function heightOf(i) { return i.height || 0; }

/**
 * بياخد العناصر المكتشفة ويرجع لستة العرض: الصورة + الصوت بتاعها في عنصر واحد،
 * وجودات نفس الفيديو (نفس assetId) متجمعة كـvariants.
 */
export function pairItems(items) {
  const plain = items.filter((i) => !i.split);
  const split = items.filter((i) => i.split).sort((a, b) => a.detectedAt - b.detectedAt);
  const videos = split.filter((i) => i.track !== 'audio');
  const audios = split.filter((i) => i.track === 'audio');

  // نجمع جودات نفس الفيديو
  const groups = [];
  const byAsset = new Map();
  for (const v of videos) {
    const key = v.assetId;
    if (key && byAsset.has(key)) { byAsset.get(key).push(v); continue; }
    const g = [v];
    groups.push(g);
    if (key) byAsset.set(key, g);
  }

  const used = new Set();
  const out = [];
  for (const g of groups) {
    g.sort((a, b) => heightOf(b) - heightOf(a));
    const main = g[0];
    let best = null;
    let bestScore = Infinity;
    for (const a of audios) {
      if (used.has(a.id)) continue;
      const s = Math.min(...g.map((v) => score(v, a)));
      if (s < bestScore) { bestScore = s; best = a; }
    }
    const item = { ...main };
    if (best) {
      used.add(best.id);
      item.audio = { url: best.url, id: best.id };
    }
    if (g.length > 1 || main.height) {
      item.variants = g.map((v) => ({ url: v.url, height: v.height || null, label: v.height ? `${v.height}p` : 'Default' }));
    }
    item.duration = item.duration || best?.duration || null;
    out.push(item);
  }
  for (const a of audios) {
    if (!used.has(a.id)) out.push({ ...a, ext: 'm4a', audioOnly: true });
  }
  return [...plain, ...out];
}
