// Runtime i18n. Unlike chrome.i18n, the language can be switched from the settings without
// restarting the browser. Messages live in _locales/<lang>/messages.json (Chrome format).

let dict = {};
let lang = 'en';
let plural = new Intl.PluralRules('en');

// Interface languages: code (= _locales folder) → name in that language. Keep in sync with scripts/i18n/.
export const LANGS = { ar: 'العربية', en: 'English', es: 'Español', fr: 'Français', pt_BR: 'Português (Brasil)', tr: 'Türkçe' };

/** 'auto' or a code from settings → a code from LANGS (browser language for 'auto', English if unsupported) */
export function resolveLang(pref, ui) {
  if (pref && pref !== 'auto' && LANGS[pref]) return pref;
  if (ui === undefined) {
    ui = 'en';
    try { ui = chrome.i18n?.getUILanguage?.() || navigator.language || 'en'; } catch {}
  }
  const base = String(ui).toLowerCase().split(/[-_]/)[0];
  if (base === 'pt') return 'pt_BR';
  return LANGS[base] ? base : 'en';
}

export async function initI18n(pref) {
  if (pref === undefined) {
    try { pref = (await chrome.storage.local.get('settings')).settings?.uiLang; } catch {}
  }
  lang = resolveLang(pref);
  plural = new Intl.PluralRules(lang.replace('_', '-'));
  const res = await fetch(chrome.runtime.getURL(`_locales/${lang}/messages.json`));
  const json = await res.json();
  dict = Object.fromEntries(Object.entries(json).map(([k, v]) => [k, v.message]));
  return lang;
}

export function t(key, ...args) {
  let s = dict[key];
  if (s == null) return key;
  args.forEach((a, i) => { s = s.split('$' + (i + 1)).join(String(a)); });
  return s;
}

// t for counts: picks key_one / key_two / key_few / key_many / key_other
export function tn(key, n) {
  const cat = n === 0 && dict[key + '_zero'] ? 'zero' : plural.select(n);
  const k = dict[`${key}_${cat}`] != null ? `${key}_${cat}` : `${key}_other`;
  return t(k, fmtNum(n));
}

export function fmtNum(n) {
  return lang === 'ar' ? Number(n).toLocaleString('ar-EG') : String(n);
}

export const getLang = () => lang;
export const isRtl = () => lang === 'ar';

// Fills [data-i18n], [data-i18n-title], [data-i18n-placeholder] and sets lang/dir on <html>.
export function applyI18n(root = document) {
  for (const n of root.querySelectorAll('[data-i18n]')) n.textContent = t(n.dataset.i18n);
  for (const n of root.querySelectorAll('[data-i18n-title]')) n.title = t(n.dataset.i18nTitle);
  for (const n of root.querySelectorAll('[data-i18n-placeholder]')) n.placeholder = t(n.dataset.i18nPlaceholder);
  if (root === document) {
    document.documentElement.lang = lang.replace('_', '-');
    document.documentElement.dir = isRtl() ? 'rtl' : 'ltr';
  }
}

// Light/dark: settings.theme = auto | light | dark → data-theme on <html>
export async function applyTheme(pref) {
  if (pref === undefined) {
    try { pref = (await chrome.storage.local.get('settings')).settings?.theme; } catch {}
  }
  const dark = pref === 'dark' || (pref !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  try { chrome.runtime.sendMessage({ type: 'scheme', dark: matchMedia('(prefers-color-scheme: dark)').matches }).catch(() => {}); } catch {}
  return dark;
}
