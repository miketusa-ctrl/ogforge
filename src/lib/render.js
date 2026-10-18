// satori (layout -> SVG, text as paths) + resvg-wasm (SVG -> PNG). Wasm modules/fonts are injected
// so the same code runs in the Worker (CompiledWasm imports) and in Node tests (Buffers).
import satori, { init as initSatori } from 'satori/wasm';
import initYoga from 'yoga-wasm-web';
import { initWasm, Resvg } from '@resvg/resvg-wasm';
import { buildTree, WIDTH, HEIGHT } from './templates.js';

let ready = null;
export function setupRenderer({ yogaWasm, resvgWasm }) {
  if (!ready) {
    ready = (async () => {
      const yoga = await initYoga(yogaWasm);
      initSatori(yoga);
      await initWasm(resvgWasm);
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

export function makeFonts({ inter400, inter700, inter800, interExt400, interExt700, mono400, mono700 }) {
  return [
    { name: 'Inter', data: inter400, weight: 400, style: 'normal' },
    { name: 'Inter', data: inter700, weight: 700, style: 'normal' },
    { name: 'Inter', data: inter800, weight: 800, style: 'normal' },
    { name: 'Inter', data: interExt400, weight: 400, style: 'normal' },
    { name: 'Inter', data: interExt700, weight: 700, style: 'normal' },
    { name: 'JetBrains Mono', data: mono400, weight: 400, style: 'normal' },
    { name: 'JetBrains Mono', data: mono700, weight: 700, style: 'normal' },
  ].filter((f) => f.data);
}

// Twemoji SVGs (CC-BY 4.0) from jsDelivr, memoized per isolate. Max MAX_EMOJI fetches per render.
const TWEMOJI = 'https://cdn.jsdelivr.net/gh/jdecked/twemoji@15.1.0/assets/svg/';
const MAX_EMOJI = 6;
const emojiMemo = new Map();
export function emojiCode(seg) {
  const cps = Array.from(seg).map((c) => c.codePointAt(0));
  const keep = cps.includes(0x200d) ? cps : cps.filter((c) => c !== 0xfe0f);
  return keep.map((c) => c.toString(16)).join('-');
}

function makeAssetLoader(fetchImpl, stats) {
  return async (code, segment) => {
    if (code !== 'emoji') return []; // non-Latin scripts: no bundled font -> glyphs fall back to .notdef
    const key = emojiCode(segment);
    if (emojiMemo.has(key)) return emojiMemo.get(key);
    if (stats.emojiFetches >= MAX_EMOJI) return undefined;
    stats.emojiFetches++;
    try {
      const res = await fetchImpl(TWEMOJI + key + '.svg', { cf: { cacheTtl: 2592000, cacheEverything: true }, signal: AbortSignal.timeout(2500) });
      if (!res.ok) { emojiMemo.set(key, undefined); return undefined; }
      const svg = await res.text();
      if (svg.length > 40000 || !svg.includes('<svg')) return undefined;
      const uri = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svg)));
      if (emojiMemo.size > 500) emojiMemo.clear();
      emojiMemo.set(key, uri);
      return uri;
    } catch { return undefined; }
  };
}

// satori wraps every CSS gradient in a <pattern>; resvg rasterizes pattern fills ~4x slower than a plain
// gradient fill. For the simple case (pattern = one linearGradient filling the element's own box) point the
// fill straight at the gradient: gradientUnits=objectBoundingBox makes the result identical.
const PATTERN_RE = /<pattern id="([^"]+)" x="0" y="0" width="1" height="1" patternUnits="objectBoundingBox">(<linearGradient id="([^"]+)"[^>]*>(?:<stop [^>]*\/>)+<\/linearGradient>)<rect x="0" y="0" width="[\d.]+" height="[\d.]+" fill="url\(#\3\)"\/><\/pattern>/g;
export function optimizeSvg(svg) {
  const swaps = [];
  let out = svg.replace(PATTERN_RE, (_, pid, grad, gid) => { swaps.push([pid, gid]); return grad; });
  for (const [pid, gid] of swaps) out = out.split(`url(#${pid})`).join(`url(#${gid})`);
  return out;
}

export async function renderPng(opts, { fonts, fetchImpl, assets = {}, watermark = true }) {
  const stats = { emojiFetches: 0 };
  const tree = buildTree(opts, { assets, watermark });
  const svg = await satori(tree, { width: WIDTH, height: HEIGHT, fonts, loadAdditionalAsset: makeAssetLoader(fetchImpl, stats) });
  const resvg = new Resvg(optimizeSvg(svg), { fitTo: { mode: 'original' } });
  const img = resvg.render();
  const png = img.asPng();
  img.free?.(); resvg.free?.();
  return { png, stats };
}
