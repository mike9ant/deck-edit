/**
 * Which shape a click on a slide means. Every shape is rendered as a box (a
 * positioned element with `data-pptx-node-id`), but a click should go to what
 * is actually drawn there:
 *
 * - `shapesAt`: the top-level shapes whose box (rotation included) contains the
 *   point, topmost first.
 * - `paintsAt`: whether a shape draws something at the point, within ±1 px:
 *   a picture's non-transparent pixel, a drawn shape's fill or outline, the
 *   area its laid-out text covers (between letters and lines included), or —
 *   for tables, charts, media — its box.
 *
 * SlideEditor picks the topmost shape that paints at the point, falling back
 * to the topmost box; a selected shape keeps its whole box (for moving and
 * editing), and ⌥-click steps down through the stack.
 */

/** The point and its eight neighbours (±1 px). */
const NEAR: [number, number][] = [[0, 0], [-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, -1], [-1, 1], [1, 1]]

/** The top-level shape element (a child of the slide root) an element belongs to. */
function shapeOf(root: HTMLElement, el: Element | null): HTMLElement | null {
  while (el && el !== root) {
    if (el.parentElement === root) return el instanceof HTMLElement && el.hasAttribute('data-pptx-node-id') ? el : null
    el = el.parentElement
  }
  return null
}

/** Top-level shape ids whose box contains the client point, topmost first. */
export function shapesAt(root: HTMLElement, x: number, y: number, isShape: (id: string) => boolean): string[] {
  const out: string[] = []
  for (const el of document.elementsFromPoint(x, y)) {
    const id = shapeOf(root, el)?.getAttribute('data-pptx-node-id')
    if (id && isShape(id) && !out.includes(id)) out.push(id)
  }
  return out
}

/** Whether the shape element draws anything at the client point (±1 px). */
export function paintsAt(shape: HTMLElement, x: number, y: number): boolean {
  for (const img of shape.querySelectorAll('img')) if (imageHit(img, shape, x, y)) return true
  for (const g of shape.querySelectorAll<SVGGeometryElement>('path, rect, ellipse, circle, polygon, polyline, line')) {
    if (g.closest('defs, clipPath, mask, marker, pattern, symbol')) continue
    if (geometryHit(g, x, y)) return true
  }
  if (textHit(shape, x, y)) return true
  // No finer test for these: their box counts.
  return !!shape.querySelector('table, canvas, video, iframe, foreignObject')
}

// ── pictures ─────────────────────────────────────────────────────────────────

/** Downscaled pixels of a picture, for its alpha. null: unreadable (counts as opaque). */
const pixels = new WeakMap<HTMLImageElement, { src: string; data: ImageData | null }>()
const MAX_SIDE = 1024

function imageData(img: HTMLImageElement): ImageData | null {
  const cached = pixels.get(img)
  if (cached && cached.src === img.currentSrc) return cached.data
  let data: ImageData | null = null
  if (img.complete && img.naturalWidth && img.naturalHeight) {
    const k = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight))
    const w = Math.max(1, Math.round(img.naturalWidth * k))
    const h = Math.max(1, Math.round(img.naturalHeight * k))
    try {
      const canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!
      ctx.drawImage(img, 0, 0, w, h)
      data = ctx.getImageData(0, 0, w, h)
    } catch {
      data = null // e.g. a cross-origin image: no pixel access
    }
  }
  pixels.set(img, { src: img.currentSrc, data })
  return data
}

/**
 * The accumulated CSS transform from the shape down to the picture, as flips:
 * null when something rotates or skews it (then its box counts).
 */
function flips(el: Element, shape: HTMLElement): { x: boolean; y: boolean } | null {
  let fx = false
  let fy = false
  for (let e: Element | null = el; e; e = e === shape ? null : e.parentElement) {
    const t = getComputedStyle(e).transform
    if (!t || t === 'none') continue
    const m = new DOMMatrixReadOnly(t)
    if (Math.abs(m.b) > 1e-6 || Math.abs(m.c) > 1e-6) return null
    if (m.a < 0) fx = !fx
    if (m.d < 0) fy = !fy
  }
  return { x: fx, y: fy }
}

function imageHit(img: HTMLImageElement, shape: HTMLElement, x: number, y: number): boolean {
  const r = img.getBoundingClientRect()
  if (!NEAR.some(([dx, dy]) => x + dx >= r.left && x + dx < r.right && y + dy >= r.top && y + dy < r.bottom)) return false
  const fit = getComputedStyle(img).objectFit
  const flip = flips(img, shape)
  const data = imageData(img)
  if (!data || !flip || (fit && fit !== 'fill')) return true // can't map the point to a pixel: the box counts
  return NEAR.some(([dx, dy]) => {
    let u = (x + dx - r.left) / r.width
    let v = (y + dy - r.top) / r.height
    if (u < 0 || u >= 1 || v < 0 || v >= 1) return false
    if (flip.x) u = 1 - u
    if (flip.y) v = 1 - v
    const px = Math.min(data.width - 1, Math.floor(u * data.width))
    const py = Math.min(data.height - 1, Math.floor(v * data.height))
    return data.data[(py * data.width + px) * 4 + 3] > 16
  })
}

// ── drawn shapes ─────────────────────────────────────────────────────────────

function geometryHit(g: SVGGeometryElement, x: number, y: number): boolean {
  const svg = g.ownerSVGElement
  const ctm = g.getScreenCTM()
  if (!svg || !ctm) return false
  const cs = getComputedStyle(g)
  const fill = cs.fill !== 'none' && cs.fillOpacity !== '0' && g.tagName !== 'line' && g.tagName !== 'polyline'
  const stroke = cs.stroke !== 'none' && cs.strokeOpacity !== '0' && parseFloat(cs.strokeWidth) > 0
  if (!fill && !stroke) return false
  const inv = ctm.inverse()
  const p = svg.createSVGPoint()
  return NEAR.some(([dx, dy]) => {
    p.x = x + dx
    p.y = y + dy
    const local = p.matrixTransform(inv)
    return (fill && g.isPointInFill(local)) || (stroke && g.isPointInStroke(local))
  })
}

// ── text ─────────────────────────────────────────────────────────────────────

/** The area a shape's laid-out text covers: from its first line to its last, leftmost to rightmost. */
function textArea(shape: HTMLElement): DOMRect | null {
  const range = document.createRange()
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity
  const walker = document.createTreeWalker(shape, NodeFilter.SHOW_TEXT)
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!n.textContent?.trim() || n.parentElement?.closest('svg')) continue
    range.selectNodeContents(n)
    for (const r of range.getClientRects()) {
      if (!r.width || !r.height) continue
      left = Math.min(left, r.left)
      top = Math.min(top, r.top)
      right = Math.max(right, r.right)
      bottom = Math.max(bottom, r.bottom)
    }
  }
  return left < right ? new DOMRect(left, top, right - left, bottom - top) : null
}

function textHit(shape: HTMLElement, x: number, y: number): boolean {
  const a = textArea(shape)
  return !!a && x >= a.left - 1 && x <= a.right + 1 && y >= a.top - 1 && y <= a.bottom + 1
}
