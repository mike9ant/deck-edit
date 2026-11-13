/**
 * Answers the agent's `screenshot_slide` tool: renders the requested slide
 * (or PDF page) exactly as the app shows it and posts a PNG back.
 *
 * Slides are rasterized with html-to-image. Fonts registered through the
 * FontFace API (the deck's embedded fonts) aren't visible to it, so we decode
 * the embedded font parts ourselves and hand it matching @font-face CSS.
 */

import { toPng } from 'html-to-image'
import { renderSlide, type PresentationData } from '@diceui/pptx-core'
import { decodeEmbeddedFont } from '@diceui/pptx-core/fonts'
import * as pdfjs from 'pdfjs-dist'
import { api } from './api/client'
import type { ServerEvent } from './api/types'
import { docKind, useApp } from './store/appStore'
import { deckKey, useDecks } from './deck/deckStore'
import { mediaCache } from './deck/SlideRender'
import { pdfKey, usePdfs } from './pdf/pdfStore'

const fontCss = new WeakMap<PresentationData, string>()

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

async function slidePng(pid: string, deck: string, slideNumber: number): Promise<string> {
  const decks = useDecks.getState()
  const key = deckKey(pid, deck)
  if (!decks.sessions[key]) await decks.open(pid, deck)
  const s = useDecks.getState().sessions[key]
  if (!s?.pres) throw new Error(s?.error ?? 'deck failed to load')
  const pres = s.pres
  const slide = pres.slides[slideNumber - 1]
  if (!slide) throw new Error(`slide ${slideNumber} does not exist (the deck has ${pres.slides.length})`)
  const host = document.createElement('div')
  host.style.cssText = `position:fixed;left:-20000px;top:0;width:${pres.width}px;height:${pres.height}px;overflow:hidden;background:#fff`
  document.body.appendChild(host)
  const handle = renderSlide(pres, slide, { mediaUrlCache: mediaCache(key, pres) })
  host.appendChild(handle.element)
  try {
    await handle.ready
    await document.fonts.ready
    await Promise.all(
      [...host.querySelectorAll('img')].map((img) => (img.complete ? null : new Promise((r) => { img.onload = img.onerror = r }))),
    )
    return await toPng(handle.element, { width: pres.width, height: pres.height, pixelRatio: 1.5, backgroundColor: '#ffffff', fontEmbedCSS: embeddedFontCss(pres) })
  } finally {
    handle.dispose()
    host.remove()
  }
}

async function pagePng(pid: string, path: string, pageNumber: number): Promise<string> {
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
  return canvas.toDataURL('image/png')
}

export async function handleScreenshot(ev: Extract<ServerEvent, { type: 'screenshot' }>) {
  if (useApp.getState().projectId !== ev.projectId) return
  try {
    const kind = docKind(ev.deck)
    const url =
      kind === 'pptx' ? await slidePng(ev.projectId, ev.deck, ev.slideIndex)
        : kind === 'pdf' ? await pagePng(ev.projectId, ev.deck, ev.slideIndex)
          : (() => { throw new Error('only .pptx and .pdf files can be rendered') })()
    await api.screenshotResult(ev.requestId, url)
  } catch (e) {
    await api.screenshotResult(ev.requestId, `Could not render: ${(e as Error).message}`).catch(() => {})
  }
}
