/**
 * The formatted Markdown view, with its text editable in place: click a
 * paragraph, heading, list item or table cell and type. Enter (or clicking
 * away) commits, Escape cancels, ↑ on a block's first line / ↓ on its last
 * moves to the previous/next block (in a table: the cell above/below), ← at
 * a cell's start / → at its end to the previous/next cell. In a list, Enter
 * at the end of an item adds one below and Backspace in an empty item removes
 * it; in a table, Enter at the end of a row's last cell adds a row below and
 * Backspace in the empty first cell of an empty row removes the row; ⌘Z / ⇧⌘Z outside a block undo/redo
 * committed edits (history resets when the file changes on disk).
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
 * Inline code, code blocks and images are read-only.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { Bold, Copy, FileCode, Italic } from 'lucide-react'
import clsx from 'clsx'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useApp } from '../store/appStore'
import { rebase } from './textMerge'
import {
  applyRunEdits, deleteLineAt, insertLineAfter, lineStartOf, listItemContentStart, mapPos, nextListMarker, tableCellArea,
  rehypeSourceText, runSourceMap, sameVisibleText, toggleMarkRange, unwrapMark, type Mark, type RunContext, type RunEdit } from './mdSourceEdit'

interface Snapshot {
  /** The block element it was taken from (a re-render replaces it). */
  host: HTMLElement
  runs: Map<string, { s: number; e: number; v: string }>
  outside: string
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

/** Text in a block that isn't inside a source-mapped run (inline code, typed into a gap…). */
function outsideText(host: HTMLElement, skip?: Set<HTMLElement>): string {
  let out = ''
  const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT)
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.parentElement?.closest('span[data-s]')) continue
    const slot = skip && slotOf(n)
    if (slot && skip.has(slot)) continue
    out += n.textContent
  }
  return out
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

export function MarkdownEditable({ text, editable, onChange }: { text: string; editable: boolean; onChange(next: string): void }) {
  const [generation, setGeneration] = useState(0)
  const [bar, setBar] = useState<{ x: number; y: number; kind: 'format' | 'copy'; bold: boolean; italic: boolean } | null>(null)
  const articleRef = useRef<HTMLElement>(null)
  const pendingFormat = useRef<(Pos & { mark: Mark }) | null>(null)
  const restoreSel = useRef<Pos | null>(null)
  /** After a structural edit: the list item / table row (by its new source start) to put the caret in. */
  const focusAt = useRef<{ tag: 'li' | 'tr'; hs: number; cell?: number; at: 'start' | 'end' } | null>(null)
  const snapshot = useRef<Snapshot | null>(null)
  const undo = useRef<string[]>([])
  const redo = useRef<string[]>([])
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
    undo.current = []
    redo.current = []
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
  const publish = (next: string, history = true) => {
    if (history) {
      undo.current.push(rendered.current)
      redo.current = []
    }
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
      toast('That edit crossed formatting the formatted view can’t map back — switch to the Markdown tab for it.')
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
      if (!editable || !r || r.collapsed || !articleRef.current?.contains(r.commonAncestorContainer)) return setBar(null)
      const host = hostOf(r.startContainer)
      const kind = host && host.isContentEditable && hostOf(r.endContainer) === host ? 'format' : 'copy'
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

  // Undo/redo of committed edits (while not typing in a block).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'z') return
      const a = document.activeElement as HTMLElement | null
      if (a && (a.isContentEditable || a.tagName === 'INPUT' || a.tagName === 'TEXTAREA')) return
      const [from, to] = e.shiftKey ? [redo.current, undo.current] : [undo.current, redo.current]
      const prev = from.pop()
      if (prev === undefined) return
      e.preventDefault()
      to.push(rendered.current)
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
      code({ node: _node, ...props }: any) {
        return <code {...props} contentEditable={false} />
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
          outside: outsideText(host),
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
      onKeyDown={(e) => {
        const host = e.target as HTMLElement
        if (!host.isContentEditable) return
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
    </>
  )
}
