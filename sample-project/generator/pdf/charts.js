// A tiny SVG line-chart helper for the sample project's PDFs: the figures are computed from the
// physics in the page (not pasted in), so the numbers on the plots are the formulas' numbers.
// chart(el, { width, height, legend: 'tl' | 'tr' | 'bl' | 'br', x: { min, max, log, label, ticks }, y: { ... }, series: [{ name, color,
//   points: [[x, y], ...], dash, width }], bands: [{ y0, y1, color, label }], marks: [{ x, y, label }],
//   lines: [{ y, label, color }], regions: [{ path: [[x, y], ...], color, label, at: [x, y] }] })
const BRAND = { ink: '#14123A', soft: '#8A809E', grid: '#E6DED0', espresso: '#6B4226', nebula: '#3B2A6B', teal: '#2BB3A3', heart: '#D7263D', gold: '#F2B33D' }

function chart(el, o) {
  const W = o.width ?? 640, H = o.height ?? 380
  const m = { l: 74, r: 24, t: 20, b: 58 }
  const pw = W - m.l - m.r, ph = H - m.t - m.b
  const scale = (ax, size, flip) => {
    const f = ax.log ? Math.log10 : (v) => v
    const a = f(ax.min), b = f(ax.max)
    return (v) => {
      const t = (f(v) - a) / (b - a)
      return flip ? m.t + size - t * size : m.l + t * size
    }
  }
  const X = scale(o.x, pw, false), Y = scale(o.y, ph, true)
  const fmt = (v, ax) => ax.format ? ax.format(v) : ax.log ? (v >= 1000 || v < 0.01 ? `10${sup(Math.round(Math.log10(v)))}` : `${v}`) : `${v}`
  const sup = (n) => String(n).split('').map((c) => '⁰¹²³⁴⁵⁶⁷⁸⁹⁻'['0123456789-'.indexOf(c)]).join('')
  const ticks = (ax) => ax.ticks ?? (() => {
    if (ax.log) { const out = []; for (let e = Math.ceil(Math.log10(ax.min)); e <= Math.floor(Math.log10(ax.max)); e++) out.push(10 ** e); return out }
    const step = ax.step ?? (ax.max - ax.min) / 5; const out = []; for (let v = ax.min; v <= ax.max + 1e-9; v += step) out.push(+v.toFixed(6)); return out
  })()
  const parts = []
  parts.push(`<rect x="${m.l}" y="${m.t}" width="${pw}" height="${ph}" fill="#FFFDF8" stroke="${BRAND.grid}"/>`)
  for (const b of o.bands ?? []) {
    parts.push(`<rect x="${m.l}" y="${Y(b.y1)}" width="${pw}" height="${Y(b.y0) - Y(b.y1)}" fill="${b.color}" opacity="0.18"/>`)
    if (b.label) parts.push(`<text x="${m.l + pw - 8}" y="${Y(b.y1) + 16}" text-anchor="end" font-size="12" fill="${b.color}" font-weight="bold">${b.label}</text>`)
  }
  for (const r of o.regions ?? []) {
    parts.push(`<path d="M${r.path.map(([x, y]) => `${X(x).toFixed(1)} ${Y(y).toFixed(1)}`).join(' L')} Z" fill="${r.color}" opacity="0.16"/>`)
    if (r.label) parts.push(`<text x="${X(r.at[0])}" y="${Y(r.at[1])}" text-anchor="middle" font-size="14" fill="${r.color}" font-weight="bold">${r.label}</text>`)
  }
  for (const t of ticks(o.x)) {
    parts.push(`<line x1="${X(t)}" x2="${X(t)}" y1="${m.t}" y2="${m.t + ph}" stroke="${BRAND.grid}"/>`)
    parts.push(`<text x="${X(t)}" y="${m.t + ph + 20}" text-anchor="middle" font-size="12" fill="${BRAND.soft}">${fmt(t, o.x)}</text>`)
  }
  for (const t of ticks(o.y)) {
    parts.push(`<line x1="${m.l}" x2="${m.l + pw}" y1="${Y(t)}" y2="${Y(t)}" stroke="${BRAND.grid}"/>`)
    parts.push(`<text x="${m.l - 10}" y="${Y(t) + 4}" text-anchor="end" font-size="12" fill="${BRAND.soft}">${fmt(t, o.y)}</text>`)
  }
  for (const l of o.lines ?? []) {
    parts.push(`<line x1="${m.l}" x2="${m.l + pw}" y1="${Y(l.y)}" y2="${Y(l.y)}" stroke="${l.color ?? BRAND.ink}" stroke-width="1.5" stroke-dasharray="6 5"/>`)
    if (l.label) parts.push(`<text x="${m.l + pw - 8}" y="${Y(l.y) - 6}" text-anchor="end" font-size="12" fill="${l.color ?? BRAND.ink}">${l.label}</text>`)
  }
  for (const s of o.series) {
    const d = s.points.map(([x, y], i) => `${i ? 'L' : 'M'}${X(x).toFixed(1)} ${Y(y).toFixed(1)}`).join(' ')
    parts.push(`<path d="${d}" fill="none" stroke="${s.color}" stroke-width="${s.width ?? 3}" ${s.dash ? `stroke-dasharray="${s.dash}"` : ''} stroke-linejoin="round" stroke-linecap="round"/>`)
  }
  for (const k of o.marks ?? []) {
    parts.push(`<circle cx="${X(k.x)}" cy="${Y(k.y)}" r="7" fill="${k.color ?? BRAND.gold}" stroke="${BRAND.ink}" stroke-width="2"/>`)
    if (k.label) parts.push(`<text x="${X(k.x) + (k.dx ?? 12)}" y="${Y(k.y) + (k.dy ?? -10)}" font-size="13" font-weight="bold" fill="${BRAND.ink}" ${k.anchor ? `text-anchor="${k.anchor}"` : ''}>${k.label}</text>`)
  }
  parts.push(`<text x="${m.l + pw / 2}" y="${H - 14}" text-anchor="middle" font-size="14" fill="${BRAND.ink}">${o.x.label}</text>`)
  parts.push(`<text transform="translate(18 ${m.t + ph / 2}) rotate(-90)" text-anchor="middle" font-size="14" fill="${BRAND.ink}">${o.y.label}</text>`)
  // legend
  const named = o.series.filter((s) => s.name)
  const lw = Math.max(0, ...named.map((s) => s.name.length)) * 6.6 + 48
  const pos = o.legend ?? 'tl'
  const lx = pos.endsWith('r') ? m.l + pw - lw : m.l + 14
  const ly = pos.startsWith('b') ? m.t + ph - 12 - (named.length - 1) * 20 - 6 : m.t + 18
  const legend = named.map((s, i) =>
    `<g transform="translate(${lx} ${ly + i * 20})"><line x1="0" x2="26" y1="0" y2="0" stroke="${s.color}" stroke-width="${s.width ?? 3}" ${s.dash ? `stroke-dasharray="${s.dash}"` : ''}/><text x="34" y="4" font-size="12.5" fill="${BRAND.ink}">${s.name}</text></g>`).join('')
  if (legend && !o.noLegend) parts.push(`<rect x="${lx - 8}" y="${ly - 13}" width="${lw}" height="${named.length * 20 + 6}" fill="#FFFDF8" opacity="0.85" rx="4"/><g>${legend}</g>`)
  el.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="100%" font-family="Arial, sans-serif">${parts.join('')}</svg>`
}

/** n points from a to b (geometric when log). */
function range(a, b, n = 120, log = false) {
  return Array.from({ length: n }, (_, i) => (log ? a * (b / a) ** (i / (n - 1)) : a + ((b - a) * i) / (n - 1)))
}
