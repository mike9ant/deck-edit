/**
 * Answers the agent's `screenshot_slide` tool: renders the requested slide
 * (or PDF page) exactly as the app shows it and posts a PNG back.
 *
 * Slides are rasterized with html-to-image (captured until stable in WebKit, see
 * capturePng). Fonts registered through the
 * FontFace API (the deck's embedded fonts) aren't visible to it, so we decode
 * the embedded font parts ourselves and hand it matching @font-face CSS.
 *
 * With `showNotes`, the slide's open notes are drawn on top — the user's
 * freehand marks and a tag with each note's id at its pin — so the agent can
 * see exactly which area a note points at.
 */

import { toPng } from 'html-to-image'
import { renderSlide, type PresentationData } from '@diceui/pptx-core'
import { decodeEmbeddedFont } from '@diceui/pptx-core/fonts'
import * as pdfjs from 'pdfjs-dist'
import { api } from './api/client'
import type { Note, ServerEvent } from './api/types'
import { notesForSlide, useNotes } from './store/notesStore'
import { NOTE_COLORS } from './notes/NoteDrawing'
import { docKind, useApp } from './store/appStore'
import { deckKey, useDecks } from './deck/deckStore'
import { mediaCache } from './deck/SlideRender'
import { polishCharts } from './deck/chartFixes'
import { scalingForChart } from './deck/SlideRender'
import { pdfKey, usePdfs } from './pdf/pdfStore'

const fontCss = new WeakMap<PresentationData, string>()

/** Safari's engine (the desktop app's web view), not Chrome's. */
const isWebKit = /AppleWebKit/.test(navigator.userAgent) && !/Chrome|Chromium|Edg\//.test(navigator.userAgent)

/**
 * html-to-image draws the slide as an SVG (its HTML in a foreignObject) onto a canvas. WebKit only
 * decodes the pictures inside that SVG once it has been drawn, so the first capture comes out
 * without them — no pictures, no background picture. There, capture until two captures agree
 * (at most four); Chrome gets it right the first time.
 */
async function capturePng(el: HTMLElement, options: Parameters<typeof toPng>[1]): Promise<string> {
  let url = await toPng(el, options)
  if (!isWebKit) return url
  for (let i = 0; i < 3; i++) {
    const next = await toPng(el, options)
    if (next === url) break
    url = next
  }
  return url
}

function embeddedFontCss(pres: PresentationData): string {
  const cached = fontCss.get(pres)
  if (cached !== undefined) return cached
  const rules: string[] = []
  const variants = [
    ['regular', 'normal', 400],
    ['bold', 'normal', 700],
    ['italic', 'italic', 400],
    ['boldItalic', 'italic', 700],
  ] as const
  for (const f of pres.embeddedFonts ?? []) {
    for (const [k, style, weight] of variants) {
      const v = f[k]
      const part = v && pres.fonts.get(v.path)
      if (!v || !part) continue
      const bytes = decodeEmbeddedFont(part, v.fontKey)
      if (!bytes) continue
      let bin = ''
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
      rules.push(`@font-face{font-family:"${f.typeface}";font-style:${style};font-weight:${weight};src:url(data:font/ttf;base64,${btoa(bin)}) format("truetype");}`)
    }
  }
  const css = rules.join('\n')
  fontCss.set(pres, css)
  return css
}

function openNotesOn(deck: string, slideId: string, n: number): Note[] {
  return notesForSlide(useNotes.getState().notes, deck, slideId, n).filter((x) => x.status === 'open')
}

/** The notes as an SVG overlay for a w×h image: marks, then an id tag at each pin. */
function notesSvg(notes: Note[], w: number, h: number): string {
  const lw = Math.max(3, w / 300)
  const fs = Math.max(12, w / 70)
  const parts: string[] = []
  for (const n of notes) {
    const c = n.author === 'agent' ? NOTE_COLORS.agent : NOTE_COLORS.user
    for (const s of n.strokes ?? []) {
      parts.push(`<polyline points="${s.map(([x, y]) => `${x * w},${y * h}`).join(' ')}" fill="none" stroke="${c}" stroke-width="${lw}" stroke-linecap="round" stroke-linejoin="round"/>`)
    }
    const label = `note ${n.id}`
    const tw = label.length * fs * 0.6 + fs
    const px = Math.min(Math.max(0, n.x * w), w - tw)
    const py = Math.max(fs * 1.6, n.y * h)
    parts.push(`<rect x="${px}" y="${py - fs * 1.6}" width="${tw}" height="${fs * 1.5}" rx="${fs * 0.4}" fill="${c}"/>`)
    parts.push(`<text x="${px + fs / 2}" y="${py - fs * 0.5}" font-family="Helvetica, Arial, sans-serif" font-size="${fs}" font-weight="700" fill="#fff">${label}</text>`)
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${parts.join('')}</svg>`
}

async function slidePng(pid: string, deck: string, slideNumber: number, showNotes: boolean): Promise<string> {
  const decks = useDecks.getState()
  const key = deckKey(pid, deck)
  if (!decks.sessions[key]) await decks.open(pid, deck)
  const s = useDecks.getState().sessions[key]
  if (!s?.pres) throw new Error(s?.error ?? 'deck failed to load')
  const pres = s.pres
  const slide = pres.slides[slideNumber - 1]
  if (!slide) throw new Error(`slide ${slideNumber} does not exist (the deck has ${pres.slides.length})`)
  const host = document.createElement('div')
  host.className = 'pptx-render'
  host.style.cssText = `position:fixed;left:-20000px;top:0;width:${pres.width}px;height:${pres.height}px;overflow:hidden;background:#fff`
  document.body.appendChild(host)
  const charts = new Set<never>()
  const handle = renderSlide(pres, slide, { mediaUrlCache: mediaCache(key, pres), chartInstances: charts as never })
  host.appendChild(handle.element)
  try {
    await handle.ready
    await new Promise((r) => requestAnimationFrame(r))
    polishCharts(charts, (dom) => scalingForChart(pres, slide, dom))
    // ECharts animates its first draw — let it finish before capturing.
    await new Promise((r) => setTimeout(r, charts.size ? 900 : 0))
    await document.fonts.ready
    await Promise.all(
      [...host.querySelectorAll('img')].map((img) => (img.complete ? null : new Promise((r) => { img.onload = img.onerror = r }))),
    )
    const notes = showNotes ? openNotesOn(deck, s.sldIds.get(slide.id) ?? '', slideNumber) : []
    if (notes.length) {
      const overlay = document.createElement('div')
      overlay.style.cssText = 'position:absolute;left:0;top:0;pointer-events:none;z-index:2147483647'
      overlay.innerHTML = notesSvg(notes, pres.width, pres.height)
      if (getComputedStyle(handle.element).position === 'static') handle.element.style.position = 'relative'
      handle.element.appendChild(overlay)
    }
    return await capturePng(handle.element, { width: pres.width, height: pres.height, pixelRatio: 1.5, backgroundColor: '#ffffff', fontEmbedCSS: embeddedFontCss(pres) })
  } finally {
    handle.dispose()
    host.remove()
  }
}

async function pagePng(pid: string, path: string, pageNumber: number, showNotes: boolean): Promise<string> {
  const store = usePdfs.getState()
  const key = pdfKey(pid, path)
  if (!store.sessions[key]) await store.open(pid, path)
  const doc = usePdfs.getState().sessions[key]?.doc as pdfjs.PDFDocumentProxy | null
  if (!doc) throw new Error('PDF failed to load')
  const page = await doc.getPage(pageNumber)
  const vp1 = page.getViewport({ scale: 1 })
  const vp = page.getViewport({ scale: 1400 / vp1.width })
  const canvas = document.createElement('canvas')
  canvas.width = Math.ceil(vp.width)
  canvas.height = Math.ceil(vp.height)
  await page.render({ canvasContext: canvas.getContext('2d')!, viewport: vp }).promise
  const notes = showNotes ? openNotesOn(path, '', pageNumber) : []
  if (notes.length) {
    const img = new Image()
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(notesSvg(notes, canvas.width, canvas.height))}`
    await img.decode()
    canvas.getContext('2d')!.drawImage(img, 0, 0)
  }
  return canvas.toDataURL('image/png')
}

export async function handleScreenshot(ev: Extract<ServerEvent, { type: 'screenshot' }>) {
  if (useApp.getState().projectId !== ev.projectId) return
  try {
    const kind = docKind(ev.deck)
    const url =
      kind === 'pptx' ? await slidePng(ev.projectId, ev.deck, ev.slideIndex, !!ev.showNotes)
        : kind === 'pdf' ? await pagePng(ev.projectId, ev.deck, ev.slideIndex, !!ev.showNotes)
          : (() => { throw new Error('only .pptx and .pdf files can be rendered') })()
    await api.screenshotResult(ev.requestId, url)
  } catch (e) {
    await api.screenshotResult(ev.requestId, `Could not render: ${(e as Error).message}`).catch(() => {})
  }
}
