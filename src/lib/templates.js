// OG image templates as plain satori element trees (no JSX build step). 1200x630.
export const WIDTH = 1200;
export const HEIGHT = 630;

const h = (type, style = {}, children, extra = {}) => ({
  type,
  props: { style: type === 'div' ? { display: 'flex', ...style } : style, children, ...extra },
});

// --- colors -----------------------------------------------------------------
function hexToRgb(hex) { const n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function rgbToHex([r, g, b]) { return '#' + [r, g, b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join(''); }
export function mix(a, b, t) { const A = hexToRgb(a), B = hexToRgb(b); return rgbToHex(A.map((v, i) => v + (B[i] - v) * t)); }
export function rgba(hex, alpha) { const [r, g, b] = hexToRgb(hex); return `rgba(${r},${g},${b},${alpha})`; }
function luminance(hex) { const [r, g, b] = hexToRgb(hex).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; }

const PALETTES = {
  light: { bg: '#ffffff', fg: '#0f172a', accent: '#4f46e5' },
  dark: { bg: '#0b1020', fg: '#f8fafc', accent: '#818cf8' },
};
export const TEMPLATE_INFO = {
  blog: { theme: 'light', name: 'Blog post', description: 'Category label, big title, subtitle, author/site footer with logo or emoji. Accent bar on the left.' },
  launch: { theme: 'dark', name: 'Product launch', description: 'Centered logo/emoji tile, "now live" pill, bold title on a soft accent gradient.' },
  docs: { theme: 'dark', name: 'Docs / changelog', description: 'Monospace breadcrumb and version pill (label), title and summary. Good for docs pages and release notes.' },
  minimal: { theme: 'light', name: 'Minimal', description: 'Just a large title with a thin accent rule and a small site/author line.' },
  gradient: { theme: 'dark', name: 'Gradient', description: 'Vivid diagonal gradient (accent → bg) with white text in a glass card.' },
};

export function palette(opts) {
  const info = TEMPLATE_INFO[opts.template];
  const base = PALETTES[opts.theme || info.theme];
  let bg = opts.bg || base.bg;
  let accent = opts.accent || base.accent;
  if (opts.template === 'gradient') {
    accent = opts.accent || '#6366f1';
    bg = opts.bg || '#db2777';
  }
  // Pick a readable default text color for custom backgrounds.
  const fg = opts.fg || (opts.template === 'gradient' ? '#ffffff' : (opts.bg ? (luminance(bg) > 0.45 ? '#0f172a' : '#f8fafc') : base.fg));
  const muted = mix(fg, bg, 0.38);
  return { bg, fg, accent, muted };
}

function titleSize(title, big = false) {
  const n = Array.from(title).length;
  const s = n <= 24 ? 80 : n <= 45 ? 68 : n <= 70 ? 58 : n <= 95 ? 50 : 44;
  return big ? s + 4 : s;
}

function mark(opts, size, assets) {
  if (assets.logo) return h('img', { width: size, height: size, objectFit: 'contain', borderRadius: Math.round(size * 0.18) }, undefined, { src: assets.logo, width: size, height: size });
  if (opts.emoji) return h('div', { fontSize: Math.round(size * 0.86), width: size, height: size, alignItems: 'center', justifyContent: 'center', lineHeight: 1 }, opts.emoji);
  return null;
}

function badge(p, dark) {
  return h('div', {
    position: 'absolute', right: 28, bottom: 24, padding: '6px 14px', borderRadius: 999, fontSize: 18, fontWeight: 700,
    color: dark ? 'rgba(255,255,255,0.85)' : 'rgba(15,23,42,0.75)', background: dark ? 'rgba(255,255,255,0.12)' : 'rgba(15,23,42,0.07)',
    fontFamily: 'Inter', letterSpacing: 0.5,
  }, 'ogforge');
}

const clampText = (text, style, lines) => h('div', { display: 'block', lineClamp: lines, ...style }, text);
const compact = (arr) => arr.filter(Boolean);

function blog(o, p, a) {
  const m = mark(o, 64, a);
  return h('div', { width: WIDTH, height: HEIGHT, background: p.bg, color: p.fg, fontFamily: 'Inter', flexDirection: 'column', justifyContent: 'space-between', padding: '64px 88px 60px 100px', position: 'relative' }, compact([
    h('div', { position: 'absolute', left: 0, top: 0, bottom: 0, width: 18, background: p.accent }),
    h('div', { fontSize: 26, fontWeight: 700, color: p.accent, textTransform: 'uppercase', letterSpacing: 3, minHeight: 32 }, o.label || ' '),
    h('div', { flexDirection: 'column', flexGrow: 1, justifyContent: 'center' }, compact([
      clampText(o.title, { fontSize: titleSize(o.title), fontWeight: 800, lineHeight: 1.12, letterSpacing: -1.5 }, 3),
      o.subtitle && clampText(o.subtitle, { fontSize: 30, color: p.muted, marginTop: 24, lineHeight: 1.4 }, 2),
    ])),
    (m || o.site || o.author) && h('div', { alignItems: 'center' }, compact([
      m && h('div', { marginRight: 20 }, m),
      h('div', { flexDirection: 'column' }, compact([
        o.site && h('div', { fontSize: 28, fontWeight: 700 }, o.site),
        o.author && h('div', { fontSize: 24, color: p.muted, marginTop: 2 }, o.author),
      ])),
    ])),
  ]));
}

function launch(o, p, a) {
  const m = mark(o, 92, a);
  const dark = luminance(p.bg) < 0.45;
  return h('div', { width: WIDTH, height: HEIGHT, backgroundImage: `linear-gradient(135deg, ${p.bg} 0%, ${mix(p.bg, p.accent, dark ? 0.32 : 0.18)} 100%)`, color: p.fg, fontFamily: 'Inter', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '56px 90px', position: 'relative', textAlign: 'center' }, compact([
    m && h('div', { width: 136, height: 136, borderRadius: 32, alignItems: 'center', justifyContent: 'center', background: rgba(p.accent, 0.2), border: `2px solid ${rgba(p.accent, 0.55)}`, marginBottom: 30 }, m),
    o.label && h('div', { fontSize: 22, fontWeight: 700, color: p.bg, background: p.accent, padding: '8px 20px', borderRadius: 999, marginBottom: 22, textTransform: 'uppercase', letterSpacing: 2 }, o.label),
    clampText(o.title, { fontSize: titleSize(o.title, true), fontWeight: 800, lineHeight: 1.08, letterSpacing: -2, maxWidth: 1020 }, m ? 2 : 3),
    o.subtitle && clampText(o.subtitle, { fontSize: 30, color: p.muted, marginTop: 22, lineHeight: 1.4, maxWidth: 940 }, 2),
    (o.site || o.author) && h('div', { fontSize: 24, fontWeight: 700, color: p.muted, marginTop: 30 }, [o.site, o.author].filter(Boolean).join('  ·  ')),
  ]));
}

function docs(o, p, a) {
  const m = mark(o, 40, a);
  const crumbs = [o.site || 'docs', o.author].filter(Boolean).join(' / ');
  return h('div', { width: WIDTH, height: HEIGHT, background: p.bg, color: p.fg, fontFamily: 'Inter', flexDirection: 'column', padding: '60px 80px', position: 'relative' }, compact([
    h('div', { position: 'absolute', left: 0, right: 0, top: 0, height: 8, backgroundImage: `linear-gradient(90deg, ${p.accent}, ${mix(p.accent, p.bg, 0.7)})` }),
    h('div', { alignItems: 'center', fontFamily: 'JetBrains Mono', fontSize: 26, color: p.muted }, compact([
      m && h('div', { marginRight: 16 }, m),
      h('div', {}, crumbs),
    ])),
    h('div', { flexDirection: 'column', flexGrow: 1, justifyContent: 'center' }, compact([
      o.label && h('div', { alignSelf: 'flex-start', fontFamily: 'JetBrains Mono', fontSize: 24, fontWeight: 700, color: p.accent, border: `2px solid ${rgba(p.accent, 0.6)}`, background: rgba(p.accent, 0.12), padding: '6px 16px', borderRadius: 10, marginBottom: 26 }, o.label),
      clampText(o.title, { fontSize: titleSize(o.title) - 4, fontWeight: 800, lineHeight: 1.12, letterSpacing: -1 }, 3),
      o.subtitle && clampText(o.subtitle, { fontSize: 28, color: p.muted, marginTop: 22, lineHeight: 1.45 }, 2),
    ])),
  ]));
}

function minimal(o, p, a) {
  const m = mark(o, 44, a);
  return h('div', { width: WIDTH, height: HEIGHT, background: p.bg, color: p.fg, fontFamily: 'Inter', flexDirection: 'column', justifyContent: 'center', padding: '72px 100px', position: 'relative' }, compact([
    h('div', { width: 96, height: 8, borderRadius: 4, background: p.accent, marginBottom: 36 }),
    clampText(o.title, { fontSize: titleSize(o.title, true), fontWeight: 800, lineHeight: 1.08, letterSpacing: -2 }, 3),
    o.subtitle && clampText(o.subtitle, { fontSize: 30, color: p.muted, marginTop: 24, lineHeight: 1.4 }, 2),
    (m || o.site || o.author) && h('div', { position: 'absolute', left: 100, bottom: 56, alignItems: 'center', fontSize: 24, color: p.muted, fontWeight: 700 }, compact([
      m && h('div', { marginRight: 14 }, m),
      h('div', {}, [o.site, o.author].filter(Boolean).join('  ·  ')),
    ])),
  ]));
}

function gradient(o, p, a) {
  const m = mark(o, 80, a);
  return h('div', { width: WIDTH, height: HEIGHT, backgroundImage: `linear-gradient(135deg, ${p.accent} 0%, ${p.bg} 100%)`, color: p.fg, fontFamily: 'Inter', alignItems: 'center', justifyContent: 'center', padding: 60, position: 'relative' }, [
    h('div', { flexDirection: 'column', alignItems: 'center', textAlign: 'center', width: 1040, padding: '52px 60px', borderRadius: 36, background: 'rgba(255,255,255,0.14)' }, compact([
      m && h('div', { marginBottom: 22 }, m),
      o.label && h('div', { fontSize: 24, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 3, color: rgba(p.fg, 0.85), marginBottom: 16 }, o.label),
      clampText(o.title, { fontSize: titleSize(o.title), fontWeight: 800, lineHeight: 1.1, letterSpacing: -1.5 }, 3),
      o.subtitle && clampText(o.subtitle, { fontSize: 30, color: rgba(p.fg, 0.85), marginTop: 20, lineHeight: 1.4 }, 2),
      (o.site || o.author) && h('div', { fontSize: 24, fontWeight: 700, color: rgba(p.fg, 0.8), marginTop: 26 }, [o.site, o.author].filter(Boolean).join('  ·  ')),
    ])),
  ]);
}

const BUILDERS = { blog, launch, docs, minimal, gradient };

/** Build the element tree. assets = { logo: dataUri|null }, watermark = free-tier badge. */
export function buildTree(opts, { assets = {}, watermark = true } = {}) {
  const p = palette(opts);
  const tree = BUILDERS[opts.template](opts, p, assets);
  if (watermark) {
    const dark = opts.template === 'gradient' || opts.template === 'launch' ? luminance(p.bg) < 0.6 || opts.template === 'gradient' : luminance(p.bg) < 0.45;
    tree.props.children = [...[].concat(tree.props.children), badge(p, dark)];
  }
  return tree;
}
