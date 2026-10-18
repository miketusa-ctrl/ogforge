// Input validation + normalization for /api/og. Pure functions (no Worker APIs) so they run in Node tests.

export const RENDER_VERSION = 'r2'; // bump to invalidate every cached render
export const TEMPLATES = ['blog', 'launch', 'docs', 'minimal', 'gradient'];
export const THEMES = ['light', 'dark'];
export const LIMITS = {
  title: 120,
  subtitle: 200,
  label: 40,
  site: 60,
  author: 60,
  logo: 512,      // logo URL length
  query: 2000,    // whole query string (bytes, after decoding)
};

export class ParamError extends Error {
  constructor(code, message, status = 400, field) { super(message); this.code = code; this.httpStatus = status; this.field = field; }
}

// Strip control chars, collapse whitespace, trim. Keeps emoji / accents.
export function cleanText(s) {
  return String(s ?? '')
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b\u200c\u200e\u200f\u2028-\u202e\u2060-\u2064\ufeff]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Truncate by user-perceived characters (code points), adding an ellipsis.
export function clip(s, max) {
  const cps = Array.from(s);
  if (cps.length <= max) return { text: s, truncated: false };
  return { text: cps.slice(0, max - 1).join('').trimEnd() + '…', truncated: true };
}

export function parseColor(raw, field) {
  if (raw == null || raw === '') return null;
  const s = String(raw).trim().replace(/^#/, '').toLowerCase();
  if (/^[0-9a-f]{3}$/.test(s)) return '#' + s.split('').map((c) => c + c).join('');
  if (/^[0-9a-f]{6}$/.test(s)) return '#' + s;
  throw new ParamError('invalid_color', `"${field}" must be a hex color like 0f172a or #0f172a (3 or 6 hex digits).`, 400, field);
}

// One emoji (a single grapheme, at most 8 code points: covers ZWJ families, flags, skin tones).
const EMOJI_RE = /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator})/u;
export function parseEmoji(raw) {
  if (raw == null || raw === '') return null;
  const s = cleanText(raw).replace(/\s/g, '');
  if (!s) return null;
  const cps = Array.from(s);
  if (cps.length > 8 || !EMOJI_RE.test(s)) throw new ParamError('invalid_emoji', '"emoji" must be a single emoji, e.g. 🚀', 400, 'emoji');
  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    const segs = [...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(s)];
    if (segs.length !== 1) throw new ParamError('invalid_emoji', '"emoji" must be a single emoji, e.g. 🚀', 400, 'emoji');
  }
  return s;
}

export function parseLogo(raw) {
  if (raw == null || raw === '') return null;
  const s = String(raw).trim();
  if (s.length > LIMITS.logo) throw new ParamError('param_too_long', `"logo" URL is longer than ${LIMITS.logo} characters.`, 400, 'logo');
  let u;
  try { u = new URL(s); } catch { throw new ParamError('invalid_logo', '"logo" must be an absolute https:// URL to a PNG, JPEG or SVG image.', 400, 'logo'); }
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) {
    throw new ParamError('invalid_logo', '"logo" must be an https:// URL on the default port, without credentials.', 400, 'logo');
  }
  const host = u.hostname.toLowerCase();
  if (!host.includes('.') || /^[\d.]+$/.test(host) || host.startsWith('[') || /\.(local|localhost|internal|lan|home|arpa|test|invalid|example)$/.test(host) || host === 'localhost') {
    throw new ParamError('invalid_logo', '"logo" must point to a public hostname (no IP literals or local names).', 400, 'logo');
  }
  u.hash = '';
  return u.href;
}

/**
 * Normalize URLSearchParams into a canonical options object.
 * Unknown params are ignored (and do not affect the cache key).
 * Text over the limit is truncated with "…" (reported in `truncated`), so OG tags built from long titles still render.
 */
export function normalizeParams(searchParams) {
  const get = (k) => { const v = searchParams.get(k); return v == null ? '' : v; };
  let qlen = 0;
  for (const [k, v] of searchParams) qlen += k.length + v.length + 2;
  if (qlen > LIMITS.query) throw new ParamError('query_too_long', `Query string is too long (max ${LIMITS.query} characters).`, 414);

  const template = (get('template') || get('t') || 'blog').trim().toLowerCase();
  if (!TEMPLATES.includes(template)) throw new ParamError('invalid_template', `Unknown template "${template.slice(0, 30)}". Use one of: ${TEMPLATES.join(', ')}.`, 400, 'template');

  const themeRaw = get('theme').trim().toLowerCase();
  if (themeRaw && !THEMES.includes(themeRaw)) throw new ParamError('invalid_theme', `"theme" must be "light" or "dark".`, 400, 'theme');

  const truncated = [];
  const text = (k, alias) => {
    const raw = cleanText(get(k) || (alias ? get(alias) : ''));
    const { text: t, truncated: cut } = clip(raw, LIMITS[k]);
    if (cut) truncated.push(k);
    return t;
  };

  const opts = {
    template,
    theme: themeRaw || null,
    title: text('title') || 'Untitled',
    subtitle: text('subtitle', 'description'),
    label: text('label', 'tag'),
    site: text('site'),
    author: text('author'),
    emoji: parseEmoji(get('emoji')),
    logo: parseLogo(get('logo')),
    bg: parseColor(get('bg'), 'bg'),
    fg: parseColor(get('fg'), 'fg'),
    accent: parseColor(get('accent'), 'accent'),
  };
  return { opts, truncated };
}

// Canonical, order-independent string for the cache key. `tier` matters because free renders carry the badge.
export function canonicalString(opts, tier = 'free') {
  const keys = ['template', 'theme', 'title', 'subtitle', 'label', 'site', 'author', 'emoji', 'logo', 'bg', 'fg', 'accent'];
  return [RENDER_VERSION, tier, ...keys.map((k) => `${k}=${opts[k] ?? ''}`)].join('\n');
}

export async function cacheKeyHash(opts, tier = 'free') {
  const data = new TextEncoder().encode(canonicalString(opts, tier));
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 40);
}
