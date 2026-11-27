/**
 * In-place text editing: turns the rendered text body of a shape into a
 * contentEditable region, and reads the edited DOM back into a `setTextBody`
 * operation that reuses each run's original formatting (`a:rPr`) and each
 * paragraph's properties (`a:pPr`) — so editing keeps fonts, sizes, colors
 * and bullets; only new text picks up the formatting around it.
 *
 * The renderer tags paragraphs with `data-pptx-p` (source paragraph index)
 * and runs with `data-pptx-r` (source run index). When the user presses
 * Enter, the browser splits the paragraph element and clones those
 * attributes, so a new paragraph inherits its neighbour's formatting.
 */

import { PPTX_ATTRS, type SetTextBodyParagraph, type SetTextBodyRun } from '@diceui/pptx-core'

/**
 * Text shown in an editable text that isn't part of it (removed words marked in place, see
 * notesChangeMarks.ts): skipped like bullets when the text is read, or a caret position counted.
 */
export const GHOST_ATTR = 'data-text-ghost'

export function textContainer(nodeEl: HTMLElement): HTMLElement | null {
  return (nodeEl.querySelector(`[${PPTX_ATTRS.paragraph}]`)?.parentElement as HTMLElement | null) ?? null
}

export function beginEditing(container: HTMLElement, at?: { x: number; y: number }) {
  container.contentEditable = 'true'
  container.spellcheck = false
  container.style.outline = 'none'
  container.style.cursor = 'text'
  container.style.userSelect = 'text'
  container.style.pointerEvents = 'auto'
  // Bullets are paragraph properties, not text: not editable, and not copied with the text
  // (pasted into a list, they'd come back as a second bullet).
  container.querySelectorAll<HTMLElement>(`[${PPTX_ATTRS.bullet}]`).forEach((b) => { b.contentEditable = 'false'; b.style.userSelect = 'none' })
  watchBullets(container)
  container.focus({ preventScroll: true }) // the slide clips, it must not scroll (see SlideEditor)
  const sel = window.getSelection()
  if (!sel) return
  const range = at ? document.caretRangeFromPoint?.(at.x, at.y) : null
  if (range && container.contains(range.startContainer)) {
    sel.removeAllRanges()
    sel.addRange(range)
  } else {
    // Select everything, like a double-click in PowerPoint on a short label.
    const r = document.createRange()
    r.selectNodeContents(container)
    sel.removeAllRanges()
    sel.addRange(r)
  }
}

/** Plain text of a paragraph list (what we compare to detect "no change"). */
export const paragraphsText = (ps: { runs: { text: string }[] }[]) => ps.map((p) => p.runs.map((r) => r.text).join('')).join('\n')

const isBlock = (el: Element) => el.tagName === 'DIV' || el.tagName === 'P' || el.tagName === 'LI'

/** A position in a text body: paragraph index and character offset (as setTextStyle's TextPosition). */
export interface TextPoint {
  p: number
  o: number
}

/** Read an edited container back into setTextBody paragraphs. */
export function readParagraphs(container: HTMLElement): SetTextBodyParagraph[] {
  return readParagraphsAt(container, []).paragraphs
}

/** A DOM point as a text node + offset (the start of the next text, or the end of the previous). */
function textPoint(node: Node, off: number): [Node, number] | null {
  if (node.nodeType === Node.TEXT_NODE) return [node, off]
  const after = node.childNodes[off]
  const w = document.createTreeWalker(node, NodeFilter.SHOW_TEXT)
  if (after) {
    w.currentNode = after
    const t = after.nodeType === Node.TEXT_NODE ? after : w.nextNode()
    if (t && node.contains(t)) return [t, 0]
  }
  let last: Node | null = null
  for (let n = w.nextNode(); n; n = w.nextNode()) last = n
  return last ? [last, (last.textContent ?? '').length] : null
}

/**
 * Like readParagraphs, and also maps DOM points (e.g. the selection's ends) to
 * positions in the paragraphs it returns — so a formatting change can be
 * applied to exactly the selected characters after the text is written back.
 */
export function readParagraphsAt(container: HTMLElement, points: [Node, number][]): { paragraphs: SetTextBodyParagraph[]; positions: (TextPoint | null)[] } {
  const targets = points.map(([n, o]) => textPoint(n, o))
  const positions: (TextPoint | null)[] = points.map(() => null)
  const out: SetTextBodyParagraph[] = []
  let lastP = 0
  let current: { p: number; runs: SetTextBodyRun[] } | null = null

  const startParagraph = (el: Element | null) => {
    const attr = el?.getAttribute(PPTX_ATTRS.paragraph)
    const p = attr != null ? Number(attr) : lastP
    lastP = p
    current = { p, runs: [] }
    out.push(el?.hasAttribute(NO_BULLET) ? { sourceParagraphIndex: p, runs: current.runs, noBullet: true } : { sourceParagraphIndex: p, runs: current.runs })
  }

  const pushText = (text: string, run: [number, number] | undefined) => {
    if (!current) startParagraph(null)
    const runs = current!.runs
    const prev = runs[runs.length - 1]
    if (prev && prev.text !== '\n' && text !== '\n' && sameRun(prev.sourceRun, run)) prev.text += text
    else runs.push(run ? { text, sourceRun: run } : { text })
  }

  /** Formatting source for text typed outside any run: the paragraph's latest run, else its first. */
  const inherited = (): [number, number] => {
    const runs = current?.runs ?? []
    for (let i = runs.length - 1; i >= 0; i--) if (runs[i].sourceRun) return runs[i].sourceRun!
    return [current?.p ?? lastP, 0]
  }

  const walk = (node: Node, run: [number, number] | undefined) => {
    if (node.nodeType === Node.TEXT_NODE) {
      targets.forEach((tp, k) => {
        if (tp?.[0] !== node) return
        if (!current) startParagraph(null)
        const before = current!.runs.reduce((n, r) => n + r.text.length, 0)
        positions[k] = { p: out.length - 1, o: before + (node.textContent ?? '').slice(0, tp[1]).replace(/​/g, '').length }
      })
      const t = (node.textContent ?? '').replace(/​/g, '')
      if (t) pushText(t, run ?? inherited())
      return
    }
    if (!(node instanceof Element)) return
    if (node.hasAttribute(PPTX_ATTRS.bullet) || node.hasAttribute(GHOST_ATTR)) return
    if (node.tagName === 'BR') {
      if (node.hasAttribute(PPTX_ATTRS.emptyLine)) return
      // A trailing <br> the browser adds to keep an empty block open is not a line break.
      if (!node.nextSibling && node.parentElement && isBlock(node.parentElement)) return
      pushText('\n', run)
      return
    }
    const r = node.getAttribute(PPTX_ATTRS.run)
    const nextRun: [number, number] | undefined = r != null ? [current?.p ?? lastP, Number(r)] : run
    for (const child of Array.from(node.childNodes)) walk(child, nextRun)
  }

  for (const child of Array.from(container.childNodes)) {
    if (child instanceof Element && isBlock(child)) {
      startParagraph(child)
      // Browsers sometimes nest a new block inside a paragraph on Enter: flatten.
      for (const inner of Array.from(child.childNodes)) {
        if (inner instanceof Element && isBlock(inner) && !inner.hasAttribute(PPTX_ATTRS.bullet)) {
          startParagraph(inner.hasAttribute(PPTX_ATTRS.paragraph) ? inner : child)
          for (const n of Array.from(inner.childNodes)) walk(n, undefined)
        } else walk(inner, undefined)
      }
    } else {
      walk(child, undefined)
    }
  }
  // Drop empty runs, but never leave the body without a paragraph.
  for (const p of out) p.runs = p.runs.filter((r) => r.text.length > 0)
  if (!out.length) out.push({ sourceParagraphIndex: 0, runs: [] })
  return { paragraphs: out, positions }
}

/**
 * The DOM point for a text position in a rendered text container (inverse of readParagraphsAt).
 * At a boundary between two runs, `start` picks the beginning of the next run, `end` the end of the previous.
 */
export function domPointAt(container: HTMLElement, pos: TextPoint, bias: 'start' | 'end' = 'end'): [Node, number] | null {
  const paras = [...container.querySelectorAll<HTMLElement>(`[${PPTX_ATTRS.paragraph}]`)].filter((el) => !el.parentElement?.closest(`[${PPTX_ATTRS.paragraph}]`))
  const para = paras[pos.p]
  if (!para) return null
  let acc = 0
  let last: [Node, number] | null = null
  const w = document.createTreeWalker(para, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT)
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    if (n instanceof Element) {
      if (n.closest(`[${PPTX_ATTRS.bullet}], [${GHOST_ATTR}]`)) continue
      if (n.tagName === 'BR' && !n.hasAttribute(PPTX_ATTRS.emptyLine)) acc += 1
      continue
    }
    if ((n.parentElement as Element | null)?.closest(`[${PPTX_ATTRS.bullet}], [${GHOST_ATTR}]`)) continue
    const len = (n.textContent ?? '').length
    if (bias === 'start' ? pos.o < acc + len : pos.o <= acc + len) return [n, pos.o - acc]
    acc += len
    last = [n, len]
  }
  return last ?? [para, 0]
}

// ── bullets and numbering while editing ────────────────────────────────────
//
// A paragraph's bullet is a property of the paragraph (a:pPr), drawn as a
// non-editable span. When Enter splits a paragraph the new one keeps the
// source index (so it saves with the same bullet) but not the span; and
// numbers are only recomputed when the shape is re-rendered. So while
// editing: give bullet-less paragraphs their source paragraph's bullet, and
// renumber numbered lists as lines come and go.

/** Marks a paragraph whose bullet the user removed while editing (saved as `noBullet`). */
export const NO_BULLET = 'data-no-bullet'

/** Whether edited paragraphs differ from the text body they were read from (text, or a removed bullet). */
export const textBodyChanged = (paragraphs: SetTextBodyParagraph[], before: string) => paragraphsText(paragraphs) !== before || paragraphs.some((p) => p.noBullet)

type NumKind = 'arabic' | 'alphaLc' | 'alphaUc' | 'romanLc' | 'romanUc'
/** Per editing container: source paragraph index → its bullet span, to clone. */
const bulletTemplates = new WeakMap<HTMLElement, Map<string, HTMLElement>>()

/** The paragraph elements, in order (as readParagraphsAt sees them, incl. blocks a browser nested on Enter). */
function paragraphEls(container: HTMLElement): HTMLElement[] {
  const out: HTMLElement[] = []
  for (const child of Array.from(container.children)) {
    if (!(child instanceof HTMLElement) || !isBlock(child)) continue
    out.push(child)
    for (const inner of Array.from(child.children)) if (inner instanceof HTMLElement && isBlock(inner) && !inner.hasAttribute(PPTX_ATTRS.bullet)) out.push(inner)
  }
  return out
}
const ownBullet = (p: HTMLElement) => Array.from(p.children).find((c) => c.hasAttribute(PPTX_ATTRS.bullet)) as HTMLElement | undefined
const levelOf = (p: HTMLElement) => parseFloat(p.style.paddingLeft) || 0

const ROMAN: [number, string][] = [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']]
const toRoman = (n: number) => ROMAN.reduce((s, [v, r]) => { while (n >= v) { s += r; n -= v } return s }, '')
const fromRoman = (s: string) => {
  let n = 0
  for (let i = 0; i < s.length; i++) {
    const v = ROMAN.find(([, r]) => r === s[i])?.[0] ?? 0
    const next = ROMAN.find(([, r]) => r === s[i + 1])?.[0] ?? 0
    n += v < next ? -v : v
  }
  return n
}
function formatNum(kind: NumKind, n: number) {
  if (kind === 'arabic') return String(n)
  if (kind === 'romanLc' || kind === 'romanUc') return kind === 'romanLc' ? toRoman(n) : toRoman(n).toUpperCase()
  const letter = String.fromCharCode(97 + ((n - 1) % 26)).repeat(Math.floor((n - 1) / 26) + 1) // a…z, aa…zz (as PowerPoint)
  return kind === 'alphaLc' ? letter : letter.toUpperCase()
}

/** "1. " / "(a) " / "iv) " → parts; a plain bullet ("• ", "o ", "– ") → null. */
function parseNum(text: string) {
  const m = /^(\(?)(\d+|[a-zA-Z]+)([.)]?)(\s*)$/.exec(text)
  if (!m || (!/^\d/.test(m[2]) && !m[3])) return null
  return { open: m[1], token: m[2], close: m[3], tail: m[4] }
}

/** The marker text for item `n` of an `a:buAutoNum` scheme ("romanLcParenR", 3 → "iii)"). */
export function autoNumber(scheme: string, n: number): string {
  const m = /^(arabic|romanLc|romanUc|alphaLc|alphaUc)(Period|ParenR|ParenBoth|Plain)$/.exec(scheme)
  if (!m) return `${n}.`
  const s = formatNum(m[1] as NumKind, Math.max(1, n))
  return m[2] === 'Period' ? `${s}.` : m[2] === 'ParenR' ? `${s})` : m[2] === 'ParenBoth' ? `(${s})` : s
}

/** Containers whose input listeners are installed (once; the bullet scan reruns each time). */
const watched = new WeakSet<HTMLElement>()

/**
 * Remember each paragraph's bullet (and its list's numbering), and keep them
 * in step with edits. Call again after re-rendering the container's content.
 */
export function watchBullets(container: HTMLElement) {
  const templates = new Map<string, HTMLElement>()
  bulletTemplates.set(container, templates)

  // Group the numbered paragraphs into lists (same level, same style, uninterrupted)
  // to learn each list's kind and starting number.
  type Item = { span: HTMLElement; num: NonNullable<ReturnType<typeof parseNum>> }
  const lists: Item[][] = []
  const open = new Map<number, { key: string; list: Item[] }>()
  for (const p of paragraphEls(container)) {
    const level = levelOf(p)
    for (const l of [...open.keys()]) if (l > level) open.delete(l)
    const span = ownBullet(p)
    const num = span ? parseNum(span.textContent ?? '') : null
    if (!span || !num) { open.delete(level); continue }
    const key = `${/^\d/.test(num.token) ? 'd' : num.token === num.token.toLowerCase() ? 'l' : 'u'}${num.open}${num.close}`
    const cur = open.get(level)
    if (cur?.key === key) cur.list.push({ span, num })
    else { const list = [{ span, num }]; lists.push(list); open.set(level, { key, list }) }
  }
  for (const list of lists) {
    const first = list[0].num.token
    const lower = first === first.toLowerCase()
    const romanish = (t: string) => /^[ivxlcdm]+$/i.test(t)
    const kind: NumKind = /^\d/.test(first) ? 'arabic'
      : (/^i$/i.test(first) || list.some((x) => x.num.token.length > 1)) && list.every((x) => romanish(x.num.token)) ? (lower ? 'romanLc' : 'romanUc')
        : lower ? 'alphaLc' : 'alphaUc'
    const value = (t: string) => kind === 'arabic' ? Number(t) : kind.startsWith('roman') ? fromRoman(t.toLowerCase()) : (t.toLowerCase().charCodeAt(0) - 96) + 26 * (t.length - 1)
    const start = value(first)
    for (const { span, num } of list) Object.assign(span.dataset, { numKind: kind, numStart: String(start), numOpen: num.open, numClose: num.close, numTail: num.tail })
  }
  for (const p of paragraphEls(container)) {
    const span = ownBullet(p)
    const src = p.getAttribute(PPTX_ATTRS.paragraph)
    if (span && src != null && !templates.has(src)) templates.set(src, span.cloneNode(true) as HTMLElement)
  }
  if (!templates.size || watched.has(container)) return
  watched.add(container)
  container.addEventListener('beforeinput', (e) => {
    newItemAbove(container, e)
    removeBullet(container, e)
  })
  container.addEventListener('input', () => syncBullets(container))
}

/**
 * Enter at the very start of a bulleted line: Chrome mishandles the caret next
 * to the non-editable bullet (it inserts a line break into the item). Do what
 * PowerPoint does — open an empty item above and keep the caret on this line.
 */
function newItemAbove(container: HTMLElement, e: InputEvent) {
  if (e.inputType !== 'insertParagraph') return
  const sel = window.getSelection()!
  const p = bulletedLineAtCaret(container)
  if (!p) return
  e.preventDefault()
  const item = p.cloneNode(false) as HTMLElement
  item.appendChild(document.createElement('br'))
  p.before(item)
  syncBullets(container)
  // Keep the caret at the start of this line's text.
  const text = document.createTreeWalker(p, NodeFilter.SHOW_TEXT)
  for (let n = text.nextNode(); n; n = text.nextNode()) {
    if (!n.parentElement?.closest(`[${PPTX_ATTRS.bullet}]`)) { sel.collapse(n, 0); break }
  }
}

/** The bulleted paragraph whose text the (collapsed) caret is at the very start of. */
function bulletedLineAtCaret(container: HTMLElement): HTMLElement | null {
  const sel = window.getSelection()
  if (!sel?.isCollapsed || !sel.anchorNode) return null
  const p = paragraphEls(container).reverse().find((el) => el.contains(sel.anchorNode))
  if (!p || !ownBullet(p)) return null
  const before = document.createRange()
  before.setStart(p, 0)
  before.setEnd(sel.anchorNode, sel.anchorOffset)
  const head = before.cloneContents()
  head.querySelectorAll(`[${PPTX_ATTRS.bullet}]`).forEach((b) => b.remove())
  return (head.textContent ?? '').replace(/​/g, '') === '' ? p : null
}

/**
 * Backspace at the start of a bulleted line, as in PowerPoint: the first press
 * removes just the bullet / number (the line stays, as a plain paragraph — a
 * way to get a blank line or a note inside a list); the next one joins it to
 * the line above.
 */
function removeBullet(container: HTMLElement, e: InputEvent) {
  if (e.inputType !== 'deleteContentBackward') return
  const p = bulletedLineAtCaret(container)
  if (!p) return
  e.preventDefault()
  ownBullet(p)!.remove()
  p.setAttribute(NO_BULLET, '')
  syncBullets(container)
  // Tell the editor's owner there's a change (preventDefault means no input event of its own).
  container.dispatchEvent(new Event('input', { bubbles: true }))
}

/** Whether a paragraph element has text (not counting its bullet). */
const hasText = (p: HTMLElement) =>
  [...p.childNodes].some((n) => !(n instanceof Element && n.hasAttribute(PPTX_ATTRS.bullet)) && (n.textContent ?? '').replace(/​/g, '') !== '')

function syncBullets(container: HTMLElement) {
  const templates = bulletTemplates.get(container)
  if (!templates) return
  const sel = window.getSelection()
  let src: string | null = null
  const counters = new Map<number, { key: string; n: number }>()
  for (const p of paragraphEls(container)) {
    // A paragraph the browser created without a source index saves as the previous one (see readParagraphsAt).
    src = p.getAttribute(PPTX_ATTRS.paragraph) ?? src
    let span = ownBullet(p)
    const template = src != null && !p.hasAttribute(NO_BULLET) ? templates.get(src) : undefined
    if (!span && template) {
      span = template.cloneNode(true) as HTMLElement
      const caretHere = sel?.isCollapsed && sel.anchorNode === p && sel.anchorOffset === 0
      p.insertBefore(span, p.firstChild)
      if (caretHere) sel!.collapse(p, 1) // keep typing after the bullet, not before it
    }
    // Renumber, PowerPoint-style: a list continues at its level until a shallower or un-numbered paragraph
    // (an empty line without a bullet doesn't interrupt it).
    if (!span && !hasText(p)) continue
    const level = levelOf(p)
    for (const l of [...counters.keys()]) if (l > level) counters.delete(l)
    const d = span?.dataset
    if (!d?.numKind) { counters.delete(level); continue }
    const key = `${d.numKind}${d.numOpen}${d.numClose}`
    const c = counters.get(level)
    const n = c?.key === key ? c.n + 1 : Number(d.numStart) || 1
    counters.set(level, { key, n })
    const text = `${d.numOpen}${formatNum(d.numKind as NumKind, n)}${d.numClose}${d.numTail}`
    if (span!.textContent !== text) span!.textContent = text
  }
}

function sameRun(a?: [number, number], b?: [number, number]) {
  if (!a || !b) return !a && !b
  return a[0] === b[0] && a[1] === b[1]
}
