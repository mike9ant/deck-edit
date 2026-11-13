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
  container.querySelectorAll(`[${PPTX_ATTRS.bullet}]`).forEach((b) => ((b as HTMLElement).contentEditable = 'false'))
  container.focus()
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

/** Read an edited container back into setTextBody paragraphs. */
export function readParagraphs(container: HTMLElement): SetTextBodyParagraph[] {
  const out: SetTextBodyParagraph[] = []
  let lastP = 0
  let current: { p: number; runs: SetTextBodyRun[] } | null = null

  const startParagraph = (el: Element | null) => {
    const attr = el?.getAttribute(PPTX_ATTRS.paragraph)
    const p = attr != null ? Number(attr) : lastP
    lastP = p
    current = { p, runs: [] }
    out.push({ sourceParagraphIndex: p, runs: current.runs })
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
      const t = (node.textContent ?? '').replace(/​/g, '')
      if (t) pushText(t, run ?? inherited())
      return
    }
    if (!(node instanceof Element)) return
    if (node.hasAttribute(PPTX_ATTRS.bullet)) return
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
  return out
}

function sameRun(a?: [number, number], b?: [number, number]) {
  if (!a || !b) return !a && !b
  return a[0] === b[0] && a[1] === b[1]
}
