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
import type { Stroke } from '../api/types'
import { notesForSlide, useNotes } from '../store/notesStore'
import { useApp } from '../store/appStore'
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
}

export interface SlideActions {
  addTextBox(): void
  align(kind: AlignKind): void
  /** Bring the selected shapes to the front / forward one step, or send them backward / to the back. */
  arrange(order: NodeOrder): void
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

export function SlideEditor({ session, noteMode, setNoteMode, showResolved, registerActions }: Props) {
  const { apply, setSelection, saveNow } = useDecks()
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

  // Leave text editing / drafts when the slide changes underneath.
  useEffect(() => {
    setEditing(null)
    setDraft(null)
  }, [slide.id, session.version])

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
    const n = nodeById(nodeId)
    const el = nodeEl(nodeId)
    if (!n || !el || n.nodeType !== 'shape') return
    const container = textContainer(el)
    if (!container) return
    setSelection(key, [nodeId])
    beginEditing(container, at)
    setEditing({ nodeId, container, before: nodeText(n) })
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
    if (id) startEditing(id, { x: e.clientX, y: e.clientY })
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
    void run(ops.length === 1 ? ops[0] : { type: 'batch', operations: ops },
      `Slide ${slideNo}: moved ${nodes.map((n) => `"${label(n)}"`).join(', ')}`, `move:${slide.id}:${selection.join(',')}`)
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
      e.stopPropagation()
      return
    }
    const mod = e.metaKey || e.ctrlKey
    if (e.key === 'Escape') { setSelection(key, []); setNoteMode(false); setDraft(null); return }
    if ((e.key === 'Delete' || e.key === 'Backspace') && selection.length) { e.preventDefault(); void deleteSelection(); return }
    if (mod && e.key === 'c' && selection.length) { e.preventDefault(); void copySelection(); return }
    if (mod && e.key === 'x' && selection.length) { e.preventDefault(); void copySelection().then(deleteSelection); return }
    if (mod && e.key === 'v' && getClipboard()?.kind === 'nodes') { e.preventDefault(); void paste(); return }
    if (mod && e.key === 'd') { e.preventDefault(); void duplicateSelection(); return }
    if (mod && e.key === 'a') { e.preventDefault(); setSelection(key, slide.nodes.map((n) => n.id)); return }
    if (e.key === 'Enter' && selection.length === 1) { e.preventDefault(); startEditing(selection[0]); return }
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
              className={`absolute border ${editing?.nodeId === id ? 'border-dashed border-accent/70' : 'border-accent'}`}
              style={{ left: r.x * scale, top: r.y * scale, width: r.w * scale, height: r.h * scale, rotate: `${rotation}deg` }}
            >
              {selection.length === 1 && !editing &&
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
