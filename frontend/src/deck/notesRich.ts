/**
 * Formatted speaker notes. The notes page's paragraphs (`a:p`) are rendered
 * into the same tagged HTML the slide renderer produces — `data-pptx-p` per
 * paragraph, `data-pptx-r` per run, a non-editable bullet span — so the slide
 * text editor's reader (textEdit.ts `readParagraphsAt`) maps an edited pane
 * back to source paragraphs and runs. `buildParagraphs` then writes new `a:p`
 * XML that reuses each source paragraph's `a:pPr` and each run's `a:rPr`:
 * bold, colours, sizes, links, bullets and levels survive editing.
 */

import { PPTX_ATTRS, type SetTextBodyParagraph, type SetTextBodyRun } from '@diceui/pptx-core'
import { autoNumber, type TextPoint } from './textEdit'

const A = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const INDENT = 20 // px per outline level (and for a bullet)

export type StyleProp = 'b' | 'i' | 'u'
/** A run as read back from the editor, plus formatting set by a toggle. */
export type StyledRun = SetTextBodyRun & { set?: Partial<Record<StyleProp, boolean>> }
export type StyledParagraph = Omit<SetTextBodyParagraph, 'runs'> & { runs: StyledRun[] }

const child = (el: Element | undefined, name: string) => (el ? [...el.children].find((c) => c.localName === name) : undefined)
/** A paragraph's content elements — what `data-pptx-r` indexes. */
const contents = (p: Element | undefined) => (p ? [...p.children].filter((c) => c.localName === 'r' || c.localName === 'br' || c.localName === 'fld') : [])
const textOf = (el: Element) => (el.localName === 'br' ? '\n' : (child(el, 't')?.textContent ?? ''))
const truthy = (v: string | null) => v === '1' || v === 'true'

/** Symbol-font bullet characters (Wingdings / Symbol) shown as their look-alikes. */
const SYMBOL_BULLETS: Record<string, string> = { '§': '▪', 'Ø': '➢', 'ü': '✓', 'q': '❑', 'v': '❖', 'n': '■', 'l': '●', 'o': '○', '·': '•' }

function bulletOf(pPr: Element | undefined): { char?: string; scheme?: string; startAt?: number } | null {
  if (!pPr || child(pPr, 'buNone')) return null
  const ch = child(pPr, 'buChar')
  if (ch) {
    const c = ch.getAttribute('char') || '•'
    const font = child(pPr, 'buFont')?.getAttribute('typeface') ?? ''
    return { char: /wingdings|symbol/i.test(font) ? (SYMBOL_BULLETS[c] ?? '•') : c }
  }
  const num = child(pPr, 'buAutoNum')
  if (num) return { scheme: num.getAttribute('type') || 'arabicPeriod', startAt: Number(num.getAttribute('startAt')) || undefined }
  return null
}

function nearWhite(hex: string) {
  const n = parseInt(hex, 16)
  if (Number.isNaN(n)) return false
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 235
}

function styleRun(span: HTMLElement, rPr: Element | undefined) {
  if (!rPr) return
  if (truthy(rPr.getAttribute('b'))) span.style.fontWeight = '700'
  if (truthy(rPr.getAttribute('i'))) span.style.fontStyle = 'italic'
  const deco: string[] = []
  const u = rPr.getAttribute('u')
  if (u && u !== 'none') deco.push('underline')
  const strike = rPr.getAttribute('strike')
  if (strike && strike !== 'noStrike') deco.push('line-through')
  const link = child(rPr, 'hlinkClick')
  if (link) {
    if (!deco.includes('underline')) deco.push('underline')
    span.style.color = '#0563c1'
  } else {
    const rgb = child(child(rPr, 'solidFill'), 'srgbClr')?.getAttribute('val')
    if (rgb && !nearWhite(rgb)) span.style.color = `#${rgb}` // white text would vanish on the white pane
  }
  if (deco.length) span.style.textDecorationLine = deco.join(' ')
  const mark = child(child(rPr, 'highlight'), 'srgbClr')?.getAttribute('val')
  if (mark) span.style.backgroundColor = `#${mark}`
  const sz = Number(rPr.getAttribute('sz'))
  if (sz) span.style.fontSize = `${Math.min(1.6, Math.max(0.8, sz / 1200))}em` // relative to the usual 12pt
  const baseline = Number(rPr.getAttribute('baseline'))
  if (baseline) {
    span.style.verticalAlign = baseline > 0 ? 'super' : 'sub'
    span.style.fontSize = '0.75em'
  }
}

/** Render notes paragraphs into `container` (replacing its content). */
export function renderNotes(container: HTMLElement, paragraphs: Element[]) {
  container.replaceChildren()
  const counters = new Map<number, { scheme: string; n: number }>()
  const list = paragraphs.length ? paragraphs : [document.createElementNS(A, 'a:p')]
  list.forEach((p, pi) => {
    const div = document.createElement('div')
    div.setAttribute(PPTX_ATTRS.paragraph, String(pi))
    div.style.position = 'relative'
    const pPr = child(p, 'pPr')
    const level = Number(pPr?.getAttribute('lvl') ?? 0) || 0
    const algn = pPr?.getAttribute('algn')
    if (algn === 'ctr') div.style.textAlign = 'center'
    else if (algn === 'r') div.style.textAlign = 'right'
    const items = contents(p)
    const visible = items.some((c) => c.localName !== 'br' && textOf(c))

    // Bullets and numbering (PowerPoint hides them on empty lines; numbering as in the slide renderer).
    const bullet = bulletOf(pPr)
    if (visible) {
      for (const l of [...counters.keys()]) if (l > level) counters.delete(l)
      if (!bullet?.scheme || counters.get(level)?.scheme !== bullet.scheme) counters.delete(level)
    }
    let marker = ''
    if (bullet && visible) {
      if (bullet.char) marker = bullet.char
      else if (bullet.scheme) {
        const n = (counters.get(level)?.n ?? (bullet.startAt ?? 1) - 1) + 1
        counters.set(level, { scheme: bullet.scheme, n })
        marker = autoNumber(bullet.scheme, n)
      }
    }
    // The text's left edge: the paragraph's own margin when it has one (so a line whose bullet
    // was removed stays put), else by outline level.
    const marL = pPr?.getAttribute('marL')
    const pad = Number(marL) > 0 ? Math.round(Number(marL) / 9525) : level * INDENT + (bullet ? INDENT : 0)
    div.style.paddingLeft = `${pad}px`
    if (marker) {
      const b = document.createElement('span')
      b.setAttribute(PPTX_ATTRS.bullet, '')
      b.contentEditable = 'false'
      b.textContent = `${marker} `
      Object.assign(b.style, { position: 'absolute', left: `${Math.max(0, pad - INDENT)}px`, top: '0', width: `${INDENT}px`, whiteSpace: 'pre', userSelect: 'none' })
      div.appendChild(b)
    }

    items.forEach((c, ri) => {
      if (c.localName === 'br') {
        div.appendChild(document.createElement('br'))
        return
      }
      const span = document.createElement('span')
      span.setAttribute(PPTX_ATTRS.run, String(ri))
      span.textContent = textOf(c)
      styleRun(span, child(c, 'rPr'))
      div.appendChild(span)
    })
    // An empty line, or one ending in a line break, needs a placeholder <br> to show (and is not text).
    if (!visible || div.lastChild?.nodeName === 'BR') {
      const br = document.createElement('br')
      br.setAttribute(PPTX_ATTRS.emptyLine, '')
      div.appendChild(br)
    }
    container.appendChild(div)
  })
}

/** Whether a read-back run has `prop` on: a toggle's setting, else its source run's. */
export function runHas(base: Element[], run: StyledRun, prop: StyleProp): boolean {
  const set = run.set?.[prop]
  if (set !== undefined) return set
  const src = run.sourceRun ? contents(base[run.sourceRun[0]])[run.sourceRun[1]] : undefined
  const rPr = child(src, 'rPr')
  if (!rPr) return false
  if (prop === 'u') {
    const u = rPr.getAttribute('u')
    return !!u && u !== 'none'
  }
  return truthy(rPr.getAttribute(prop))
}

/** Set `prop` on the characters from `start` to `end` (splitting runs): on, unless all of them have it already. */
export function styleRange(base: Element[], paragraphs: StyledParagraph[], start: TextPoint, end: TextPoint, prop: StyleProp) {
  const inside: StyledRun[] = []
  paragraphs.forEach((p, pi) => {
    if (pi < start.p || pi > end.p) return
    const from = pi === start.p ? start.o : 0
    const to = pi === end.p ? end.o : Infinity
    const out: StyledRun[] = []
    let acc = 0
    for (const r of p.runs) {
      const a = acc
      const b = acc + r.text.length
      acc = b
      const s = Math.max(from, a)
      const e = Math.min(to, b)
      if (s >= e || r.text === '\n') {
        out.push(r)
        continue
      }
      if (s > a) out.push({ ...r, text: r.text.slice(0, s - a) })
      const mid: StyledRun = { ...r, text: r.text.slice(s - a, e - a) }
      out.push(mid)
      inside.push(mid)
      if (e < b) out.push({ ...r, text: r.text.slice(e - a) })
    }
    p.runs = out
  })
  const on = !(inside.length && inside.every((r) => runHas(base, r, prop)))
  for (const r of inside) r.set = { ...r.set, [prop]: on }
}

/**
 * New `a:p` XML for edited paragraphs: each reuses its source paragraph's
 * `a:pPr` / `a:endParaRPr`, each run its source run's `a:rPr` (text typed
 * outside any run takes its neighbour's), with toggled formatting applied.
 * An unchanged field (`a:fld`, e.g. a slide number) is kept as a field.
 */
export function buildParagraphs(base: Element[], edited: StyledParagraph[]): string[] {
  const doc = document.implementation.createDocument(A, 'a:txBody', null)
  const ser = new XMLSerializer()
  const el = (name: string) => doc.createElementNS(A, `a:${name}`)
  const asRPr = (from: Element) => {
    // endParaRPr → rPr: same attributes and children, run element name.
    if (from.localName === 'rPr') return doc.importNode(from, true) as Element
    const r = el('rPr')
    for (const a of from.attributes) r.setAttribute(a.name, a.value)
    for (const c of from.children) r.appendChild(doc.importNode(c, true))
    return r
  }
  return edited.map((ep) => {
    const src = base[ep.sourceParagraphIndex] ?? base[base.length - 1]
    const p = el('p')
    const pPr = child(src, 'pPr')
    if (pPr) p.appendChild(doc.importNode(pPr, true))
    if (ep.noBullet) {
      // The bullet removed with Backspace (as setTextBody's noBullet in the patched engine).
      let own = child(p, 'pPr')
      if (!own) p.appendChild((own = el('pPr')))
      for (const c of [...own.children]) if (['buChar', 'buAutoNum', 'buBlip', 'buNone'].includes(c.localName)) own.removeChild(c)
      own.insertBefore(el('buNone'), [...own.children].find((c) => ['tabLst', 'defRPr', 'extLst'].includes(c.localName)) ?? null)
      const indent = own.getAttribute('indent')
      if (indent === null || Number(indent) < 0) own.setAttribute('indent', '0')
    }
    const fallback = contents(src).map((c) => child(c, 'rPr')).find(Boolean) ?? child(src, 'endParaRPr')
    let last: Element | undefined
    for (const run of ep.runs) {
      const srcEl = run.sourceRun ? contents(base[run.sourceRun[0]] ?? src)[run.sourceRun[1]] : undefined
      const tpl = child(srcEl, 'rPr') ?? last ?? fallback
      if (run.text === '\n') {
        const br = el('br')
        if (tpl) br.appendChild(asRPr(tpl))
        p.appendChild(br)
        continue
      }
      if (srcEl?.localName === 'fld' && !run.set && run.text === textOf(srcEl)) {
        p.appendChild(doc.importNode(srcEl, true))
        last = child(srcEl, 'rPr') ?? last
        continue
      }
      const rPr = tpl ? asRPr(tpl) : el('rPr')
      for (const [prop, on] of Object.entries(run.set ?? {})) rPr.setAttribute(prop, prop === 'u' ? (on ? 'sng' : 'none') : on ? '1' : '0')
      const r = el('r')
      r.appendChild(rPr)
      const t = el('t')
      t.textContent = run.text
      r.appendChild(t)
      p.appendChild(r)
      last = rPr
    }
    const end = child(src, 'endParaRPr')
    if (end) p.appendChild(doc.importNode(end, true))
    return ser.serializeToString(p)
  })
}

/** Plain text of notes paragraphs (line breaks as "\n", one line per paragraph). */
export const notesText = (paragraphs: Element[]) => paragraphs.map((p) => contents(p).map(textOf).join('')).join('\n')

/** Parse `a:p` XML (as buildParagraphs returns) back into elements — the next editing base. */
export const parseParagraphs = (xml: string[]) => xml.map((x) => new DOMParser().parseFromString(x, 'application/xml').documentElement)
