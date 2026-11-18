/**
 * Pasting into slide text, as in PowerPoint's two paste options:
 *
 * - ⌘V — text only: the pasted text takes the formatting where it lands
 *   (paragraph breaks kept). What you see while editing is what's saved.
 * - ⌥⇧⌘V — keep source formatting: the clipboard's HTML is read into styled
 *   pieces (bold, italic, underline, strikethrough, colour, font, size — what
 *   `setTextStyle` can carry), the text is inserted as with ⌘V, and each
 *   piece's style is then applied to its range (`styledRanges`).
 *
 * The text goes in through `execCommand`, like typing: it keeps the browser's
 * own undo while editing, and the bullet / numbering upkeep (`watchBullets`)
 * sees it as input.
 */

import type { TextStyle } from '@diceui/pptx-core'
import type { TextPoint } from './textEdit'

/** Line breaks as `\n`; leading and trailing blank lines dropped. */
export const normalizePasted = (text: string) => text.replace(/\r\n?|[\u2028\u2029\v\f]/g, '\n').replace(/^\n+|\n+$/g, '')

/** Insert text at the caret (replacing the selection): one paragraph per line, formatted like the text around it. */
export function insertPlainText(text: string) {
  const lines = normalizePasted(text).split('\n')
  const sel = window.getSelection()
  if (sel && !sel.isCollapsed) document.execCommand('delete')
  lines.forEach((line, i) => {
    if (i) document.execCommand('insertParagraph')
    if (line) document.execCommand('insertText', false, line)
  })
}

// ── formatted ────────────────────────────────────────────────────────────────

export interface StyledPiece {
  text: string
  /** Only what the source states explicitly; the rest comes from where it's pasted. */
  style: TextStyle
}
export type StyledParagraphs = StyledPiece[][]

/** The paragraphs' text, one per line (what `insertPlainText` gets for a formatted paste). */
export const styledText = (ps: StyledParagraphs) => ps.map((p) => p.map((x) => x.text).join('')).join('\n')

const BLOCK = new Set(['P', 'DIV', 'LI', 'UL', 'OL', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'TR', 'TABLE', 'BLOCKQUOTE', 'PRE', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'DL', 'DT', 'DD', 'FIGURE', 'FIGCAPTION', 'HR'])
const SKIP = new Set(['HEAD', 'STYLE', 'SCRIPT', 'TITLE', 'META', 'LINK', 'TEMPLATE', 'NOSCRIPT', 'svg', 'IMG'])
const GENERIC_FONT = /^(serif|sans-serif|monospace|cursive|fantasy|system-ui|ui-[a-z-]+|-apple-system|blinkmacsystemfont|inherit|initial|unset|emoji|math)$/i

/** A CSS colour as RRGGBB, or null (transparent, unknown, a keyword like `inherit`). */
export function cssColorHex(value: string): string | null {
  const v = value.trim().toLowerCase()
  let m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(v)
  if (m) return (m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1]).toUpperCase()
  m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/.exec(v)
  if (m) {
    if (m[4] !== undefined && parseFloat(m[4]) === 0) return null
    return [m[1], m[2], m[3]].map((n) => Math.max(0, Math.min(255, Math.round(Number(n)))).toString(16).padStart(2, '0')).join('').toUpperCase()
  }
  if (!/^[a-z]+$/.test(v) || ['transparent', 'inherit', 'initial', 'unset', 'currentcolor', 'windowtext'].includes(v)) return null
  // A named colour: let a canvas resolve it (black when the name is unknown, so check it round-trips).
  try {
    const ctx = document.createElement('canvas').getContext('2d')
    if (!ctx) return null
    ctx.fillStyle = '#010203'
    ctx.fillStyle = v
    const out = String(ctx.fillStyle)
    return out === '#010203' ? null : cssColorHex(out)
  } catch {
    return null
  }
}

/** A CSS font size in points (px and pt only), or null. */
export function cssFontSizePt(value: string): number | null {
  const m = /^([\d.]+)(px|pt)$/.exec(value.trim().toLowerCase())
  if (!m) return null
  const pt = m[2] === 'pt' ? Number(m[1]) : Number(m[1]) * 0.75
  return pt > 0 && pt < 4000 ? Math.round(pt * 2) / 2 : null
}

/** The first named (non-generic) family of a CSS font-family list. */
export function cssFontFamily(value: string): string | null {
  for (const part of value.split(',')) {
    const name = part.trim().replace(/^["']|["']$/g, '').trim()
    if (name && !GENERIC_FONT.test(name)) return name
  }
  return null
}

/** What an element says about the formatting of the text in it: its tag, then its inline style. */
function elementStyle(el: Element, inherited: TextStyle): TextStyle {
  const s: TextStyle = { ...inherited }
  const tag = el.tagName.toUpperCase()
  if (tag === 'B' || tag === 'STRONG' || /^H[1-6]$/.test(tag)) s.bold = true
  if (tag === 'I' || tag === 'EM') s.italic = true
  if (tag === 'U' || tag === 'INS') s.underline = true
  if (tag === 'S' || tag === 'STRIKE' || tag === 'DEL') s.strikethrough = true
  if (tag === 'FONT') {
    const color = el.getAttribute('color')
    const face = el.getAttribute('face')
    if (color && cssColorHex(color)) s.color = cssColorHex(color)
    if (face && cssFontFamily(face)) s.fontFamily = cssFontFamily(face)
  }
  const st = (el as HTMLElement).style
  if (!st) return s
  const weight = st.fontWeight
  if (weight) {
    if (weight === 'bold' || weight === 'bolder' || Number(weight) >= 600) s.bold = true
    else if (weight === 'normal' || weight === 'lighter' || Number(weight) > 0) s.bold = false
  }
  if (st.fontStyle) s.italic = st.fontStyle === 'italic' || st.fontStyle.startsWith('oblique')
  const deco = `${st.textDecorationLine || ''} ${st.textDecoration || ''}`
  if (/underline|line-through|none/.test(deco)) {
    if (/none/.test(deco) && !/underline|line-through/.test(deco)) { s.underline = false; s.strikethrough = false }
    if (/underline/.test(deco)) s.underline = true
    if (/line-through/.test(deco)) s.strikethrough = true
  }
  if (st.color && cssColorHex(st.color)) s.color = cssColorHex(st.color)
  if (st.fontFamily && cssFontFamily(st.fontFamily)) s.fontFamily = cssFontFamily(st.fontFamily)
  if (st.fontSize && cssFontSizePt(st.fontSize)) s.fontSize = cssFontSizePt(st.fontSize)
  return s
}

const sameStyle = (a: TextStyle, b: TextStyle) => JSON.stringify(a) === JSON.stringify(b)

/** Clipboard HTML → paragraphs of styled pieces (block elements and `<br>` start paragraphs; cells are tab-separated). */
export function parseClipboardHtml(html: string): StyledParagraphs {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const paras: StyledParagraphs = [[]]
  const cur = () => paras[paras.length - 1]
  const newParagraph = () => paras.push([])
  const add = (text: string, style: TextStyle) => {
    if (!text) return
    const p = cur()
    const last = p[p.length - 1]
    if (last && sameStyle(last.style, style)) last.text += text
    else p.push({ text, style })
  }
  const lineText = () => cur().map((x) => x.text).join('')

  const walk = (node: Node, style: TextStyle, pre: boolean) => {
    if (node.nodeType === Node.TEXT_NODE) {
      let t = node.textContent ?? ''
      if (pre) {
        t.split('\n').forEach((line, i) => { if (i) newParagraph(); add(line, style) })
        return
      }
      // HTML whitespace collapses; a non-breaking space (how editors keep runs of spaces) is a space.
      t = t.replace(/[ \t\n\r\f]+/g, ' ').replace(/\u00a0/g, ' ')
      if (!lineText() || lineText().endsWith(' ')) t = t.replace(/^ +/, '')
      add(t, style)
      return
    }
    if (!(node instanceof Element) || SKIP.has(node.tagName) || SKIP.has(node.tagName.toUpperCase())) return
    const tag = node.tagName.toUpperCase()
    if (tag === 'BR') { newParagraph(); return }
    const block = BLOCK.has(tag)
    if (block && lineText()) newParagraph()
    if ((tag === 'TD' || tag === 'TH') && lineText()) add('\t', style)
    const s = elementStyle(node, style)
    for (const child of Array.from(node.childNodes)) walk(child, s, pre || tag === 'PRE')
    if (block && lineText()) newParagraph()
  }
  walk(doc.body, {}, false)

  // Trailing spaces at line ends; empty pieces; blank lines at the start and end.
  for (const p of paras) {
    const last = p[p.length - 1]
    if (last) last.text = last.text.replace(/ +$/, '')
    for (let i = p.length - 1; i >= 0; i--) if (!p[i].text) p.splice(i, 1)
  }
  while (paras.length && !paras[0].length) paras.shift()
  while (paras.length && !paras[paras.length - 1].length) paras.pop()
  return paras
}

/**
 * The ranges to style once `styledText(ps)` has been inserted, given where its first character
 * landed — one per piece that states any formatting.
 */
export function styledRanges(ps: StyledParagraphs, start: TextPoint): { start: TextPoint; end: TextPoint; style: TextStyle }[] {
  const out: { start: TextPoint; end: TextPoint; style: TextStyle }[] = []
  ps.forEach((pieces, i) => {
    const p = start.p + i
    let o = i === 0 ? start.o : 0
    for (const { text, style } of pieces) {
      if (Object.keys(style).length && text.length) out.push({ start: { p, o }, end: { p, o: o + text.length }, style })
      o += text.length
    }
  })
  return out
}

/**
 * Where an insertion of `text` began, from where the caret ended up after it (`end`) and the
 * length of the paragraph it began in (`paraLength(p)`): the first line ends that paragraph
 * (the rest of the line moved down with the last inserted line).
 */
export function insertionStart(text: string, end: TextPoint, paraLength: (p: number) => number): TextPoint {
  const lines = normalizePasted(text).split('\n')
  if (lines.length === 1) return { p: end.p, o: end.o - lines[0].length }
  const p = end.p - (lines.length - 1)
  return { p, o: paraLength(p) - lines[0].length }
}
