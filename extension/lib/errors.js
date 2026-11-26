// Turns raw errors (Chrome download interrupt reasons, yt-dlp output, helper messages) into a
// short message in the user's language. The raw text stays in the job (and in "Copy diagnostics").

// Order matters: the first match wins.
const RULES = [
  ['errDrm', /\bDRM\b/],
  ['errLiveNotStarted', /live event will begin|Premieres in|is upcoming|This live event/i],
  ['errAge', /confirm your age|age[- ]restricted|inappropriate for some users/i],
  ['errPrivate', /Private video|video is private|This video has been made private/i],
  ['errMembers', /members[- ]only|Join this channel|channel'?s members/i],
  ['errGeo', /available in your country|geo[- ]?restrict|blocked it in your country|not available from your location/i],
  ['errNeedDeno', /Deno/],
  ['errSignIn', /Sign in to confirm|login required|log in to|rate-limit reached|use --cookies|cookies-from-browser|SERVER_UNAUTHORIZED|HTTP Error 401/i],
  ['errTooMany', /HTTP Error 429|Too Many Requests/i],
  ['errUnavailable', /Video unavailable|This video is unavailable|has been removed|no longer available|account associated with this video|HTTP Error 404|HTTP Error 410/i],
  ['errUpdateYtdlp', /Signature|nsig|n challenge|JavaScript runtime|Unable to extract|Requested format is not available|No video formats found|unreadable yt-dlp output|رد غير مفهوم من yt-dlp/i],
  ['errUnsupported', /Unsupported URL|doesn't support this site|مش بيدعم الموقع/i],
  ['errToolMissing', /(ffmpeg|yt-dlp)( is missing| not found| مش موجود)/i],
  ['errDiskFull', /FILE_NO_SPACE|No space left|Errno 28|ENOSPC|not enough space|disk (is )?full/i],
  ['errNameLong', /FILE_NAME_TOO_LONG|File name too long|Errno 36|Errno 63|ENAMETOOLONG/i],
  ['errAccess', /FILE_ACCESS_DENIED|Permission denied|Errno 13|EACCES|Access is denied|can't create the folder|مش قادر أعمل الفولدر/i],
  ['errBlocked', /FILE_VIRUS_INFECTED|FILE_BLOCKED|FILE_SECURITY_CHECK_FAILED/],
  ['errFileFailed', /FILE_FAILED|FILE_TRANSIENT_ERROR|FILE_TOO_LARGE|FILE_HASH_MISMATCH|FILE_SAME_AS_SOURCE/],
  ['errForbidden', /SERVER_FORBIDDEN|HTTP Error 403|\b403\b/],
  ['errServer', /SERVER_FAILED|SERVER_BAD_CONTENT|SERVER_NO_RANGE|SERVER_CONTENT_LENGTH_MISMATCH|SERVER_CROSS_ORIGIN_REDIRECT|HTTP Error 5\d\d/],
  ['errNetwork', /NETWORK_\w+|SERVER_UNREACHABLE|SERVER_CERT_PROBLEM|timed out|Connection reset|Connection refused|getaddrinfo|Name or service not known|name resolution|Network is unreachable|Unable to connect|ECONNRESET|ETIMEDOUT/i],
  ['errBrowserClosed', /^(CRASH|USER_SHUTDOWN)$/],
];

// Looks like something only a developer would read (not one of our own translated messages)
const TECHNICAL = /^[A-Z][A-Z0-9_]{3,}$|ERROR|Error|error:|Exception|Traceback|errno|HTTP|\[[\w:-]+\]|exit status|signal:|\.py\b|0x[0-9a-f]+/;

/**
 * @returns {{ key: string|null, raw: string, technical: boolean }}
 *   key: a strings.mjs key for a known problem; null when unknown.
 *   technical: unknown and not human-readable → show errUnknown instead of the raw text.
 */
export function classifyError(raw) {
  const s = String(raw || '');
  for (const [key, re] of RULES) if (re.test(s)) return { key, raw: s, technical: true };
  return { key: null, raw: s, technical: TECHNICAL.test(s) };
}

/** The message to show. `t` and `installer` are passed in so this stays testable. */
export function friendlyError(raw, t, installer = '') {
  if (!raw) return t('jobStopped');
  const c = classifyError(raw);
  if (c.key) return t(c.key, installer);
  return c.technical ? t('errUnknown') : c.raw;
}
