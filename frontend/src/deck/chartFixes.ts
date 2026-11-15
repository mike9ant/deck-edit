/**
 * Post-render fixes for charts drawn by @diceui/pptx-core (via ECharts), so
 * they look like PowerPoint's static charts:
 *
 * - no hover tooltip / axis pointer / emphasis — a slide is a picture, and the
 *   tooltip popped up empty with a dashed line while dragging over the slide;
 * - category labels that don't fit side by side are rotated 45° (PowerPoint's
 *   automatic label rotation, `bodyPr rot="-60000000"`), instead of being
 *   drawn on top of each other;
 * - a legend placed at the top no longer overlaps the chart title;
 * - chart text is sized in points, as PowerPoint does: the renderer passes a
 *   12 pt font to ECharts as 12 px, drawing all chart text at 3/4 size.
 *
 * Applied through the `chartInstances` set the renderer fills.
 */

/** The bits of an ECharts instance we use (kept structural: echarts isn't a direct dependency). */
export interface ChartLike {
  getOption(): Record<string, unknown>
  setOption(option: Record<string, unknown>, opts?: Record<string, unknown>): void
  getWidth(): number
  getHeight(): number
  getDom?(): HTMLElement
  getDataURL?(opts: Record<string, unknown>): string
  on?(event: string, handler: () => void): void
  off?(event: string, handler: () => void): void
  isDisposed?(): boolean
}

type Opt = Record<string, any>

const toPx = (v: unknown, total: number): number => {
  if (typeof v === 'number') return v
  if (typeof v === 'string') {
    if (v.endsWith('%')) return (parseFloat(v) / 100) * total
    const n = parseFloat(v)
    if (!Number.isNaN(n)) return n
    if (v === 'top') return 0
    if (v === 'middle' || v === 'center') return total / 2
  }
  return 0
}

let measureCtx: CanvasRenderingContext2D | null = null
function textWidth(text: string, size: number, family: string, weight: string | number = 'normal') {
  measureCtx ??= document.createElement('canvas').getContext('2d')
  if (!measureCtx) return text.length * size * 0.55
  measureCtx.font = `${weight} ${size}px ${family}`
  return measureCtx.measureText(text).width
}

/** pt → px. */
const PT = 4 / 3
const scaled = (n: unknown) => (typeof n === 'number' ? Math.round(n * PT * 10) / 10 : n)

/** Font sizes of a textStyle-like object (and its rich styles) converted pt → px. */
function scaleText(t: Opt | undefined): Opt | undefined {
  if (!t) return undefined
  const out: Opt = {}
  if (typeof t.fontSize === 'number') out.fontSize = scaled(t.fontSize)
  if (t.rich && typeof t.rich === 'object') {
    out.rich = Object.fromEntries(Object.entries(t.rich as Opt).map(([k, v]) => [k, typeof (v as Opt)?.fontSize === 'number' ? { fontSize: scaled((v as Opt).fontSize) } : {}]))
  }
  return Object.keys(out).length ? out : undefined
}

/** Charts already polished (setOption changes persist; polishing twice would double-scale). */
const done = new WeakSet<object>()

function fixFontSizes(chart: ChartLike, o: Opt) {
  const patch: Opt = {}
  if (o.title) patch.title = o.title.map((t: Opt) => ({ textStyle: scaleText(t.textStyle) ?? {} }))
  for (const key of ['xAxis', 'yAxis'] as const) {
    if (o[key]) patch[key] = o[key].map((ax: Opt) => ({ axisLabel: scaleText(ax.axisLabel) ?? {}, nameTextStyle: scaleText(ax.nameTextStyle) ?? {} }))
  }
  if (o.series) patch.series = o.series.map((se: Opt) => ({ label: scaleText(se.label) ?? {} }))
  if (o.legend) patch.legend = o.legend.map((l: Opt) => ({ textStyle: scaleText(l.textStyle) ?? {} }))
  chart.setOption(patch)
  const overlay = chart.getDom?.()?.parentElement?.querySelector<HTMLElement>(':scope > .pptx-chart-custom-legend')
  overlay?.querySelectorAll<HTMLElement>('span').forEach((sp) => {
    const px = parseFloat(sp.style.fontSize)
    if (px) sp.style.fontSize = `${Math.round(px * PT * 10) / 10}px`
  })
}

/** Value-axis scaling the chart XML asks for (`c:valAx/c:scaling/c:min|max`). */
export interface AxisScaling {
  min?: number
  max?: number
}

/** Read the value axes' fixed min/max from a chart part's XML root element. */
export function valueAxisScaling(chartRoot: Element | null | undefined): AxisScaling[] {
  if (!chartRoot) return []
  const C = 'http://schemas.openxmlformats.org/drawingml/2006/chart'
  return [...chartRoot.getElementsByTagNameNS(C, 'valAx')].map((ax) => {
    const scaling = ax.getElementsByTagNameNS(C, 'scaling')[0]
    const num = (tag: string) => {
      const v = scaling?.getElementsByTagNameNS(C, tag)[0]?.getAttribute('val')
      return v != null && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : undefined
    }
    return { min: num('min'), max: num('max') }
  })
}

function polish(chart: ChartLike, scaling: AxisScaling[]) {
  if (chart.isDisposed?.() || done.has(chart)) return
  done.add(chart)
  fixFontSizes(chart, chart.getOption() as Opt)
  // The renderer skips a HIDDEN value axis's fixed min/max (c:delete="1"), so
  // ECharts picks its own range and the series no longer span the plot as in
  // PowerPoint. Restore them from the chart XML.
  {
    const o0 = chart.getOption() as Opt
    const fix: Opt = {}
    for (const key of ['yAxis', 'xAxis'] as const) {
      let i = 0
      fix[key] = (o0[key] ?? []).map((ax: Opt) => {
        if (ax.type !== 'value') return {}
        const s = scaling[i++]
        if (!s) return {}
        const out: Opt = {}
        if (s.min !== undefined && ax.min == null) out.min = s.min
        if (s.max !== undefined && ax.max == null) out.max = s.max
        return out
      })
    }
    chart.setOption(fix)
  }
  const o = chart.getOption() as Opt
  const W = chart.getWidth()
  const H = chart.getHeight()
  const patch: Opt = {
    // Static like PowerPoint: no draw-in animation (it also replayed on every edit).
    animation: false,
    tooltip: (o.tooltip ?? [{}]).map(() => ({ show: false })),
    axisPointer: [{ show: false }],
    series: (o.series ?? []).map(() => ({ emphasis: { disabled: true }, silent: true })),
  }

  // Title and a top legend: put the legend below the title when they collide.
  // The renderer draws the legend as an HTML overlay (.pptx-chart-custom-legend)
  // next to the chart canvas; ECharts' own legend is the fallback.
  const title = o.title?.[0]
  if (title?.show !== false && title?.text) {
    const tTop = toPx(title.top ?? 0, H)
    const tSize = Number(title.textStyle?.fontSize ?? 18)
    const pad = Number(Array.isArray(title.padding) ? title.padding[0] : (title.padding ?? 5))
    const titleBottom = tTop + pad * 2 + tSize * 1.25
    const overlay = chart.getDom?.()?.parentElement?.querySelector<HTMLElement>(':scope > .pptx-chart-custom-legend')
    const legend = o.legend?.[0]
    let legendBottom: number | null = null
    if (overlay && overlay.style.top && !overlay.style.bottom) {
      const lTop = parseFloat(overlay.style.top)
      if (lTop < titleBottom) overlay.style.top = `${Math.round(titleBottom + 2)}px`
      legendBottom = parseFloat(overlay.style.top) + overlay.offsetHeight
    } else if (legend && legend.show !== false && legend.bottom == null) {
      const lTop = toPx(legend.top ?? 0, H)
      if (lTop < titleBottom) patch.legend = [{ top: Math.round(titleBottom + 2) }]
      legendBottom = Math.max(lTop, titleBottom + 2) + Number(legend.itemHeight ?? 14) + 10
    }
    // Keep the plot clear of the moved legend.
    const grid = o.grid?.[0]
    if (legendBottom != null && grid && grid.top != null && toPx(grid.top, H) < legendBottom + 6) {
      patch.grid = [{ top: Math.round(legendBottom + 6) }]
    }
  }

  // Category labels that can't sit side by side: rotate 45°, show them all.
  // The plot keeps its place (PowerPoint's plot-area layout); room is only
  // added below it when the rotated labels wouldn't fit in the chart box.
  let needBottom = 0
  let needLeft = 0
  patch.xAxis = (o.xAxis ?? []).map((ax: Opt) => {
    const data: unknown[] = ax.data ?? []
    if (ax.type !== 'category' || data.length < 2 || ax.axisLabel?.show === false || ax.axisLabel?.rotate) return {}
    const grid = o.grid?.[ax.gridIndex ?? 0] ?? {}
    const plotW = Math.max(1, (grid.width != null ? toPx(grid.width, W) : W - toPx(grid.left ?? '10%', W) - toPx(grid.right ?? '10%', W)))
    const slot = plotW / data.length
    const size = Number(ax.axisLabel?.fontSize ?? 12)
    const family = String(ax.axisLabel?.fontFamily ?? 'sans-serif')
    const widest = Math.max(...data.map((d) => textWidth(String(typeof d === 'object' && d ? (d as Opt).value : d), size, family, ax.axisLabel?.fontWeight)))
    if (widest <= slot * 0.95) return {}
    needBottom = Math.max(needBottom, Math.ceil((widest + size) * Math.SQRT1_2) + 10)
    // The first label hangs left of its tick by its rotated width.
    const first = textWidth(String(typeof data[0] === 'object' && data[0] ? (data[0] as Opt).value : data[0]), size, family, ax.axisLabel?.fontWeight)
    needLeft = Math.max(needLeft, Math.ceil(first * Math.SQRT1_2 - slot / 2 + 6))
    return { axisLabel: { rotate: 45, interval: 0, hideOverlap: false } }
  })
  // Room for the rotated labels, set exactly: ECharts' containLabel (the
  // renderer's default without a manual plot layout) over-reserves for rotated
  // labels and squashes the plot well below PowerPoint's.
  const grid0 = o.grid?.[0]
  if (needBottom && grid0) {
    const g: Opt = { ...(patch.grid?.[0] ?? {}) }
    if (grid0.containLabel) {
      g.containLabel = false
      g.bottom = needBottom
      g.left = Math.max(toPx(grid0.left ?? 0, W), needLeft)
      g.height = null
    } else {
      const bottom = grid0.bottom != null ? toPx(grid0.bottom, H) : grid0.height != null ? H - toPx(grid0.top ?? 0, H) - toPx(grid0.height, H) : 60
      if (bottom < needBottom) Object.assign(g, { bottom: needBottom, height: null })
    }
    patch.grid = [g]
  }
  chart.setOption(patch)
}

/**
 * `scalingFor` maps a chart's DOM to the value-axis scaling in its chart XML
 * (see SlideRender), for the fixes the rendered option alone can't make.
 */
/**
 * Replace a chart's canvas with a PNG snapshot of it. For thumbnails: a large
 * canvas shrunk by CSS loses its thin lines (canvas downscaling skips pixels),
 * an <img> is downscaled smoothly.
 */
function snapshotAsImage(chart: ChartLike) {
  const dom = chart.getDom?.()
  if (!dom || !chart.getDataURL || dom.dataset.deckeditSnapshot) return
  const take = () => {
    if (chart.isDisposed?.()) return
    const img = document.createElement('img')
    img.src = chart.getDataURL!({ type: 'png', pixelRatio: 1, backgroundColor: 'transparent' })
    img.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block'
    dom.dataset.deckeditSnapshot = '1'
    for (const child of Array.from(dom.children)) (child as HTMLElement).style.visibility = 'hidden'
    dom.appendChild(img)
  }
  // Draw is synchronous-ish after setOption with animation off; wait a frame to be safe.
  requestAnimationFrame(() => requestAnimationFrame(take))
}

export function polishCharts(charts: Set<unknown>, scalingFor?: (dom: HTMLElement | undefined) => AxisScaling[], asImage = false) {
  for (const c of charts) {
    try {
      const chart = c as ChartLike
      polish(chart, scalingFor?.(chart.getDom?.()) ?? [])
      if (asImage) snapshotAsImage(chart)
    } catch (e) {
      console.warn('chart polish', e)
    }
  }
}
