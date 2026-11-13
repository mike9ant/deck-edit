/**
 * Mini-slides rail: thumbnails of every slide. Click to view, shift/cmd-click
 * to multi-select, drag to reorder, and Duplicate / Delete / Copy / Paste
 * (buttons or ⌘D, Delete, ⌘C, ⌘V while the rail has focus). Slides the agent
 * just changed get a dot; slides with open notes show a count.
 */

import { memo, useEffect, useRef, useState } from 'react'
import { Copy, CopyPlus, ClipboardPaste, Trash2 } from 'lucide-react'
import clsx from 'clsx'
import type { PresentationData, SlideData } from '@diceui/pptx-core'
import { useDecks, type DeckSession, isProjectBusy } from './deckStore'
import { SlideRender } from './SlideRender'
import { getClipboard, setClipboard } from './clipboard'
import { slideTitle } from './deckModel'
import { useNotes } from '../store/notesStore'
import { useApp } from '../store/appStore'

const Thumb = memo(function Thumb(p: { deckKey: string; pres: PresentationData; slide: SlideData; version: number; width: number }) {
  return <SlideRender deckKey={p.deckKey} pres={p.pres} slide={p.slide} version={p.version} width={p.width} thumbnail />
})

export function SlideRail({ session, width }: { session: DeckSession; width: number }) {
  const { apply, setSlide } = useDecks()
  const pres = session.pres!
  const key = session.key
  const [picked, setPicked] = useState<string[]>([])
  const [dragOver, setDragOver] = useState<number | null>(null)
  const dragIds = useRef<string[]>([])
  const listRef = useRef<HTMLDivElement>(null)
  const notes = useNotes((s) => s.notes)
  const busy = isProjectBusy(session.pid)
  const thumbW = Math.max(80, width - 44)
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
  const copy = () => {
    setClipboard({ kind: 'slides', deckKey: key, slideIds: [...selected].sort((a, b) => indexOf(a) - indexOf(b)) })
    useApp.getState().toast(`Copied slide${selected.length > 1 ? 's' : ''} ${nums(selected)}`)
  }
  const paste = async () => {
    const c = getClipboard()
    if (!c || c.kind !== 'slides') return
    if (c.deckKey !== key) return useApp.getState().toast('Pasting slides into a different deck isn’t supported yet — copy shapes instead.')
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
    if (!ids.length || busy) return
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

  const onKeyDown = (e: React.KeyboardEvent) => {
    const mod = e.metaKey || e.ctrlKey
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') { e.preventDefault(); setPicked([]); setSlide(key, session.slideIndex + 1) }
    else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') { e.preventDefault(); setPicked([]); setSlide(key, session.slideIndex - 1) }
    if (busy) return
    if (mod && e.key === 'd') { e.preventDefault(); void duplicate() }
    else if (mod && e.key === 'c') { e.preventDefault(); copy() }
    else if (mod && e.key === 'v') { e.preventDefault(); void paste() }
    else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); void remove() }
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-paper" style={{ width }}>
      <div ref={listRef} tabIndex={0} onKeyDown={onKeyDown} className="min-h-0 flex-1 overflow-y-auto px-2 py-2 outline-none">
        {pres.slides.map((slide, i) => {
          const sid = session.sldIds.get(slide.id) ?? ''
          const openNotes = notes.filter((n) => n.deck === session.path && n.status === 'open' && (sid ? n.slideId === sid : n.slideIndex === i + 1)).length
          const isCurrent = i === session.slideIndex
          const isPicked = picked.includes(slide.id)
          const changed = sid && session.externallyChanged.includes(sid)
          return (
            <div key={slide.id} data-slide-index={i}>
              <div className={clsx('mx-1 h-1 rounded', dragOver === i ? 'bg-accent' : 'bg-transparent')} />
              <div
                draggable={!busy}
                onDragStart={(e) => {
                  dragIds.current = isPicked ? picked : [slide.id]
                  e.dataTransfer.effectAllowed = 'move'
                  e.dataTransfer.setData('text/plain', 'slides')
                }}
                onDragOver={(e) => {
                  if (!dragIds.current.length) return
                  e.preventDefault()
                  const r = e.currentTarget.getBoundingClientRect()
                  setDragOver(e.clientY < r.top + r.height / 2 ? i : i + 1)
                }}
                onDrop={(e) => { e.preventDefault(); if (dragOver !== null) void onDrop(dragOver) }}
                onDragEnd={() => setDragOver(null)}
                onClick={(e) => {
                  if (e.shiftKey && current) {
                    const a = Math.min(session.slideIndex, i), b = Math.max(session.slideIndex, i)
                    setPicked(pres.slides.slice(a, b + 1).map((s) => s.id))
                  } else if (e.metaKey || e.ctrlKey) {
                    const base = picked.length ? picked : current ? [current.id] : []
                    setPicked(base.includes(slide.id) ? base.filter((x) => x !== slide.id) : [...base, slide.id])
                  } else {
                    setPicked([])
                    setSlide(key, i)
                  }
                }}
                className="group flex cursor-pointer items-start gap-1.5 py-0.5"
              >
                <div className="w-5 shrink-0 pt-0.5 text-right text-[11px] tabular-nums text-ink-3">{i + 1}</div>
                <div
                  className={clsx(
                    'relative overflow-hidden rounded-[3px] ring-offset-1',
                    isCurrent ? 'ring-2 ring-accent' : isPicked ? 'ring-2 ring-accent/50' : 'ring-1 ring-hair group-hover:ring-ink-3',
                  )}
                >
                  <Thumb deckKey={key} pres={pres} slide={slide} version={session.slideVersions[slide.id] ?? 0} width={thumbW} />
                  {openNotes > 0 && (
                    <div className="absolute right-1 top-1 rounded-full bg-note px-1.5 text-[10px] font-bold text-amber-950 shadow" title={`${openNotes} open note(s)`}>
                      {openNotes}
                    </div>
                  )}
                  {changed && <div className="absolute left-1 top-1 h-2.5 w-2.5 rounded-full bg-violet-500 ring-2 ring-white" title="Changed by the agent" />}
                </div>
              </div>
            </div>
          )
        })}
        <div
          className={clsx('mx-1 h-6 rounded', dragOver === pres.slides.length ? 'border-t-4 border-accent' : '')}
          onDragOver={(e) => { if (dragIds.current.length) { e.preventDefault(); setDragOver(pres.slides.length) } }}
          onDrop={(e) => { e.preventDefault(); void onDrop(pres.slides.length) }}
        />
      </div>
      <div className="flex items-center justify-center gap-0.5 border-t border-hair px-1 py-1">
        <button className="icon-btn" title="Duplicate (⌘D)" disabled={busy} onClick={() => void duplicate()}><CopyPlus size={15} /></button>
        <button className="icon-btn" title="Copy (⌘C)" onClick={copy}><Copy size={15} /></button>
        <button className="icon-btn" title="Paste after current (⌘V)" disabled={busy || getClipboard()?.kind !== 'slides'} onClick={() => void paste()}><ClipboardPaste size={15} /></button>
        <button className="icon-btn" title="Delete (⌫)" disabled={busy} onClick={() => void remove()}><Trash2 size={15} /></button>
        {picked.length > 1 && <span className="ml-1 text-[11px] text-ink-3">{picked.length} selected</span>}
      </div>
    </div>
  )
}
