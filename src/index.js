// Worker entry: wires bundled assets (wasm as CompiledWasm, fonts as Data, pages as Text) into the router.
import yogaWasm from '../assets/yoga.wasm';
import resvgWasm from '../assets/resvg.wasm';
import inter400 from '../assets/fonts/inter-latin-400-normal.woff';
import inter700 from '../assets/fonts/inter-latin-700-normal.woff';
import inter800 from '../assets/fonts/inter-latin-800-normal.woff';
import interExt400 from '../assets/fonts/inter-latin-ext-400-normal.woff';
import interExt700 from '../assets/fonts/inter-latin-ext-700-normal.woff';
import mono400 from '../assets/fonts/jetbrains-mono-latin-400-normal.woff';
import mono700 from '../assets/fonts/jetbrains-mono-latin-700-normal.woff';
import index from '../public/index.html';
import docs from '../public/docs.html';
import playground from '../public/playground.html';
import pricing from '../public/pricing.html';
import css from '../public/style.css';
import js from '../public/playground.js.txt';
import { createApp } from './app.js';
import { setupRenderer, makeFonts, renderPng } from './lib/render.js';

const fonts = makeFonts({ inter400, inter700, inter800, interExt400, interExt700, mono400, mono700 });

async function render(opts, { assets, watermark, fetchImpl }) {
  await setupRenderer({ yogaWasm, resvgWasm });
  return renderPng(opts, { fonts, assets, watermark, fetchImpl });
}

let handle;
export default {
  fetch(request, env, ctx) {
    if (!handle) {
      const cache = typeof caches !== 'undefined' && caches.default ? caches.default : null;
      handle = createApp({ pages: { index, docs, playground, pricing, css, js }, render, cache });
    }
    return handle(request, env, ctx);
  },
};
