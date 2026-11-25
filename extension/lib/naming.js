// التسمية الذكية (زي smartnaming): قالب + قواعد لكل موقع + فولدرات فرعية.
//
// شكل القاعدة في الإعدادات (JSON):
// {
//   "match": "example.com"            // دومين (بيطابق الفرعي كمان) أو regex بين / /
//   "template": "%hostname - %title",
//   "selector": "h1.video-title",     // اختياري: نص من الصفحة يتحط مكان %selector
//   "directory": "Example",           // اختياري: فولدر فرعي جوه Downloads
//   "maxLength": 80,
//   "replace": [{ "from": "/\\s+-\\s+Example$/", "to": "" }]
// }
// متغيرات القالب: %title %hostname %quality %date %selector

const WIN_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

export const DEFAULT_SETTINGS = {
  subdir: '',
  template: '%title',
  maxLength: 64,
  minSizeMB: 1,
  history: true,
  defaultEngine: 'browser',
  nativeDir: '',
  subs: false,
  subLangs: 'ar,en',
  embedMeta: true,
  embedThumb: false,
  rateLimit: '',
  maxConcurrent: 3,
  autoUpdate: true,
  notifications: true,
  hlsToMp4: true,
  rules: [],
  uiLang: 'auto',
  theme: 'auto',
};

export function sanitizeSegment(s) {
  let out = String(s ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[<>:"/\\|?*~]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '')
    .replace(/^[. ]+/g, '');
  if (WIN_RESERVED.test(out)) out = '_' + out;
  return out;
}

function toRegex(s) {
  const m = /^\/(.*)\/([gimsuy]*)$/s.exec(s);
  return m ? new RegExp(m[1], m[2].includes('g') ? m[2] : m[2] + 'g') : null;
}

export function ruleMatches(rule, url) {
  if (!rule || !rule.match) return false;
  const re = toRegex(rule.match);
  if (re) { re.lastIndex = 0; return re.test(url); }
  let host = '';
  try { host = new URL(url).hostname.toLowerCase(); } catch { return false; }
  const d = rule.match.toLowerCase().replace(/^\*?\.?/, '');
  return host === d || host.endsWith('.' + d);
}

export function findRule(rules, url) {
  return (rules || []).find((r) => ruleMatches(r, url)) || null;
}

export function applyReplace(name, replace) {
  for (const r of replace || []) {
    const re = toRegex(r.from);
    name = re ? name.replace(re, r.to ?? '') : name.split(r.from).join(r.to ?? '');
  }
  return name;
}

function truncate(s, max) {
  const chars = Array.from(s); // ما نقطعش حرف عربي أو إيموجي من النص
  return chars.length > max ? chars.slice(0, max).join('').trim() : s;
}

/** الاسم من غير امتداد، اللي بيظهر للمستخدم يعدّله */
export function buildBaseName(vars, settings, rule) {
  const s = { ...DEFAULT_SETTINGS, ...settings };
  const tpl = (rule && rule.template) || s.template || '%title';
  const max = Number((rule && rule.maxLength) || s.maxLength) || 64;
  let host = '';
  try { host = new URL(vars.pageUrl || vars.url).hostname.replace(/^www\./, ''); } catch {}
  const date = new Date().toISOString().slice(0, 10);
  let name = tpl
    .replace(/%title/g, vars.title || '')
    .replace(/%hostname/g, host)
    .replace(/%quality/g, vars.quality || '')
    .replace(/%date/g, date)
    .replace(/%selector/g, vars.selector || '');
  name = applyReplace(name, rule && rule.replace);
  name = sanitizeSegment(name);
  name = truncate(name, max);
  return name || 'video';
}

/** الفولدرات الفرعية (من الإعدادات + القاعدة) كمسار نسبي آمن */
export function buildRelDir(settings, rule) {
  const s = { ...DEFAULT_SETTINGS, ...settings };
  return [s.subdir, rule && rule.directory]
    .filter(Boolean)
    .flatMap((d) => String(d).split(/[\\/]+/))
    .map(sanitizeSegment)
    .filter((d) => d && d !== '..')
    .join('/');
}

/** المسار النهائي النسبي لفولدر Downloads */
export function buildPath(baseName, ext, settings, rule) {
  const dir = buildRelDir(settings, rule);
  const file = (sanitizeSegment(baseName) || 'video') + '.' + (ext || 'mp4');
  return dir ? dir + '/' + file : file;
}
