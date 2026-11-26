/**
 * Mini-slides rail: thumbnails of every slide. Click to view, shift/cmd-click
 * to multi-select, drag to reorder, and Duplicate / Delete / Copy / Paste
 * (buttons or ⌘D, Delete, ⌘C, ⌘V while the rail has focus). Slides the agent
 * just changed get a dot; slides with open notes show a count.
 */

import { memo, useEffect, useRef, useState } from 'react'
import { Copy, CopyPlus, ClipboardPaste, MessageSquareText, Trash2 } from 'lucide-react'
import clsx from 'clsx'
import { copyNodes, materializeSlide, type PresentationData, type SlideData } from '@diceui/pptx-core'
import { useDecks, type DeckSession } from './deckStore'
import { SlideRender } from './SlideRender'
import { getClipboard, setClipboard, type PortableSlide } from './clipboard'
import { slideTitle } from './deckModel'
import { useNotes } from '../store/notesStore'
import { useApp } from '../store/appStore'
import { requestEdit, useEditMode } from '../store/editGuard'
import { useInnerWidth } from '../components/useInnerWidth'
import type { DeckDiff, SlideDiff, SummaryLine } from './deckDiff'
import { lineItems, rowItems, rowState, type Decision, type Decisions } from './review'
import { DiffSummary, ThumbWordMarks } from './CompareView'
import type { DeckComment } from './comments'

const Thumb = memo(function Thumb(p: { deckKey: string; pres: PresentationData; slide: SlideData; version: number; width: number }) {
  return <SlideRender deckKey={p.deckKey} pres={p.pres} slide={p.slide} version={p.version} width={p.width} thumbnail />
})

/** Comparing the deck with a base version: what changed is listed beside each thumbnail. */
export interface RailCompare {
  diff: DeckDiff | null
  basePres: PresentationData | null
  /** The removed slide shown in the main view (its part in the base). */
  removed: string | null
  /** Width of the summary column (included in the rail's width). */
  summaryW: number
  onShowRemoved(oldSlide: string | null): void
  /** A summary line clicked: go to the slide (and select the line's shapes). */
  onPick(slideIndex: number, line: SummaryLine | null): void
  /** A summary line under the pointer: mark its shapes (null: none). */
  onHover(slideIndex: number, ids: string[] | null): void
  /** Reviewing: the decisions, and deciding items (the rail is read-only meanwhile). */
  review?: { decisions: Decisions; decide(keys: string[], d: Decision | null): void; header: React.ReactNode }
}

export function SlideRail({ session, width, compare, comments }: { session: DeckSession; width: number; compare?: RailCompare; comments?: Map<string, DeckComment[]> }) {
  const { apply, setSlide } = useDecks()
  const editOff = useEditMode() === 'off'
  const pres = session.pres!
  const key = session.key
  const [picked, setPicked] = useState<string[]>([])
  const [dragOver, setDragOver] = useState<number | null>(null)
  const dragIds = useRef<string[]>([])
  /** A reorder drag in progress (pointer-driven, see startDrag): what it carries and where it started. */
  const drag = useRef<{ ids: string[]; x: number; y: number; active: boolean } | null>(null)
  const [dragging, setDragging] = useState<{ count: number; x: number; y: number } | null>(null)
  /** The click that ends a drag isn't a click on the slide. */
  const suppressClick = useRef(false)
  const listRef = useRef<HTMLDivElement>(null)
  const notes = useNotes((s) => s.notes)
  const summaryW = compare?.summaryW ?? 0
  const thumbW = Math.max(60, Math.floor(useInnerWidth(listRef, width - 16) - 32 - summaryW))
  const thumbH = (thumbW * pres.height) / pres.width
  // The comparison by slide: each slide's row, and the removed slides that go after it ('' = at the top).
  const rowOf = new Map<string, SlideDiff>()
  const removedAfter = new Map<string, SlideDiff[]>()
  if (compare?.diff) {
    let last = ''
    for (const r of compare.diff.rows) {
      if (r.newSlide) {
        rowOf.set(r.newSlide, r)
        last = r.newSlide
      } else removedAfter.set(last, [...(removedAfter.get(last) ?? []), r])
    }
  }
  const maxLines = Math.max(2, Math.floor((thumbH + 2) / 13))
  // Reviewing: each summary line's (and slide's) items, their state, and deciding them.
  const review = compare?.review
  const reviewOf = (r: SlideDiff) => review && ((l: SummaryLine | { moved: true }) => {
    const items = lineItems(r, l)
    if (!items.length) return undefined
    return { state: rowState(items, review.decisions), decide: (d: Decision | null) => review.decide(items.map((i) => i.key), d) }
  })
  /** Accept / reject the whole slide: on hover, at the bottom of its summary. */
  const slideButtons = (r: SlideDiff) => {
    if (!review) return null
    const items = rowItems(r)
    if (!items.length) return null
    const st = rowState(items, review.decisions)
    const keys = items.map((i) => i.key)
    return (
      <div className="mt-0.5 hidden items-center gap-1 text-[10px] group-hover:flex" onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
        <button className={clsx('rounded border px-1 leading-[13px]', st === 'accept' ? 'border-emerald-600 bg-emerald-600 text-white' : 'border-emerald-300 bg-white text-emerald-700 hover:bg-emerald-50')} title="Accept every change on this slide" onClick={() => review.decide(keys, st === 'accept' ? null : 'accept')}>✓ Slide</button>
        <button className={clsx('rounded border px-1 leading-[13px]', st === 'reject' ? 'border-ink-3 bg-ink-3 text-white' : 'border-hair bg-white text-ink-3 hover:bg-paper')} title="Accept none of this slide's changes" onClick={() => review.decide(keys, st === 'reject' ? null : 'reject')}>✗</button>
      </div>
    )
  }
  /** A reviewed slide's thumbnail: accepted — a green ring; not accepted — greyed. */
  const thumbTone = (r: SlideDiff | undefined) => {
    if (!review || !r) return undefined
    const st = rowState(rowItems(r), review.decisions)
    return st === 'accept' ? 'accept' : st === 'reject' ? 'reject' : undefined
  }
  const removedRows = (after: string) =>
    compare?.basePres && (removedAfter.get(after) ?? []).map((r) => {
      const old = compare.basePres!.slides.find((x) => x.id === r.oldSlide)
      if (!old) return null
      const on = compare.removed === r.oldSlide
      return (
        <div
          key={`removed:${r.oldSlide}`}
          className="group flex cursor-pointer items-start gap-1.5 py-0.5"
          title="Removed — click to see it as it was"
          onClick={() => compare.onShowRemoved(on ? null : r.oldSlide!)}
        >
          <div className="w-5 shrink-0 pt-0.5 text-right text-[11px] tabular-nums text-red-400">–</div>
          <div className={clsx('relative overflow-hidden rounded-[3px] ring-offset-1', on ? 'ring-2 ring-red-500' : 'ring-1 ring-red-300 group-hover:ring-red-400', thumbTone(r) === 'accept' && 'outline outline-2 outline-emerald-500', thumbTone(r) === 'reject' && 'opacity-50')}>
            <div className="opacity-40 grayscale">
              <SlideRender deckKey={`${key}#base`} pres={compare.basePres!} slide={old} version={0} width={thumbW} thumbnail />
            </div>
            <div className="absolute inset-0 bg-red-500/10" />
          </div>
          <div style={{ width: summaryW - 8 }} className="shrink-0">
            <DiffSummary row={r} maxLines={maxLines} reviewOf={reviewOf(r)} />
            {slideButtons(r)}
          </div>
        </div>
      )
    })
  const current = pres.slides[session.slideIndex]

  // Keep the current slide in view.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-slide-index="${session.slideIndex}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [session.slideIndex])

  const selected = picked.length ? picked : current ? [current.id] : []
  const indexOf = (id: string) => pres.slides.findIndex((s) => s.id === id)
  const nums = (ids: string[]) => ids.map((id) => indexOf(id) + 1).sort((a, b) => a - b).join(', ')

  const duplicate = async () => {
    for (const id of [...selected].sort((a, b) => indexOf(b) - indexOf(a))) {
      const n = indexOf(id) + 1
      await apply(key, { type: 'duplicateSlide', slideId: id }, `Duplicated slide ${n} (the copy is slide ${n + 1})`)
    }
    setPicked([])
  }
  const remove = async () => {
    if (selected.length >= pres.slides.length) return useApp.getState().toast('A deck needs at least one slide.')
    const titles = selected.map((id) => `${indexOf(id) + 1} ("${slideTitle(pres.slides[indexOf(id)])}")`).join(', ')
    await apply(
      key,
      selected.length === 1 ? { type: 'deleteSlide', slideId: selected[0] } : { type: 'batch', operations: selected.map((id) => ({ type: 'deleteSlide' as const, slideId: id })) },
      `Deleted slide${selected.length > 1 ? 's' : ''} ${titles}`,
    )
    setPicked([])
    setSlide(key, Math.min(session.slideIndex, pres.slides.length - 1))
  }
  const copy = async () => {
    const ids = [...selected].sort((a, b) => indexOf(a) - indexOf(b))
    // A self-contained copy of each slide (shapes + the images they use), so
    // it can also be pasted into ANOTHER deck.
    const portable: PortableSlide[] = []
    let omitted = 0
    for (const id of ids) {
      const slide = pres.slides[indexOf(id)]
      materializeSlide(pres, slide)
      const nodes = await copyNodes(pres, slide.id, slide.nodes.map((n) => n.id))
      omitted += nodes.omittedNodeIds.length
      portable.push({ title: slideTitle(slide), layoutName: pres.layouts.get(slide.layoutIndex)?.name, nodes })
    }
    setClipboard({ kind: 'slides', deckKey: key, deckName: session.path.split('/').pop() ?? session.path, slideIds: ids, portable, width: pres.width, height: pres.height })
    useApp.getState().toast(
      `Copied slide${ids.length > 1 ? 's' : ''} ${nums(ids)} — paste with ⌘V here or in another deck's slide list` +
        (omitted ? ` (${omitted} chart/diagram shape${omitted > 1 ? 's' : ''} can only be pasted within this deck)` : ''),
    )
  }

  /**
   * Paste slides copied from ANOTHER deck, PowerPoint "use destination theme"
   * style: each becomes a new slide on the target's layout of the same name
   * (or the current slide's layout), its empty layout placeholders are
   * cleared, and the source slide's shapes and images are pasted onto it.
   * One undo step for the whole paste.
   */
  const pasteFromOtherDeck = async (c: Extract<NonNullable<ReturnType<typeof getClipboard>>, { kind: 'slides' }>) => {
    const anchor = pres.slides[session.slideIndex]
    if (!anchor) return
    const layoutByName = new Map([...pres.layouts.entries()].map(([id, l]) => [l.name ?? '', id]))
    const n = c.portable.length
    const created = await useDecks.getState().transaction(
      key,
      `Pasted ${n} slide${n > 1 ? 's' : ''} from "${c.deckName}" (${c.portable.map((p) => `"${p.title}"`).join(', ')}) after slide ${session.slideIndex + 1}`,
      // The anchor comes in as a slide id at (re)apply time — edits made while the agent works are replayed onto its version.
      async (run, p, [anchorId]) => {
        const ids: string[] = []
        let after = anchorId
        for (const src of c.portable) {
          const layoutId = (src.layoutName && layoutByName.get(src.layoutName)) || anchor.layoutIndex
          const added = await run({ type: 'addSlide', layoutId, afterSlideId: after })
          const sid = added.createdSlideId!
          const slide = p.slides.find((x) => x.id === sid)!
          materializeSlide(p, slide)
          if (slide.nodes.length) {
            await run({ type: 'batch', operations: slide.nodes.map((nd) => ({ type: 'deleteNode' as const, slideId: sid, nodeId: nd.id })) })
          }
          if (src.nodes.nodes.length) await run({ type: 'pasteNodes', slideId: sid, clipboard: src.nodes, offset: { x: 0, y: 0 } })
          ids.push(sid)
          after = sid
        }
        return ids
      },
      [anchor.id],
    )
    if (created?.length) {
      setSlide(key, session.slideIndex + 1)
      const sizeNote = Math.abs(c.width / c.height - pres.width / pres.height) > 0.01 ? ' The decks have different slide sizes — check positions.' : ''
      useApp.getState().toast(`Pasted ${created.length} slide${created.length > 1 ? 's' : ''} from ${c.deckName} using this deck's layouts.${sizeNote}`)
    }
  }

  const paste = async () => {
    const c = getClipboard()
    if (!c || c.kind !== 'slides') return
    if (c.deckKey !== key) return pasteFromOtherDeck(c)
    let at = session.slideIndex + 1
    for (const id of c.slideIds) {
      if (indexOf(id) < 0) continue
      const created = await apply(key, { type: 'duplicateSlide', slideId: id }, `Pasted a copy of slide ${indexOf(id) + 1}`)
      const newId = created?.[0]
      if (!newId) continue
      const s = useDecks.getState().sessions[key]
      const from = s?.pres?.slides.findIndex((x) => x.id === newId) ?? -1
      if (from >= 0 && from !== at) await apply(key, { type: 'moveSlide', slideId: newId, toIndex: at }, `Moved the pasted slide to position ${at + 1}`)
      at++
    }
    setSlide(key, session.slideIndex + 1)
  }

  const onDrop = async (toIndex: number) => {
    setDragOver(null)
    const ids = dragIds.current
    dragIds.current = []
    if (!ids.length) return
    // Move in order so the block lands contiguously at toIndex.
    let target = toIndex
    const ordered = [...ids].sort((a, b) => indexOf(a) - indexOf(b))
    for (const id of ordered) {
      const from = indexOf(id)
      const dest = from < target ? target - 1 : target
      if (from !== dest) {
        await apply(key, { type: 'moveSlide', slideId: id, toIndex: dest }, `Moved slide ${from + 1} to position ${dest + 1}`)
      }
      target = dest + 1
    }
    const s = useDecks.getState().sessions[key]
    const first = s?.pres?.slides.findIndex((x) => x.id === ordered[0]) ?? 0
    setSlide(key, first)
  }

  /** Where a drop at `clientY` lands: before the row whose upper half it's in, else after the last. */
  const targetAt = (clientY: number): number => {
    const rows = [...(listRef.current?.querySelectorAll<HTMLElement>('[data-slide-row]') ?? [])]
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i].getBoundingClientRect()
      if (clientY < r.top + r.height / 2) return i
    }
    return rows.length
  }

  /**
   * Reorder by dragging, tracked with pointer events rather than HTML drag-and-drop: in the
   * desktop app's web view (WebKit) a drag started over a thumbnail picks up the slide's own
   * pictures instead, and the drop never reaches the rail. A press that moves 5 px becomes a drag.
   */
  const startDrag = (e: React.PointerEvent, ids: string[]) => {
    if (e.button !== 0 || compare?.review) return // (read-only while reviewing)
    // A drag that ended over another row got no click, so its "swallow the next click" is stale.
    suppressClick.current = false
    drag.current = { ids, x: e.clientX, y: e.clientY, active: false }
    const move = (ev: PointerEvent) => {
      const d = drag.current
      if (!d) return
      if (!d.active) {
        if (Math.hypot(ev.clientX - d.x, ev.clientY - d.y) < 5) return
        // Reordering changes the file: only with editing on (else the press stays a click).
        if (!requestEdit()) {
          drag.current = null
          return
        }
        d.active = true
        dragIds.current = d.ids
        document.body.style.cursor = 'grabbing'
      }
      setDragging({ count: d.ids.length, x: ev.clientX, y: ev.clientY })
      setDragOver(targetAt(ev.clientY))
      // Scroll the rail when dragging near its top or bottom edge.
      const list = listRef.current
      if (list) {
        const r = list.getBoundingClientRect()
        if (ev.clientY < r.top + 30) list.scrollTop -= 14
        else if (ev.clientY > r.bottom - 30) list.scrollTop += 14
      }
    }
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      const d = drag.current
      drag.current = null
      setDragging(null)
      document.body.style.cursor = ''
      if (d?.active && ev.type === 'pointerup') {
        suppressClick.current = true
        void onDrop(targetAt(ev.clientY))
      } else {
        setDragOver(null)
        dragIds.current = []
      }
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    const mod = e.metaKey || e.ctrlKey
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') { e.preventDefault(); setPicked([]); setSlide(key, session.slideIndex + 1) }
    else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') { e.preventDefault(); setPicked([]); setSlide(key, session.slideIndex - 1) }
    // Read-only while reviewing: moving through slides and copying only.
    if (compare?.review && !(/^Arrow/.test(e.key) || (mod && e.key === 'c'))) return
    if (mod && e.key === 'd') { e.preventDefault(); void duplicate() }
    else if (mod && e.key === 'c') { e.preventDefault(); void copy() }
    else if (mod && e.key === 'v') { e.preventDefault(); void paste() }
    else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); void remove() }
  }

  return (
    // Keeps its width (the thumbnails are sized from it), so they never hang out of the rail.
    <div className="flex h-full min-h-0 shrink-0 flex-col bg-paper" style={{ width }}>
      <div ref={listRef} tabIndex={0} onKeyDown={onKeyDown} className="min-h-0 flex-1 select-none overflow-y-auto px-2 py-2 outline-none [scrollbar-gutter:stable]">
        {review?.header}
        {compare?.diff && compare.diff.deck.length > 0 && (
          <div className="mb-1.5 rounded border border-amber-200 bg-amber-50 px-1.5 py-1 text-[10px] leading-[13px] text-amber-900" title="Changes to the whole deck">
            {compare.diff.deck.join(' · ')}
          </div>
        )}
        {removedRows('')}
        {pres.slides.map((slide, i) => {
          const sid = session.sldIds.get(slide.id) ?? ''
          const openNotes = notes.filter((n) => n.deck === session.path && n.status === 'open' && (sid ? n.slideId === sid : n.slideIndex === i + 1)).length
          const isCurrent = i === session.slideIndex
          const isPicked = picked.includes(slide.id)
          const changed = sid && session.externallyChanged.includes(sid)
          const diffRow = rowOf.get(slide.id)
          return (
            <div key={slide.id} data-slide-index={i}>
              <div className={clsx('mx-1 h-1 rounded', dragOver === i ? 'bg-accent' : 'bg-transparent')} />
              <div
                data-slide-row
                onPointerDown={(e) => startDrag(e, isPicked ? picked : [slide.id])}
                // No native drags from the rail (the thumbnails' pictures would be dragged instead).
                onDragStart={(e) => e.preventDefault()}
                onClick={(e) => {
                  if (suppressClick.current) {
                    suppressClick.current = false
                    return
                  }
                  if (e.shiftKey && current) {
                    const a = Math.min(session.slideIndex, i), b = Math.max(session.slideIndex, i)
                    setPicked(pres.slides.slice(a, b + 1).map((s) => s.id))
                  } else if (e.metaKey || e.ctrlKey) {
                    const base = picked.length ? picked : current ? [current.id] : []
                    setPicked(base.includes(slide.id) ? base.filter((x) => x !== slide.id) : [...base, slide.id])
                  } else {
                    setPicked([])
                    setSlide(key, i)
                    compare?.onShowRemoved(null)
                  }
                }}
                className="group flex cursor-pointer items-start gap-1.5 py-0.5"
              >
                <div className="w-5 shrink-0 pt-0.5 text-right text-[11px] tabular-nums text-ink-3">{i + 1}</div>
                <div
                  className={clsx(
                    'relative overflow-hidden rounded-[3px] ring-offset-1',
                    isCurrent && !compare?.removed ? 'ring-2 ring-accent' : isPicked ? 'ring-2 ring-accent/50' : 'ring-1 ring-hair group-hover:ring-ink-3',
                    thumbTone(diffRow) === 'accept' && 'outline outline-2 outline-offset-1 outline-emerald-500',
                    thumbTone(diffRow) === 'reject' && 'opacity-45 grayscale',
                    // Reviewing: a slide with nothing to decide steps back (half faded, colors kept).
                    review && diffRow?.status === 'same' && 'opacity-50',
                  )}
                >
                  {diffRow && diffRow.status !== 'same' && (
                    <div className={clsx('absolute inset-y-0 left-0 z-[1] w-[3px]', diffRow.status === 'added' ? 'bg-emerald-500' : diffRow.lines.length || diffRow.shapes.length ? 'bg-amber-500' : 'bg-sky-500')} />
                  )}
                  <Thumb deckKey={key} pres={pres} slide={slide} version={session.slideVersions[slide.id] ?? 0} width={thumbW} />
                  {diffRow?.shapes.some((x) => x.text) && <ThumbWordMarks shapes={diffRow.shapes} width={thumbW} />}
                  {openNotes > 0 && (
                    <div className="absolute right-1 top-1 rounded-full bg-note px-1.5 text-[10px] font-bold text-amber-950 shadow" title={`${openNotes} open note(s)`}>
                      {openNotes}
                    </div>
                  )}
                  {changed && <div className="absolute left-1 top-1 h-2.5 w-2.5 rounded-full bg-violet-500 ring-2 ring-white" title="Changed by the agent" />}
                  {/* Review comments on the slide (shown on the slide with the toolbar's Comments toggle). */}
                  {(comments?.get(slide.id)?.length ?? 0) > 0 && (
                    <div className="absolute bottom-1 right-1 flex items-center gap-0.5 rounded-full bg-sky-600 px-1 text-[9px] font-bold leading-[14px] text-white shadow" title={`${comments!.get(slide.id)!.length} review comment(s)`}>
                      <MessageSquareText size={9} /> {comments!.get(slide.id)!.length}
                    </div>
                  )}
                </div>
                {compare && (
                  <div style={{ width: summaryW - 8 }} className="shrink-0">
                    {compare.diff ? <DiffSummary row={diffRow} maxLines={maxLines} onPick={(l) => compare.onPick(i, l)} onHover={(ids) => compare.onHover(i, ids)} reviewOf={diffRow && reviewOf(diffRow)} /> : null}
                    {diffRow && slideButtons(diffRow)}
                  </div>
                )}
              </div>
              {removedRows(slide.id)}
            </div>
          )
        })}
        <div className={clsx('mx-1 h-6 rounded', dragOver === pres.slides.length ? 'border-t-4 border-accent' : '')} />
      </div>
      {dragging && (
        <div className="pointer-events-none fixed z-50 rounded bg-accent px-2 py-0.5 text-xs font-medium text-white shadow-lg" style={{ left: dragging.x + 14, top: dragging.y + 10 }}>
          {dragging.count} slide{dragging.count > 1 ? 's' : ''}
        </div>
      )}
      <div className="flex items-center justify-center gap-0.5 border-t border-hair px-1 py-1">
        {editOff || compare?.review ? (
          <button className="icon-btn" title="Copy slides (⌘C) — paste into another deck" onClick={() => void copy()}><Copy size={15} /></button>
        ) : (
          <>
            <button className="icon-btn" title="Duplicate (⌘D)" onClick={() => void duplicate()}><CopyPlus size={15} /></button>
            <button className="icon-btn" title="Copy slides (⌘C) — paste into this deck or another one" onClick={() => void copy()}><Copy size={15} /></button>
            <button className="icon-btn" title="Paste slides after the current one (⌘V) — also from another deck" disabled={getClipboard()?.kind !== 'slides'} onClick={() => void paste()}><ClipboardPaste size={15} /></button>
            <button className="icon-btn" title="Delete (⌫)" onClick={() => void remove()}><Trash2 size={15} /></button>
          </>
        )}
        {picked.length > 1 && <span className="ml-1 text-[11px] text-ink-3">{picked.length} selected</span>}
      </div>
    </div>
  )
}
