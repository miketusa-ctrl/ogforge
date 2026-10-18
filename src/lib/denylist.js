// Acceptable-use denylist, checked BEFORE any cache lookup (so a takedown also hides already-cached images).
// Three lists, each = source constant below + optional comma/newline-separated env var (wrangler.toml [vars] or dashboard):
//   terms      -> DENY_TERMS       blocked words/phrases in title, subtitle, label, site, author
//   logoHosts  -> DENY_LOGO_HOSTS  blocked logo hostnames (exact host or any subdomain of it)
//   hashes     -> DENY_HASHES      blocked cache-key hashes (= the image's ETag without quotes) for single-image takedowns
// Matching is case-, accent- and punctuation-insensitive ("V.e.r.i.f.y  Your  Account" matches "verify your account").

export const DENYLIST = {
  // Phishing / account-takeover phrasing that has no business on a social card.
  terms: [
    'verify your account',
    'verify your identity',
    'account suspended',
    'account has been suspended',
    'account will be suspended',
    'confirm your password',
    'reset your password now',
    'enter your seed phrase',
    'wallet recovery phrase',
    'claim your airdrop',
    'free crypto giveaway',
  ],
  // IP loggers and link cloakers: no legitimate logo is served from these.
  logoHosts: ['grabify.link', 'iplogger.org', 'iplogger.com', 'iplogger.ru', '2no.co', 'yip.su', 'blasze.tk'],
  hashes: [],
};

export const TEXT_FIELDS = ['title', 'subtitle', 'label', 'site', 'author'];

export function normText(s) {
  return String(s || '')
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')       // strip accents / combining marks
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}
const squash = (s) => s.replace(/ /g, '');

function splitList(v) {
  return String(v || '').split(/[\n,]/).map((x) => x.trim()).filter(Boolean);
}

/** Merge the source constant with env overrides. Cached per (env values) string. */
let memo = { key: null, value: null };
export function loadDenylist(env = {}) {
  const key = [env.DENY_TERMS, env.DENY_LOGO_HOSTS, env.DENY_HASHES].map((x) => x || '').join('\u0000');
  if (memo.key === key && memo.value) return memo.value;
  const terms = [...DENYLIST.terms, ...splitList(env.DENY_TERMS)]
    .map((t) => normText(t)).filter((t) => t.length >= 3)
    .map((t) => ({ spaced: ` ${t} `, squashed: squash(t) }));
  const logoHosts = [...DENYLIST.logoHosts, ...splitList(env.DENY_LOGO_HOSTS)].map((h) => h.toLowerCase().replace(/^\*?\./, '').replace(/\.$/, ''));
  const hashes = new Set([...DENYLIST.hashes, ...splitList(env.DENY_HASHES)].map((h) => h.toLowerCase().replace(/^w\//, '').replace(/"/g, '')));
  memo = { key, value: { terms, logoHosts, hashes } };
  return memo.value;
}

/** Returns { field, reason } when the request is blocked, otherwise null. Never reveals the matched term. */
export function checkDenylist(opts, list) {
  for (const field of TEXT_FIELDS) {
    const n = normText(opts[field]);
    if (!n) continue;
    const spaced = ` ${n} `;
    const sq = squash(n);
    for (const t of list.terms) {
      // Whole-word/phrase match; squashed match (defeats "v e r i f y" or "v.e.r.i.f.y") only for longer terms.
      if (spaced.includes(t.spaced) || (t.squashed.length >= 8 && sq.includes(t.squashed))) return { field, reason: 'term' };
    }
  }
  if (opts.logo) {
    let host = '';
    try { host = new URL(opts.logo).hostname.toLowerCase().replace(/\.$/, ''); } catch { /* validated earlier */ }
    if (host && list.logoHosts.some((h) => host === h || host.endsWith('.' + h))) return { field: 'logo', reason: 'logo_host' };
  }
  return null;
}

export function hashDenied(hash, list) {
  return list.hashes.has(String(hash).toLowerCase());
}
