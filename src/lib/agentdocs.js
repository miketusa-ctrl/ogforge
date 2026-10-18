// llms.txt, OpenAPI 3.1 and the MCP server card, generated from code constants and publicLimits(env). Adapted
// from LinkPulse src/lib/agentdocs.js. Never hard-code a limit here: everything comes from `L` or code
// constants.
import { TOOLS, SUPPORTED_VERSIONS, DISCOVERY_PER_MIN, MAX_BODY_BYTES as MCP_BODY, SERVER_INFO, RESULT_OUT } from './mcp.js';
import { VERSION } from './version.js';
import { LIMITS, TEMPLATES, THEMES } from './params.js';

export const SUPPORT_EMAIL = 'digitalpromohub.support@gmail.com';
export const mcpClientConfig = (origin) => ({ mcpServers: { ogforge: { type: 'http', url: `${origin}/mcp` } } });

/** L = { reqPerMin, renderPerMin, globalRenderPerMin } */
export const llmsTxt = (origin, L) => `# OgForge

> Open Graph (social preview) image API: 1200x630 PNG cards from ${TEMPLATES.length} templates via a single GET URL, for og:image and twitter:image tags. Public JSON/image API plus a remote MCP server for AI agents. No account, no key.

## For AI agents

- [MCP server](${origin}/mcp): remote MCP over Streamable HTTP (POST only, stateless, JSON responses). Protocol versions: ${SUPPORTED_VERSIONS.join(', ')}. Tools: ${TOOLS.map((t) => `\`${t.name}\` (${Object.keys(t.inputSchema.properties).join(', ')})`).join(', ')}. Read-only. Client config (most MCP clients accept this; some use a different format, for example VS Code uses a \`servers\` key): \`${JSON.stringify(mcpClientConfig(origin))}\`
- [OpenAPI 3.1 spec](${origin}/openapi.json): machine-readable description of the API
- [Docs](${origin}/docs): human-readable docs, every parameter and error code
- [Playground](${origin}/playground): build an image URL and meta tags in the browser

## Image API

- \`GET ${origin}/api/og?template=blog&title=Hello\` (alias \`/og.png\`) returns image/png 1200x630. Params: template (${TEMPLATES.join(', ')}), title (max ${LIMITS.title}), subtitle (${LIMITS.subtitle}), label (${LIMITS.label}), site (${LIMITS.site}), author (${LIMITS.author}), emoji (one), logo (https PNG/JPEG/SVG URL, max ${LIMITS.logo} chars), theme (${THEMES.join('/')}), bg/fg/accent (hex). Query string max ${LIMITS.query} characters. Longer text is truncated with "…" (X-OgForge-Truncated header).
- Cached for a year (immutable, ETag, 304 on If-None-Match). Headers: X-OgForge-Cache (MISS, HIT-MEMORY, HIT-EDGE, REVALIDATED), X-OgForge-Tier, X-OgForge-Warning (e.g. logo_fetch_failed).
- Errors: { "error": { "code", "message" } } with 400 (invalid_template, invalid_theme, invalid_color, invalid_emoji, invalid_logo, param_too_long), 403 (blocked_content), 404 (not_found), 405 (method_not_allowed), 414 (query_too_long), 429 (rate_limited or busy, with Retry-After), 500 (render_failed, internal_error).
- \`GET ${origin}/api/templates\`: templates and text limits (JSON). \`GET ${origin}/api/health\`: version.

## Limits, keys and pricing

- Free tier, no key: about ${L.reqPerMin} image requests and ${L.renderPerMin} new (uncached) renders per minute per IP, and about ${L.globalRenderPerMin} new renders per minute for the whole service (approximate, per Cloudflare location). Cached images don't count toward the render limit. Free renders carry a small "ogforge" badge. The MCP endpoint uses the same counters: each \`create_og_image\` call is one /api/og request. Non-call MCP messages don't count as renders, but are capped at about ${DISCOVERY_PER_MIN}/min per IP (HTTP 429 + Retry-After). Max MCP body ${MCP_BODY} bytes.
- [Pricing](${origin}/pricing): Free only today. Pro is coming soon; nothing is for sale and API keys are not available yet (a sent key is ignored and the free tier applies).

## Optional

- [Privacy](${origin}/#privacy): no request logs, cookies or analytics. A salted, daily-rotating hash of your network is kept for up to 9 days to count unique visitors per day; no IP address is stored.
- Acceptable use: no impersonation, phishing or illegal content (403 blocked_content).
- Contact: ${SUPPORT_EMAIL}
`;

const H = (d) => ({ description: d, schema: { type: 'string' } });
const errResp = (d, headers) => ({ description: d, ...(headers ? { headers } : {}), content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } });
const str = (name, max, d, extra = {}) => ({ name, in: 'query', required: false, description: d, schema: { type: 'string', maxLength: max, ...extra } });

export function openApiSpec(origin, L) {
  const imgHeaders = { 'x-ogforge-cache': H('MISS, HIT-MEMORY or HIT-EDGE'), 'x-ogforge-tier': H('free'), 'x-ogforge-truncated': H('Comma-separated fields that were shortened'), 'x-ogforge-warning': H('e.g. logo_fetch_failed'), etag: H('Strong ETag (cache-key hash)'), 'cache-control': H('public, max-age=31536000, immutable (300 s when degraded)') };
  const hex = { pattern: '^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$' };
  const ogParams = [
    { name: 'template', in: 'query', required: false, description: 'Layout (default blog). Alias: t', schema: { type: 'string', enum: TEMPLATES } },
    str('title', 1000, `Headline (truncated to ${LIMITS.title} characters)`),
    str('subtitle', 1000, `Secondary line (truncated to ${LIMITS.subtitle}). Alias: description`),
    str('label', 1000, `Pill / tag (truncated to ${LIMITS.label}). Alias: tag`),
    str('site', 1000, `Site name (truncated to ${LIMITS.site})`),
    str('author', 1000, `Author (truncated to ${LIMITS.author})`),
    str('emoji', 32, 'One emoji'),
    str('logo', LIMITS.logo, 'https:// PNG, JPEG or SVG URL (max 300 KB), fetched server-side', { format: 'uri' }),
    { name: 'theme', in: 'query', required: false, schema: { type: 'string', enum: THEMES } },
    str('bg', 7, 'Background hex color', hex), str('fg', 7, 'Text hex color', hex), str('accent', 7, 'Accent hex color', hex),
  ];
  const ogResponses = {
    200: { description: '1200x630 PNG', headers: imgHeaders, content: { 'image/png': { schema: { type: 'string', format: 'binary' } } } },
    304: { description: 'Not modified (If-None-Match matched the ETag)' },
    400: errResp('invalid_template, invalid_theme, invalid_color, invalid_emoji, invalid_logo or param_too_long (error.field)'),
    403: errResp('blocked_content (acceptable-use denylist)'),
    405: errResp('method_not_allowed', { allow: H('GET, HEAD, OPTIONS') }),
    414: errResp('query_too_long'),
    429: errResp('rate_limited (per IP) or busy (global render cap)', { 'retry-after': H('Seconds to wait') }),
    500: errResp('render_failed or internal_error'),
  };
  const ogOp = (operationId) => ({ get: { operationId, summary: 'Render an Open Graph image', parameters: ogParams, responses: ogResponses } });
  const allow = { allow: { schema: { type: 'string', enum: ['POST, OPTIONS'] } } };
  return {
    openapi: '3.1.0',
    info: {
      title: 'OgForge', version: VERSION, contact: { email: SUPPORT_EMAIL },
      description: `Open Graph image API: 1200x630 PNG social cards from ${TEMPLATES.length} templates. Free, no key: about ${L.reqPerMin} image requests and ${L.renderPerMin} new renders per minute per IP, ~${L.globalRenderPerMin} new renders/min service-wide. API keys are not available yet; a sent key is ignored.`,
    },
    servers: [{ url: origin }],
    security: [{}, { bearerAuth: [] }, { apiKeyHeader: [] }],
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', description: 'Reserved for the future Pro tier; ignored today.' },
        apiKeyHeader: { type: 'apiKey', in: 'header', name: 'X-Api-Key', description: 'Reserved for the future Pro tier; ignored today.' },
      },
      schemas: {
        Error: { type: 'object', properties: { error: { type: 'object', properties: { code: { type: 'string' }, message: { type: 'string' }, field: { type: 'string' }, limit: { type: 'integer' }, window: { type: 'string' }, scope: { type: 'string' } }, required: ['code', 'message'] } }, required: ['error'] },
        McpCreateOgImageResult: RESULT_OUT,
      },
    },
    paths: {
      '/api/og': ogOp('renderOgImage'),
      '/og.png': ogOp('renderOgImagePng'),
      '/api/templates': { get: { operationId: 'listTemplates', summary: 'Templates and text limits', responses: { 200: { description: 'OK', content: { 'application/json': { schema: { type: 'object' } } } } } } },
      '/api/health': { get: { operationId: 'health', summary: 'Service status and version', responses: { 200: { description: 'OK', content: { 'application/json': { schema: { type: 'object' } } } } } } },
      '/mcp': {
        post: { operationId: 'mcp', summary: `MCP JSON-RPC 2.0 (Streamable HTTP, stateless). Protocol versions ${SUPPORTED_VERSIONS.join(', ')}. Max body ${MCP_BODY} bytes.`,
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' } } } },
          responses: { 200: { description: 'JSON-RPC response (tool errors are results with isError and _meta["ogforge/error"])', headers: { 'retry-after': H('Seconds (on a rate-limited tools/call)'), 'x-ogforge-cache': H('Cache status of the rendered image') } }, 202: { description: 'Notification or client response accepted' }, 400: { description: 'Parse error, invalid request, header mismatch or unsupported version' }, 401: { description: 'Reserved (no API keys yet; no WWW-Authenticate)' }, 403: { description: 'Origin not allowed' }, 404: { description: 'Unknown method (2026-07-28)' }, 413: { description: 'Body too large' }, 429: { description: 'Too many MCP requests', headers: { 'retry-after': H('Seconds') } }, 500: { description: 'Internal error' }, 503: { description: 'Unavailable' } } },
        get: { operationId: 'mcpGet', summary: 'Not supported (stateless, no SSE)', responses: { 405: { description: 'Method not allowed', headers: allow } } },
        delete: { operationId: 'mcpDelete', summary: 'Not supported (no sessions)', responses: { 405: { description: 'Method not allowed', headers: allow } } },
      },
    },
  };
}

export const serverCard = (origin) => ({
  serverInfo: { name: SERVER_INFO.name, title: SERVER_INFO.title, version: VERSION },
  transport: { type: 'streamable-http', url: `${origin}/mcp` },
  authentication: { required: false },
  tools: TOOLS, resources: [], prompts: [],
});
