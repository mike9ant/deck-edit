/**
 * Sticky notes pinned on a slide/page: numbered pins at their saved position,
 * a popover to read/edit/resolve/delete, and a draft popover when the user
 * places a new note (in "add note" mode). A drawn note (see NoteDrawing) also
 * shows its freehand mark. Notes go to the agent with every turn; the agent
 * resolves them through its tools.
 */

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, GripHorizontal, MessageSquarePlus, RotateCcw, Trash2, X, Zap } from 'lucide-react'
import clsx from 'clsx'
import type { Note, Stroke } from '../api/types'
import { noteNumber, useNotes } from '../store/notesStore'
import { useChat } from '../store/chatStore'
import { NOTE_COLORS, StrokesSvg, pinNearMark } from './NoteDrawing'

export interface NoteDraft {
  x: number
  y: number
  shapeName?: string
  /** A drawn note: the strokes so far (more can be added while the popover is open). */
  strokes?: Stroke[]
  /** Shapes the drawn mark covers. */
  shapes?: string[]
  /** A note on selected text (PDF): the text. */
  quote?: string
}

interface Props {
  /** Space a bubble may use past the right edge (a PDF page has grey margin beside it). */
  roomRight?: number
  notes: Note[]
  /** Stage size in screen px. */
  width: number
  height: number
  showResolved: boolean
  draft: NoteDraft | null
  /** Pin the drafted note; `actNow`: also ask the agent to handle it right away. */
  onSaveDraft(text: string, actNow: boolean): Promise<void>
  onCancelDraft(): void
}

export function NotePins({ notes, width, height, showResolved, draft, onSaveDraft, onCancelDraft, roomRight = 0 }: Props) {
  const [openId, setOpenId] = useState<string | null>(null)
  const allNotes = useNotes((s) => s.notes)
  const visible = notes.filter((n) => showResolved || n.status === 'open')
  // Open popovers toward the side with room (they're ~290 px wide, ≤ ~260 px tall).
  const flipX = (x: number) => x * width + 300 > width && x * width > 300
  const flipY = (y: number) => y * height + 270 > height && y * height > 270
  const color = (n: Note) => (n.status === 'resolved' ? NOTE_COLORS.resolved : n.author === 'agent' ? NOTE_COLORS.agent : NOTE_COLORS.user)
  // A drawn note's pin sits just outside the mark (see pinNearMark); a pinned one where it was put.
  const anchorOf = (n: { x: number; y: number; strokes?: Stroke[] }) => (n.strokes?.length ? pinNearMark(n.strokes, width, height) : { x: n.x, y: n.y })
  /**
   * Where a note's bubble goes and which way it opens. It opens to the right of its spot; when it
   * wouldn't fit there, a drawn note's bubble moves to the mark's top-left corner (same rule,
   * opening left), a pinned note's opens to the left of its pin.
   */
  const placeOf = (n: Note, chars: number): { at: { x: number; y: number }; leftward: boolean } => {
    const est = Math.min(PIN_MAX_W, 24 + chars * 5.6) // the bubble's width, near enough
    const right = anchorOf(n)
    if (right.x * width + est <= width + roomRight) return { at: right, leftward: false }
    if (n.strokes?.length) {
      const left = pinNearMark(n.strokes, width, height, 'tl')
      if (left.x * width - est >= 0 || left.x * width > width - right.x * width) return { at: left, leftward: true }
    }
    return { at: right, leftward: true }
  }
  return (
    <div className="pointer-events-none absolute inset-0" style={{ width, height }}>
      {visible.map((n) =>
        n.strokes?.length ? (
          <StrokesSvg
            key={`s-${n.id}`}
            strokes={n.strokes}
            width={width}
            height={height}
            color={color(n)}
            strokeWidth={openId === n.id ? 4.5 : 3}
            opacity={n.status === 'resolved' ? 0.5 : openId && openId !== n.id ? 0.45 : 0.9}
          />
        ) : null,
      )}
      {draft?.strokes?.length ? <StrokesSvg strokes={draft.strokes} width={width} height={height} color={NOTE_COLORS.user} /> : null}
      {visible.map((n) => {
        const tag = n.author === 'agent' ? 'AI' : String(noteNumber(n, allNotes))
        const snippet = n.status === 'resolved' ? '' : shortText(n.text, PIN_CHARS - tag.length - 1)
        // The bubble's tail marks the spot.
        const { at, leftward } = placeOf(n, tag.length + 1 + snippet.length)
        return (
          <div key={n.id} className="absolute" style={{ left: at.x * width, top: at.y * height }}>
            <button
              className={clsx(
                'pointer-events-auto absolute bottom-0 flex min-h-6 w-max min-w-6 max-w-[156px] items-center gap-1 rounded-xl border px-1.5 py-[3px] text-left shadow-md',
                leftward ? 'right-0 rounded-br-none' : 'left-0 rounded-bl-none',
                n.status === 'resolved'
                  ? 'items-center justify-center border-emerald-300 bg-emerald-50 text-emerald-700 opacity-70'
                  : n.author === 'agent'
                    ? 'border-violet-300 bg-violet-100 text-violet-800'
                    : 'border-amber-400 bg-note text-amber-950',
              )}
              title={n.text}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation()
                setOpenId(openId === n.id ? null : n.id)
              }}
            >
              {n.status === 'resolved' ? <Check size={12} /> : (
                <>
                  <span className="shrink-0 text-[11px] font-semibold leading-[13px]">{tag}</span>
                  {snippet && <span className="line-clamp-2 break-words text-[10px] font-medium leading-[13px]">{snippet}</span>}
                </>
              )}
            </button>
            {openId === n.id && <NotePopover note={n} onClose={() => setOpenId(null)} flipX={flipX(at.x)} flipY={flipY(at.y)} />}
          </div>
        )
      })}
      {draft && (
        <div className="absolute" style={{ left: anchorOf(draft).x * width, top: anchorOf(draft).y * height }}>
          <div className="-translate-x-1/2 -translate-y-full flex h-6 w-6 items-center justify-center rounded-full rounded-bl-none border border-amber-400 bg-note shadow-md">
            <MessageSquarePlus size={12} />
          </div>
          <DraftPopover draft={draft} onSave={onSaveDraft} onCancel={onCancelDraft} flipX={flipX(draft.x)} flipY={flipY(draft.y)} />
        </div>
      )}
    </div>
  )
}

/**
 * Drag a popover by its header. The offset is kept while it stays open; it
 * can't be dragged out of the visible editing area (the nearest clipping ancestor).
 */
function useDraggable() {
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const onPointerDown = (e: React.PointerEvent<HTMLElement>) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('button')) return
    const pop = e.currentTarget.closest<HTMLElement>('[data-note-popover]')
    if (!pop) return
    e.preventDefault()
    let clip: HTMLElement | null = pop.parentElement
    while (clip && getComputedStyle(clip).overflow === 'visible') clip = clip.parentElement
    const bounds = (clip ?? document.body).getBoundingClientRect()
    const start = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y }
    const r0 = pop.getBoundingClientRect()
    const move = (ev: PointerEvent) => {
      // Keep the whole box inside the visible area.
      const dx = Math.min(Math.max(ev.clientX - start.x, bounds.left - r0.left), bounds.right - r0.right)
      const dy = Math.min(Math.max(ev.clientY - start.y, bounds.top - r0.top), bounds.bottom - r0.bottom)
      setOffset({ x: start.ox + dx, y: start.oy + dy })
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  return { style: { translate: `${offset.x}px ${offset.y}px` }, handle: { onPointerDown, className: 'cursor-move select-none' } }
}

const Grip = () => <GripHorizontal size={14} className="shrink-0 text-ink-3/60" aria-label="Drag to move" />

function popoverPos(flipX: boolean, flipY: boolean) {
  return clsx('pointer-events-auto absolute z-30 w-72 rounded-lg border border-hair bg-white p-3 text-sm shadow-xl', flipX ? 'right-2' : 'left-2', flipY ? 'bottom-8' : 'top-2')
}

function DraftPopover({ draft, onSave, onCancel, flipX, flipY }: { draft: NoteDraft; onSave(t: string, actNow: boolean): Promise<void>; onCancel(): void; flipX: boolean; flipY: boolean }) {
  const agentBusy = useChat((s) => !!s.pid && !!s.busyProjects[s.pid])
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const ref = useRef<HTMLTextAreaElement>(null)
  // Back to the text after each stroke, so drawing then typing just works.
  useEffect(() => ref.current?.focus(), [draft.strokes?.length])
  const drag = useDraggable()
  const save = async (actNow = false) => {
    if (!text.trim() || (actNow && agentBusy)) return
    setBusy(true)
    await onSave(text.trim(), actNow)
    setBusy(false)
  }
  return (
    <div data-note-popover className={popoverPos(flipX, flipY)} style={drag.style} onPointerDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      <div {...drag.handle} className={clsx('-mx-3 -mt-3 mb-1 flex items-center gap-2 rounded-t-lg px-3 pb-1 pt-2 text-xs text-ink-3', drag.handle.className)} title="Drag to move">
        <span className="min-w-0 flex-1 truncate">
          Note for the agent{draft.quote ? ' · on the selected text' : draft.strokes?.length ? ' · on the area you marked' : draft.shapeName ? ` · on “${draft.shapeName}”` : ''}
        </span>
        <Grip />
      </div>
      {draft.strokes?.length ? <MarkInfo shapes={draft.shapes} hint /> : null}
      {draft.quote ? <Quote text={draft.quote} /> : null}
      <textarea
        ref={ref}
        className="h-20 w-full resize-none rounded border border-hair p-2 text-sm outline-none focus:border-accent"
        placeholder="e.g. make this chart bigger, use the brand teal"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void save(e.shiftKey)
          if (e.key === 'Escape') onCancel()
        }}
      />
      {/* Pin is the main action; "Act now" (pin + ask the agent right away) sits apart on the left. */}
      <div className="mt-2 flex items-center gap-2">
        <button
          className="btn-ghost border border-hair text-amber-900"
          disabled={busy || !text.trim() || agentBusy}
          onClick={() => void save(true)}
          title={agentBusy ? 'The agent is working — pin the note now, or act when its turn ends' : 'Pin it and have the agent handle it right away (⌘⇧Enter)'}
        >
          <Zap size={13} /> Act now
        </button>
        <span className="flex-1" />
        <button className="btn-ghost" onClick={onCancel}>Cancel</button>
        <button className="btn-primary" disabled={busy || !text.trim()} onClick={() => void save()} title="Pin it — the agent sees it with your next message (⌘Enter)">Pin note</button>
      </div>
    </div>
  )
}

/**
 * Where a card opened from a badge goes, in the window: above the badge (or below it when there's
 * no room above), right-aligned to it, and kept inside the window — so a scrolling panel can't clip it.
 */
function floatingStyle(anchor: DOMRect): React.CSSProperties {
  const W = 288
  const left = Math.max(8, Math.min(anchor.right - W, window.innerWidth - W - 8))
  const above = anchor.top > 300 || anchor.top > window.innerHeight - anchor.bottom
  return above
    ? { left, bottom: window.innerHeight - anchor.top + 6, maxHeight: anchor.top - 14, overflowY: 'auto' }
    : { left, top: anchor.bottom + 6, maxHeight: window.innerHeight - anchor.bottom - 14, overflowY: 'auto' }
}

/**
 * A note's card: the note, its quote or mark, Resolve / Reopen, Edit, Delete. Opens next to its pin;
 * given an `anchor` (a badge's rect), it floats over the window above that badge instead.
 */
export function NotePopover({ note, onClose, flipX, flipY, anchor }: { note: Note; onClose(): void; flipX: boolean; flipY: boolean; anchor?: DOMRect }) {
  const { update, remove } = useNotes()
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(note.text)
  const drag = useDraggable()
  const card = (
    <div
      data-note-popover
      className={anchor ? 'pointer-events-auto fixed z-[60] w-72 rounded-lg border border-hair bg-white p-3 text-sm shadow-xl' : popoverPos(flipX, flipY)}
      style={anchor ? { ...floatingStyle(anchor), ...drag.style } : drag.style}
      onPointerDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <div {...drag.handle} className={clsx('-mx-3 -mt-3 mb-1 flex items-center gap-2 rounded-t-lg px-3 pb-1 pt-2 text-xs text-ink-3', drag.handle.className)} title="Drag to move">
        <Grip />
        <span className={clsx('rounded px-1.5 py-0.5 font-medium', note.author === 'agent' ? 'bg-violet-100 text-violet-800' : 'bg-amber-100 text-amber-900')}>
          {note.author === 'agent' ? 'Agent' : 'You'}
        </span>
        {note.strokes?.length ? <span className="truncate">drawn mark</span> : note.shapeName && <span className="truncate">on “{note.shapeName}”</span>}
        <span className="ml-auto">{new Date(note.createdAt).toLocaleString()}</span>
        <button className="text-ink-3 hover:text-ink" onClick={onClose}><X size={14} /></button>
      </div>
      {note.strokes?.length ? <MarkInfo shapes={note.shapes} /> : null}
      {note.quote ? <Quote text={note.quote} /> : null}
      {editing ? (
        <textarea className="h-20 w-full resize-none rounded border border-hair p-2 outline-none focus:border-accent" value={text} onChange={(e) => setText(e.target.value)} autoFocus />
      ) : (
        <div className="whitespace-pre-wrap text-ink" onDoubleClick={() => setEditing(true)}>{note.text}</div>
      )}
      {note.status === 'resolved' && (
        <div className="mt-2 rounded bg-emerald-50 p-2 text-xs text-emerald-800">
          <b>Resolved{note.resolvedBy === 'agent' ? ' by the agent' : ''}:</b> {note.resolution || 'done'}
        </div>
      )}
      <div className="mt-2 flex items-center gap-1">
        {editing ? (
          <>
            <button className="btn-primary" onClick={async () => { await update(note.id, { text }); setEditing(false) }}>Save</button>
            <button className="btn-ghost" onClick={() => setEditing(false)}>Cancel</button>
          </>
        ) : (
          <>
            {note.status === 'open' ? (
              <button className="btn-ghost" onClick={() => void update(note.id, { status: 'resolved' })}><Check size={14} /> Resolve</button>
            ) : (
              <button className="btn-ghost" onClick={() => void update(note.id, { status: 'open' })}><RotateCcw size={14} /> Reopen</button>
            )}
            <button className="btn-ghost" onClick={() => setEditing(true)}>Edit</button>
            <button className="btn-ghost ml-auto text-red-600" onClick={() => void remove(note.id)}><Trash2 size={14} /></button>
          </>
        )}
      </div>
    </div>
  )
  return anchor ? createPortal(card, document.body) : card
}

function Quote({ text }: { text: string }) {
  return <div className="mb-2 line-clamp-3 border-l-2 border-amber-400 bg-amber-50/60 px-2 py-1 text-[11px] text-ink-2">{text.length > 400 ? `${text.slice(0, 399)}…` : text}</div>
}

function MarkInfo({ shapes, hint }: { shapes?: string[]; hint?: boolean }) {
  return (
    <div className="mb-2 text-[11px] text-ink-3">
      {shapes?.length ? <div className="line-clamp-3">Covers: {shapes.join(' · ')}</div> : null}
      {hint && <div>Draw more strokes to extend the mark.</div>}
    </div>
  )
}

/** The message "Act now" sends: the note itself (place, drawn area, shapes/cells, quote) reaches the agent in the context block. */
/** At most this many characters in a pin's bubble: the number, a space, the start of the note (two short lines). */
const PIN_CHARS = 44
/** A bubble's widest (px): ~24 characters a line, two lines. */
const PIN_MAX_W = 156

/** `text` cut to `max` characters (on a word when it can), with an ellipsis. */
function shortText(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim()
  if (t.length <= max) return t
  const cut = t.slice(0, max - 1)
  const word = cut.lastIndexOf(' ')
  return `${(word > max * 0.6 ? cut.slice(0, word) : cut).trimEnd()}…`
}

export function actNowPrompt(note: Note, unit: 'slide' | 'page' | 'sheet' | 'text' | 'image' | 'speakerNotes' | 'chat'): string {
  const clip = (t: string, n = 120) => (t.length > n ? `${t.slice(0, n - 1)}…` : t)
  let place: string
  if (unit === 'speakerNotes') {
    place = `in the speaker notes of slide ${note.slideIndex} of ${note.deck}, on the text "${clip(note.quote ?? '')}"`
  } else if (unit === 'chat') {
    return `About this part of our chat — "${clip(note.quote ?? '', 300)}": ${note.text}\n\n(note ${note.id} — resolve it when done)`
  } else if (unit === 'text') {
    const lines = note.lines ? ` (line${/[–-]/.test(note.lines) ? 's' : ''} ${note.lines})` : ''
    place = `in ${note.deck}${lines}, on the text "${clip(note.quote ?? '')}"`
  } else if (note.quote) {
    place = `on page ${note.slideIndex} of ${note.deck}, on the text "${clip(note.quote)}"`
  } else if (unit === 'image') {
    place = `on the image ${note.deck}${note.strokes?.length ? ' (the area I marked)' : ''}`
  } else if (unit === 'sheet') {
    place = `on sheet "${note.slideId}" of ${note.deck}${note.strokes?.length ? ' (the cells I marked)' : note.shapeName ? ` (${note.shapeName})` : ''}`
  } else {
    const where = note.strokes?.length ? ' (the area I marked)' : note.shapeName ? ` (on "${note.shapeName}")` : ''
    place = `on ${unit} ${note.slideIndex}${where}`
  }
  return `Please act on the note I just pinned ${place} — note ${note.id}: "${note.text}". Make the change now, then resolve the note.`
}
