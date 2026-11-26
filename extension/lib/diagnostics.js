// "Copy diagnostics": a short plain-text report for bug reports.
// No personal data: no URLs, page titles, file names, folder paths or settings that hold them.
// Pure functions here (tested in tests/unit.mjs); background.js gathers the inputs.

/** Remove anything that could identify the user or what they downloaded from an error message. */
export function scrubError(msg) {
  if (!msg) return '';
  return String(msg)
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s'"<>)\]]+/gi, (u) => {
      try { return `<url ${new URL(u).hostname}>`; } catch { return '<url>'; }
    })
    // Windows paths (C:\..., \\server\share\...) and POSIX/home paths
    .replace(/(?:[a-zA-Z]:|\\\\[^\\\s]+)\\[^\s'"<>|]*/g, '<path>')
    .replace(/(?:~|\/(?:home|Users|tmp|var|private|mnt|media|Volumes|root))\/[^\s'"<>]*/g, '<path>')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '<email>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

/** Browser name and version from userAgentData/userAgent (Brave reports itself as Chrome). */
export function browserName({ ua = '', brands = [], isBrave = false, firefox = null } = {}) {
  if (firefox) return `Firefox ${firefox}`;
  const b = (name) => brands.find((x) => x.brand === name)?.version;
  const chromeVer = b('Google Chrome') || b('Chromium') || (ua.match(/Chrome\/([\d.]+)/) || [])[1] || '';
  if (isBrave) return `Brave (Chromium ${chromeVer})`.replace(' ()', '');
  const edge = b('Microsoft Edge') || (ua.match(/Edg\/([\d.]+)/) || [])[1];
  if (edge) return `Edge ${edge}`;
  const ff = (ua.match(/Firefox\/([\d.]+)/) || [])[1];
  if (ff) return `Firefox ${ff}`;
  return chromeVer ? `Chrome ${chromeVer}` : 'unknown';
}

const yn = (v) => (v ? 'yes' : 'no');

/**
 * d = { extVersion, browser, os, arch, uiLang, helper (info() or null), managed, firefox,
 *       settings: { defaultEngine, maxConcurrent, hlsToMp4 }, lastError: { error, engine, kind, host, at } | null }
 */
export function formatDiagnostics(d) {
  const h = d.helper;
  const lines = [
    'Hudhud diagnostics',
    `Extension: ${d.extVersion}`,
    `Browser: ${d.browser}`,
    `OS: ${d.os}${d.arch ? ' ' + d.arch : ''}`,
    `UI language: ${d.uiLang || 'auto'}`,
  ];
  if (h) {
    lines.push(
      `Helper: ${h.version || '?'}${h.os ? ' (' + h.os + ')' : ''}`,
      `yt-dlp: ${h.ytdlp || 'missing'}`,
      `ffmpeg: ${yn(h.ffmpeg)} · Deno: ${yn(h.deno)}`,
    );
    if (h.extVersion) lines.push(`Extension in Hudhud folder: ${h.extVersion}`);
  } else {
    lines.push('Helper: not connected');
  }
  lines.push(`One-click updates: ${d.firefox ? 'Firefox (add-on updates from Firefox)' : yn(d.managed)}`);
  const s = d.settings || {};
  lines.push(`Settings: engine=${s.defaultEngine || '?'}, concurrent=${s.maxConcurrent ?? '?'}, hlsToMp4=${yn(s.hlsToMp4)}`);
  const e = d.lastError;
  if (e?.error) {
    const when = e.at ? new Date(e.at).toISOString().replace(/\.\d+Z$/, 'Z') : '';
    const meta = [e.engine, e.kind, e.host].filter(Boolean).join(', ');
    lines.push(`Last error${meta ? ' (' + meta + ')' : ''}${when ? ' ' + when : ''}: ${scrubError(e.error)}`);
  } else {
    lines.push('Last error: none');
  }
  return lines.join('\n');
}
