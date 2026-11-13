/**
 * Speaker notes under the slide: a collapsible, resizable, editable panel.
 * Typing saves into the slide's notes page (debounced, and on blur) — an
 * undoable deck edit the agent is told about like any other. The panel's
 * open state and height persist.
 */

import { useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, Loader2 } from 'lucide-react'
import type { SlideData } from '@diceui/pptx-core'
import { useDecks, type DeckSession, isProjectBusy } from './deckStore'
import { readNotes, writeNotes } from './speakerNotes'
import { short } from './deckModel'

const LS_OPEN = 'pdfedit-notes-open'
const LS_HEIGHT = 'pdfedit-notes-height'
const SAVE_MS = 900

export function NotesPane({ session }: { session: DeckSession }) {
  const pres = session.pres!
  const slide: SlideData | undefined = pres.slides[session.slideIndex]
  const [open, setOpen] = useState(() => localStorage.getItem(LS_OPEN) !== '0')
  const [height, setHeight] = useState(() => Number(localStorage.getItem(LS_HEIGHT)) || 130)
  const [text, setText] = useState('')
  const [loaded, setLoaded] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const saved = useRef('')
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const area = useRef<HTMLTextAreaElement>(null)
  const busy = isProjectBusy(session.pid)
  const slideNo = session.slideIndex + 1

  // Load the notes when the slide changes or the deck reloads — but never
  // overwrite what's being typed.
  useEffect(() => {
    if (!slide) return
    let live = true
    void readNotes(pres, slide).then((t) => {
      if (!live) return
      if (document.activeElement === area.current && loaded === slide.id) return
      saved.current = t
      setText(t)
      setLoaded(slide.id)
    })
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pres, slide?.id, session.version])

  const save = async (value: string) => {
    clearTimeout(timer.current)
    if (!slide || value === saved.current) return
    setSaving(true)
    const before = saved.current
    const ok = await useDecks.getState().applyCustom(
      session.key,
      value.trim()
        ? `Slide ${slideNo}: edited the speaker notes${before.trim() ? '' : ' (new)'}: "${short(value, 160)}"`
        : `Slide ${slideNo}: cleared the speaker notes`,
      () => writeNotes(pres, slide, value),
      `notes:${slide.id}`,
    )
    if (ok) saved.current = value
    setSaving(false)
  }

  const onChange = (v: string) => {
    setText(v)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => void save(v), SAVE_MS)
  }

  const toggle = () => {
    setOpen(!open)
    localStorage.setItem(LS_OPEN, open ? '0' : '1')
  }

  const startResize = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    const startY = e.clientY
    const startH = height
    const el = e.currentTarget
    el.setPointerCapture(e.pointerId)
    const move = (ev: PointerEvent) => setHeight(Math.max(60, Math.min(480, startH - (ev.clientY - startY))))
    const up = () => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      setHeight((h) => {
        localStorage.setItem(LS_HEIGHT, String(h))
        return h
      })
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
  }

  const preview = text.trim() ? short(text, 110) : 'No speaker notes'

  return (
    <div className="shrink-0 border-t border-hair bg-panel">
      {open && <div className="h-1 cursor-row-resize hover:bg-accent/20" onPointerDown={startResize} title="Drag to resize" />}
      <button className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-xs text-ink-2 hover:bg-paper" onClick={toggle}>
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <span className="font-medium">Speaker notes</span>
        <span className="text-ink-3">· slide {slideNo}</span>
        {!open && <span className="ml-2 truncate text-ink-3">{preview}</span>}
        {saving && <Loader2 size={12} className="ml-auto animate-spin text-ink-3" />}
      </button>
      {open && (
        <textarea
          ref={area}
          className="block w-full resize-none border-0 bg-white px-4 py-2 text-[13px] leading-relaxed text-ink outline-none placeholder:text-ink-3 disabled:bg-paper"
          style={{ height }}
          placeholder={busy ? 'The agent is working — notes are read-only until its turn ends.' : 'Click to add speaker notes'}
          value={text}
          disabled={busy || !slide}
          onChange={(e) => onChange(e.target.value)}
          onBlur={() => void save(text)}
          onKeyDown={(e) => e.stopPropagation()}
        />
      )}
    </div>
  )
}
