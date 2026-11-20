/**
 * Font, size and color for the slide toolbar (FormatTools.tsx, applied by SlideEditor).
 *
 * - Sizes step through PowerPoint's preset list (`stepSize`), run by run.
 * - The font list is the deck's own: the theme's heading and body fonts and every typeface its
 *   slides use (`deckFonts`).
 * - The color popup offers black, white and PowerPoint's standard colors, then the deck's colors —
 *   every color its slides use for text, fills, lines and backgrounds, plus its theme palette —
 *   in color-wheel order (`deckColors`).
 */

import type { PresentationData } from '@diceui/pptx-core'
import { PPTX_ATTRS } from '@diceui/pptx-core'
import { domPointAt, readParagraphsAt, type TextPoint } from './textEdit'

/** PowerPoint's font size list. */
export const PRESET_SIZES = [8, 9, 10, 10.5, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 40, 44, 48, 54, 60, 66, 72, 80, 88, 96]

/** The next preset size up / down (beyond the list: steps of 10 pt / down to 1 pt). */
export function stepSize(pt: number, dir: 1 | -1): number {
  if (dir > 0) return PRESET_SIZES.find((s) => s > pt + 0.01) ?? Math.floor(pt / 10) * 10 + 10
  const down = [...PRESET_SIZES].reverse().find((s) => s < pt - 0.01)
  return down ?? Math.max(1, Math.ceil(pt) - 1)
}

/** A typed size, in PowerPoint's limits (1–4000 pt, half points); null if it isn't a number. */
export function parseSize(text: string): number | null {
  const n = Number(text.trim().replace(/\s*pt$/i, ''))
  if (!Number.isFinite(n) || n <= 0) return null
  return Math.min(4000, Math.max(1, Math.round(n * 2) / 2))
}

/** Black and white, then PowerPoint's ten standard colors. */
export const STANDARD_COLORS = ['000000', 'FFFFFF', 'C00000', 'FF0000', 'FFC000', 'FFFF00', '92D050', '00B050', '00B0F0', '0070C0', '002060', '7030A0']

/** The raw XML element behind a parsed node (pptx-core keeps it on a private field). */
const elementOf = (node: unknown): Element | null => ((node as { el?: Element | null } | undefined)?.el ?? null)

/** Every element named `local` (any namespace) under the slides' shapes and backgrounds. */
function slideElements(pres: PresentationData, local: string): Element[] {
  const out: Element[] = []
  for (const slide of pres.slides) {
    const roots = [...slide.nodes.map((n) => elementOf(n.source)), elementOf(slide.background)]
    for (const r of roots) if (r) out.push(...Array.from(r.getElementsByTagNameNS('*', local)))
  }
  return out
}

/** The typefaces the deck uses: its theme's heading and body fonts first, then the slides', by use. */
export function deckFonts(pres: PresentationData): string[] {
  const themeFonts: string[] = []
  for (const t of pres.themes.values()) for (const f of [t.majorFont?.latin, t.minorFont?.latin]) if (f && !themeFonts.includes(f)) themeFonts.push(f)
  const counts = new Map<string, number>()
  for (const el of slideElements(pres, 'latin')) {
    const face = el.getAttribute('typeface')
    if (face && !face.startsWith('+')) counts.set(face, (counts.get(face) ?? 0) + 1)
  }
  const used = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([f]) => f).filter((f) => !themeFonts.includes(f))
  return [...themeFonts, ...used]
}

/** Every color the deck uses (slides' text, fills, lines, backgrounds; the theme palette), in color-wheel order. */
export function deckColors(pres: PresentationData): string[] {
  const set = new Set<string>()
  for (const el of slideElements(pres, 'srgbClr')) {
    const v = el.getAttribute('val')
    if (v && /^[0-9a-f]{6}$/i.test(v)) set.add(v.toUpperCase())
  }
  for (const t of pres.themes.values()) {
    for (const [name, v] of t.colorScheme) if (name !== 'hlink' && name !== 'folHlink' && /^[0-9a-f]{6}$/i.test(v)) set.add(v.toUpperCase())
  }
  return sortByHue([...set])
}

function hsl(hex: string): [number, number, number] {
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  if (max === min) return [0, 0, l]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  const h = max === r ? ((g - b) / d + (g < b ? 6 : 0)) : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  return [h * 60, s, l]
}

/** Color-wheel order: hues around the wheel (each from dark to light), then grays from black to white. */
export function sortByHue(colors: string[]): string[] {
  const grays = colors.filter((c) => hsl(c)[1] < 0.12)
  const hued = colors.filter((c) => hsl(c)[1] >= 0.12)
  // Hue in 24 bands (15°), so near-equal hues line up by lightness instead of jittering.
  hued.sort((a, b) => {
    const [ha, , la] = hsl(a)
    const [hb, , lb] = hsl(b)
    return Math.floor(ha / 15) - Math.floor(hb / 15) || la - lb
  })
  grays.sort((a, b) => hsl(a)[2] - hsl(b)[2])
  return [...hued, ...grays]
}

/** A computed CSS color as RRGGBB (null for transparent / unknown). */
export function cssToHex(css: string | null | undefined): string | null {
  const m = css?.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?/)
  if (!m || (m[4] !== undefined && Number(m[4]) === 0)) return null
  return [m[1], m[2], m[3]].map((n) => Math.round(Number(n)).toString(16).padStart(2, '0')).join('').toUpperCase()
}

/** A rendered font size in points (the renderer lays slides out at 96 px per inch). */
export const pxToPt = (px: string) => Math.round(parseFloat(px) * 0.75 * 2) / 2

/** The first family of a CSS font-family list. */
export const firstFamily = (css: string) => css.split(',')[0].trim().replace(/^["']|["']$/g, '')

/**
 * The text between two positions of a rendered text container, split into runs of one size:
 * [start, end) positions and the size in points — for stepping each run's size separately.
 */
export function sizeRuns(container: HTMLElement, start: TextPoint, end: TextPoint): { start: TextPoint; end: TextPoint; pt: number }[] {
  const a = domPointAt(container, start, 'start')
  const b = domPointAt(container, end, 'end')
  if (!a || !b) return []
  const range = document.createRange()
  range.setStart(a[0], a[1])
  range.setEnd(b[0], b[1])
  // Each text node in the range (bullets aside), clipped to it, with its size.
  const pieces: { from: [Node, number]; to: [Node, number]; pt: number }[] = []
  const w = document.createTreeWalker(container, NodeFilter.SHOW_TEXT)
  for (let n = w.nextNode() as Text | null; n; n = w.nextNode() as Text | null) {
    if (!n.data || !range.intersectsNode(n) || n.parentElement?.closest(`[${PPTX_ATTRS.bullet}]`)) continue
    const s = n === range.startContainer ? range.startOffset : 0
    const e = n === range.endContainer ? range.endOffset : n.data.length
    if (e <= s) continue
    pieces.push({ from: [n, s], to: [n, e], pt: pxToPt(getComputedStyle(n.parentElement!).fontSize) })
  }
  if (!pieces.length) return []
  const { positions } = readParagraphsAt(container, pieces.flatMap((p) => [p.from, p.to]))
  const out: { start: TextPoint; end: TextPoint; pt: number }[] = []
  pieces.forEach((p, i) => {
    const s = positions[2 * i]
    const e = positions[2 * i + 1]
    if (!s || !e) return
    const last = out[out.length - 1]
    // Neighbouring pieces of the same size become one run.
    if (last && last.pt === p.pt && last.end.p === s.p && last.end.o === s.o) last.end = e
    else out.push({ start: s, end: e, pt: p.pt })
  })
  return out
}
