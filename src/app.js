// Request router. Free of Worker-only imports so it can be unit-tested in Node (renderer, cache and fetch are injected).
import { normalizeParams, cacheKeyHash, ParamError, TEMPLATES, LIMITS, RENDER_VERSION } from './lib/params.js';
import { TEMPLATE_INFO } from './lib/templates.js';
import { loadDenylist, checkDenylist, hashDenied } from './lib/denylist.js';
import { VERSION } from './lib/version.js';
import { handleMcp } from './lib/mcp.js';
import { llmsTxt, openApiSpec, serverCard, SUPPORT_EMAIL } from './lib/agentdocs.js';
import { countVisitor } from './lib/visitors.js';

export { VERSION };
const IMAGE_CACHE_CONTROL = 'public, max-age=31536000, immutable';
const DEGRADED_CACHE_CONTROL = 'public, max-age=300';
const LOGO_MAX_BYTES = 300 * 1024;
const LOGO_TYPES = { 'image/png': 'image/png', 'image/jpeg': 'image/jpeg', 'image/jpg': 'image/jpeg', 'image/svg+xml': 'image/svg+xml' };

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, HEAD, OPTIONS',
  'access-control-allow-headers': 'content-type, x-api-key, authorization, if-none-match',
  'access-control-expose-headers': 'x-ogforge-cache, x-ogforge-tier, x-ogforge-truncated, x-ogforge-warning, etag, retry-after',
  'access-control-max-age': '86400',
};
const SECURITY = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-frame-options': 'DENY',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), usb=(), payment=()',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
};
// Images and API JSON must be embeddable / readable from any site.
const API_SECURITY = { ...SECURITY, 'cross-origin-resource-policy': 'cross-origin' };
export const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

// ---- per-isolate state ------------------------------------------------------------------------
const memLimits = new Map();
const memCache = new Map(); // hash -> { png: Uint8Array, cacheControl, at }
let memBytes = 0;
const inflight = new Map();
export const MEM_CACHE_MAX_BYTES = 12 * 1024 * 1024;
export const MEM_CACHE_MAX_ENTRIES = 150;
export function _resetForTests() { memLimits.clear(); memCache.clear(); memBytes = 0; inflight.clear(); }

function memLimit(key, limit, periodMs) {
  const now = Date.now();
  const e = memLimits.get(key);
  if (!e || now - e.start > periodMs) { memLimits.set(key, { start: now, n: 1 }); if (memLimits.size > 5000) memLimits.clear(); return true; }
  e.n++;
  return e.n <= limit;
}
function memGet(hash) {
  const e = memCache.get(hash);
  if (!e) return null;
  memCache.delete(hash); memCache.set(hash, e); // LRU bump
  return e;
}
function memDelete(hash) {
  const e = memCache.get(hash);
  if (e) { memBytes -= e.png.byteLength; memCache.delete(hash); }
}
function memPut(hash, png, cacheControl) {
  if (png.byteLength > 2 * 1024 * 1024) return;
  if (memCache.has(hash)) { memBytes -= memCache.get(hash).png.byteLength; memCache.delete(hash); }
  memCache.set(hash, { png, cacheControl, at: Date.now() });
  memBytes += png.byteLength;
  while (memCache.size > MEM_CACHE_MAX_ENTRIES || memBytes > MEM_CACHE_MAX_BYTES) {
    const [k, v] = memCache.entries().next().value;
    memCache.delete(k); memBytes -= v.png.byteLength;
  }
}

/**
 * robots.txt body. Staging: block everything. Production: everything is crawlable, including the image endpoints
 * that social crawlers (Twitterbot, LinkedInBot, facebookexternalhit, Slackbot, Discordbot…) must fetch for og:image.
 * Allow lines come first (for first-match parsers) and are longer than "/api/" (for RFC 9309 longest-match parsers);
 * only the non-image JSON endpoints under /api/ are disallowed.
 */
export function robotsTxt(env, origin) {
  if (staging(env)) return 'User-agent: *\nDisallow: /\n';
  return `User-agent: *\nAllow: /api/og\nAllow: /og.png\nDisallow: /api/health\nDisallow: /api/templates\nAllow: /\n\nSitemap: ${origin}/sitemap.xml\n`;
}

const BLOCKED_MESSAGE = `This image can't be generated: it matches OgForge's acceptable-use denylist (no impersonation, phishing or illegal content). If you think this is a mistake, contact ${SUPPORT_EMAIL}.`;

// ---- helpers ----------------------------------------------------------------------------------
function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...CORS, ...API_SECURITY, ...extra },
  });
}
const apiError = (status, code, message, extra = {}, more = {}) => json({ error: { code, message, ...more } }, status, extra);
export const PROD_ORIGIN = 'https://ogforge.mike-tusa.workers.dev';
/** Canonical tag on HTML pages. Production: fixed prod origin. Staging: omitted (never leaks a staging host). */
export function withCanonical(html, env, path) {
  const out = html.replace(/\s*<link rel="canonical"[^>]*>/g, '');
  if (staging(env)) return out;
  return out.replace('</head>', `<link rel="canonical" href="${PROD_ORIGIN}${path}">\n</head>`);
}
export function staging(env) { return String(env.PUBLIC_LAUNCH || 'false') !== 'true'; }
const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };

/** IPv4 as is; IPv6 -> its /64 (one subscriber controls a whole /64). Same output as workdayapi/linkpulse ipBucket. */
export function ipBucket(ip) {
  const s = String(ip || 'unknown').trim().toLowerCase();
  if (!s.includes(':')) return s;
  if (s.includes('.')) return s.slice(s.lastIndexOf(':') + 1); // IPv4-mapped ::ffff:a.b.c.d
  const [h, t] = s.split('::'), head = h ? h.split(':') : [], tail = t ? t.split(':') : [];
  const parts = t === undefined ? head : [...head, ...Array(Math.max(0, 8 - head.length - tail.length)).fill('0'), ...tail];
  return parts.slice(0, 4).map((x) => x.replace(/^0+(?=.)/, '') || '0').join(':') + '::/64';
}

/** Limits as published on /pricing, llms.txt, OpenAPI and MCP instructions (one source: the env vars = ratelimit bindings). */
export function publicLimits(env = {}) {
  return { reqPerMin: num(env.REQ_LIMIT_PER_MIN, 120), renderPerMin: num(env.RENDER_LIMIT_PER_MIN, 20), globalRenderPerMin: num(env.GLOBAL_RENDER_LIMIT_PER_MIN, 60) };
}

/** Shared gate for /api/og and /mcp. No key store yet: always ok, free tier (see resolveTier). */
export async function authenticate(request, env) {
  return { ok: true, ...resolveTier(request, env) };
}

export const REGISTRY_AUTH_RE = /^v=MCPv1; k=(ed25519|ecdsap384); p=[A-Za-z0-9+/=]{20,120}$/;
const AGENT_DOCS = ['/llms.txt', '/openapi.json', '/.well-known/mcp/server-card.json', '/.well-known/mcp-registry-auth', '/.well-known/glama.json'];
// Glama connector claim. Account-wide token; must stay published.
export const GLAMA_CLAIM_BODY = '{"$schema":"https://glama.ai/mcp/schemas/connector.json","claim":"<GLAMA_CLAIM_TOKEN>"}';
// Daily unique visitors: human/API entry points only. Never /api/health, docs assets, robots, agent docs or cached image hits.
const COUNTED = (path, method) => (method === 'GET' && (path === '/' || path === '/docs' || path === '/playground' || path === '/pricing'))
  || (method === 'POST' && path === '/mcp');

async function limited(binding, key, fallbackLimit) {
  if (binding && typeof binding.limit === 'function') {
    try { const { success } = await binding.limit({ key }); return !success; } catch { /* fall back */ }
  }
  return !memLimit(key, fallbackLimit, 60_000);
}

/**
 * Tier resolution. Placeholder for the future paid API-key tier: NO billing or key store is wired.
 * Keys are only ever read from headers (never the query string, because og:image URLs are public).
 * While PAID_TIER_ENABLED !== "true", every request is free tier (badge on, free limits), even with a key.
 */
export function resolveTier(request, env) {
  const auth = request.headers.get('authorization') || '';
  const key = request.headers.get('x-api-key') || (auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '');
  if (key && String(env.PAID_TIER_ENABLED || 'false') === 'true') {
    // FUTURE: look the key up (KV/D1), check plan + quota, then return { tier: 'pro', watermark: false, ... }.
    // Not implemented on purpose: there is no paid plan yet.
  }
  return { tier: 'free', watermark: true, keyIgnored: Boolean(key) };
}

function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

async function fetchLogo(url, doFetch) {
  try {
    const res = await doFetch(url, { redirect: 'follow', headers: { accept: 'image/png,image/jpeg,image/svg+xml;q=0.9', 'user-agent': 'OgForge/0.1 (+og image renderer)' }, cf: { cacheTtl: 86400, cacheEverything: true }, signal: AbortSignal.timeout(3000) });
    if (!res.ok) { res.body?.cancel?.(); return { error: `logo_http_${res.status}` }; }
    const finalUrl = res.url ? new URL(res.url) : null;
    if (finalUrl && finalUrl.protocol !== 'https:') { res.body?.cancel?.(); return { error: 'logo_not_https' }; }
    const type = LOGO_TYPES[(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()];
    if (!type) { res.body?.cancel?.(); return { error: 'logo_unsupported_type' }; }
    const len = Number(res.headers.get('content-length') || 0);
    if (len > LOGO_MAX_BYTES) { res.body?.cancel?.(); return { error: 'logo_too_large' }; }
    // Read with a hard byte cap (content-length can be missing or wrong).
    const reader = res.body.getReader();
    const chunks = []; let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > LOGO_MAX_BYTES) { reader.cancel(); return { error: 'logo_too_large' }; }
      chunks.push(value);
    }
    const buf = new Uint8Array(total); let off = 0;
    for (const c of chunks) { buf.set(c, off); off += c.byteLength; }
    if (type === 'image/svg+xml') {
      const txt = new TextDecoder().decode(buf);
      if (!/<svg[\s>]/i.test(txt)) return { error: 'logo_unsupported_type' };
    }
    return { dataUri: `data:${type};base64,${toBase64(buf)}` };
  } catch {
    return { error: 'logo_fetch_failed' };
  }
}

function imageResponse(request, png, { hash, cacheStatus, tier, cacheControl, truncated, warning }) {
  const headers = {
    'content-type': 'image/png',
    'content-length': String(png.byteLength),
    'cache-control': cacheControl,
    etag: `"${hash}"`,
    'x-ogforge-cache': cacheStatus,
    'x-ogforge-tier': tier.tier,
    ...CORS, ...API_SECURITY,
  };
  if (truncated?.length) headers['x-ogforge-truncated'] = truncated.join(',');
  if (warning) headers['x-ogforge-warning'] = warning;
  if (tier.keyIgnored) headers['x-ogforge-note'] = 'API keys are not available yet; served as free tier';
  return new Response(request.method === 'HEAD' ? null : png, { status: 200, headers });
}

// ---- app --------------------------------------------------------------------------------------
/**
 * deps:
 *  pages: { index, docs, playground, css, js }
 *  render(opts, { assets, watermark, fetchImpl }) -> Promise<{ png: Uint8Array }>
 *  cache: Cache-like ({ match, put }) or null (caches.default in the Worker)
 *  fetchImpl: fetch
 */
export function createApp(deps) {
  const route = createRouter(deps);
  return async function handle(request, env = {}, ctx = {}) {
    let res;
    try {
      res = await route(request, env, ctx);
    } catch {
      res = apiError(500, 'internal_error', 'Unexpected server error. Please retry.');
    }
    if (staging(env)) res.headers.set('x-robots-tag', 'noindex, nofollow');
    else res.headers.delete('x-robots-tag');
    return res;
  };
}

function createRouter({ pages = {}, render, cache = null, fetchImpl }) {
  const doFetch = fetchImpl || ((...a) => fetch(...a)); // never pass bare `fetch` (Illegal invocation on Workers)

  async function og(request, env, ctx, url) {
    if (request.method !== 'GET' && request.method !== 'HEAD') return apiError(405, 'method_not_allowed', 'Use GET /api/og?title=…', { allow: 'GET, HEAD, OPTIONS' });
    let parsed;
    try { parsed = normalizeParams(url.searchParams); } catch (e) {
      if (e instanceof ParamError) return apiError(e.httpStatus, e.code, e.message, {}, e.field ? { field: e.field } : {});
      throw e;
    }
    const { opts, truncated } = parsed;
    // Acceptable-use denylist (text terms + logo hosts), before rate limiting and before any cache lookup.
    const deny = loadDenylist(env);
    const blocked = checkDenylist(opts, deny);
    if (blocked) return apiError(403, 'blocked_content', BLOCKED_MESSAGE, {}, { field: blocked.field });
    const ip = ipBucket(request.headers.get('cf-connecting-ip') || 'local');
    const tier = resolveTier(request, env);

    // 1) Every image request (hit or miss) counts toward a generous per-IP request cap.
    const reqLimit = num(env.REQ_LIMIT_PER_MIN, 120);
    if (await limited(env.REQ_LIMITER, `req:${ip}`, reqLimit)) {
      return apiError(429, 'rate_limited', `Too many requests from your IP (free tier: about ${reqLimit} image requests per minute). Wait a minute and retry.`, { 'retry-after': '60' }, { limit: reqLimit, window: '60s', scope: 'ip' });
    }

    const hash = await cacheKeyHash(opts, tier.tier);
    const cacheReq = new Request(`${url.origin}/__og-cache/${RENDER_VERSION}/${hash}.png`, { method: 'GET' });
    // Single-image takedown by cache-key hash (ETag), checked before 304/memory/edge so cached copies stop being served.
    if (hashDenied(hash, deny)) {
      memDelete(hash);
      if (cache && typeof cache.delete === 'function') {
        const del = cache.delete(cacheReq).catch(() => {});
        if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(del);
      }
      return apiError(403, 'blocked_content', BLOCKED_MESSAGE);
    }
    const etag = `"${hash}"`;
    const inm = request.headers.get('if-none-match');
    if (inm && inm.split(',').map((s) => s.trim().replace(/^W\//, '')).includes(etag)) {
      return new Response(null, { status: 304, headers: { etag, 'cache-control': IMAGE_CACHE_CONTROL, 'x-ogforge-cache': 'REVALIDATED', ...CORS, ...API_SECURITY } });
    }

    const mem = memGet(hash);
    if (mem) return imageResponse(request, mem.png, { hash, cacheStatus: 'HIT-MEMORY', tier, cacheControl: mem.cacheControl, truncated });

    // also works on workers.dev).
    if (cache) {
      try {
        const hit = await cache.match(cacheReq);
        if (hit) {
          const png = new Uint8Array(await hit.arrayBuffer());
          memPut(hash, png, IMAGE_CACHE_CONTROL);
          return imageResponse(request, png, { hash, cacheStatus: 'HIT-EDGE', tier, cacheControl: IMAGE_CACHE_CONTROL, truncated });
        }
      } catch { /* cache unavailable: render */ }
    }

    // 4) Render (cache miss): stricter per-IP and global render caps keep CPU and daily usage bounded.
    if (!inflight.has(hash)) {
      const renderLimit = num(env.RENDER_LIMIT_PER_MIN, 20);
      if (await limited(env.RENDER_LIMITER, `render:${ip}`, renderLimit)) {
        return apiError(429, 'rate_limited', `Too many new renders from your IP (free tier: about ${renderLimit} uncached renders per minute; cached images don't count). Wait a minute and retry.`, { 'retry-after': '60' }, { limit: renderLimit, window: '60s', scope: 'ip' });
      }
      const globalLimit = num(env.GLOBAL_RENDER_LIMIT_PER_MIN, 60);
      if (await limited(env.GLOBAL_LIMITER, 'render:global', globalLimit)) {
        return apiError(429, 'busy', 'The free renderer is at capacity right now. Cached images still work; please retry in a minute.', { 'retry-after': '60' }, { scope: 'global' });
      }
    }

    let job = inflight.get(hash);
    if (!job) {
      job = (async () => {
        let warning = null;
        const assets = {};
        if (opts.logo) {
          const r = await fetchLogo(opts.logo, doFetch);
          if (r.dataUri) assets.logo = r.dataUri; else warning = r.error;
        }
        const { png } = await render(opts, { assets, watermark: tier.watermark, fetchImpl: doFetch });
        return { png, warning };
      })();
      inflight.set(hash, job);
      job.finally(() => inflight.delete(hash)).catch(() => {});
    }
    let out;
    try { out = await job; } catch {
      return apiError(500, 'render_failed', 'Could not render this image. Try shorter text or a different logo.');
    }
    const { png, warning } = out;
    // Degraded renders (logo failed) get a short TTL and are not stored, so they heal once the logo is reachable.
    const cacheControl = warning ? DEGRADED_CACHE_CONTROL : IMAGE_CACHE_CONTROL;
    if (!warning) {
      memPut(hash, png, cacheControl);
      if (cache) {
        const put = cache.put(cacheReq, new Response(png, { headers: { 'content-type': 'image/png', 'cache-control': IMAGE_CACHE_CONTROL } })).catch(() => {});
        if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(put); else await put;
      }
    }
    return imageResponse(request, png, { hash, cacheStatus: 'MISS', tier, cacheControl, truncated, warning });
  }

  /**
   * MCP create_og_image: the exact GET /api/og pipeline (validation, denylist, limiters, caches, render), run on a
   * synthetic GET that carries only the caller's IP and key headers. -> { ok, url, png, etag, template, headers } | { ok:false, ... }
   */
  async function runOg(qs, request, env, ctx, origin) {
    const u = new URL(`${origin}/api/og?${qs.toString()}`);
    const h = new Headers();
    for (const k of ['cf-connecting-ip', 'authorization', 'x-api-key']) if (request.headers.get(k)) h.set(k, request.headers.get(k));
    const res = await og(new Request(u.href, { method: 'GET', headers: h }), env, ctx, u);
    const headers = Object.fromEntries(res.headers);
    if (res.status !== 200) {
      let e = {}; try { e = (await res.json()).error || {}; } catch { /* not json */ }
      return { ok: false, status: res.status, code: e.code || 'error', message: e.message, field: e.field, headers };
    }
    const png = new Uint8Array(await res.arrayBuffer());
    let template = 'blog'; try { template = normalizeParams(u.searchParams).opts.template; } catch { /* validated already */ }
    return { ok: true, url: u.href, png, etag: headers.etag, template, headers };
  }

  return async function route(request, env = {}, ctx = {}) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const method = request.method.toUpperCase();
    const ip = request.headers.get('cf-connecting-ip') || 'local';
    if (COUNTED(path, method)) countVisitor(request, env, ctx, ipBucket(ip));

    if (path === '/mcp') {
      return handleMcp(request, env, ctx, {
        authenticate, ip, ipBucket: ipBucket(ip), memLimit, origin: url.origin, allowedOrigins: env.MCP_ALLOWED_ORIGINS,
        limits: publicLimits(env), security: API_SECURITY,
        runOg: (qs, req) => runOg(qs, req, env, ctx, url.origin),
      });
    }
    if (AGENT_DOCS.includes(path)) {
      const AGENT_CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, HEAD, OPTIONS', 'access-control-max-age': '86400' };
      if (method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...AGENT_CORS, ...API_SECURITY } });
      if (method !== 'GET' && method !== 'HEAD') return apiError(405, 'method_not_allowed', 'Use GET.', { allow: 'GET, HEAD, OPTIONS' });
      const doc = (body, type, cache = 'public, max-age=3600', status = 200) => new Response(method === 'HEAD' ? null : body, {
        status, headers: { 'content-type': type, 'cache-control': cache, ...API_SECURITY, 'access-control-allow-origin': '*' },
      });
      const PL = publicLimits(env);
      if (path === '/llms.txt') return doc(llmsTxt(url.origin, PL), 'text/plain; charset=utf-8');
      if (path === '/openapi.json') return doc(JSON.stringify(openApiSpec(url.origin, PL), null, 2), 'application/json; charset=utf-8');
      if (path === '/.well-known/mcp/server-card.json') return doc(JSON.stringify(serverCard(url.origin), null, 2), 'application/json; charset=utf-8');
      if (path === '/.well-known/glama.json') return doc(GLAMA_CLAIM_BODY, 'application/json');
      const v = String(env.MCP_REGISTRY_AUTH || '');
      if (REGISTRY_AUTH_RE.test(v)) return doc(v, 'text/plain; charset=utf-8', 'no-store');
      return doc('Not found\n', 'text/plain; charset=utf-8', 'no-store', 404);
    }

    if (request.method === 'OPTIONS' && (path.startsWith('/api/') || path === '/og.png')) return new Response(null, { status: 204, headers: { ...CORS } });
    if (path === '/api/og' || path === '/og.png') return og(request, env, ctx, url);

    if (path === '/api/templates') {
      const base = `${url.origin}/api/og`;
      return json({
        templates: TEMPLATES.map((id) => ({ id, ...TEMPLATE_INFO[id], defaultTheme: TEMPLATE_INFO[id].theme, example: `${base}?template=${id}&title=${encodeURIComponent('Hello from OgForge')}` })),
        limits: LIMITS,
      }, 200, { 'cache-control': 'public, max-age=3600' });
    }
    if (path === '/api/health') {
      return json({ ok: true, service: 'ogforge', version: VERSION, renderVersion: RENDER_VERSION, publicLaunch: !staging(env), paidTier: String(env.PAID_TIER_ENABLED || 'false') === 'true' });
    }
    if (path.startsWith('/api/')) return apiError(404, 'not_found', 'Unknown API endpoint. See /docs.');

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method not allowed', { status: 405, headers: { 'content-type': 'text/plain; charset=utf-8', allow: 'GET, HEAD', ...SECURITY } });
    }
    const page = (body, type, cache = 'public, max-age=300', status = 200) => new Response(request.method === 'HEAD' ? null : body, {
      status, headers: { 'content-type': type, 'cache-control': cache, ...SECURITY, 'content-security-policy': CSP },
    });
    const fill = (html) => html.replaceAll('{{ORIGIN}}', url.origin);
    if (path === '/') return page(withCanonical(fill(pages.index || ''), env, '/'), 'text/html; charset=utf-8');
    if (path === '/docs') return page(withCanonical(fill(pages.docs || ''), env, '/docs'), 'text/html; charset=utf-8');
    if (path === '/playground') return page(withCanonical(fill(pages.playground || ''), env, '/playground'), 'text/html; charset=utf-8');
    if (path === '/pricing') return page(withCanonical(pricingHtml(fill(pages.pricing || ''), env), env, '/pricing'), 'text/html; charset=utf-8');
    if (path === '/playground.js') return page(pages.js || '', 'text/javascript; charset=utf-8');
    if (path === '/style.css') return page(pages.css || '', 'text/css; charset=utf-8');
    if (path === '/robots.txt') {
      return page(robotsTxt(env, url.origin), 'text/plain; charset=utf-8');
    }
    if (path === '/sitemap.xml' && !staging(env)) {
      return page(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>${url.origin}/</loc></url>\n  <url><loc>${url.origin}/docs</loc></url>\n  <url><loc>${url.origin}/playground</loc></url>\n  <url><loc>${url.origin}/pricing</loc></url>\n</urlset>\n`, 'application/xml; charset=utf-8');
    }
    if (path === '/favicon.ico' || path === '/favicon.svg') {
      return page(FAVICON, 'image/svg+xml', 'public, max-age=86400');
    }
    return page('Not found', 'text/plain; charset=utf-8', 'no-store', 404);
  };
}

/** /pricing: limits filled from publicLimits(env) (same numbers the limiter enforces). */
export function pricingHtml(html, env) {
  const L = publicLimits(env);
  return html.replaceAll('{{REQ_PER_MIN}}', String(L.reqPerMin)).replaceAll('{{RENDER_PER_MIN}}', String(L.renderPerMin))
    .replaceAll('{{GLOBAL_RENDER_PER_MIN}}', String(L.globalRenderPerMin)).replaceAll('{{TEMPLATE_COUNT}}', String(TEMPLATES.length))
    .replaceAll('{{SUPPORT_EMAIL}}', SUPPORT_EMAIL);
}

export const FAVICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#6366f1"/><stop offset="1" stop-color="#db2777"/></linearGradient></defs><rect width="32" height="32" rx="7" fill="url(#g)"/><rect x="6" y="9" width="20" height="14" rx="2.5" fill="none" stroke="#fff" stroke-width="2"/><path d="M10 19l4-4 3 3 2-2 3 3" fill="none" stroke="#fff" stroke-width="2" stroke-linejoin="round"/></svg>';
