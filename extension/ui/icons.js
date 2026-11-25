// Inline SVG icons (stroke/fill = currentColor) shared by every page.
const P = {
  download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14" stroke-width="2.4"/>',
  sliders: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9" stroke-width="2"/><circle cx="15" cy="7" r="2" stroke-width="2"/><circle cx="9" cy="17" r="2" stroke-width="2"/>',
  heart: '<path d="M12 20s-8-4.8-8-10.4C4 7 6 5 8.4 5c1.6 0 2.9.9 3.6 2.2C12.7 5.9 14 5 15.6 5 18 5 20 7 20 9.6 20 15.2 12 20 12 20z" fill="currentColor" stroke="none"/>',
  x: '<path d="M6 6l12 12M18 6L6 18" stroke-width="2.4"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4.5l2 2H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" stroke-width="2"/>',
  retry: '<path d="M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5" stroke-width="2.4"/>',
  check: '<path d="M5 12.5l5 4.5 9-10" stroke-width="2.6"/>',
  chevron: '<path d="M7 10l5 5 5-5" stroke-width="2.2"/>',
  alert: '<path d="M12 7v6" stroke-width="2.6"/><circle cx="12" cy="17" r="1.6" fill="currentColor" stroke="none"/>',
  plug: '<path d="M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0zM12 17v4" stroke-width="2"/>',
  info: '<circle cx="12" cy="12" r="8" stroke-width="2"/><path d="M12 11v5" stroke-width="2.4"/><circle cx="12" cy="8" r="1.3" fill="currentColor" stroke="none"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" stroke-width="2"/>',
  more: '<circle cx="6" cy="12" r="1.7" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.7" fill="currentColor" stroke="none"/><circle cx="18" cy="12" r="1.7" fill="currentColor" stroke="none"/>',
  play: '<path d="M8 5.5v13l10.5-6.5z" fill="currentColor" stroke="none"/>',
  refresh: '<path d="M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5" stroke-width="2.2"/>',
  win: '<path d="M3 5l8-1v7.5H3zM13 3.8l8-1v8.7h-8zM3 12.5h8V20l-8-1zM13 12.5h8v8.7l-8-1z" fill="currentColor" stroke="none"/>',
  mac: '<path d="M16 3c0 2-1.5 3.6-3.2 3.6C12.7 4.8 14.2 3.1 16 3zM19.5 16.5c-.7 1.7-1.9 4.1-3.6 4.1-1.3 0-1.7-.8-3.3-.8s-2.1.8-3.3.8c-1.8 0-4.8-4.3-4.8-8 0-3.2 2.1-5 4.1-5 1.4 0 2.4.9 3.4.9.9 0 2.2-1 3.8-1 .8 0 2.7.3 3.8 2.1-2.6 1.4-2.3 5.8-.1 6.9z" fill="currentColor" stroke="none"/>',
  linux: '<circle cx="12" cy="8" r="4.5" stroke-width="2"/><path d="M6 21c0-6 2-8 6-8s6 2 6 8" stroke-width="2"/>',
  puzzle: '<path d="M5 8h4c0-3 4-3 4 0h4v4c3 0 3 4 0 4v4H5z" stroke-width="1.8"/>',
};
export function icon(name, cls = '') {
  return `<svg class="ico ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] || ''}</svg>`;
}
export function iconEl(name, cls = '') {
  const t = document.createElement('template');
  t.innerHTML = icon(name, cls);
  return t.content.firstChild;
}
// Mascot <img> pair that follows the theme
export function mascot(pose, size) {
  const w = document.createElement('span');
  w.className = 'mascot';
  w.style.width = w.style.height = size + 'px';
  w.innerHTML = `<img class="light-only" src="assets/mascot/${pose}.svg" alt="" width="${size}" height="${size}">`
    + `<img class="dark-only" src="assets/mascot/${pose}-dark.svg" alt="" width="${size}" height="${size}">`;
  return w;
}
