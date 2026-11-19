/**
 * The formatted Markdown view, with its text editable in place: click a
 * paragraph, heading, list item or table cell and type. Enter (or clicking
 * away) commits, Escape cancels, ↑ on a block's first line / ↓ on its last
 * moves to the previous/next block (in a table: the cell above/below), ← at
 * a cell's start / → at its end to the previous/next cell. In a list, Enter
 * at the end of an item adds one below and Backspace in an empty item removes
 * it; in a table, Enter at the end of a row's last cell adds a row below and
 * Backspace in the empty first cell of an empty row removes the row. ⌘Z / ⇧⌘Z undo/redo saved edits
 * (in a block with unsaved typing, that typing first) — through the file's history shared with the
 * Markdown tab (docHistory.ts), which survives switching tabs and the agent's saves. The cursor is
 * remembered as a source position, so either tab opens where you were.
 *
 * Blocks become editable only when clicked (or a selection is made inside
 * one): until then the view is an ordinary document, so a drag can select
 * across paragraphs, lists and tables — the bar over such a selection copies
 * its text or the Markdown source of the blocks it touches.
 *
 * Bold and italic toggle with ⌘B / ⌘I or the little toolbar over a selection,
 * like a word processor: a selection that's all bold loses bold on just that
 * part; one that's partly bold (at or across a section's edge) becomes bold as
 * a whole, merging with that section; with only the caret in bold text, the
 * whole section loses it. Other formatting (links,
 * headings, lists) is changed in the Markdown tab.
 *
 * Each change is written back into exactly the source characters it came
 * from (mdSourceEdit.ts), so the rest of the file is never reformatted.
 *
 * Code is editable too. Inline code is typed in like the text around it (and
 * rewritten with backticks that fit). A fenced code block is a block of its
 * own: Enter is a new line, Tab indents, ⌘Enter or clicking away saves, Escape
 * cancels; its text goes back between the fences. Images (and indented code
 * blocks or code in quotes) are read-only.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Bold, Copy, FileCode, Italic } from 'lucide-react'
import clsx from 'clsx'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useApp } from '../store/appStore'
import { rebase } from './textMerge'
import { findQuote, type QuoteMark, type TextSelection } from './TextEditor'
import { domRangeOf } from './textRanges'
import { useNotes } from '../store/notesStore'
import { NotePopover } from '../notes/NotePins'
import { DocHistory } from './docHistory'

import {
  applyRunEdits, codeBlockEdit, codeBlockSourcePos, codeBlockTextOffset, deleteLineAt, inlineCodeSource, inlineCodeTextStart, insertLineAfter,
  lineStartOf, listItemContentStart, mapPos, nextListMarker, tableCellArea,
  rehypeSourceText, runSourceMap, sameVisibleText, toggleMarkRange, unwrapMark, type Mark, type RunContext, type RunEdit } from './mdSourceEdit'

interface Snapshot {
  /** The block element it was taken from (a re-render replaces it). */
  host: HTMLElement
  runs: Map<string, { s: number; e: number; v: string }>
  outside: string
  /** Inline code in the block: source range (backticks included) and text. */
  codes: Map<string, { s: number; e: number; v: string }>
  /** List items / table cells with no text: typing into them goes into their source slot. */
  empty: HTMLElement[]
}

/** The list item or table cell a node belongs to (its innermost). */
const slotOf = (n: Node | null): HTMLElement | null => (n instanceof Element ? n : n?.parentElement ?? null)?.closest<HTMLElement>('li, td, th') ?? null

/** Text nodes of a list item / cell's own text (not those of nested lists). */
function ownTextNodes(el: HTMLElement): Text[] {
  const out: Text[] = []
  const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
  for (let n = w.nextNode() as Text | null; n; n = w.nextNode() as Text | null) if (slotOf(n) === el) out.push(n)
  return out
}
const ownText = (el: HTMLElement) => ownTextNodes(el).map((n) => n.data).join('')

/** The caret's offset within a list item / cell's own text. */
function ownOffset(el: HTMLElement, node: Node, off: number): number {
  const before = document.createRange()
  before.setStart(el, 0)
  before.setEnd(node, off)
  let acc = 0
  for (const n of ownTextNodes(el)) {
    if (n === node) return acc + off
    if (before.intersectsNode(n)) acc += n.length
  }
  return acc
}

/** A caret at the start / end of an element's own text (inside it even when empty). */
function caretIn(el: HTMLElement, at: 'start' | 'end'): Range {
  const nodes = el.matches('li, td, th') ? ownTextNodes(el) : []
  const r = document.createRange()
  const n = at === 'start' ? nodes[0] : nodes[nodes.length - 1]
  if (n) r.setStart(n, at === 'start' ? 0 : n.length)
  else {
    r.selectNodeContents(el)
    r.collapse(true)
  }
  r.collapse(true)
  return r
}

const runKey = (el: HTMLElement) => `${el.dataset.s}:${el.dataset.e}`
const runSpans = (host: HTMLElement) => [...host.querySelectorAll<HTMLElement>('span[data-s]')]

/** Text in a block that isn't inside a source-mapped run or inline code (typed into a gap…). */
function outsideText(host: HTMLElement, skip?: Set<HTMLElement>): string {
  let out = ''
  const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT)
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.parentElement?.closest('span[data-s], code[data-cs]')) continue
    const slot = skip && slotOf(n)
    if (slot && skip.has(slot)) continue
    out += n.textContent
  }
  return out
}

const codeKey = (el: HTMLElement) => `${el.dataset.cs}:${el.dataset.ce}`
const inlineCodes = (host: HTMLElement) => [...host.querySelectorAll<HTMLElement>('code[data-cs]')]
/** A fenced code block, edited as a block of its own. */
const isCodeHost = (el: HTMLElement) => el.hasAttribute('data-md-code')

/** A code block's text as typed (line breaks the browser made as elements read as newlines). */
function codeText(host: HTMLElement): string {
  let out = ''
  const walk = (n: Node) => {
    if (n.nodeType === Node.TEXT_NODE) out += (n as Text).data
    else if (n.nodeName === 'BR') out += '\n'
    else {
      if ((n.nodeName === 'DIV' || n.nodeName === 'P') && out && !out.endsWith('\n')) out += '\n'
      n.childNodes.forEach(walk)
    }
  }
  host.childNodes.forEach(walk)
  return out
}

/** What Tab inserts in a code block: a tab if it's indented with tabs, else its smallest space indent (2 by default). */
function codeIndent(text: string): string {
  if (/^\t/m.test(text)) return '\t'
  const runs = text.match(/^ +(?=\S)/gm)
  return ' '.repeat(runs ? Math.min(8, Math.max(2, Math.min(...runs.map((r) => r.length)))) : 2)
}

/** A spot in a block as a character offset into its text — survives re-rendering, since formatting doesn't change the text. */
type Pos = { block: number; start: number; end: number }

function textOffset(root: Node, node: Node, off: number): number {
  const r = document.createRange()
  r.setStart(root, 0)
  r.setEnd(node, off)
  return r.toString().length
}

/** The text node + offset at a character offset (`start` prefers the following node at a boundary, `end` the preceding one). */
function pointAt(host: HTMLElement, offset: number, bias: 'start' | 'end'): { node: Text; offset: number } | null {
  const w = document.createTreeWalker(host, NodeFilter.SHOW_TEXT)
  let acc = 0
  let last: Text | null = null
  for (let n = w.nextNode() as Text | null; n; n = w.nextNode() as Text | null) {
    if (bias === 'start' ? offset < acc + n.length : offset <= acc + n.length) return { node: n, offset: offset - acc }
    acc += n.length
    last = n
  }
  return last ? { node: last, offset: last.length } : null
}

/** Whether every non-space character between text offsets a and b is inside a `mark` element. */
function allMarked(host: HTMLElement, a: number, b: number, mark: Mark): boolean {
  const w = document.createTreeWalker(host, NodeFilter.SHOW_TEXT)
  let acc = 0
  for (let n = w.nextNode() as Text | null; n; n = w.nextNode() as Text | null) {
    const s = Math.max(a, acc)
    const e = Math.min(b, acc + n.length)
    if (s < e && n.data.slice(s - acc, e - acc).trim() && !n.parentElement?.closest(mark)) return false
    acc += n.length
  }
  return true
}

/** The screen rect of a block's first (or last) line of text: its first (last) character's box. */
function edgeLineRect(host: HTMLElement, last: boolean): DOMRect | null {
  const w = document.createTreeWalker(host, NodeFilter.SHOW_TEXT)
  let node: Text | null = null
  for (let n = w.nextNode() as Text | null; n; n = w.nextNode() as Text | null) {
    if (!n.data.trim()) continue
    node = n
    if (!last) break
  }
  if (!node) return null
  const r = document.createRange()
  const i = last ? node.data.trimEnd().length - 1 : node.data.length - node.data.trimStart().length
  r.setStart(node, i)
  r.setEnd(node, i + 1)
  const rects = r.getClientRects()
  return rects.length ? rects[last ? rects.length - 1 : 0] : null
}

/** A collapsed range at a screen point (where a click landed). */
function caretAt(x: number, y: number): Range | null {
  const doc = document as Document & { caretPositionFromPoint?(x: number, y: number): { offsetNode: Node; offset: number } | null }
  if (document.caretRangeFromPoint) return document.caretRangeFromPoint(x, y)
  const p = doc.caretPositionFromPoint?.(x, y)
  if (!p) return null
  const r = document.createRange()
  r.setStart(p.offsetNode, p.offset)
  return r
}

function contextOf(el: HTMLElement): RunContext {
  const block = el.closest('[data-md-block]')
  const tag = block?.tagName.toLowerCase() ?? ''
  return /^h\d$/.test(tag) ? 'heading' : tag === 'td' || tag === 'th' ? 'cell' : 'text'
}

export function MarkdownEditable({ text, editable, onChange, onSelection, marks = [], history }: {
  text: string
  editable: boolean
  /** The file's undo history and cursor, shared with the Markdown tab (a private one if not given). */
  history?: DocHistory
  onChange(next: string): void
  /** The selected text (and its lines in the source), or null. */
  onSelection?(s: TextSelection | null): void
  /** Text of open notes, highlighted. */
  marks?: QuoteMark[]
}) {
  const [generation, setGeneration] = useState(0)
  const onSelectionRef = useRef(onSelection)
  onSelectionRef.current = onSelection
  const [bar, setBar] = useState<{ x: number; y: number; kind: 'format' | 'copy'; bold: boolean; italic: boolean } | null>(null)
  const articleRef = useRef<HTMLElement>(null)
  const pendingFormat = useRef<(Pos & { mark: Mark }) | null>(null)
  const restoreSel = useRef<Pos | null>(null)
  /** After a structural edit: the list item / table row (by its new source start) to put the caret in. */
  const focusAt = useRef<{ tag: 'li' | 'tr'; hs: number; cell?: number; at: 'start' | 'end' } | null>(null)
  const snapshot = useRef<Snapshot | null>(null)
  const ownHistory = useRef<DocHistory | null>(null)
  const hist = history ?? (ownHistory.current ??= new DocHistory(text))
  const histRef = useRef(hist)
  histRef.current = hist
  /** After undo/redo or on opening: the source position to put the caret at. */
  const restoreSource = useRef<{ anchor: number; head: number } | null>(null)
  /** The last caret / selection in a block (text offsets, converted to a source position on leaving). */
  const lastPos = useRef<Pos | null>(null)
  // The view renders its own copy of the source: an edit shows immediately, without waiting
  // for the parent to re-render. A different `text` arriving means the file changed on disk.
  const [source, setSource] = useState(text)
  const rendered = useRef(source)
  rendered.current = source
  const ours = useRef(text)
  useEffect(() => {
    if (text === ours.current) return
    // The file changed on disk (the agent). Typing in the focused block isn't saved yet: merge it
    // onto the new text, then put the caret back in that block.
    let next = text
    let caret: Pos | null = null
    const snap = snapshot.current
    if (snap?.host.isConnected) {
      const edits = collect(snap.host, snap)
      if (edits?.length) {
        const r = rebase(rendered.current, applyRunEdits(rendered.current, edits), text)
        next = r.text
        if (!r.clean) toast('Part of your typing overlapped the agent’s edit and couldn’t be merged — check that spot.')
      }
      const sel = getSelection()
      if (sel?.rangeCount && snap.host.contains(sel.anchorNode)) {
        const r = sel.getRangeAt(0)
        caret = { block: hosts().indexOf(snap.host), start: textOffset(snap.host, r.startContainer, r.startOffset), end: textOffset(snap.host, r.endContainer, r.endOffset) }
      }
    }
    hist.external(text) // not undoable; the user's own steps stay
    if (next !== text) hist.edit(next) // their merged typing is theirs
    ours.current = next
    snapshot.current = null
    restoreSel.current = caret
    setSource(next)
    setGeneration((g) => g + 1)
    if (next !== text) onChange(next) // save the merged text
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text])

  const toast = (t: string) => useApp.getState().toast(t, 'error')
  /** Editable blocks, outermost only (a nested list item is typed in through its parent item). */
  const hosts = () =>
    [...(articleRef.current?.querySelectorAll<HTMLElement>('[data-md-block]') ?? [])].filter((el) => !el.parentElement?.closest('[data-md-block]'))
  const hostOf = (n: Node | null): HTMLElement | null => {
    let el = (n instanceof Element ? n : n?.parentElement)?.closest<HTMLElement>('[data-md-block]') ?? null
    while (el?.parentElement?.closest('[data-md-block]')) el = el.parentElement.closest<HTMLElement>('[data-md-block]')
    return el && articleRef.current?.contains(el) ? el : null
  }

  const publishRef = useRef<(next: string, history?: boolean) => void>(() => {})
  /** Write a new source, as one undoable step. */
  const publish = (next: string, record = true) => {
    if (record) histRef.current.edit(next)
    ours.current = next
    setSource(next)
    onChange(next)
    setGeneration((g) => g + 1) // re-render cleanly from the new source
  }

  publishRef.current = publish

  /** Make a block editable and put the caret/selection in it. */
  const activate = (host: HTMLElement, range?: Range | null) => {
    if (!editable) return
    if (!host.isContentEditable) {
      host.setAttribute('contenteditable', 'plaintext-only')
      host.spellcheck = true
    }
    host.focus({ preventScroll: true })
    if (range) {
      getSelection()?.removeAllRanges()
      getSelection()?.addRange(range)
    }
  }

  // ── the cursor as a source position (shared with the Markdown tab) ─────
  /** The source offset of a point in the document; null outside any editable block. */
  const sourceOffsetAt = (node: Node, off: number): number | null => {
    const host = hostOf(node)
    if (!host) return null
    if (node instanceof Element) {
      // A point between elements: the text position there.
      const p = pointAt(host, textOffset(host, node, off), 'end')
      if (p) ({ node, offset: off } = p)
    }
    const src = rendered.current
    if (isCodeHost(host)) return codeBlockSourcePos(src, Number(host.dataset.hs), Number(host.dataset.he), textOffset(host, node, off)) ?? Number(host.dataset.hs)
    const code = (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>('code[data-cs]')
    if (code && host.contains(code)) {
      const cs = Number(code.dataset.cs)
      const ce = Number(code.dataset.ce)
      return Math.min(inlineCodeTextStart(src, cs, ce) + textOffset(code, node, off), ce)
    }
    const run = (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>('span[data-s]')
    if (run && host.contains(run)) {
      const s = Number(run.dataset.s)
      const e = Number(run.dataset.e)
      const i = textOffset(run, node, off)
      const map = runSourceMap(src, s, e, run.dataset.v ?? '')
      return map ? map[Math.min(i, map.length - 1)] : Math.min(s + i, e)
    }
    // Not in a text run (an empty item, inline code…): the end of the run before it, else the block's start.
    let at: number | null = null
    for (const r of runSpans(host)) if (r.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING) at = Number(r.dataset.e)
    return at ?? Number(host.dataset.hs ?? host.closest<HTMLElement>('[data-bs]')?.dataset.bs ?? 0)
  }

  /** The point for a source offset: in the text run holding it, else at the start of the next run (or the end of the last). */
  const domPointAtSource = (pos: number): { host: HTMLElement; node: Text; offset: number } | null => {
    const src = rendered.current
    let last: HTMLElement | null = null
    for (const run of articleRef.current?.querySelectorAll<HTMLElement>('span[data-s], code[data-cs], pre[data-md-code]') ?? []) {
      const host = hostOf(run)
      if (!host) continue
      last = run
      const isPre = run.tagName === 'PRE'
      const isCode = run.tagName === 'CODE'
      const s = Number(isPre ? run.dataset.hs : isCode ? run.dataset.cs : run.dataset.s)
      const e = Number(isPre ? run.dataset.he : isCode ? run.dataset.ce : run.dataset.e)
      if (pos > e) continue
      if (isPre || isCode) {
        const len = (run.textContent ?? '').length
        const i = isPre ? codeBlockTextOffset(src, s, e, pos) ?? 0 : pos - inlineCodeTextStart(src, s, e)
        const p = pointAt(run, Math.max(0, Math.min(i, len)), 'start')
        return p && { host, ...p }
      }
      const map = runSourceMap(src, s, e, run.dataset.v ?? '')
      const i = pos <= s ? 0 : map ? Math.max(0, map.findIndex((m) => m >= pos)) : pos - s
      const p = pointAt(run, i, 'start')
      return p && { host, ...p }
    }
    const p = last && pointAt(last, (last.textContent ?? '').length, 'end')
    return p && last ? { host: hostOf(last)!, ...p } : null
  }

  /** Remember the caret / selection in a block (typing moves it without a selectionchange in some browsers: also on input and keys). */
  const recordPos = () => {
    const sel = getSelection()
    const r = sel?.rangeCount ? sel.getRangeAt(0) : null
    const host = r && hostOf(r.startContainer)
    if (!r || !host) return
    const start = textOffset(host, r.startContainer, r.startOffset)
    lastPos.current = { block: hosts().indexOf(host), start, end: hostOf(r.endContainer) === host ? textOffset(host, r.endContainer, r.endOffset) : start }
  }

  /** Put the caret (or selection, within one block) at source positions and bring it into view. */
  const placeCaret = (at: { anchor: number; head: number }, block: ScrollLogicalPosition) => {
    const a = domPointAtSource(Math.min(at.anchor, at.head))
    if (!a) return
    const b = at.anchor === at.head ? a : domPointAtSource(Math.max(at.anchor, at.head))
    const r = document.createRange()
    r.setStart(a.node, a.offset)
    if (b && b.host === a.host) r.setEnd(b.node, b.offset)
    else r.collapse(true)
    snapshot.current = null
    activate(a.host, r)
    ;(a.node.parentElement ?? a.host).scrollIntoView({ block })
  }

  /** Leave `host` for `target` with the caret at `caret`, saving the edit on the way (if that re-renders, the effect below lands the caret). */
  const moveInto = (host: HTMLElement, target: HTMLElement, caret: Range) => {
    const block = hosts().indexOf(target)
    const off = textOffset(target, caret.startContainer, caret.startOffset)
    if (commit(host) !== 'none') {
      restoreSel.current = { block, start: off, end: off }
      return
    }
    host.removeAttribute('contenteditable')
    activate(target, caret)
  }
  const edgeCaret = (target: HTMLElement, atEnd: boolean) => {
    const r = document.createRange()
    r.selectNodeContents(target)
    r.collapse(!atEnd)
    return r
  }

  /** Where ↑/↓ leads: in a table the cell above/below (leaving the table past its first/last row), else the previous/next block. */
  const verticalTarget = (host: HTMLElement, dir: -1 | 1): HTMLElement | null => {
    const list = hosts()
    if (host instanceof HTMLTableCellElement) {
      const table = host.closest('table')!
      const rows = [...table.rows]
      const row = rows[rows.indexOf(host.parentElement as HTMLTableRowElement) + dir]
      if (row) return row.cells[Math.min(host.cellIndex, row.cells.length - 1)] ?? null
      const inTable = list.filter((h) => table.contains(h))
      return list[dir < 0 ? list.indexOf(inTable[0]) - 1 : list.indexOf(inTable[inTable.length - 1]) + 1] ?? null
    }
    return list[list.indexOf(host) + dir] ?? null
  }

  /** ↑ on a block's first line / ↓ on its last: move to the block (or table cell) above/below, at the same x. */
  const moveVertical = (host: HTMLElement, dir: -1 | 1): boolean => {
    const sel = getSelection()
    if (!sel?.rangeCount) return false
    const r = sel.getRangeAt(0).cloneRange()
    r.collapse(dir < 0)
    const hr = host.getBoundingClientRect()
    let cr = r.getClientRects()[0] ?? r.getBoundingClientRect()
    if (!cr.height) cr = new DOMRect(hr.left, dir < 0 ? hr.top : hr.bottom - 1, 0, 1)
    const lh = parseFloat(getComputedStyle(host).lineHeight) || 20
    // Only from the text's first (↑) / last (↓) line — measured on the text itself, not the block's
    // box: a table cell can be taller than its text when a neighbouring cell wraps.
    const edge = edgeLineRect(host, dir > 0)
    if (edge && Math.abs((dir < 0 ? cr.top - edge.top : cr.bottom - edge.bottom)) > lh / 2) return false
    let target = verticalTarget(host, dir)
    if (!target) return false
    // Entering a table from above/below: the cell under the caret.
    if (target instanceof HTMLTableCellElement && !target.closest('table')!.contains(host)) {
      const row = target.parentElement as HTMLTableRowElement
      target = [...row.cells].find((c) => { const b = c.getBoundingClientRect(); return cr.left >= b.left && cr.left < b.right }) ?? target
    }
    target.scrollIntoView({ block: 'nearest' })
    const tr = target.getBoundingClientRect()
    const x = Math.min(Math.max(cr.left, tr.left + 1), tr.right - 1)
    // Aim at the target's last (↑) / first (↓) line of text — not its box, which can be taller.
    const line = edgeLineRect(target, dir < 0)
    const y = line ? line.top + line.height / 2 : dir < 0 ? tr.bottom - Math.min(lh / 2, tr.height / 2) : tr.top + Math.min(lh / 2, tr.height / 2)
    let caret = caretAt(x, y)
    if (!caret || hostOf(caret.startContainer) !== target) caret = edgeCaret(target, dir < 0)
    moveInto(host, target, caret)
    return true
  }

  /** ← at the start / → at the end of a table cell: the previous/next cell (row by row, within the table). */
  const moveHorizontal = (host: HTMLElement, dir: -1 | 1): boolean => {
    if (!(host instanceof HTMLTableCellElement)) return false
    const sel = getSelection()
    if (!sel?.rangeCount || !sel.isCollapsed) return false
    const r = sel.getRangeAt(0)
    const off = textOffset(host, r.startContainer, r.startOffset)
    if (dir < 0 ? off > 0 : off < (host.textContent ?? '').length) return false
    const cells = [...host.closest('table')!.querySelectorAll<HTMLElement>('th, td')]
    const target = cells[cells.indexOf(host) + dir]
    if (!target) return false
    target.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    moveInto(host, target, edgeCaret(target, dir < 0))
    return true
  }

  const copySelection = async (asMarkdown: boolean) => {
    const sel = getSelection()
    const r = sel?.rangeCount ? sel.getRangeAt(0) : null
    if (!r) return
    let out = sel!.toString()
    if (asMarkdown) {
      const blocks = [...(articleRef.current?.children ?? [])].filter((el): el is HTMLElement => el instanceof HTMLElement && !!el.dataset.bs && r.intersectsNode(el))
      if (!blocks.length) return
      out = rendered.current.slice(Math.min(...blocks.map((b) => Number(b.dataset.bs))), Math.max(...blocks.map((b) => Number(b.dataset.be))))
    }
    await navigator.clipboard.writeText(out)
    useApp.getState().toast(asMarkdown ? 'Copied the Markdown of the selected blocks.' : 'Copied the selected text.')
  }

  /** The source edits for what was typed in a block since it was focused; null if it can't be mapped back. */
  const collect = (host: HTMLElement, snap: Snapshot): RunEdit[] | null => {
    const src = rendered.current
    if (isCodeHost(host)) {
      const now = codeText(host).replace(/\u00a0/g, ' ')
      if (now === snap.outside) return []
      const ed = codeBlockEdit(src, Number(host.dataset.hs), Number(host.dataset.he), now)
      return ed && [ed]
    }
    // Never write through stale positions: every recorded run must still be what the file has there.
    for (const r of snap.runs.values()) if (!runSourceMap(src, r.s, r.e, r.v)) return null
    const edits: RunEdit[] = []
    const seen = new Set<string>()
    for (const span of runSpans(host)) {
      const k = runKey(span)
      const orig = snap.runs.get(k)
      if (!orig) continue
      seen.add(k)
      // Typed edge spaces arrive as non-breaking spaces; the file wants plain ones.
      const now = (span.textContent ?? '').replace(/\u00a0/g, ' ')
      if (now !== orig.v) edits.push({ s: orig.s, e: orig.e, text: now, ctx: contextOf(span) })
    }
    // A run deleted entirely (the browser drops its emptied span).
    for (const [k, orig] of snap.runs) if (!seen.has(k)) edits.push({ s: orig.s, e: orig.e, text: '', ctx: 'text' })
    // Inline code: rewritten whole (backticks that fit its new text); gone entirely when emptied.
    const seenCode = new Set<string>()
    for (const el of inlineCodes(host)) {
      const k = codeKey(el)
      const orig = snap.codes.get(k)
      if (!orig) continue
      seenCode.add(k)
      if (src[orig.s] !== '`' || src[orig.e - 1] !== '`') return null
      const now = (el.textContent ?? '').replace(/\u00a0/g, ' ')
      if (now !== orig.v) edits.push({ s: orig.s, e: orig.e, text: inlineCodeSource(now, contextOf(el)), ctx: 'raw' })
    }
    for (const [k, orig] of snap.codes) if (!seenCode.has(k)) edits.push({ s: orig.s, e: orig.e, text: '', ctx: 'raw' })
    if (outsideText(host, new Set(snap.empty)) !== snap.outside) return null
    // Text typed into a list item / cell that was empty goes into its slot in the source.
    for (const el of snap.empty) {
      const t = ownText(el).replace(/\u00a0/g, ' ')
      if (!el.isConnected || !t.trim()) continue
      if (el.tagName === 'LI') {
        const c = listItemContentStart(src, Number(el.dataset.hs))
        if (!c) return null
        edits.push({ s: c.pos, e: c.pos, text: (c.space ? ' ' : '') + t.trim(), ctx: 'text' })
      } else {
        const row = el.parentElement as HTMLTableRowElement
        const area = tableCellArea(src, Number(row.dataset.hs), (el as HTMLTableCellElement).cellIndex)
        if (!area) return null
        edits.push({ s: area[0], e: area[1], text: ` ${t.trim()} `, ctx: 'cell' })
      }
    }
    return edits
  }

  const commit = (host: HTMLElement): 'none' | 'committed' | 'failed' => {
    const snap = snapshot.current
    snapshot.current = null
    if (!snap || snap.host !== host) return 'none'
    const edits = collect(host, snap)
    if (!edits) {
      toast(isCodeHost(host)
        ? 'That code can’t be saved here (a line of it would end the code block) — use the Markdown tab for it.'
        : 'That edit crossed formatting the formatted view can’t map back — switch to the Markdown tab for it.')
      setGeneration((g) => g + 1)
      return 'failed'
    }
    if (!edits.length) return 'none'
    publish(applyRunEdits(rendered.current, edits))
    return 'committed'
  }

  // ── lists and tables: Enter adds an item / row, Backspace in an empty one removes it ──
  /** Typed edits of the focused block, applied — the base for a structural edit. */
  const typedBase = (host: HTMLElement) => {
    const snap = snapshot.current?.host === host ? snapshot.current : null
    const edits = snap ? collect(host, snap) : []
    return edits && { edits, base: applyRunEdits(rendered.current, edits) }
  }
  const caretSlot = (host: HTMLElement) => {
    const sel = getSelection()
    if (!sel?.rangeCount || !sel.isCollapsed) return null
    const r = sel.getRangeAt(0)
    const slot = slotOf(r.startContainer)
    return slot && host.contains(slot) ? { slot, offset: ownOffset(slot, r.startContainer, r.startOffset) } : null
  }
  const structural = (next: string) => {
    snapshot.current = null
    publish(next)
  }

  const structuralEnter = (host: HTMLElement): boolean => {
    const c = caretSlot(host)
    if (!c || c.offset !== ownText(c.slot).length) return false
    const src = rendered.current
    if (c.slot.tagName === 'LI') {
      const li = c.slot
      if ([...li.children].some((ch) => ch.tagName === 'P')) return false // a "loose" item: its paragraphs edit as usual
      const hs = Number(li.dataset.hs)
      const marker = nextListMarker(src, hs)
      const tb = typedBase(host)
      if (!marker || !tb) return false
      const ownSpans = [...li.querySelectorAll<HTMLElement>('span[data-s]')].filter((sp) => slotOf(sp) === li)
      const ownEnd = ownSpans.length ? Math.max(...ownSpans.map((sp) => Number(sp.dataset.e))) : hs
      const hsN = mapPos(src, tb.edits, hs)
      const prefix = tb.base.slice(lineStartOf(tb.base, hsN), hsN).replace(/[^\s>]/g, ' ')
      // A new item at the same level right under this item's text (its sub-items, if any, follow the new one).
      const { src: next, at } = insertLineAfter(tb.base, mapPos(src, tb.edits, ownEnd), `${prefix}${marker} `)
      focusAt.current = { tag: 'li', hs: at + prefix.length, at: 'start' }
      structural(next)
      return true
    }
    const cell = c.slot as HTMLTableCellElement
    const row = cell.parentElement as HTMLTableRowElement
    if (cell.cellIndex !== row.cells.length - 1) return false
    const tb = typedBase(host)
    if (!tb) return false
    const rs = mapPos(src, tb.edits, Number(row.dataset.hs))
    let after = rs
    if (row.parentElement?.tagName === 'THEAD') after = Math.min(tb.base.length, tb.base.indexOf('\n', rs) + 1 || tb.base.length) // below the delimiter row
    const prefix = tb.base.slice(lineStartOf(tb.base, rs), rs)
    const { src: next, at } = insertLineAfter(tb.base, after, `${prefix}|${'  |'.repeat(row.cells.length)}`)
    focusAt.current = { tag: 'tr', hs: at + prefix.length, cell: 0, at: 'start' }
    structural(next)
    return true
  }

  const structuralBackspace = (host: HTMLElement): boolean => {
    const c = caretSlot(host)
    if (!c || c.offset !== 0 || ownText(c.slot) !== '') return false
    const src = rendered.current
    if (c.slot.tagName === 'LI') {
      const li = c.slot
      if (li.querySelector('ul, ol, p')) return false
      const tb = typedBase(host)
      if (!tb) return false
      const prev = li.previousElementSibling?.tagName === 'LI' ? (li.previousElementSibling as HTMLElement) : li.parentElement?.closest<HTMLElement>('li') ?? null
      if (prev) focusAt.current = { tag: 'li', hs: Number(prev.dataset.hs), at: 'end' }
      else {
        const list = hosts()
        const before = list[list.indexOf(host) - 1]
        if (before) restoreSel.current = { block: list.indexOf(host) - 1, start: (before.textContent ?? '').length, end: (before.textContent ?? '').length }
      }
      structural(deleteLineAt(tb.base, mapPos(src, tb.edits, Number(li.dataset.hs))))
      return true
    }
    const cell = c.slot as HTMLTableCellElement
    const row = cell.parentElement as HTMLTableRowElement
    if (cell.cellIndex !== 0 || row.parentElement?.tagName !== 'TBODY' || [...row.cells].some((x) => ownText(x).trim())) return false
    const table = row.closest('table')!
    const prevRow = (row.previousElementSibling as HTMLTableRowElement | null) ?? table.tHead?.rows[table.tHead.rows.length - 1] ?? null
    const tb = typedBase(host)
    if (!tb || !prevRow) return false
    focusAt.current = { tag: 'tr', hs: Number(prevRow.dataset.hs), cell: -1, at: 'end' }
    structural(deleteLineAt(tb.base, mapPos(src, tb.edits, Number(row.dataset.hs))))
    return true
  }

  // ── bold / italic ───────────────────────────────────────────────────────
  const hasTyping = (host: HTMLElement) => {
    const snap = snapshot.current?.host === host ? snapshot.current : null
    if (!snap) return false
    const edits = collect(host, snap)
    return edits === null || edits.length > 0
  }
  const hasTypingRef = useRef(hasTyping)
  hasTypingRef.current = hasTyping

  const format = (mark: Mark) => {
    if (!editable) return
    const sel = getSelection()
    if (!sel?.rangeCount) return
    const r = sel.getRangeAt(0)
    const host = hostOf(r.startContainer)
    if (!host || hostOf(r.endContainer) !== host) return toast('Select text within one paragraph, heading, list item or cell.')
    const pos: Pos = { block: hosts().indexOf(host), start: textOffset(host, r.startContainer, r.startOffset), end: textOffset(host, r.endContainer, r.endOffset) }
    if (hasTyping(host)) {
      // Save the typing first; the toggle runs on the re-rendered block (see the effect below).
      pendingFormat.current = { ...pos, mark }
      if (commit(host) !== 'committed') pendingFormat.current = null
      return
    }
    applyFormat(host, pos, mark)
  }

  const applyFormat = (host: HTMLElement, pos: Pos, mark: Mark) => {
    const src = rendered.current
    const what = mark === 'strong' ? 'bold' : 'italic'
    const marks = [...host.querySelectorAll<HTMLElement>(mark)]
      .filter((el) => el.dataset.fs && el.dataset.fe)
      .map((el) => ({ s: Number(el.dataset.fs), e: Number(el.dataset.fe) }))
    let next: string | null
    if (pos.start === pos.end) {
      // Just the caret, inside bold/italic text: remove it from that whole section.
      const inside = pointAt(host, pos.start, 'start')?.node.parentElement?.closest<HTMLElement>(mark)
      if (!inside || !host.contains(inside) || !inside.dataset.fs || !inside.dataset.fe) return toast(`Select some text to make it ${what}.`)
      next = unwrapMark(src, Number(inside.dataset.fs), Number(inside.dataset.fe), mark)
    } else {
      const text = host.textContent ?? ''
      let a = pos.start
      let b = pos.end
      while (a < b && /\s/.test(text[a])) a++
      while (b > a && /\s/.test(text[b - 1])) b--
      if (a === b) return toast(`Select some text to make it ${what}.`)
      const pa = pointAt(host, a, 'start')
      const pb = pointAt(host, b, 'end')
      const ra = pa?.node.parentElement?.closest<HTMLElement>('span[data-s]')
      const rb = pb?.node.parentElement?.closest<HTMLElement>('span[data-s]')
      // Both ends must sit in the same formatting apart from this kind (no half a link, other style or code).
      const base = (el: HTMLElement) => {
        let p = el.parentElement
        while (p && p.tagName.toLowerCase() === mark) p = p.parentElement
        return p
      }
      if (!pa || !pb || !ra || !rb || base(ra) !== base(rb))
        return toast(`Can't make that ${what}: the selection mixes other formatting (a link, code or another style). Select within it, or use the Markdown tab.`)
      const map = (sp: HTMLElement) => runSourceMap(src, Number(sp.dataset.s), Number(sp.dataset.e), sp.dataset.v ?? '')
      const ma = map(ra)
      const mb = map(rb)
      if (!ma || !mb) return toast(`Can't make that ${what} here — use the Markdown tab.`)
      // All of it formatted already → remove from just the selection; otherwise format it all.
      next = toggleMarkRange(src, ma[textOffset(ra, pa.node, pa.offset)], mb[textOffset(rb, pb.node, pb.offset)], marks, mark, allMarked(host, a, b, mark))
    }
    if (!next || !sameVisibleText(src, next)) return toast(`Can't toggle ${what} exactly there (Markdown wouldn't read it as ${what}) — use the Markdown tab.`)
    restoreSel.current = pos
    snapshot.current = null
    publish(next)
  }

  // After a re-render: run a toggle that waited for typing to be saved, or put the selection back.
  useEffect(() => {
    const pf = pendingFormat.current
    if (pf) {
      pendingFormat.current = null
      const host = hosts()[pf.block]
      if (host) applyFormat(host, pf, pf.mark)
      return
    }
    const rsrc = restoreSource.current
    restoreSource.current = null
    if (rsrc) return placeCaret(rsrc, 'nearest')
    const fa = focusAt.current
    focusAt.current = null
    if (fa) {
      let el = articleRef.current?.querySelector<HTMLElement>(`${fa.tag}[data-hs="${fa.hs}"]`) ?? null
      if (el instanceof HTMLTableRowElement && fa.cell != null) el = el.cells[fa.cell < 0 ? el.cells.length - 1 : fa.cell] ?? null
      const host = el && hostOf(el)
      if (el && host) {
        snapshot.current = null
        activate(host, caretIn(el, fa.at))
        return
      }
    }
    const rs = restoreSel.current
    restoreSel.current = null
    const host = rs && hosts()[rs.block]
    if (!rs || !host) return
    snapshot.current = null
    activate(host)
    const a = pointAt(host, rs.start, 'start')
    const b = pointAt(host, rs.end, 'end')
    if (!a || !b) return
    const r = document.createRange()
    r.setStart(a.node, a.offset)
    r.setEnd(b.node, b.offset)
    getSelection()?.removeAllRanges()
    getSelection()?.addRange(r)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [generation])

  // The floating B / I bar over a selection.
  useEffect(() => {
    const update = () => {
      const sel = getSelection()
      const r = sel?.rangeCount ? sel.getRangeAt(0) : null
      // Report the selection inside the document (for a note on it), with its lines in the Markdown source.
      if (r && articleRef.current?.contains(r.commonAncestorContainer)) {
        recordPos()
        const t = r.collapsed ? '' : sel!.toString().trim()
        const src = rendered.current
        const at = t ? findQuote(src, t) ?? findQuote(src, t.split('\n')[0]) : null
        const line = at ? src.slice(0, at.from).split('\n').length : 1
        onSelectionRef.current?.(t ? { text: t, fromLine: line, toLine: line + (at ? src.slice(at.from, at.to).split('\n').length - 1 : 0) } : null)
      }
      if (!editable || !r || r.collapsed || !articleRef.current?.contains(r.commonAncestorContainer)) return setBar(null)
      const host = hostOf(r.startContainer)
      const kind = host && host.isContentEditable && hostOf(r.endContainer) === host && !isCodeHost(host) ? 'format' : 'copy'
      const rect = r.getBoundingClientRect()
      const el = r.startContainer.parentElement
      setBar({ x: rect.left + rect.width / 2, y: rect.top, kind, bold: !!el?.closest('strong'), italic: !!el?.closest('em') })
    }
    document.addEventListener('selectionchange', update)
    window.addEventListener('scroll', update, true)
    return () => {
      document.removeEventListener('selectionchange', update)
      window.removeEventListener('scroll', update, true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editable])

  // Opening: where the user was (in the Markdown tab, or here before). Leaving: remember where they are,
  // as a source position (measured on the final text — leaving saved any typing and re-rendered).
  useEffect(() => {
    hist.external(text)
    if (hist.placed) placeCaret(hist.cursor(), 'center')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useLayoutEffect(() => () => {
    const lp = lastPos.current
    const host = lp && hosts()[lp.block]
    if (!lp || !host) return
    const a = pointAt(host, lp.start, 'start')
    const b = pointAt(host, lp.end, 'end')
    const sa = a && sourceOffsetAt(a.node, a.offset)
    const sb = b && sourceOffsetAt(b.node, b.offset)
    if (sa != null) histRef.current.setCursor(sa, sb ?? sa)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Undo/redo of saved edits, through the file's shared history.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'z') return
      const a = document.activeElement as HTMLElement | null
      if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA')) return
      if (a?.isContentEditable) {
        // In a block: its own unsaved typing is undone by the browser first; then the file's history.
        if (!articleRef.current?.contains(a) || hasTypingRef.current(a)) return
        snapshot.current = null
      }
      const h = histRef.current
      const prev = e.shiftKey ? h.redo() : h.undo()
      if (prev === null) return
      e.preventDefault()
      restoreSource.current = h.cursor()
      publishRef.current(prev, false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const components = useMemo<Components>(() => {
    const block = (Tag: 'p' | 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6' | 'td' | 'th') =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      function Block({ node: _node, ...props }: any) {
        // Made editable on click (see `activate`), so a drag can still select across blocks.
        return editable ? <Tag {...props} data-md-block suppressContentEditableWarning /> : <Tag {...props} />
      }
    return {
      p: block('p'), h1: block('h1'), h2: block('h2'), h3: block('h3'), h4: block('h4'), h5: block('h5'), h6: block('h6'),
      td: block('td'), th: block('th'),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      li({ node, ...props }: any) {
        // A "loose" item holds paragraphs, which are editable themselves.
        const hasP = node?.children?.some((c: { tagName?: string }) => c.tagName === 'p')
        return editable && !hasP ? <li {...props} data-md-block suppressContentEditableWarning /> : <li {...props} />
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      pre({ node: _node, ...props }: any) {
        // A fenced code block: edited as a block of its own (its text goes between the fences).
        return editable && props['data-hs'] != null ? <pre {...props} data-md-block data-md-code suppressContentEditableWarning /> : <pre {...props} />
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      code({ node: _node, children, ...props }: any) {
        // A code block's text without the newline the renderer ends it with (the caret would land on an empty last line).
        const text = props['data-cs'] == null && typeof children === 'string' ? children.replace(/\n$/, '') : children
        return <code {...props}>{text}</code>
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      a({ node: _node, ...props }: any) {
        return (
          <a
            {...props}
            title={editable ? `${props.href} — ⌘-click to open` : props.href}
            onClick={(e) => {
              e.preventDefault() // a plain click edits the text; never navigate the app away
              if (!editable || e.metaKey || e.ctrlKey) window.open(props.href, '_blank', 'noopener')
            }}
          />
        )
      },
    }
  }, [editable])

  // Highlight the text open notes are about (CSS Custom Highlight API — no DOM changes).
  const marksKey = JSON.stringify(marks)
  useEffect(() => {
    const reg = (globalThis as { CSS?: { highlights?: Map<string, unknown> } }).CSS?.highlights
    const H = (globalThis as { Highlight?: new (...r: Range[]) => unknown }).Highlight
    if (!reg || !H || !articleRef.current) return
    const ranges = marks.map((m) => domRangeOf(articleRef.current!, m.quote)).filter((r): r is Range => !!r)
    reg.set('note-quote', new H(...ranges))
    return () => { reg.delete('note-quote') }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [marksKey, generation, source])

  // Each open note's number in the right margin, level with its text (kept placed as the text reflows).
  const wrapRef = useRef<HTMLDivElement>(null)
  const [badges, setBadges] = useState<{ key: string; id?: string; top: number; left: number; label: string; title: string; quote: string }[]>([])
  const [openBadge, setOpenBadge] = useState<{ key: string; at: DOMRect } | null>(null)
  const allNotes = useNotes((s) => s.notes)
  useEffect(() => {
    const wrap = wrapRef.current
    const art = articleRef.current
    if (!wrap || !art) return
    const place = () => {
      const wr = wrap.getBoundingClientRect()
      const ar = art.getBoundingClientRect()
      const placed: { key: string; id?: string; top: number; left: number; label: string; title: string; quote: string }[] = []
      marks.forEach((m, i) => {
        const r = domRangeOf(art, m.quote) ?? domRangeOf(art, m.quote.split('\n').map((l) => l.trim()).find(Boolean) ?? '')
        const rect = r?.getClientRects()[0]
        if (!rect) return
        const top = rect.top - wr.top + (rect.height - 16) / 2
        // Notes on the same line sit side by side.
        const beside = placed.filter((b) => Math.abs(b.top - top) < 8).length
        placed.push({ key: `${i}:${m.quote}`, id: m.id, top, left: ar.right - wr.left - 26 - beside * 22, label: m.label ?? String(i + 1), title: m.title ?? '', quote: m.quote })
      })
      setBadges(placed)
    }
    place()
    const ro = new ResizeObserver(place)
    ro.observe(art)
    ro.observe(wrap)
    return () => ro.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [marksKey, generation, source])

  // Rendered once per source/generation, so React never touches a block while it's being typed in.
  const content = useMemo(
    () => <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSourceText]} components={components}>{source}</ReactMarkdown>,
    [source, components],
  )

  return (
    <>
    {bar && (
      <div
        className="fixed z-40 flex -translate-x-1/2 -translate-y-full gap-0.5 rounded-md border border-hair bg-white p-0.5 shadow-lg"
        style={{ left: bar.x, top: bar.y - 6 }}
        onMouseDown={(e) => e.preventDefault() /* keep the selection */}
      >
        {bar.kind === 'format' ? (
          <>
            <button className={clsx('icon-btn h-6 w-6', bar.bold && 'bg-accent-soft text-accent')} title="Bold (⌘B)" onClick={() => format('strong')}><Bold size={14} /></button>
            <button className={clsx('icon-btn h-6 w-6', bar.italic && 'bg-accent-soft text-accent')} title="Italic (⌘I)" onClick={() => format('em')}><Italic size={14} /></button>
          </>
        ) : (
          <>
            <button className="tool-btn h-6" title="Copy the selected text (⌘C)" onClick={() => void copySelection(false)}><Copy size={13} /> Copy</button>
            <button className="tool-btn h-6" title="Copy the Markdown source of the blocks the selection touches" onClick={() => void copySelection(true)}><FileCode size={13} /> Copy Markdown</button>
          </>
        )}
      </div>
    )}
    <div ref={wrapRef} className="relative">
    {badges.map((b) => {
      const note = b.id ? allNotes.find((n) => n.id === b.id) : undefined
      return (
        <div key={b.key} className="absolute z-20" style={{ top: b.top, left: b.left }}>
          <span
            className="md-note-badge"
            style={{ top: 0, left: 0 }}
            title={`${b.title}\n(click to open the note)`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={(e) => setOpenBadge(openBadge?.key === b.key ? null : { key: b.key, at: e.currentTarget.getBoundingClientRect() })}
          >
            {b.label}
          </span>
          {openBadge?.key === b.key && note && <NotePopover note={note} anchor={openBadge.at} onClose={() => setOpenBadge(null)} flipX flipY={false} />}
        </div>
      )
    })}
    <article
      ref={articleRef}
      key={generation}
      className="md-editable prose prose-slate mx-auto max-w-3xl px-8 py-8 prose-headings:font-semibold prose-a:text-accent prose-table:text-sm"
      onFocus={(e) => {
        const host = e.target as HTMLElement
        if (!host.isContentEditable || !host.hasAttribute('data-md-block') || snapshot.current?.host === host) return
        snapshot.current = {
          host,
          runs: new Map(runSpans(host).map((sp) => [runKey(sp), { s: Number(sp.dataset.s), e: Number(sp.dataset.e), v: sp.dataset.v ?? '' }])),
          outside: isCodeHost(host) ? codeText(host) : outsideText(host),
          codes: new Map(inlineCodes(host).map((el) => [codeKey(el), { s: Number(el.dataset.cs), e: Number(el.dataset.ce), v: el.dataset.cv ?? '' }])),
          empty: [...(host.matches('li, td, th') ? [host] : []), ...host.querySelectorAll<HTMLElement>('li, td, th')].filter((el) => !ownText(el).trim()),
        }
      }}
      onBlur={(e) => {
        const host = e.target as HTMLElement
        if (host.isContentEditable && host.hasAttribute('data-md-block')) {
          commit(host)
          host.removeAttribute('contenteditable')
        }
      }}
      onMouseUp={(e) => {
        if (!editable || e.button !== 0) return
        const sel = getSelection()
        const r = sel?.rangeCount ? sel.getRangeAt(0) : null
        if (r && !r.collapsed && articleRef.current?.contains(r.commonAncestorContainer)) {
          // A selection inside one block makes it editable (keeping the selection, for B / I);
          // one across blocks stays a plain selection to copy.
          const host = hostOf(r.startContainer)
          if (host && !host.isContentEditable && hostOf(r.endContainer) === host) activate(host, r.cloneRange())
          return
        }
        // A click: edit that block at the click point (found afresh — the block may have just re-rendered).
        const caret = caretAt(e.clientX, e.clientY)
        const host = caret && hostOf(caret.startContainer)
        if (host && !host.isContentEditable) activate(host, caret)
      }}
      onInput={recordPos}
      onKeyUp={recordPos}
      onKeyDown={(e) => {
        const host = e.target as HTMLElement
        if (!host.isContentEditable) return
        if (isCodeHost(host)) {
          // A code block: Enter is a new line, Tab indents, ⌘Enter saves (arrows and Escape as elsewhere).
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); host.blur(); return }
          if (e.key === 'Enter') { e.preventDefault(); document.execCommand('insertText', false, '\n'); return }
          if (e.key === 'Tab' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); document.execCommand('insertText', false, codeIndent(codeText(host))); return }
          if ((e.metaKey || e.ctrlKey) && (e.key === 'b' || e.key === 'i')) { e.preventDefault(); return }
          if (e.key === 'Backspace') return
        }
        if ((e.metaKey || e.ctrlKey) && (e.key === 'b' || e.key === 'i')) {
          e.preventDefault()
          format(e.key === 'b' ? 'strong' : 'em')
        } else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
          if (moveVertical(host, e.key === 'ArrowUp' ? -1 : 1)) e.preventDefault()
        } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
          if (moveHorizontal(host, e.key === 'ArrowLeft' ? -1 : 1)) e.preventDefault()
        } else if (e.key === 'Enter') {
          e.preventDefault()
          if (!e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey && structuralEnter(host)) return
          host.blur()
        } else if (e.key === 'Backspace' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
          if (structuralBackspace(host)) e.preventDefault()
        } else if (e.key === 'Escape') {
          e.preventDefault()
          snapshot.current = null
          setGeneration((g) => g + 1)
        }
      }}
    >
      {content}
    </article>
    </div>
    </>
  )
}
