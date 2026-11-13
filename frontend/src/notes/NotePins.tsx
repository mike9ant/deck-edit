/**
 * Sticky notes pinned on a slide/page: numbered pins at their saved position,
 * a popover to read/edit/resolve/delete, and a draft popover when the user
 * places a new note (in "add note" mode). A drawn note (see NoteDrawing) also
 * shows its freehand mark. Notes go to the agent with every turn; the agent
 * resolves them through its tools.
 */

import { useEffect, useRef, useState } from 'react'
import { Check, MessageSquarePlus, RotateCcw, Trash2, X } from 'lucide-react'
import clsx from 'clsx'
import type { Note, Stroke } from '../api/types'
import { useNotes } from '../store/notesStore'
import { NOTE_COLORS, StrokesSvg } from './NoteDrawing'

export interface NoteDraft {
  x: number
  y: number
  shapeName?: string
  /** A drawn note: the strokes so far (more can be added while the popover is open). */
  strokes?: Stroke[]
  /** Shapes the drawn mark covers. */
  shapes?: string[]
}

interface Props {
  notes: Note[]
  /** Stage size in screen px. */
  width: number
  height: number
  showResolved: boolean
  draft: NoteDraft | null
  onSaveDraft(text: string): Promise<void>
  onCancelDraft(): void
}

export function NotePins({ notes, width, height, showResolved, draft, onSaveDraft, onCancelDraft }: Props) {
  const [openId, setOpenId] = useState<string | null>(null)
  const visible = notes.filter((n) => showResolved || n.status === 'open')
  // Open popovers toward the side with room (they're ~290 px wide, ≤ ~260 px tall).
  const flipX = (x: number) => x * width + 300 > width && x * width > 300
  const flipY = (y: number) => y * height + 270 > height && y * height > 270
  const color = (n: Note) => (n.status === 'resolved' ? NOTE_COLORS.resolved : n.author === 'agent' ? NOTE_COLORS.agent : NOTE_COLORS.user)
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
      {visible.map((n, i) => (
        <div key={n.id} className="absolute" style={{ left: n.x * width, top: n.y * height }}>
          <button
            className={clsx(
              'pointer-events-auto -translate-x-1/2 -translate-y-full flex h-6 min-w-6 items-center justify-center rounded-full rounded-bl-none border px-1.5 text-[11px] font-semibold shadow-md',
              n.status === 'resolved'
                ? 'border-emerald-300 bg-emerald-50 text-emerald-700 opacity-70'
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
            {n.status === 'resolved' ? <Check size={12} /> : n.author === 'agent' ? 'AI' : i + 1}
          </button>
          {openId === n.id && <NotePopover note={n} onClose={() => setOpenId(null)} flipX={flipX(n.x)} flipY={flipY(n.y)} />}
        </div>
      ))}
      {draft && (
        <div className="absolute" style={{ left: draft.x * width, top: draft.y * height }}>
          <div className="-translate-x-1/2 -translate-y-full flex h-6 w-6 items-center justify-center rounded-full rounded-bl-none border border-amber-400 bg-note shadow-md">
            <MessageSquarePlus size={12} />
          </div>
          <DraftPopover draft={draft} onSave={onSaveDraft} onCancel={onCancelDraft} flipX={flipX(draft.x)} flipY={flipY(draft.y)} />
        </div>
      )}
    </div>
  )
}

function popoverPos(flipX: boolean, flipY: boolean) {
  return clsx('pointer-events-auto absolute z-30 w-72 rounded-lg border border-hair bg-white p-3 text-sm shadow-xl', flipX ? 'right-2' : 'left-2', flipY ? 'bottom-8' : 'top-2')
}

function DraftPopover({ draft, onSave, onCancel, flipX, flipY }: { draft: NoteDraft; onSave(t: string): Promise<void>; onCancel(): void; flipX: boolean; flipY: boolean }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const ref = useRef<HTMLTextAreaElement>(null)
  // Back to the text after each stroke, so drawing then typing just works.
  useEffect(() => ref.current?.focus(), [draft.strokes?.length])
  const save = async () => {
    if (!text.trim()) return
    setBusy(true)
    await onSave(text.trim())
    setBusy(false)
  }
  return (
    <div className={popoverPos(flipX, flipY)} onPointerDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      <div className="mb-1 text-xs text-ink-3">
        Note for the agent{draft.strokes?.length ? ' · on the area you marked' : draft.shapeName ? ` · on “${draft.shapeName}”` : ''}
      </div>
      {draft.strokes?.length ? <MarkInfo shapes={draft.shapes} hint /> : null}
      <textarea
        ref={ref}
        className="h-20 w-full resize-none rounded border border-hair p-2 text-sm outline-none focus:border-accent"
        placeholder="e.g. make this chart bigger, use the brand teal"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void save()
          if (e.key === 'Escape') onCancel()
        }}
      />
      <div className="mt-2 flex justify-end gap-2">
        <button className="btn-ghost" onClick={onCancel}>Cancel</button>
        <button className="btn-primary" disabled={busy || !text.trim()} onClick={() => void save()}>Pin note</button>
      </div>
    </div>
  )
}

function NotePopover({ note, onClose, flipX, flipY }: { note: Note; onClose(): void; flipX: boolean; flipY: boolean }) {
  const { update, remove } = useNotes()
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(note.text)
  return (
    <div className={popoverPos(flipX, flipY)} onPointerDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      <div className="mb-1 flex items-center gap-2 text-xs text-ink-3">
        <span className={clsx('rounded px-1.5 py-0.5 font-medium', note.author === 'agent' ? 'bg-violet-100 text-violet-800' : 'bg-amber-100 text-amber-900')}>
          {note.author === 'agent' ? 'Agent' : 'You'}
        </span>
        {note.strokes?.length ? <span className="truncate">drawn mark</span> : note.shapeName && <span className="truncate">on “{note.shapeName}”</span>}
        <span className="ml-auto">{new Date(note.createdAt).toLocaleString()}</span>
        <button className="text-ink-3 hover:text-ink" onClick={onClose}><X size={14} /></button>
      </div>
      {note.strokes?.length ? <MarkInfo shapes={note.shapes} /> : null}
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
}

function MarkInfo({ shapes, hint }: { shapes?: string[]; hint?: boolean }) {
  return (
    <div className="mb-2 text-[11px] text-ink-3">
      {shapes?.length ? <div className="line-clamp-3">Covers: {shapes.join(' · ')}</div> : null}
      {hint && <div>Draw more strokes to extend the mark.</div>}
    </div>
  )
}
