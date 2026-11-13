// Dev-only: render every slide of ?url= stacked at 960px wide, for
// screenshot comparison against PowerPoint's own PDF export.
import { readPptx, buildPresentation, renderSlide } from '@diceui/pptx-core'
import { loadEmbeddedFonts } from '@diceui/pptx-core/fonts'

async function main() {
  const params = new URLSearchParams(location.search)
  const buf = await (await fetch(params.get('url')!)).arrayBuffer()
  const pres = buildPresentation(await readPptx(buf, { keepSourcePackage: true }))
  const fonts = loadEmbeddedFonts(pres, { onError: (e) => console.warn('font', e.path, e.stage, e.message) })
  await fonts.complete
  const from = Number(params.get('from') ?? 0)
  const to = Number(params.get('to') ?? pres.slides.length)
  const out = document.getElementById('out')!
  const scale = 960 / pres.width
  const cache = new Map<string, string>()
  for (const slide of pres.slides.slice(from, to)) {
    const box = document.createElement('div')
    box.className = 'slide'
    const h = renderSlide(pres, slide, { mediaUrlCache: cache })
    h.element.style.transform = `scale(${scale})`
    h.element.style.transformOrigin = '0 0'
    box.appendChild(h.element)
    out.appendChild(box)
    await h.ready
  }
  await document.fonts.ready
  await new Promise((r) => setTimeout(r, 300))
  document.title = 'done'
}
main().catch((e) => { document.title = 'error'; document.body.textContent = String(e?.stack ?? e) })
