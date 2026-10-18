# OgForge

Render 1200x630 Open Graph social preview images from templates; returns a cacheable PNG URL.

## Live service

- Web app and API: https://ogforge.mike-tusa.workers.dev/
- Plans: Free; Pro coming soon (https://ogforge.mike-tusa.workers.dev/pricing)
- Support: digitalpromohub.support@gmail.com

## Use it from an AI assistant (MCP)

OgForge is a remote MCP server (Streamable HTTP) at `https://ogforge.mike-tusa.workers.dev/mcp`. Tools: `create_og_image`.

Cursor and Windsurf accept this config:

```json
{
  "mcpServers": {
    "ogforge": {
      "type": "http",
      "url": "https://ogforge.mike-tusa.workers.dev/mcp"
    }
  }
}
```

Cline (MCP Servers > Remote Servers, or `cline_mcp_settings.json`) needs `"type": "streamableHttp"`:

```json
{
  "mcpServers": {
    "ogforge": {
      "type": "streamableHttp",
      "url": "https://ogforge.mike-tusa.workers.dev/mcp"
    }
  }
}
```

Claude Desktop: open Settings > Connectors, choose "Add custom connector" and paste `https://ogforge.mike-tusa.workers.dev/mcp`. Or, for clients that only support local (stdio) servers, use the mcp-remote bridge: `npx mcp-remote https://ogforge.mike-tusa.workers.dev/mcp`.

VS Code uses a `servers` key instead of `mcpServers`.

The `server.json` file is the [MCP Registry](https://registry.modelcontextprotocol.io) manifest for this server.

## Run your own copy

Requires Node.js 22+ and a Cloudflare account.

```bash
npm install
npx wrangler@4 dev      # local dev server
```

`wrangler.toml` is a template: create your own KV namespaces / D1 databases / rate-limit namespaces and replace the `<PLACEHOLDER>` values before `npx wrangler@4 deploy`. Any secrets the Worker reads go in `wrangler secret put` (or `.dev.vars` locally), never in the repo.

Optional Worker secrets (leave unset if you do not need them): `GLAMA_CLAIM` (your glama.ai connector claim token, served at `/.well-known/glama.json`).

## Third-party data

Bundles the Inter and JetBrains Mono fonts (SIL Open Font License; see `assets/fonts/LICENSE-*.txt`), `assets/resvg.wasm` from resvg-wasm 2.6.2 (MPL-2.0) and `assets/yoga.wasm` from yoga-wasm-web 0.3.3 (MIT); see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## License

MIT (c) Digital Promo Hub. See [LICENSE](LICENSE).
