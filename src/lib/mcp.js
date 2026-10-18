/**
 * OgForge remote MCP server. Hand-rolled JSON-RPC 2.0 over Streamable HTTP; no SDK, no dependencies. Transport copied
 * from LinkPulse src/lib/mcp.js (SwearGuard/CheckDigit/CertGuard c2606ed/DnsGuard lineage): modern 2026-07-28 tool errors
 * keep _meta["ogforge/error"] next to serverInfo.
 *
 * Dual-era and stateless: modern 2026-07-28 (server/discover, tools/list, tools/call with per-request _meta and
 * MCP-Protocol-Version / Mcp-Method / Mcp-Name headers) and legacy (initialize, ping, tools/list, tools/call; batches
 * max 10, at most one tools/call). No sessions, no SSE: GET/DELETE -> 405.
 *
 * Validation, denylist, limits and caching are NOT implemented here: the router passes runOg() from app.js, which runs
 * the exact GET /api/og pipeline (same normalizeParams, denylist, per-IP request + render limiters, global render cap,
 * memory + edge cache). One create_og_image call = one /api/og request.
 */
import { VERSION } from './version.js';
import { LIMITS, TEMPLATES, THEMES } from './params.js';

export const MODERN_VERSIONS = ['2026-07-28'];
export const LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
export const SUPPORTED_VERSIONS = [...MODERN_VERSIONS, ...LEGACY_VERSIONS];
export const MAX_BODY_BYTES = 64 * 1024;
export const MAX_BATCH = 10;
export const MAX_CHECKS_PER_REQUEST = 1;
export const DISCOVERY_PER_MIN = 120;
const META_VERSION = 'io.modelcontextprotocol/protocolVersion';
const META_CAPS = 'io.modelcontextprotocol/clientCapabilities';
const META_SERVER = 'io.modelcontextprotocol/serverInfo';
const ERROR_META = 'ogforge/error';
export const PASS_HEADERS = ['retry-after', 'x-ogforge-cache', 'x-ogforge-tier', 'x-ogforge-truncated', 'x-ogforge-warning']; // what /api/og sends
export const E = {
  PARSE: -32700, INVALID_REQUEST: -32600, METHOD_NOT_FOUND: -32601, INVALID_PARAMS: -32602, INTERNAL: -32603,
  SERVER: -32000, HEADER_MISMATCH: -32020, UNSUPPORTED_VERSION: -32022,
};

export const MCP_CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'content-type, accept, authorization, x-api-key, mcp-protocol-version, mcp-method, mcp-name',
  'access-control-expose-headers': ['mcp-protocol-version', ...PASS_HEADERS].join(', '),
  'access-control-max-age': '86400',
};

export const SERVER_INFO = { name: 'ogforge', title: 'OgForge', version: VERSION };
export const instructions = (L = { renderPerMin: 20, reqPerMin: 120, globalRenderPerMin: 60 }) => `OgForge renders 1200x630 PNG Open Graph (social preview) images from ${TEMPLATES.length} templates (${TEMPLATES.join(', ')}). Use create_og_image with a "title" (required) and optional subtitle, label, site, author, emoji, logo (https PNG/JPEG/SVG URL), theme (light/dark) and hex colors bg/fg/accent. It returns a stable public image URL you can put in og:image / twitter:image tags, plus the rendered size; set include_image true to also get the PNG inline. Long text is truncated with an ellipsis (listed in "truncated"). No key needed; free renders carry a small "ogforge" badge. Limits (free tier, approximate, per Cloudflare location): about ${L.reqPerMin} image requests and ${L.renderPerMin} new (uncached) renders per minute per IP, and about ${L.globalRenderPerMin} new renders per minute for the whole service. Cached images do not count toward the render limit. Each create_og_image call counts as one /api/og request. Rate-limit errors include retryAfterSeconds. Impersonation, phishing and illegal content are refused (blocked_content).`;

const TEXT = (k, d) => ({ type: 'string', description: `${d} Max ${LIMITS[k]} characters (longer text is truncated with "…").`, maxLength: 1000 });
export const RESULT_OUT = { type: 'object', properties: {
  image_url: { type: 'string', description: 'Public PNG URL (GET /api/og?...). Use it as og:image / twitter:image.' },
  width: { type: 'integer' }, height: { type: 'integer' }, bytes: { type: 'integer' },
  template: { type: 'string' }, cache: { type: 'string', description: 'MISS, HIT-MEMORY or HIT-EDGE' },
  tier: { type: 'string' }, etag: { type: 'string' },
  truncated: { type: 'array', items: { type: 'string' }, description: 'Fields that were shortened to fit.' },
  warning: { type: 'string', description: 'e.g. logo_fetch_failed: the image rendered without the logo.' },
  meta_tags: { type: 'string', description: 'Ready-to-paste og:image / twitter:card meta tags.' },
}, required: ['image_url', 'width', 'height', 'template', 'cache', 'tier'] };

export const TOOL_ARGS = ['template', 'title', 'subtitle', 'label', 'site', 'author', 'emoji', 'logo', 'theme', 'bg', 'fg', 'accent'];
export const TOOLS = [
  {
    name: 'create_og_image',
    title: 'Create an Open Graph social preview image',
    description: `Render a 1200x630 PNG Open Graph / social-card image from a template and return its public URL (for og:image and twitter:image tags), size and ready-to-paste meta tags. Templates: ${TEMPLATES.join(', ')}. Optional inline PNG with include_image. Same engine, cache and free-tier limits as GET /api/og. Read-only (renders are cached; nothing is stored about you).`,
    inputSchema: { type: 'object', properties: {
      title: TEXT('title', 'Headline, e.g. "How we cut API latency by 60%".'),
      template: { type: 'string', enum: TEMPLATES, description: 'Layout (default blog).' },
      subtitle: TEXT('subtitle', 'Secondary line / description.'),
      label: TEXT('label', 'Small pill or tag, e.g. "Engineering".'),
      site: TEXT('site', 'Site or brand name, e.g. "example.dev".'),
      author: TEXT('author', 'Author or byline.'),
      emoji: { type: 'string', description: 'One emoji, e.g. 🚀', maxLength: 32 },
      logo: { type: 'string', description: `Public https:// URL of a PNG, JPEG or SVG logo (max ${LIMITS.logo} characters, 300 KB). Fetched by OgForge's server.`, maxLength: LIMITS.logo },
      theme: { type: 'string', enum: THEMES, description: 'Color scheme (default depends on the template).' },
      bg: { type: 'string', description: 'Background hex color, e.g. 0f172a.', maxLength: 7, pattern: '^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$' },
      fg: { type: 'string', description: 'Text hex color.', maxLength: 7, pattern: '^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$' },
      accent: { type: 'string', description: 'Accent hex color.', maxLength: 7, pattern: '^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$' },
      include_image: { type: 'boolean', description: 'Also return the PNG inline as MCP image content (default false; usually 30-150 KB).' },
    }, required: ['title'], additionalProperties: false },
    outputSchema: RESULT_OUT,
    annotations: { title: 'Create OG image', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
];
const ROUTE = Object.fromEntries(TOOLS.map((t) => [t.name, t]));
export const PUBLIC_TOOLS = TOOLS;

const clip = (s, n) => (typeof s === 'string' && s.length > n ? `${s.slice(0, n - 1)}…` : s);
const escAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

function toolError(message, data, extra = {}) {
  return { content: [{ type: 'text', text: message }], isError: true, ...(data ? { _meta: { [ERROR_META]: data } } : {}), ...extra };
}

function checkArgs(tool, args) {
  const props = tool.inputSchema.properties;
  const unknown = Object.keys(args).filter((k) => !Object.prototype.hasOwnProperty.call(props, k));
  if (unknown.length) return { code: 'invalid_arguments', msg: `Unknown argument(s): ${clip(unknown.slice(0, 5).join(', '), 80)}. Allowed: ${Object.keys(props).join(', ')}.` };
  if (typeof args.title !== 'string' || !args.title.trim()) return { code: 'missing_title', msg: '"title" (string) is required.' };
  for (const k of TOOL_ARGS) {
    if (args[k] !== undefined && typeof args[k] !== 'string') return { code: 'invalid_arguments', msg: `"${k}" must be a string.` };
    if (typeof args[k] === 'string' && args[k].length > (props[k].maxLength || 1000)) return { code: 'param_too_long', msg: `"${k}" is longer than ${props[k].maxLength} characters.` };
  }
  if (args.include_image !== undefined && typeof args.include_image !== 'boolean') return { code: 'invalid_arguments', msg: '"include_image" must be true or false.' };
  return null;
}

function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

async function callTool(params, deps) {
  const { name } = params;
  const args = params.arguments === undefined ? {} : params.arguments;
  const tool = typeof name === 'string' && Object.prototype.hasOwnProperty.call(ROUTE, name) ? ROUTE[name] : null;
  if (!tool) return { error: { code: E.INVALID_PARAMS, message: `Unknown tool: ${clip(String(name), 80)}` } };
  if (!args || typeof args !== 'object' || Array.isArray(args)) return { error: { code: E.INVALID_PARAMS, message: 'arguments must be an object' } };
  const bad = checkArgs(tool, args);
  if (bad) return { result: toolError(bad.msg, { code: bad.code, httpStatus: 400 }) };
  const qs = new URLSearchParams();
  for (const k of TOOL_ARGS) if (typeof args[k] === 'string' && args[k] !== '') qs.set(k, args[k]);
  const r = await deps.runOg(qs, deps.request); // same pipeline as GET /api/og
  const headers = r.headers || {};
  if (!r.ok) {
    const retry = headers['retry-after'] ? Number(headers['retry-after']) : undefined;
    const msg = clip(String(r.message || 'The image could not be created.'), 600) + (retry ? ` (retry after ${retry} seconds)` : '');
    return { result: toolError(msg, { code: String(r.code || 'error'), httpStatus: r.status, ...(retry ? { retryAfterSeconds: retry } : {}), ...(r.field ? { field: String(r.field) } : {}) }), headers };
  }
  const out = {
    image_url: r.url, width: 1200, height: 630, bytes: r.png.byteLength, template: r.template,
    cache: headers['x-ogforge-cache'] || 'MISS', tier: headers['x-ogforge-tier'] || 'free', etag: String(r.etag || '').replace(/"/g, ''),
    truncated: headers['x-ogforge-truncated'] ? headers['x-ogforge-truncated'].split(',') : [],
    meta_tags: `<meta property="og:image" content="${escAttr(r.url)}">\n<meta property="og:image:width" content="1200">\n<meta property="og:image:height" content="630">\n<meta name="twitter:card" content="summary_large_image">\n<meta name="twitter:image" content="${escAttr(r.url)}">`,
  };
  if (headers['x-ogforge-warning']) out.warning = headers['x-ogforge-warning'];
  const text = `Rendered a 1200x630 PNG (${out.bytes} bytes, template ${out.template}, cache ${out.cache}). Image URL: ${out.image_url}${out.truncated.length ? ` Truncated: ${out.truncated.join(', ')}.` : ''}${out.warning ? ` Warning: ${out.warning}.` : ''}`;
  const content = [{ type: 'text', text }];
  if (args.include_image === true) content.push({ type: 'image', data: toBase64(r.png), mimeType: 'image/png' });
  return { result: { content, structuredContent: out, isError: false }, headers };
}

// ---------- transport helpers ----------

/** Origin policy: absent = OK (CLI / server-side clients). Present: must be a bare https origin or an http loopback
 * origin, or (if MCP_ALLOWED_ORIGINS is set) same-origin / listed. Malformed, "null" and plain-http remote → 403. */
export function originAllowed(origin, selfOrigin, allowList) {
  if (origin === null || origin === undefined) return true;
  if (origin === selfOrigin) return true;
  if (allowList) return String(allowList).split(',').map((s) => s.trim()).filter(Boolean).includes(origin);
  let u;
  try { u = new URL(origin); } catch { return false; }
  if (u.origin !== origin) return false;
  if (u.protocol === 'https:') return true;
  return u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
}

async function readCapped(request, cap) {
  const cl = Number(request.headers.get('content-length'));
  if (Number.isFinite(cl) && cl > cap) return null;
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > cap) { try { await reader.cancel(); } catch { /* ignore */ } return null; }
    chunks.push(value);
  }
  const buf = new Uint8Array(size);
  let o = 0;
  for (const c of chunks) { buf.set(c, o); o += c.byteLength; }
  return new TextDecoder().decode(buf);
}

function decodeHeaderValue(v) {
  if (v == null) return v;
  const m = /^=\?base64\?([A-Za-z0-9+/=]*)\?=$/.exec(v);
  if (!m) return v;
  try { return new TextDecoder().decode(Uint8Array.from(atob(m[1]), (ch) => ch.charCodeAt(0))); } catch { return null; }
}

const isId = (id) => typeof id === 'string' || (typeof id === 'number' && Number.isFinite(id));
const rpcError = (id, code, message, data) => ({ jsonrpc: '2.0', ...(id !== undefined ? { id } : {}), error: { code, message, ...(data !== undefined ? { data } : {}) } });
const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });

/**
 * Handle one JSON-RPC message. Returns { response?, status?, headers?, isCheck? }.
 * `response` undefined = notification accepted (202 when it's the whole request).
 */
async function handleMessage(msg, { modern, request, deps, auth, checkBudget }) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return { response: rpcError(null, E.INVALID_REQUEST, 'Invalid Request'), status: 400 };
  const hasId = Object.prototype.hasOwnProperty.call(msg, 'id');
  if (msg.jsonrpc !== '2.0') return { response: rpcError(hasId && isId(msg.id) ? msg.id : null, E.INVALID_REQUEST, 'Invalid Request: jsonrpc must be "2.0"'), status: 400 };
  if (typeof msg.method !== 'string') {
    // A JSON-RPC response or garbage. Legacy clients may POST responses → accept like a notification.
    if (!modern && hasId && ('result' in msg || 'error' in msg)) return {};
    return { response: rpcError(hasId && isId(msg.id) ? msg.id : null, E.INVALID_REQUEST, 'Invalid Request: method is required'), status: 400 };
  }
  if (!hasId) return {}; // notification (notifications/initialized, cancelled, …): accepted, nothing to do
  if (!isId(msg.id)) return { response: rpcError(null, E.INVALID_REQUEST, 'Invalid Request: id must be a string or number'), status: 400 };
  const { id, method } = msg;
  const params = msg.params === undefined ? {} : msg.params;
  if (!params || typeof params !== 'object' || Array.isArray(params)) return { response: rpcError(id, E.INVALID_PARAMS, 'params must be an object') };

  // Modern results carry serverInfo in _meta; merge so a tool error's _meta["ogforge/error"] is kept (CertGuard c2606ed).
  const done = (result) => ({ response: rpcResult(id, modern ? { resultType: 'complete', ...result, _meta: { ...(result._meta || {}), [META_SERVER]: SERVER_INFO } } : result) });
  const notFound = () => ({ response: rpcError(id, E.METHOD_NOT_FOUND, `Method not found: ${clip(method, 80)}`), status: modern ? 404 : 200 });
  const instr = instructions(deps.limits);

  if (modern) {
    // MCP 2026-07-28 per-request validation (version, capabilities, mirrored headers).
    const hName = decodeHeaderValue(request.headers.get('mcp-name'));
    if (request.headers.get('mcp-method') !== method) return { response: rpcError(id, E.HEADER_MISMATCH, 'Header mismatch: Mcp-Method header is missing or does not match the body method'), status: 400 };
    if (!params._meta || typeof params._meta[META_CAPS] !== 'object' || params._meta[META_CAPS] === null) {
      return { response: rpcError(id, E.INVALID_PARAMS, `Missing required _meta field ${META_CAPS}`), status: 400 };
    }
    if (method === 'tools/call' && hName !== params.name) return { response: rpcError(id, E.HEADER_MISMATCH, 'Header mismatch: Mcp-Name header is missing or does not match params.name'), status: 400 };
    if (method === 'server/discover') {
      return done({ supportedVersions: SUPPORTED_VERSIONS, capabilities: { tools: { listChanged: false } }, instructions: instr, ttlMs: 3_600_000, cacheScope: 'public' });
    }
    if (method === 'tools/list') return done({ tools: PUBLIC_TOOLS, ttlMs: 3_600_000, cacheScope: 'public' });
    if (method !== 'tools/call') return notFound(); // includes initialize and ping (removed in 2026-07-28)
  } else {
    if (method === 'initialize') {
      const req = params.protocolVersion;
      const protocolVersion = LEGACY_VERSIONS.includes(req) ? req : LEGACY_VERSIONS[0];
      return done({ protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO, instructions: instr });
    }
    if (method === 'ping') return done({});
    if (method === 'tools/list') return done({ tools: PUBLIC_TOOLS });
    if (method === 'server/discover') return done({ supportedVersions: SUPPORTED_VERSIONS, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO, instructions: instr });
    if (method !== 'tools/call') return notFound();
  }

  // tools/call
  if (typeof params.name !== 'string') return { response: rpcError(id, E.INVALID_PARAMS, 'params.name (tool name) is required') };
  if (checkBudget.used >= MAX_CHECKS_PER_REQUEST) {
    return { response: rpcError(id, E.INVALID_REQUEST, `At most ${MAX_CHECKS_PER_REQUEST} tools/call per HTTP request; send each call as its own request.`) };
  }
  checkBudget.used++;
  const r = await callTool(params, { ...deps, request, auth });
  if (r.error) return { response: rpcError(id, r.error.code, r.error.message), isCheck: true };
  return { ...done(r.result), headers: r.headers, isCheck: true };
}

/** Entry point from the router for every request to /mcp. */
export async function handleMcp(request, env, ctx, deps) {
  const base = { ...MCP_CORS, ...deps.security };
  const reply = (status, body, extra = {}) => new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { ...(body === null ? {} : { 'content-type': 'application/json; charset=utf-8' }), 'cache-control': 'no-store', ...base, ...extra },
  });
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...MCP_CORS, ...deps.security } });
  if (!originAllowed(request.headers.get('origin'), deps.origin, deps.allowedOrigins)) {
    return reply(403, rpcError(undefined, E.SERVER, 'Forbidden: Origin not allowed'));
  }
  if (request.method !== 'POST') {
    return reply(405, rpcError(undefined, E.SERVER, 'Method not allowed. This MCP endpoint is stateless: POST JSON-RPC messages (no SSE stream, no sessions). Docs: /llms.txt'), { allow: 'POST, OPTIONS' });
  }
  const text = await readCapped(request, MAX_BODY_BYTES);
  if (text === null) return reply(413, rpcError(undefined, E.INVALID_REQUEST, `Request body too large (max ${MAX_BODY_BYTES} bytes)`));
  let payload;
  try { payload = JSON.parse(text); } catch { return reply(400, rpcError(null, E.PARSE, 'Parse error: body must be valid JSON')); }

  // Era detection. Modern = per-request _meta version or a modern MCP-Protocol-Version header.
  const hVer = request.headers.get('mcp-protocol-version');
  const single = !Array.isArray(payload);
  const metaVer = single && payload && typeof payload === 'object' && payload.params && typeof payload.params === 'object'
    && payload.params._meta && typeof payload.params._meta === 'object' ? payload.params._meta[META_VERSION] : undefined;
  const modern = metaVer !== undefined || MODERN_VERSIONS.includes(hVer);
  const idOf = (p) => (p && typeof p === 'object' && isId(p.id) ? p.id : null);
  if (modern) {
    if (!single) return reply(400, rpcError(null, E.INVALID_REQUEST, 'JSON-RPC batches are not supported in protocol 2026-07-28; send one message per POST'));
    if (payload && typeof payload === 'object' && Object.prototype.hasOwnProperty.call(payload, 'id')) {
      if (metaVer === undefined && typeof payload.method === 'string') {
        return reply(400, rpcError(idOf(payload), E.INVALID_PARAMS, `Missing required _meta field ${META_VERSION}`));
      }
      if (metaVer !== undefined && !SUPPORTED_VERSIONS.includes(metaVer)) {
        return reply(400, rpcError(idOf(payload), E.UNSUPPORTED_VERSION, 'Unsupported protocol version', { supported: SUPPORTED_VERSIONS, requested: clip(String(metaVer), 40) }));
      }
      if (metaVer !== undefined && !MODERN_VERSIONS.includes(metaVer)) {
        return reply(400, rpcError(idOf(payload), E.UNSUPPORTED_VERSION, `Protocol version ${metaVer} uses the initialize handshake; per-request _meta requires one of: ${MODERN_VERSIONS.join(', ')}`, { supported: SUPPORTED_VERSIONS, requested: metaVer }));
      }
      if (hVer !== metaVer) return reply(400, rpcError(idOf(payload), E.HEADER_MISMATCH, 'Header mismatch: MCP-Protocol-Version header is missing or does not match _meta protocolVersion'));
    }
  } else if (hVer && !LEGACY_VERSIONS.includes(hVer)) {
    return reply(400, rpcError(single ? idOf(payload) : null, E.UNSUPPORTED_VERSION, 'Unsupported protocol version', { supported: SUPPORTED_VERSIONS, requested: clip(hVer, 40) }));
  }

  const msgs = single ? [payload] : payload;
  if (!msgs.length) return reply(400, rpcError(null, E.INVALID_REQUEST, 'Invalid Request: empty batch'));
  if (msgs.length > MAX_BATCH) return reply(400, rpcError(null, E.INVALID_REQUEST, `Batch too large (max ${MAX_BATCH} messages)`));

  // Light per-IP-bucket cap on non-check messages (checks are governed by the /api/og limits inside runOg).
  const nonCheck = msgs.filter((m) => !(m && m.method === 'tools/call')).length;
  for (let i = 0; i < nonCheck; i++) {
    if (!deps.memLimit(`mcp:${deps.ipBucket}`, DISCOVERY_PER_MIN, 60_000)) {
      return reply(429, rpcError(single ? idOf(payload) : null, E.SERVER, `Too many MCP requests from your IP (about ${DISCOVERY_PER_MIN} per minute). Retry in a minute.`, { code: 'rate_limited', retryAfterSeconds: 60 }), { 'retry-after': '60' });
    }
  }

  // Same gate as /api/og (authenticate() in app.js), once per HTTP request. OgForge has no API keys yet: a key header
  // is ignored (free tier applies), exactly like /api/og.
  const auth = await deps.authenticate(request, env, ctx);
  if (!auth.ok) {
    // No WWW-Authenticate on /mcp: MCP clients treat a 401 Bearer challenge as "start OAuth discovery", which this
    // server doesn't offer; the JSON-RPC error body (data.code) is the useful signal.
    return reply(auth.status, rpcError(single ? idOf(payload) : null, E.SERVER, auth.message, { code: auth.code, httpStatus: auth.status }), { ...(auth.headers || {}) });
  }

  const mdeps = { ...deps, env, ctx };
  const checkBudget = { used: 0 };
  const responses = [];
  let status = 200;
  let headers = {};
  for (const m of msgs) {
    let out;
    try {
      out = await handleMessage(m, { modern, request, deps: mdeps, auth, checkBudget });
    } catch {
      out = { response: rpcError(idOf(m), E.INTERNAL, 'Internal error') };
    }
    if (out.response) responses.push(out.response);
    if (single) status = out.status || 200;
    if (out.headers) headers = out.headers; // the (single) tools/call /api headers, for batches too
  }
  if (!responses.length) return reply(202, null);
  const exposed = {};
  for (const h of PASS_HEADERS) if (headers[h]) exposed[h] = headers[h];
  return reply(status, single ? responses[0] : responses, exposed);
}
