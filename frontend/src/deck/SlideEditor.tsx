/**
 * The main slide surface: renders the current slide large and lets the user
 * - select shapes (click, shift-click, marquee), move them (drag, arrow keys,
 *   with snapping to the slide and other shapes; hold Alt to disable),
 *   resize them (8 handles; pictures keep their aspect ratio on corners),
 * - edit existing text in place (double-click / Enter), keeping formatting;
 *   ⌘B / ⌘I / ⌘U toggle bold / italic / underline on the selection (or the
 *   word at the caret), written into the runs' formatting,
 * - copy/paste/duplicate/delete shapes, drop or paste images,
 * - pin notes for the agent, at a point or as a freehand mark around an area.
 *
 * Every change is one `applyEdit` operation (see deckStore), so it is
 * undoable and saved straight into the .pptx.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { EditOperation, NodeOrder, SlideData, SlideNode } from '@diceui/pptx-core'
import { copyNodes } from '@diceui/pptx-core'
import { useDecks, type DeckSession } from './deckStore'
import { ALIGN_LABEL, alignPositions, type AlignKind } from './align'
import { SlideRender, type SlideRenderHandle } from './SlideRender'
import { beginEditing, domPointAt, paragraphsText, readParagraphs, readParagraphsAt, textBodyChanged, textContainer, type TextPoint } from './textEdit'
import { nodeText, short } from './deckModel'
import { getClipboard, setClipboard } from './clipboard'
import { fitSize, prepareImage } from './images'
import { NotePins, actNowPrompt, type NoteDraft } from '../notes/NotePins'
import { sendToAgent } from '../chat/sendToAgent'
import { DrawLayer, pinFor, strokesBox, type Box } from '../notes/NoteDrawing'
import { paintsAt, shapesAt } from './hitTest'
import { cssToHex, firstFamily, pxToPt, sizeRuns, stepSize as nextSize } from './formatting'
import { insertionStart, insertPlainText, normalizePasted, parseClipboardHtml, styledRanges, styledText } from './textPaste'
import type { Stroke } from '../api/types'
import { notesForSlide, useNotes } from '../store/notesStore'
import { useApp } from '../store/appStore'
import { requestEdit, useEditMode } from '../store/editGuard'
import { api } from '../api/client'

type Rect = { x: number; y: number; w: number; h: number }
type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'
const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']
const SNAP_PX = 6

interface Props {
  session: DeckSession
  noteMode: boolean
  setNoteMode(v: boolean): void
  showResolved: boolean
  /** Imperative hook for the toolbar's "Add text box". */
  registerActions(a: SlideActions): void
  /** The selection's font, size and colors, for the toolbar (null: nothing to format). */
  onFormat?(f: FormatState | null): void
}

/** What the toolbar's font / size / color tools show and can change. */
export interface FormatState {
  /** Text is being edited, or a selected shape has text: font and size apply. */
  text: boolean
  font?: string
  size?: number
  textColor?: string
  /** A shape is selected (or being edited): fill and line apply. */
  shape: boolean
  /** RRGGBB, or 'none' (no fill / no line). */
  fill?: string
  line?: string
  /** Nothing selected: the slide background. */
  background: boolean
}

export type ColorTarget = 'text' | 'fill' | 'line' | 'background'

export interface SlideActions {
  addTextBox(): void
  align(kind: AlignKind): void
  /** Bring the selected shapes to the front / forward one step, or send them backward / to the back. */
  arrange(order: NodeOrder): void
  setFont(face: string): void
  setSize(pt: number): void
  /** One preset size up / down, each run from its own size. */
  stepSize(dir: 1 | -1): void
  setColor(target: ColorTarget, hex: string): void
  /** Remember the text selection before focus moves to a toolbar field (it ends text editing). */
  holdSelection(): void
  /** The toolbar field was left without applying anything: forget the held selection. */
  releaseSelection(): void
}
export type { NodeOrder }

const ARRANGE_LABEL: Record<NodeOrder, string> = {
  front: 'brought to front',
  forward: 'brought forward',
  backward: 'sent backward',
  back: 'sent to back',
}
export type { AlignKind }

const rectOf = (n: SlideNode): Rect => ({ x: n.position.x, y: n.position.y, w: n.size.w, h: n.size.h })
const union = (rs: Rect[]): Rect => {
  const x1 = Math.min(...rs.map((r) => r.x)), y1 = Math.min(...rs.map((r) => r.y))
  const x2 = Math.max(...rs.map((r) => r.x + r.w)), y2 = Math.max(...rs.map((r) => r.y + r.h))
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 }
}
const rot = (x: number, y: number, deg: number) => {
  const a = (deg * Math.PI) / 180
  return { x: x * Math.cos(a) - y * Math.sin(a), y: x * Math.sin(a) + y * Math.cos(a) }
}
const label = (n: SlideNode) => n.name || `${n.nodeType} ${n.id}`

export function SlideEditor({ session, noteMode, setNoteMode, showResolved, registerActions, onFormat }: Props) {
  const { apply, setSelection, saveNow } = useDecks()
  /** Editing turned off for the project: shapes can be selected (and noted), not changed. */
  const editOff = useEditMode() === 'off'
  const pres = session.pres!
  const slide: SlideData = pres.slides[session.slideIndex]
  const key = session.key
  const slideNo = session.slideIndex + 1
  const selection = session.selection

  const wrapRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const renderRef = useRef<SlideRenderHandle>(null)
  const [box, setBox] = useState({ w: 800, h: 500 })
  const [preview, setPreview] = useState<{ rects: Record<string, Rect>; guides: { x?: number; y?: number }[] } | null>(null)
  const [marquee, setMarquee] = useState<Rect | null>(null)
  const [editing, setEditing] = useState<{ nodeId: string; container: HTMLElement; before: string } | null>(null)
  /** Editing off: a text box opened for selecting and copying its text (not for changing it). */
  const [reading, setReading] = useState<{ container: HTMLElement; restore: string } | null>(null)
  const [draft, setDraft] = useState<NoteDraft | null>(null)
  const [dropHint, setDropHint] = useState(false)

  // Fit the slide into the available space.
  useLayoutEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    setBox({ w: el.clientWidth, h: el.clientHeight })
    return () => ro.disconnect()
  }, [])
  // The slide and its shapes clip (overflow: hidden) rather than scroll, but the browser still
  // scrolls a clipping box to keep a text caret in view — editing text near the slide's bottom
  // (or past a box's edge) would shift the whole slide away from its selection overlay, and
  // nothing would scroll it back. Undo any such scroll as it happens. Boxes that really scroll
  // (overflow auto/scroll, e.g. a note's text field) are left alone.
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const onScroll = (e: Event) => {
      const t = e.target
      if (!(t instanceof HTMLElement) || !el.contains(t) || (!t.scrollTop && !t.scrollLeft)) return
      const { overflowX, overflowY } = getComputedStyle(t)
      if (/auto|scroll/.test(overflowX + overflowY)) return
      t.scrollTop = 0
      t.scrollLeft = 0
    }
    el.addEventListener('scroll', onScroll, true)
    return () => el.removeEventListener('scroll', onScroll, true)
  }, [])
  const scale = Math.max(0.1, Math.min((box.w - 48) / pres.width, (box.h - 48) / pres.height))
  const stageW = pres.width * scale
  const stageH = pres.height * scale

  const topIds = useMemo(() => new Set(slide.nodes.map((n) => n.id)), [slide, session.version])
  const nodeById = useCallback((id: string) => slide.nodes.find((n) => n.id === id), [slide, session.version])
  const nodeEl = (id: string) =>
    (renderRef.current?.root()?.querySelector(`:scope > [data-pptx-node-id="${CSS.escape(id)}"]`) as HTMLElement | null) ?? null

  const slideIdStable = session.sldIds.get(slide.id) ?? ''
  const allNotes = useNotes((s) => s.notes)
  const slideNotes = notesForSlide(allNotes, session.path, slideIdStable, slideNo)
  const noteTool = useNotes((s) => s.tool)
  const drawing = noteMode && noteTool === 'draw'

  // A half-made note goes away when note mode ends or the tool changes.
  useEffect(() => {
    setDraft(null)
  }, [noteMode, noteTool])

  // Leave text editing / reading / drafts when the slide changes underneath.
  useEffect(() => {
    setEditing(null)
    setDraft(null)
    stopReading()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slide.id, session.version, editOff])

  /**
   * The shape a click at client (x, y) means (see hitTest.ts): the topmost shape that draws
   * something there — a picture's opaque pixel, a drawn fill or outline, its text's area — else the
   * topmost box. `keepSelected`: a selected shape keeps its whole box (to move or edit it), except
   * where a shape above it draws.
   * `cycle` (⌥-click): the next shape below the selected one here, wrapping to the top.
   */
  const pickAt = (x: number, y: number, opts: { keepSelected?: boolean; cycle?: boolean } = {}): string | null => {
    const root = renderRef.current?.root()
    if (!root) return null
    const stack = shapesAt(root, x, y, (id) => topIds.has(id))
    if (!stack.length) return null
    if (opts.cycle) return stack[(stack.findIndex((id) => selection.includes(id)) + 1) % stack.length]
    const shape = (id: string) => root.querySelector<HTMLElement>(`:scope > [data-pptx-node-id="${CSS.escape(id)}"]`)
    // Top down: the first shape that draws here — or, with keepSelected, that is selected (its whole
    // box counts, but only where nothing above it draws: a picture over a selected box still wins
    // where the picture is opaque).
    return stack.find((id) => {
      if (opts.keepSelected && selection.includes(id)) return true
      const el = shape(id)
      return !!el && paintsAt(el, x, y)
    }) ?? stack[0]
  }

  const toSlide = (clientX: number, clientY: number) => {
    const r = stageRef.current!.getBoundingClientRect()
    return { x: (clientX - r.left) / scale, y: (clientY - r.top) / scale }
  }

  const run = (op: EditOperation, description: string, coalesceKey?: string) => apply(key, op, description, coalesceKey)

  // ── text editing ────────────────────────────────────────────────────────
  const startEditing = (nodeId: string, at?: { x: number; y: number }) => {
    if (!requestEdit()) return
    const n = nodeById(nodeId)
    const el = nodeEl(nodeId)
    if (!n || !el || n.nodeType !== 'shape') return
    const container = textContainer(el)
    if (!container) return
    setSelection(key, [nodeId])
    beginEditing(container, at)
    setEditing({ nodeId, container, before: nodeText(n) })
  }

  // ── reading text (editing off): select and copy, nothing more ──────────
  const startReading = (nodeId: string, at?: { x: number; y: number }) => {
    const el = nodeEl(nodeId)
    const container = el && textContainer(el)
    if (!container || !container.textContent?.trim()) return
    if (reading?.container !== container) {
      stopReading()
      const restore = container.getAttribute('style') ?? ''
      // The stage itself can't be selected (user-select: none): this box's text can, for now.
      container.style.userSelect = 'text'
      container.style.setProperty('-webkit-user-select', 'text')
      container.style.cursor = 'text'
      container.style.pointerEvents = 'auto'
      setReading({ container, restore })
    }
    setSelection(key, [nodeId])
    // Select the word under the double-click (or all of a box opened with Enter).
    const sel = window.getSelection()
    if (!sel) return
    const range = at ? document.caretRangeFromPoint?.(at.x, at.y) : null
    sel.removeAllRanges()
    if (range && container.contains(range.startContainer)) {
      sel.addRange(range)
      sel.modify?.('move', 'backward', 'word')
      sel.modify?.('extend', 'forward', 'word')
    } else {
      const all = document.createRange()
      all.selectNodeContents(container)
      sel.addRange(all)
    }
  }
  function stopReading() {
    setReading((r) => {
      if (r) {
        r.container.setAttribute('style', r.restore)
        if (window.getSelection()?.containsNode(r.container, true)) window.getSelection()?.removeAllRanges()
      }
      return null
    })
  }

  // ── bold / italic / underline while editing text ────────────────────────
  /** After a formatting toggle re-renders the shape: re-enter editing with the same selection. */
  const reselect = useRef<{ nodeId: string; start: TextPoint; end: TextPoint } | null>(null)

  const toggleStyle = async (prop: 'bold' | 'italic' | 'underline') => {
    if (!editing) return
    const { nodeId, container, before } = editing
    const sel = window.getSelection()
    if (!sel?.rangeCount) return
    const r = sel.getRangeAt(0)
    if (!container.contains(r.startContainer) || !container.contains(r.endContainer)) return
    const { paragraphs, positions } = readParagraphsAt(container, [[r.startContainer, r.startOffset], [r.endContainer, r.endOffset]])
    let [start, end] = positions
    if (!start || !end) return
    const paraText = (i: number) => paragraphs[i]?.runs.map((x) => x.text).join('') ?? ''
    if (start.p === end.p && start.o === end.o) {
      // Just the caret: the word under it, like PowerPoint.
      const t = paraText(start.p)
      let a = start.o
      let b = start.o
      while (a > 0 && /[\p{L}\p{N}_'’-]/u.test(t[a - 1])) a--
      while (b < t.length && /[\p{L}\p{N}_'’-]/u.test(t[b])) b++
      if (a === b) return
      start = { p: start.p, o: a }
      end = { p: end.p, o: b }
    }
    // Word-style: if all of it already has the style, remove it; otherwise apply it.
    const has = (el: Element) => {
      const cs = getComputedStyle(el)
      if (prop === 'bold') return (parseInt(cs.fontWeight, 10) || 400) >= 600
      if (prop === 'italic') return cs.fontStyle === 'italic' || cs.fontStyle === 'oblique'
      for (let e: Element | null = el; e && e !== container.parentElement; e = e.parentElement) if (getComputedStyle(e).textDecorationLine.includes('underline')) return true
      return false
    }
    const texts: Element[] = []
    const w = document.createTreeWalker(container, NodeFilter.SHOW_TEXT)
    const probe = document.createRange()
    probe.setStart(...(domPointAt(container, start, 'start') ?? [r.startContainer, r.startOffset]) as [Node, number])
    probe.setEnd(...(domPointAt(container, end, 'end') ?? [r.endContainer, r.endOffset]) as [Node, number])
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      // Only text actually inside the selection (not a neighbour it merely touches).
      if (!probe.intersectsNode(n) || !n.textContent?.trim() || !n.parentElement) continue
      if ((probe.startContainer === n && probe.startOffset >= (n.textContent ?? '').length) || (probe.endContainer === n && probe.endOffset === 0)) continue
      texts.push(n.parentElement)
    }
    const on = !(texts.length && texts.every(has))

    const ops: EditOperation[] = []
    if (textBodyChanged(paragraphs, before)) ops.push({ type: 'setTextBody', slideId: slide.id, nodeId, paragraphs })
    ops.push({
      type: 'setTextStyle', slideId: slide.id, nodeId, style: { [prop]: on },
      range: { start: { paragraphIndex: start.p, offset: start.o }, end: { paragraphIndex: end.p, offset: end.o } },
    })
    const picked = start.p === end.p ? paraText(start.p).slice(start.o, end.o) : `${paraText(start.p).slice(start.o)}…`
    setEditing(null)
    container.contentEditable = 'false'
    reselect.current = { nodeId, start, end }
    const n = nodeById(nodeId)
    await run(ops.length === 1 ? ops[0] : { type: 'batch', operations: ops },
      `Slide ${slideNo}: ${on ? 'made' : 'removed'} ${prop}${on ? '' : ' from'} "${short(picked, 60)}" in "${n ? label(n) : nodeId}"`)
  }

  // ── font / size / color (toolbar; ⌘⇧> / ⌘⇧< step the size) ──────────────
  /** The text being edited and its selection — the word at the caret when nothing is selected. */
  const editingTarget = () => {
    if (!editing) return null
    const { nodeId, container, before } = editing
    const sel = window.getSelection()
    if (!sel?.rangeCount) return null
    const r = sel.getRangeAt(0)
    if (!container.contains(r.startContainer) || !container.contains(r.endContainer)) return null
    const { paragraphs, positions } = readParagraphsAt(container, [[r.startContainer, r.startOffset], [r.endContainer, r.endOffset]])
    let [start, end] = positions
    if (!start || !end) return null
    if (start.p === end.p && start.o === end.o) {
      const t = paragraphs[start.p]?.runs.map((x) => x.text).join('') ?? ''
      let a = start.o
      let b = start.o
      while (a > 0 && /[\p{L}\p{N}_'’-]/u.test(t[a - 1])) a--
      while (b < t.length && /[\p{L}\p{N}_'’-]/u.test(t[b])) b++
      if (a === b) return null
      start = { p: start.p, o: a }
      end = { p: end.p, o: b }
    }
    return { nodeId, container, paragraphs, start, end, changed: textBodyChanged(paragraphs, before) }
  }
  /** The text selection saved before focus went to a toolbar field (which ended the editing). */
  const heldSelection = useRef<{ nodeId: string; start: TextPoint; end: TextPoint } | null>(null)
  const [heldTick, setHeldTick] = useState(0)
  const setHeld = (h: typeof heldSelection.current) => {
    heldSelection.current = h
    setHeldTick((n) => n + 1)
  }
  // While a toolbar field has the focus, the held selection stays visible — the browser's own
  // selection went to the field — so it's clear the size applies to that text, not the whole box.
  useLayoutEffect(() => {
    const registry = (globalThis.CSS as unknown as { highlights?: Map<string, unknown> } | undefined)?.highlights
    const HighlightCtor = (globalThis as unknown as { Highlight?: new (...r: Range[]) => unknown }).Highlight
    if (!registry || !HighlightCtor) return
    const h = heldSelection.current
    const el = h && nodeEl(h.nodeId)
    const c = el && textContainer(el)
    const a = c && domPointAt(c, h!.start, 'start')
    const b = c && domPointAt(c, h!.end, 'end')
    if (!a || !b) {
      registry.delete('held-selection')
      return
    }
    const r = document.createRange()
    r.setStart(a[0], a[1])
    r.setEnd(b[0], b[1])
    registry.set('held-selection', new HighlightCtor(r))
    return () => { registry.delete('held-selection') }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [heldTick, session.version, slide.id])

  const textRange = (start: TextPoint, end: TextPoint) => ({ start: { paragraphIndex: start.p, offset: start.o }, end: { paragraphIndex: end.p, offset: end.o } })

  /**
   * Apply text formatting: to the text being edited (its selection), the selection saved before a
   * toolbar field took the focus, or the whole text of each selected shape. `plan` gives the
   * setTextStyle operations for one text container ([start, end), or all of it when null).
   */
  const applyText = async (what: string, plan: (nodeId: string, c: HTMLElement, start: TextPoint | null, end: TextPoint | null) => EditOperation[]) => {
    const t = editingTarget()
    const held = heldSelection.current
    if (held) setHeld(null)
    if (t || (held && !editing)) {
      const nodeId = t?.nodeId ?? held!.nodeId
      const el = nodeEl(nodeId)
      const c = t?.container ?? (el && textContainer(el))
      const start = t?.start ?? held!.start
      const end = t?.end ?? held!.end
      if (!c) return
      const ops: EditOperation[] = []
      if (t?.changed) ops.push({ type: 'setTextBody', slideId: slide.id, nodeId, paragraphs: t.paragraphs })
      ops.push(...plan(nodeId, c, start, end))
      if (!ops.length) return
      if (t) {
        setEditing(null)
        t.container.contentEditable = 'false'
      }
      reselect.current = { nodeId, start, end }
      const n = nodeById(nodeId)
      await run(ops.length === 1 ? ops[0] : { type: 'batch', operations: ops }, `Slide ${slideNo}: ${what} in "${n ? label(n) : nodeId}"`)
      return
    }
    const ops: EditOperation[] = []
    const names: string[] = []
    for (const id of selection) {
      const el = nodeEl(id)
      const c = el && textContainer(el)
      if (!c) continue
      const o = plan(id, c, null, null)
      if (!o.length) continue
      ops.push(...o)
      const n = nodeById(id)
      names.push(`"${n ? label(n) : id}"`)
    }
    if (ops.length) await run(ops.length === 1 ? ops[0] : { type: 'batch', operations: ops }, `Slide ${slideNo}: ${what} in ${names.join(', ')}`)
  }

  const setFont = (face: string) =>
    void applyText(`set the font to ${face}`, (nodeId, _c, a, b) => [{ type: 'setTextStyle', slideId: slide.id, nodeId, style: { fontFamily: face }, ...(a && b ? { range: textRange(a, b) } : {}) }])
  const setSize = (pt: number) =>
    void applyText(`set the size to ${pt} pt`, (nodeId, _c, a, b) => [{ type: 'setTextStyle', slideId: slide.id, nodeId, style: { fontSize: pt }, ...(a && b ? { range: textRange(a, b) } : {}) }])
  /** Each run one preset size up / down, from its own size (as PowerPoint's Grow / Shrink Font). */
  const stepFontSize = (dir: 1 | -1) =>
    void applyText(dir > 0 ? 'made the text bigger' : 'made the text smaller', (nodeId, c, a, b) => {
      let start = a
      let end = b
      if (!start || !end) {
        const ps = readParagraphs(c)
        start = { p: 0, o: 0 }
        end = { p: ps.length - 1, o: ps[ps.length - 1]?.runs.reduce((n, r) => n + r.text.length, 0) ?? 0 }
      }
      return sizeRuns(c, start, end).map((r): EditOperation => ({ type: 'setTextStyle', slideId: slide.id, nodeId, style: { fontSize: nextSize(r.pt, dir) }, range: textRange(r.start, r.end) }))
    })
  const setColor = (target: ColorTarget, hex: string) => {
    if (target === 'text') {
      void applyText(`colored the text #${hex}`, (nodeId, _c, a, b) => [{ type: 'setTextStyle', slideId: slide.id, nodeId, style: { color: hex }, ...(a && b ? { range: textRange(a, b) } : {}) }])
      return
    }
    if (target === 'background') {
      void run({ type: 'setSlideBackground', slideId: slide.id, color: hex }, `Slide ${slideNo}: set the background to #${hex}`)
      return
    }
    const ids = editing ? [editing.nodeId] : selection
    const shapes = ids.map((id) => nodeById(id)).filter((n): n is SlideNode => !!n && n.nodeType === 'shape')
    if (!shapes.length) return
    if (editing) void commitEditing()
    const ops: EditOperation[] = shapes.map((n) =>
      // 'none': no fill (a:noFill) / no outline.
      target === 'fill' ? { type: 'setSolidFill', slideId: slide.id, nodeId: n.id, color: hex === 'none' ? null : hex } : { type: 'setOutline', slideId: slide.id, nodeId: n.id, color: hex === 'none' ? null : hex })
    void run(ops.length === 1 ? ops[0] : { type: 'batch', operations: ops },
      hex === 'none'
        ? `Slide ${slideNo}: removed the ${target === 'fill' ? 'fill' : 'outline'} of ${shapes.map((n) => `"${label(n)}"`).join(', ')}`
        : `Slide ${slideNo}: ${target === 'fill' ? 'filled' : 'outlined'} ${shapes.map((n) => `"${label(n)}"`).join(', ')} with #${hex}`)
  }
  // (A later press that finds the editing already over — e.g. a double click in the field — keeps it.)
  const holdSelection = () => {
    const t = editingTarget()
    if (t) setHeld({ nodeId: t.nodeId, start: t.start, end: t.end })
  }
  const releaseSelection = () => {
    if (heldSelection.current) setHeld(null)
  }
  // Another shape selected (or none), or text editing again: the saved text selection no longer applies.
  useEffect(() => {
    const h = heldSelection.current
    if (h && (selection.length !== 1 || selection[0] !== h.nodeId)) setHeld(null)
  }, [selection])
  useEffect(() => {
    if (editing && heldSelection.current) setHeld(null)
  }, [editing])

  // The toolbar's view of the selection: font, size and colors of the text at the caret (or of the
  // first selected shape's text), and its fill and line.
  const [formatTick, setFormatTick] = useState(0)
  useEffect(() => {
    if (!editing) return
    const bump = () => setFormatTick((n) => n + 1)
    document.addEventListener('selectionchange', bump)
    return () => document.removeEventListener('selectionchange', bump)
  }, [editing])
  useEffect(() => {
    if (!onFormat) return
    const textStyle = (el: Element | null) => {
      if (!el) return {}
      const cs = getComputedStyle(el)
      return { font: firstFamily(cs.fontFamily), size: pxToPt(cs.fontSize), textColor: cssToHex(cs.color) ?? undefined }
    }
    const firstText = (c: HTMLElement) => {
      const w = document.createTreeWalker(c, NodeFilter.SHOW_TEXT)
      for (let n = w.nextNode(); n; n = w.nextNode()) if (n.textContent?.trim() && !n.parentElement?.closest('[data-pptx-bullet]')) return n.parentElement
      return null
    }
    const paint = (el: HTMLElement | null) => {
      const g = el?.querySelector<SVGGeometryElement>('svg path, svg rect, svg ellipse, svg polygon')
      if (!g) return {}
      const cs = getComputedStyle(g)
      // No fill / no line renders as 'none' or a fully transparent color (not a gradient's url(…)).
      const clear = (v: string) => v === 'none' || v === 'transparent' || /^rgba\(.*,\s*0\)$/.test(v)
      return {
        fill: clear(cs.fill) ? 'none' : cssToHex(cs.fill) ?? undefined,
        line: clear(cs.stroke) ? 'none' : cssToHex(cs.stroke) ?? undefined,
      }
    }
    if (editing) {
      const sel = window.getSelection()
      const at = sel?.rangeCount && editing.container.contains(sel.anchorNode) ? sel.anchorNode : null
      const el = at ? (at.nodeType === Node.TEXT_NODE ? at.parentElement : (at as Element)) : firstText(editing.container)
      onFormat({ text: true, ...textStyle(el), shape: true, ...paint(nodeEl(editing.nodeId)), background: false })
      return
    }
    if (!selection.length) {
      onFormat({ text: false, shape: false, background: true })
      return
    }
    const nodes = selection.map((id) => nodeById(id)).filter((n): n is SlideNode => !!n)
    const withText = selection.map((id) => nodeEl(id)).map((el) => el && textContainer(el)).find((c): c is HTMLElement => !!c && !!c.textContent?.trim())
    const shapeEl = nodes.find((n) => n.nodeType === 'shape')
    onFormat({
      text: !!withText,
      ...(withText ? textStyle(firstText(withText)) : {}),
      shape: !!shapeEl,
      ...(shapeEl ? paint(nodeEl(shapeEl.id)) : {}),
      background: false,
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onFormat, editing, selection, session.version, slide.id, formatTick])
  useEffect(() => () => onFormat?.(null), [onFormat])

  useEffect(() => {
    const rs = reselect.current
    if (!rs) return
    reselect.current = null
    requestAnimationFrame(() => {
      const el = nodeEl(rs.nodeId)
      const c = el && textContainer(el)
      if (!c) return
      startEditing(rs.nodeId)
      const a = domPointAt(c, rs.start, 'start')
      const b = domPointAt(c, rs.end, 'end')
      if (!a || !b) return
      const range = document.createRange()
      range.setStart(a[0], a[1])
      range.setEnd(b[0], b[1])
      window.getSelection()?.removeAllRanges()
      window.getSelection()?.addRange(range)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.version])

  // ── paste into text being edited ────────────────────────────────────────
  // ⌘V (and the browser's "Paste and Match Style"): text only, formatted like where it lands.
  useEffect(() => {
    const c = editing?.container
    if (!c) return
    const onPaste = (e: ClipboardEvent) => {
      e.preventDefault()
      const text = e.clipboardData?.getData('text/plain') ?? ''
      if (text) insertPlainText(text)
    }
    c.addEventListener('paste', onPaste)
    return () => c.removeEventListener('paste', onPaste)
  }, [editing?.container])

  /** ⌥⇧⌘V: paste keeping the source's formatting (read from the system clipboard by the server). */
  const pasteFormatted = async () => {
    if (!editing) return
    const { nodeId, container } = editing
    const clip = await api.clipboardRich().catch(() => null)
    if (container.contentEditable !== 'true' || !container.isConnected) return // editing ended meanwhile
    const styled = clip?.html ? parseClipboardHtml(clip.html) : null
    const text = styled?.length ? styledText(styled) : normalizePasted(clip?.text ?? '')
    if (!text) return
    insertPlainText(text)
    if (!styled?.length) return
    // Where the pasted text ended and began, then its pieces' formatting on top.
    const sel = window.getSelection()
    if (!sel?.rangeCount) return
    const caret = sel.getRangeAt(0)
    const { paragraphs, positions: [end] } = readParagraphsAt(container, [[caret.endContainer, caret.endOffset]])
    if (!end) return
    const paraLength = (p: number) => paragraphs[p]?.runs.reduce((n, r) => n + r.text.length, 0) ?? 0
    const ranges = styledRanges(styled, insertionStart(text, end, paraLength))
    if (!ranges.length) return
    const ops: EditOperation[] = [{ type: 'setTextBody', slideId: slide.id, nodeId, paragraphs }]
    for (const r of ranges) {
      ops.push({
        type: 'setTextStyle', slideId: slide.id, nodeId, style: r.style,
        range: { start: { paragraphIndex: r.start.p, offset: r.start.o }, end: { paragraphIndex: r.end.p, offset: r.end.o } },
      })
    }
    setEditing(null)
    container.contentEditable = 'false'
    reselect.current = { nodeId, start: end, end } // back to editing, caret after the pasted text
    const n = nodeById(nodeId)
    await run({ type: 'batch', operations: ops }, `Slide ${slideNo}: pasted "${short(text, 80)}" with its formatting into "${n ? label(n) : nodeId}"`)
  }

  const commitEditing = useCallback(async () => {
    if (!editing) return
    const { nodeId, container, before } = editing
    setEditing(null)
    container.contentEditable = 'false'
    const paragraphs = readParagraphs(container)
    const after = paragraphsText(paragraphs)
    if (!textBodyChanged(paragraphs, before)) return
    const n = nodeById(nodeId)
    await run(
      { type: 'setTextBody', slideId: slide.id, nodeId, paragraphs },
      after === before
        ? `Slide ${slideNo}: removed the bullet from a line in "${n ? label(n) : nodeId}"`
        : `Slide ${slideNo}: edited the text of "${n ? label(n) : nodeId}": "${short(before, 80)}" → "${short(after, 120)}"`,
    )
  }, [editing, slide.id, slideNo])

  // ── pointer interaction ─────────────────────────────────────────────────
  const snapTargets = (exclude: Set<string>) => {
    const xs = [0, pres.width / 2, pres.width]
    const ys = [0, pres.height / 2, pres.height]
    for (const n of slide.nodes) {
      if (exclude.has(n.id)) continue
      xs.push(n.position.x, n.position.x + n.size.w / 2, n.position.x + n.size.w)
      ys.push(n.position.y, n.position.y + n.size.h / 2, n.position.y + n.size.h)
    }
    return { xs, ys }
  }
  const snap1 = (vals: number[], targets: number[], tol: number) => {
    let best: { d: number; at: number } | null = null
    for (const v of vals) for (const t of targets) {
      const d = t - v
      if (Math.abs(d) <= tol && (!best || Math.abs(d) < Math.abs(best.d))) best = { d, at: t }
    }
    return best
  }

  const startMove = (ids: string[], e: React.PointerEvent) => {
    const nodes = ids.map(nodeById).filter(Boolean) as SlideNode[]
    if (!nodes.length) return
    const start = { x: e.clientX, y: e.clientY }
    const bbox = union(nodes.map(rectOf))
    const { xs, ys } = snapTargets(new Set(ids))
    let moved = false
    let dx = 0, dy = 0
    const onMove = (ev: PointerEvent) => {
      const rx = (ev.clientX - start.x) / scale, ry = (ev.clientY - start.y) / scale
      if (!moved && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 3) return
      // A press that starts to drag changes the file: only with editing on (else it stays a click).
      if (!moved && !requestEdit()) {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        return
      }
      moved = true
      dx = rx; dy = ry
      const guides: { x?: number; y?: number }[] = []
      if (!ev.altKey) {
        const tol = SNAP_PX / scale
        const sx = snap1([bbox.x + dx, bbox.x + dx + bbox.w / 2, bbox.x + dx + bbox.w], xs, tol)
        const sy = snap1([bbox.y + dy, bbox.y + dy + bbox.h / 2, bbox.y + dy + bbox.h], ys, tol)
        if (sx) { dx += sx.d; guides.push({ x: sx.at }) }
        if (sy) { dy += sy.d; guides.push({ y: sy.at }) }
      }
      for (const n of nodes) {
        const el = nodeEl(n.id)
        if (el) el.style.translate = `${dx}px ${dy}px`
      }
      setPreview({ rects: Object.fromEntries(nodes.map((n) => [n.id, { ...rectOf(n), x: n.position.x + dx, y: n.position.y + dy }])), guides })
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      setPreview(null)
      if (!moved) return
      const ops: EditOperation[] = nodes.map((n) => ({
        type: 'setNodeTransform', slideId: slide.id, nodeId: n.id,
        position: { x: n.position.x + dx, y: n.position.y + dy },
      }))
      const names = nodes.map((n) => `"${label(n)}"`).join(', ')
      void run(ops.length === 1 ? ops[0] : { type: 'batch', operations: ops },
        `Slide ${slideNo}: moved ${names} to (${Math.round(bbox.x + dx)}, ${Math.round(bbox.y + dy)}) px`,
        `move:${slide.id}:${ids.join(',')}`)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  const startResize = (handle: Handle, e: React.PointerEvent) => {
    const n = nodeById(selection[0])
    if (!n) return
    e.stopPropagation()
    if (!requestEdit()) return
    const start = { x: e.clientX, y: e.clientY }
    const r0 = rectOf(n)
    const theta = n.rotation || 0
    const sx = handle.includes('e') ? 1 : handle.includes('w') ? -1 : 0
    const sy = handle.includes('s') ? 1 : handle.includes('n') ? -1 : 0
    const corner = sx !== 0 && sy !== 0
    const keepAspectDefault = n.nodeType === 'picture'
    const el = nodeEl(n.id)
    let next: Rect = r0
    const onMove = (ev: PointerEvent) => {
      const d = rot((ev.clientX - start.x) / scale, (ev.clientY - start.y) / scale, -theta)
      let w = Math.max(4, r0.w + sx * d.x)
      let h = Math.max(4, r0.h + sy * d.y)
      if (corner && (keepAspectDefault !== ev.shiftKey)) {
        const k = Math.max(w / r0.w, h / r0.h)
        w = r0.w * k
        h = r0.h * k
      }
      // Keep the opposite edge/corner fixed in slide space (works for rotated shapes too).
      const shift = rot((sx * (w - r0.w)) / 2, (sy * (h - r0.h)) / 2, theta)
      const cx = r0.x + r0.w / 2 + shift.x, cy = r0.y + r0.h / 2 + shift.y
      next = { x: cx - w / 2, y: cy - h / 2, w, h }
      if (el) {
        el.style.left = `${next.x}px`; el.style.top = `${next.y}px`
        el.style.width = `${w}px`; el.style.height = `${h}px`
        el.querySelectorAll(':scope > svg').forEach((svg) => {
          svg.setAttribute('width', String(w)); svg.setAttribute('height', String(h)); svg.setAttribute('preserveAspectRatio', 'none')
        })
      }
      setPreview({ rects: { [n.id]: next }, guides: [] })
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      setPreview(null)
      if (next === r0) return
      void run(
        { type: 'setNodeTransform', slideId: slide.id, nodeId: n.id, position: { x: next.x, y: next.y }, size: { w: next.w, h: next.h } },
        `Slide ${slideNo}: resized "${label(n)}" to ${Math.round(next.w)}×${Math.round(next.h)} px at (${Math.round(next.x)}, ${Math.round(next.y)})`,
        `resize:${slide.id}:${n.id}`,
      )
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  const startMarquee = (e: React.PointerEvent) => {
    const p0 = toSlide(e.clientX, e.clientY)
    let rect: Rect | null = null
    const onMove = (ev: PointerEvent) => {
      const p = toSlide(ev.clientX, ev.clientY)
      rect = { x: Math.min(p0.x, p.x), y: Math.min(p0.y, p.y), w: Math.abs(p.x - p0.x), h: Math.abs(p.y - p0.y) }
      setMarquee(rect)
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      setMarquee(null)
      if (!rect || rect.w < 3 || rect.h < 3) return
      const r = rect
      const hits = slide.nodes.filter((n) => n.position.x < r.x + r.w && n.position.x + n.size.w > r.x && n.position.y < r.y + r.h && n.position.y + n.size.h > r.y)
      setSelection(key, hits.map((n) => n.id))
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    stageRef.current?.focus({ preventScroll: true })
    if (editing && editing.container.contains(e.target as Node)) return
    if (editing) void commitEditing()
    // Selecting text in the box opened for reading: the browser's own selection.
    if (reading && reading.container.contains(e.target as Node)) return
    if (reading) stopReading()
    if (noteMode) {
      e.preventDefault() // no default mousedown focus: it would pull focus back from the note box that opens
      const p = toSlide(e.clientX, e.clientY)
      const id = pickAt(e.clientX, e.clientY)
      const n = id ? nodeById(id) : undefined
      setDraft({ x: p.x / pres.width, y: p.y / pres.height, shapeName: n ? label(n) : undefined })
      return
    }
    if (draft) setDraft(null)
    const id = pickAt(e.clientX, e.clientY, { cycle: e.altKey, keepSelected: !e.shiftKey && !e.metaKey })
    if (!id) {
      if (!e.shiftKey) setSelection(key, [])
      startMarquee(e)
      return
    }
    let sel = selection
    if (e.shiftKey || e.metaKey) sel = sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id]
    else if (!sel.includes(id)) sel = [id]
    setSelection(key, sel)
    if (sel.includes(id)) startMove(sel, e)
    e.preventDefault()
  }

  const onDoubleClick = (e: React.MouseEvent) => {
    if (noteMode || editing) return
    const id = pickAt(e.clientX, e.clientY, { keepSelected: true })
    if (!id) return
    // Editing off: open the text for selecting and copying instead.
    if (editOff) startReading(id, { x: e.clientX, y: e.clientY })
    else startEditing(id, { x: e.clientX, y: e.clientY })
  }

  // ── clipboard / keyboard ────────────────────────────────────────────────
  const copySelection = async () => {
    if (!selection.length) return
    const data = await copyNodes(pres, slide.id, selection)
    const names = selection.map((id) => nodeById(id)).filter(Boolean).map((n) => `"${label(n!)}"`).join(', ')
    setClipboard({ kind: 'nodes', deckKey: key, slideId: slide.id, data, label: names })
    if (data.omittedNodeIds.length) useApp.getState().toast('Charts/diagrams can’t be copied yet — they were left out.')
  }
  const paste = async () => {
    const c = getClipboard()
    if (!c || c.kind !== 'nodes') return
    const offset = c.deckKey === key && c.slideId === slide.id ? { x: 12, y: 12 } : { x: 0, y: 0 }
    const created = await run({ type: 'pasteNodes', slideId: slide.id, clipboard: c.data, offset }, `Slide ${slideNo}: pasted ${c.label}`)
    if (created?.length) setSelection(key, created)
    stageRef.current?.focus({ preventScroll: true })
  }
  const deleteSelection = async () => {
    if (!selection.length) return
    const nodes = selection.map(nodeById).filter(Boolean) as SlideNode[]
    const ops: EditOperation[] = nodes.map((n) => ({ type: 'deleteNode', slideId: slide.id, nodeId: n.id }))
    await run(ops.length === 1 ? ops[0] : { type: 'batch', operations: ops }, `Slide ${slideNo}: deleted ${nodes.map((n) => `"${label(n)}"`).join(', ')}`)
    setSelection(key, [])
  }
  const duplicateSelection = async () => {
    if (selection.length !== 1) return
    const n = nodeById(selection[0])
    if (!n) return
    const created = await run({ type: 'duplicateNode', slideId: slide.id, nodeId: n.id, offset: { x: 12, y: 12 } }, `Slide ${slideNo}: duplicated "${label(n)}"`)
    if (created?.length) setSelection(key, created)
  }
  const nudge = (dx: number, dy: number) => {
    const nodes = selection.map(nodeById).filter(Boolean) as SlideNode[]
    if (!nodes.length) return
    const ops: EditOperation[] = nodes.map((n) => ({ type: 'setNodeTransform', slideId: slide.id, nodeId: n.id, position: { x: n.position.x + dx, y: n.position.y + dy } }))
    // Same shapes, same direction: one undo step for the whole run of presses (see deckStore pushEdit).
    const dir = dx < 0 ? 'left' : dx > 0 ? 'right' : dy < 0 ? 'up' : 'down'
    void run(ops.length === 1 ? ops[0] : { type: 'batch', operations: ops },
      `Slide ${slideNo}: moved ${nodes.map((n) => `"${label(n)}"`).join(', ')}`, `nudge:${slide.id}:${selection.join(',')}:${dir}`)
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (editing) {
      if (e.key === 'Escape') { e.preventDefault(); void commitEditing() }
      // The browser's own bold/italic/underline would only change the page, not the file.
      const k = e.key.toLowerCase()
      if ((e.metaKey || e.ctrlKey) && !e.altKey && (k === 'b' || k === 'i' || k === 'u')) {
        e.preventDefault()
        void toggleStyle(k === 'b' ? 'bold' : k === 'i' ? 'italic' : 'underline')
      }
      // ⌘⇧> / ⌘⇧<: grow / shrink the font a preset step (as in PowerPoint).
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === '>' || e.key === '.' || e.key === '<' || e.key === ',')) {
        e.preventDefault()
        stepFontSize(e.key === '>' || e.key === '.' ? 1 : -1)
      }
      // ⌥⇧⌘V: keep source formatting (by code: ⌥ changes the key's character). Also stops the
      // browser's own ⌥⇧⌘V, "Paste and Match Style".
      if ((e.metaKey || e.ctrlKey) && e.altKey && e.shiftKey && e.code === 'KeyV') {
        e.preventDefault()
        void pasteFormatted()
      }
      e.stopPropagation()
      return
    }
    const mod = e.metaKey || e.ctrlKey
    if (reading) {
      const k = e.key.toLowerCase()
      if (e.key === 'Escape') { e.preventDefault(); stopReading(); return }
      // ⌘C copies the selected text (the browser's own copy); ⌘A selects all of the box's text.
      if (mod && k === 'c' && !window.getSelection()?.isCollapsed) return
      if (mod && k === 'a') {
        e.preventDefault()
        const all = document.createRange()
        all.selectNodeContents(reading.container)
        window.getSelection()?.removeAllRanges()
        window.getSelection()?.addRange(all)
        return
      }
    }
    if (e.key === 'Escape') { setSelection(key, []); setNoteMode(false); setDraft(null); return }
    if ((e.key === 'Delete' || e.key === 'Backspace') && selection.length) { e.preventDefault(); void deleteSelection(); return }
    if (mod && e.key === 'c' && selection.length) { e.preventDefault(); void copySelection(); return }
    if (mod && e.key === 'x' && selection.length) { e.preventDefault(); void copySelection().then(deleteSelection); return }
    if (mod && e.key === 'v' && getClipboard()?.kind === 'nodes') { e.preventDefault(); void paste(); return }
    if (mod && e.key === 'd') { e.preventDefault(); void duplicateSelection(); return }
    if (mod && e.shiftKey && selection.length && (e.key === '>' || e.key === '.' || e.key === '<' || e.key === ',')) {
      e.preventDefault()
      stepFontSize(e.key === '>' || e.key === '.' ? 1 : -1)
      return
    }
    if (mod && e.key === 'a') { e.preventDefault(); setSelection(key, slide.nodes.map((n) => n.id)); return }
    if (e.key === 'Enter' && selection.length === 1) { e.preventDefault(); if (editOff) startReading(selection[0]); else startEditing(selection[0]); return }
    // ⌘↑ / ⌘↓: one step up / down the stack; with ⇧: to the front / back (as in Google Slides).
    if (mod && selection.length && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault()
      arrange(e.key === 'ArrowUp' ? (e.shiftKey ? 'front' : 'forward') : (e.shiftKey ? 'back' : 'backward'))
      return
    }
    const step = e.shiftKey ? 10 : 1
    if (selection.length && e.key.startsWith('Arrow')) {
      e.preventDefault()
      nudge(e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0, e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0)
    }
  }

  // System-clipboard image paste (e.g. a screenshot).
  useEffect(() => {
    const onPaste = async (e: ClipboardEvent) => {
      if (document.activeElement !== stageRef.current) return
      const file = [...(e.clipboardData?.files ?? [])].find((f) => f.type.startsWith('image/'))
      if (!file) return
      e.preventDefault()
      await insertImage(file, file.name || 'pasted.png')
    }
    document.addEventListener('paste', onPaste)
    return () => document.removeEventListener('paste', onPaste)
  })

  const insertImage = async (blob: Blob, name: string, at?: { x: number; y: number }) => {
    try {
      const img = await prepareImage(blob, name)
      const size = fitSize(img, pres.width, pres.height)
      const pos = at ? { x: at.x - size.w / 2, y: at.y - size.h / 2 } : { x: (pres.width - size.w) / 2, y: (pres.height - size.h) / 2 }
      const created = await run(
        { type: 'addImage', slideId: slide.id, data: img.data, contentType: img.contentType, size, position: pos, name: img.name },
        `Slide ${slideNo}: added image "${img.name}" (${Math.round(size.w)}×${Math.round(size.h)} px at ${Math.round(pos.x)}, ${Math.round(pos.y)})`,
      )
      if (created?.length) setSelection(key, created)
      stageRef.current?.focus({ preventScroll: true })
    } catch (e) {
      useApp.getState().toast(`Couldn't add the image: ${(e as Error).message}`, 'error')
    }
  }

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault()
    setDropHint(false)
    const at = toSlide(e.clientX, e.clientY)
    const treePath = e.dataTransfer.getData('application/x-deckedit-path')
    if (treePath) {
      const pid = useApp.getState().projectId!
      const { bytes } = await api.readFile(pid, treePath)
      await insertImage(new Blob([bytes]), treePath.split('/').pop()!, at)
      return
    }
    const file = [...e.dataTransfer.files].find((f) => f.type.startsWith('image/') || /\.(png|jpe?g|gif|svg|webp)$/i.test(f.name))
    if (file) await insertImage(file, file.name, at)
  }

  /**
   * Change the stacking order of the selected shapes (slide.nodes runs bottom → top). Several
   * shapes keep their order among themselves: to the front bottom-most first, to the back top-most
   * first; one step up top-most first, one step down bottom-most first — and a shape never hops
   * over another selected one.
   */
  const arrange = (order: NodeOrder) => {
    const picked = new Set(selection)
    const ids = slide.nodes.map((n) => n.id)
    const chosen = ids.filter((id) => picked.has(id))
    if (!chosen.length) return
    const seq = order === 'front' || order === 'backward' ? chosen : [...chosen].reverse()
    const ops: EditOperation[] = []
    for (const id of seq) {
      const i = ids.indexOf(id)
      const to = order === 'front' ? ids.length - 1 : order === 'back' ? 0 : order === 'forward' ? i + 1 : i - 1
      if (to < 0 || to >= ids.length || to === i) continue
      if ((order === 'forward' || order === 'backward') && picked.has(ids[to])) continue
      ids.splice(i, 1)
      ids.splice(to, 0, id)
      ops.push({ type: 'reorderNode', slideId: slide.id, nodeId: id, order })
    }
    if (!ops.length) return
    const names = chosen.map((id) => nodeById(id)).filter(Boolean).map((n) => `"${label(n as SlideNode)}"`)
    void run(ops.length === 1 ? ops[0] : { type: 'batch', operations: ops }, `Slide ${slideNo}: ${ARRANGE_LABEL[order]} ${names.join(', ')}`)
  }

  registerActions({
    arrange,
    setFont,
    setSize,
    stepSize: stepFontSize,
    setColor,
    holdSelection,
    releaseSelection,
    addTextBox: async () => {
        const created = await run(
        { type: 'addTextBox', slideId: slide.id, text: 'New text', position: { x: pres.width * 0.3, y: pres.height * 0.42 }, size: { w: pres.width * 0.4, h: pres.height * 0.1 } },
        `Slide ${slideNo}: added a text box`,
      )
      if (created?.length) {
        setSelection(key, created)
        setTimeout(() => startEditing(created[0]), 50)
      }
    },
    align: (kind) => {
      const nodes = selection.map(nodeById).filter(Boolean) as SlideNode[]
      const pos = alignPositions(nodes.map((n) => ({ id: n.id, ...rectOf(n) })), kind)
      const ops: EditOperation[] = nodes
        .filter((n) => { const p = pos.get(n.id); return p && (Math.abs(p.x - n.position.x) > 0.01 || Math.abs(p.y - n.position.y) > 0.01) })
        .map((n) => ({ type: 'setNodeTransform', slideId: slide.id, nodeId: n.id, position: pos.get(n.id)! }))
      if (!ops.length) return
      void run(ops.length === 1 ? ops[0] : { type: 'batch', operations: ops },
        `Slide ${slideNo}: ${ALIGN_LABEL[kind]} ${nodes.map((n) => `"${label(n)}"`).join(', ')}`)
    },
  })

  // ── drawn notes ─────────────────────────────────────────────────────────
  /** The shapes a mark covers, most-covered first (skips backdrops the mark merely sits on). */
  const shapesIn = (b: Box): string[] => {
    const r = { x: b.x1 * pres.width, y: b.y1 * pres.height, w: (b.x2 - b.x1) * pres.width, h: (b.y2 - b.y1) * pres.height }
    const markArea = Math.max(1, r.w * r.h)
    const scored = slide.nodes
      .map((n) => {
        const ix = Math.max(0, Math.min(r.x + r.w, n.position.x + n.size.w) - Math.max(r.x, n.position.x))
        const iy = Math.max(0, Math.min(r.y + r.h, n.position.y + n.size.h) - Math.max(r.y, n.position.y))
        const area = Math.max(1, n.size.w * n.size.h)
        const inter = ix * iy
        return { n, ofShape: inter / area, ofMark: inter / markArea, area }
      })
      .filter((x) => x.ofShape >= 0.3 || (x.ofMark >= 0.5 && x.area <= markArea * 4))
      .sort((a, b) => b.ofShape - a.ofShape)
    return scored.slice(0, 6).map(({ n }) => {
      const t = short(nodeText(n), 40)
      return t ? `"${label(n)}" — “${t}”` : `"${label(n)}"`
    })
  }
  const addStroke = (st: Stroke) => {
    const strokes = [...(draft?.strokes ?? []), st]
    setDraft({ ...pinFor(strokes), strokes, shapes: shapesIn(strokesBox(strokes)) })
  }
  /** A tap while drawing pins the note at that point, like the pin tool. */
  const tapPin = (p: { x: number; y: number }) => {
    if (draft?.strokes?.length) return
    const sx = p.x * pres.width, sy = p.y * pres.height
    const n = [...slide.nodes].reverse().find((n) => sx >= n.position.x && sx <= n.position.x + n.size.w && sy >= n.position.y && sy <= n.position.y + n.size.h)
    setDraft({ x: p.x, y: p.y, shapeName: n ? label(n) : undefined })
  }

  const saveDraft = async (text: string, actNow: boolean) => {
    if (!draft) return
    let sid = slideIdStable
    if (!sid) {
      // A slide created moments ago gets its stable id when saved.
      await saveNow(key)
      sid = useDecks.getState().sessions[key]?.sldIds.get(slide.id) ?? ''
    }
    const note = await useNotes.getState().add({
      deck: session.path, slideId: sid, slideIndex: slideNo, x: draft.x, y: draft.y,
      shapeName: draft.shapeName, strokes: draft.strokes, shapes: draft.shapes, text,
    })
    setDraft(null)
    setNoteMode(false)
    if (actNow && note) await sendToAgent(actNowPrompt(note, 'slide'))
  }

  // ── overlay geometry ────────────────────────────────────────────────────
  const selRects = selection
    .map((id) => {
      const n = nodeById(id)
      if (!n) return null
      return { id, r: preview?.rects[id] ?? rectOf(n), rotation: n.rotation || 0 }
    })
    .filter(Boolean) as { id: string; r: Rect; rotation: number }[]

  return (
    <div
      ref={wrapRef}
      className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-[#e9e8e4]"
      onDragOver={(e) => { e.preventDefault(); setDropHint(true) }}
      onDragLeave={() => setDropHint(false)}
      onDrop={(e) => void onDrop(e)}
    >
      <div
        ref={stageRef}
        tabIndex={0}
        className={`relative shadow-lg outline-none ${noteMode ? 'cursor-crosshair' : ''}`}
        style={{ width: stageW, height: stageH }}
        onPointerDown={onPointerDown}
        onDoubleClick={onDoubleClick}
        onKeyDown={onKeyDown}
        onBlur={(e) => {
          if (editing && !e.currentTarget.contains(e.relatedTarget as Node)) void commitEditing()
        }}
        data-slide-stage
      >
        <SlideRender ref={renderRef} deckKey={key} pres={pres} slide={slide} version={session.slideVersions[slide.id] ?? session.version} width={stageW} />
        <div className="pointer-events-none absolute inset-0">
          {selRects.map(({ id, r, rotation }) => (
            <div
              key={id}
              data-selected-node={id}
              className={`absolute border ${editing?.nodeId === id || heldSelection.current?.nodeId === id ? 'border-dashed border-accent/70' : 'border-accent'}`}
              style={{ left: r.x * scale, top: r.y * scale, width: r.w * scale, height: r.h * scale, rotate: `${rotation}deg` }}
            >
              {selection.length === 1 && !editing && !editOff &&
                HANDLES.map((h) => (
                  <div
                    key={h}
                    data-handle={h}
                    onPointerDown={(e) => startResize(h, e)}
                    className="pointer-events-auto absolute h-2.5 w-2.5 rounded-sm border border-accent bg-white"
                    style={{
                      left: h.includes('w') ? -5 : h.includes('e') ? 'calc(100% - 5px)' : 'calc(50% - 5px)',
                      top: h.includes('n') ? -5 : h.includes('s') ? 'calc(100% - 5px)' : 'calc(50% - 5px)',
                      cursor: `${h}-resize`,
                    }}
                  />
                ))}
            </div>
          ))}
          {preview?.guides.map((g, i) =>
            g.x !== undefined ? (
              <div key={i} className="absolute top-0 h-full w-px bg-fuchsia-500" style={{ left: g.x * scale }} />
            ) : (
              <div key={i} className="absolute left-0 h-px w-full bg-fuchsia-500" style={{ top: (g.y ?? 0) * scale }} />
            ),
          )}
          {marquee && (
            <div className="absolute border border-accent bg-accent/10" style={{ left: marquee.x * scale, top: marquee.y * scale, width: marquee.w * scale, height: marquee.h * scale }} />
          )}
        </div>
        {drawing && <DrawLayer width={stageW} height={stageH} onStroke={addStroke} onTap={tapPin} />}
        <NotePins
          notes={slideNotes}
          width={stageW}
          height={stageH}
          showResolved={showResolved}
          draft={draft}
          onSaveDraft={saveDraft}
          onCancelDraft={() => setDraft(null)}
        />
      </div>
      {dropHint && <div className="pointer-events-none absolute inset-3 rounded-xl border-2 border-dashed border-accent/60 bg-accent/5" />}
    </div>
  )
}
