/**
 * Speaker notes edited with the change marked ("Edit + marks" in the notes pane): marked in the
 * editor itself, the same way the read-only Changes view shows it — paragraph by paragraph
 * (`paragraphOpsOf`): a removed paragraph as a struck-through block, an added one highlighted
 * whole, an edited one word by word (removed words struck through in place, new runs highlighted).
 * The removed text is in `GHOST_ATTR` spans — not editable, skipped by every text reader, never
 * saved; the new text is a CSS Custom Highlight ("notes-added", no DOM change). Redone after typing
 * pauses; the caret is kept.
 */

import { PPTX_ATTRS } from '@diceui/pptx-core'
import { paragraphOpsOf } from './deckDiff'
import { GHOST_ATTR, domPointAt, readParagraphs, readParagraphsAt } from './textEdit'

const HIGHLIGHT = 'notes-added'
const STRUCK = 'select-none text-red-600 line-through decoration-red-500/80'

type HighlightRegistry = Map<string, unknown>
const registry = () => (globalThis as { CSS?: { highlights?: HighlightRegistry } }).CSS?.highlights
const Highlight = () => (globalThis as { Highlight?: new (...r: Range[]) => unknown }).Highlight

/** Remove the marks (the removed text and the highlight). */
export function clearNotesChangeMarks(el: HTMLElement | null) {
  el?.querySelectorAll(`[${GHOST_ATTR}]`).forEach((g) => g.remove())
  registry()?.delete(HIGHLIGHT)
}

interface Word { node: Text; at: number; endNode: Text; end: number }

/** A paragraph element's words (bullets and marks skipped), where each starts and ends. */
function wordsOf(p: Element): Word[] {
  const pieces: { node: Text; at: number }[] = []
  let text = ''
  const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT)
  while (walker.nextNode()) {
    const node = walker.currentNode as Text
    if (node.parentElement?.closest(`[data-pptx-bullet], [${GHOST_ATTR}]`)) continue
    pieces.push({ node, at: text.length })
    text += node.data.replace(/​/g, ' ') // (same length: offsets stay right)
  }
  const pointAt = (pos: number, end: boolean): [Text, number] => {
    let k = pieces.length - 1
    while (k > 0 && (end ? pieces[k].at >= pos : pieces[k].at > pos)) k--
    return [pieces[k].node, Math.min(pos - pieces[k].at, pieces[k].node.data.length)]
  }
  if (!pieces.length) return []
  return [...text.matchAll(/\S+/g)].map((m) => {
    const [node, at] = pointAt(m.index!, false)
    const [endNode, end] = pointAt(m.index! + m[0].length, true)
    return { node, at, endNode, end }
  })
}

function insertAt(node: Text, offset: number, el: Node) {
  if (offset <= 0) node.parentNode?.insertBefore(el, node)
  else if (offset >= node.data.length) node.parentNode?.insertBefore(el, node.nextSibling)
  else {
    const rest = node.splitText(offset)
    rest.parentNode?.insertBefore(el, rest)
  }
}

function ghost(text: string, block: boolean): HTMLElement {
  const g = document.createElement('span')
  g.setAttribute(GHOST_ATTR, '')
  g.contentEditable = 'false'
  g.className = STRUCK
  // (A span, not a div: the editor's paragraph code treats only div/p/li as paragraphs.)
  if (block) g.style.display = 'block'
  g.textContent = text
  return g
}

/** Mark how the editor's text differs from `other` (the other version's notes), in place. */
export function markNotesChanges(el: HTMLElement, other: string) {
  const sel = window.getSelection()
  const focused = document.activeElement === el
  // The selection (not just the caret) is kept: ⌘B on a selection, then ⌘I, works on it again.
  const [anchor, focus] = focused && sel?.anchorNode && sel.focusNode && el.contains(sel.anchorNode) && el.contains(sel.focusNode)
    ? readParagraphsAt(el, [[sel.anchorNode, sel.anchorOffset], [sel.focusNode, sel.focusOffset]]).positions
    : [null, null]
  el.querySelectorAll(`[${GHOST_ATTR}]`).forEach((g) => g.remove())
  el.normalize()
  const restoreCaret = () => {
    if (!anchor || !sel) return
    const a = domPointAt(el, anchor, 'start')
    const f = focus && (focus.p !== anchor.p || focus.o !== anchor.o) ? domPointAt(el, focus, 'end') : a
    if (a && f) sel.setBaseAndExtent(a[0], a[1], f[0], f[1])
  }

  const paras = readParagraphs(el)
  const paraEls = [...el.children].filter((c) => c.hasAttribute(PPTX_ATTRS.paragraph))
  // (Paragraphs as the text reader sees them should be the paragraph elements; if not, mark nothing.)
  if (paras.length !== paraEls.length) {
    registry()?.delete(HIGHLIGHT)
    return restoreCaret()
  }
  const ops = paragraphOpsOf(other.split('\n'), paras.map((p) => p.runs.map((r) => r.text).join('')))

  // 1. The removed text, struck through: whole paragraphs before the next paragraph (in order),
  // words before the next word (in a paragraph last first, so the positions found stay right).
  const blocks: (() => void)[] = []
  const inline: (() => void)[] = []
  let np = 0
  for (const p of ops) {
    if (p.k === 'del') {
      const next = paraEls[np]
      const text = p.ops.map((o) => o.t).join(' ')
      blocks.push(() => (next ? el.insertBefore(ghost(text, true), next) : el.appendChild(ghost(text, true))))
      continue
    }
    const pel = paraEls[np++]
    if (p.k !== 'edit' || !pel) continue
    const words = wordsOf(pel)
    let j = 0
    const here: (() => void)[] = []
    for (const o of p.ops) {
      if (o.k !== 'del') {
        j += o.t.split(' ').length
        continue
      }
      const next = words[j]
      const last = words[words.length - 1]
      if (next) here.push(() => insertAt(next.node, next.at, ghost(`${o.t} `, false)))
      else if (last) here.push(() => insertAt(last.endNode, last.end, ghost(` ${o.t}`, false)))
    }
    if (j === words.length) inline.push(...here.reverse())
  }
  for (const f of inline) f()
  for (const f of blocks) f()

  // 2. The new text, highlighted: added paragraphs whole, added words as runs (no gaps between words).
  const ranges: Range[] = []
  np = 0
  for (const p of ops) {
    if (p.k === 'del') continue
    const pel = paraEls[np++]
    if (!pel || p.k === 'same') continue
    const words = wordsOf(pel)
    const run = (a: Word, b: Word) => {
      const r = document.createRange()
      r.setStart(a.node, a.at)
      r.setEnd(b.endNode, b.end)
      ranges.push(r)
    }
    if (p.k === 'add') {
      if (words.length) run(words[0], words[words.length - 1])
      continue
    }
    let j = 0
    for (const o of p.ops) {
      if (o.k === 'del') continue
      const n = o.t.split(' ').length
      if (o.k === 'add' && words[j] && words[j + n - 1]) run(words[j], words[j + n - 1])
      j += n
    }
  }
  const reg = registry()
  const H = Highlight()
  if (reg && H) reg.set(HIGHLIGHT, new H(...ranges))
  restoreCaret()
}
