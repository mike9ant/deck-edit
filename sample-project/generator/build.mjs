// Renders the sample project's pictures and PDFs with headless Chrome (see ../README.md):
// - art/*.svg → ../images/*.png (transparent, 2× for crisp slides), plus the starfield JPEG;
// - pdf/*.html → ../*.pdf (vector text, diagrams and charts).
// Run by hand from this folder (`npm install` once, then `node build.mjs`); it replaces images/ and the
// PDFs. Then `python3 make_deck.py` rebuilds the deck. See ../README.md.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, copyFileSync, existsSync } from 'node:fs'
import { dirname, join, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer-core'

const here = dirname(fileURLToPath(import.meta.url))
const out = join(here, '..') // sample-project/
const images = join(out, 'images')
mkdirSync(images, { recursive: true })

const CHROME = process.env.CHROME_PATH
  ?? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(existsSync)
if (!CHROME) throw new Error('Chrome not found — set CHROME_PATH')

/** A small seeded random generator, so the starfield is the same on every build. */
function rng(seed) {
  let s = seed >>> 0
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32)
}

/** Deep-space background: a navy → purple sky, soft nebulae and a few hundred stars. */
function starfieldSvg(w = 1920, h = 1080) {
  const r = rng(42)
  const stars = Array.from({ length: 420 }, () => {
    const big = r() < 0.06
    return `<circle cx="${(r() * w).toFixed(1)}" cy="${(r() * h).toFixed(1)}" r="${(big ? 1.6 + r() * 1.6 : 0.4 + r() * 1.1).toFixed(2)}" fill="#fff" opacity="${(0.35 + r() * 0.65).toFixed(2)}"/>`
  }).join('')
  const sparks = Array.from({ length: 9 }, () => {
    const x = r() * w, y = r() * h, s = 6 + r() * 10
    return `<path transform="translate(${x.toFixed(0)} ${y.toFixed(0)}) scale(${(s / 16).toFixed(2)})" d="M0 -16 L4 -4 L16 0 L4 4 L0 16 L-4 4 L-16 0 L-4 -4 Z" fill="#FFF3C4" opacity="0.9"/>`
  }).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0E0C2E"/><stop offset="0.55" stop-color="#1C1650"/><stop offset="1" stop-color="#3B2A6B"/></linearGradient>
    <filter id="blur" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="90"/></filter>
  </defs>
  <rect width="${w}" height="${h}" fill="url(#sky)"/>
  <g filter="url(#blur)" opacity="0.55">
    <ellipse cx="${w * 0.78}" cy="${h * 0.3}" rx="420" ry="230" fill="#7B4FB8"/>
    <ellipse cx="${w * 0.2}" cy="${h * 0.8}" rx="380" ry="200" fill="#2BB3A3" opacity="0.6"/>
    <ellipse cx="${w * 0.55}" cy="${h * 0.62}" rx="300" ry="160" fill="#D7263D" opacity="0.35"/>
  </g>
  ${stars}${sparks}
</svg>`
}

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true })
try {
  const page = await browser.newPage()

  // ── pictures ──
  const shot = async (svg, file, { scale = 2, jpeg = false } = {}) => {
    const w = Number(svg.match(/width="(\d+)"/)[1]), h = Number(svg.match(/height="(\d+)"/)[1])
    await page.setViewport({ width: w, height: h, deviceScaleFactor: scale })
    await page.setContent(`<html><body style="margin:0;background:transparent">${svg}</body></html>`, { waitUntil: 'load' })
    await page.evaluate(() => document.fonts.ready)
    await page.screenshot({ path: file, omitBackground: !jpeg, type: jpeg ? 'jpeg' : 'png', quality: jpeg ? 88 : undefined, clip: { x: 0, y: 0, width: w, height: h } })
  }
  const only = process.argv.slice(2)
  for (const f of readdirSync(join(here, 'art')).filter((f) => f.endsWith('.svg')).sort()) {
    if (only.length && !only.some((o) => f.includes(o))) continue
    const svg = readFileSync(join(here, 'art', f), 'utf8')
    await shot(svg, join(images, f.replace(/\.svg$/, '.png')))
    console.log('image', f)
  }
  // The Drink Me Pod also goes in as SVG (the deck shows it as an SVG picture with a PNG fallback).
  copyFileSync(join(here, 'art', 'drink-me-pod.svg'), join(images, 'drink-me-pod.svg'))
  if (!only.length || only.includes('starfield')) {
    await shot(starfieldSvg(), join(images, 'starfield.jpg'), { scale: 1, jpeg: true })
    console.log('image starfield.jpg')
  }

  // ── PDFs ──
  const pdfDir = join(here, 'pdf')
  if (existsSync(pdfDir) && (!only.length || only.includes('pdf'))) {
    for (const f of readdirSync(pdfDir).filter((f) => f.endsWith('.html')).sort()) {
      const title = basename(f, '.html')
      await page.goto(`file://${join(pdfDir, f)}`, { waitUntil: 'load' })
      await page.evaluate(() => document.fonts.ready)
      const footer = `<div style="font-family: Arial, sans-serif; font-size: 7.5px; color: #8A809E; width: 100%; padding: 0 0.8in; display: flex; justify-content: space-between">
        <span>Rabbit Hole Roasters · ${title}</span><span>page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>`
      writeFileSync(join(out, `${title}.pdf`), await page.pdf({
        format: 'Letter', printBackground: true, preferCSSPageSize: true,
        displayHeaderFooter: true, headerTemplate: '<span></span>', footerTemplate: footer,
      }))
      console.log('pdf', title)
    }
  }
} finally {
  await browser.close()
}
