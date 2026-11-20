/**
 * Notes on selected text in a text/code/Markdown file: select some text, then
 * "Note" — the agent gets the file, the lines and the quoted text. The text of
 * open notes is highlighted in the editor; the notes list shows them (click a
 * quote to jump to it), with resolve / reopen / delete.
 *
 * `QuoteNoteBox` and `NotesList` are shared with the other places a note can
 * be about selected text: the speaker notes (deck/NotesPane.tsx) and the chat.
 */

import { useEffect, useRef, useState } from 'react'
import { BotMessageSquare, Check, RotateCcw, StickyNote, Trash2, X, Zap } from 'lucide-react'
import clsx from 'clsx'
import type { Note } from '../api/types'
import { noteNumber, useNotes } from '../store/notesStore'
import { chatIsRunning, useChat } from '../store/chatStore'
import { sendToAgent } from '../chat/sendToAgent'
import { actNowPrompt } from './NotePins'
import type { TextSelection } from '../viewers/TextEditor'

const linesOf = (s: TextSelection) => (s.fromLine === s.toLine ? `${s.fromLine}` : `${s.fromLine}–${s.toLine}`)
const clip = (t: string, n: number) => (t.length > n ? `${t.slice(0, n - 1)}…` : t)

export function TextNoteTools({ path, selection, onReveal }: { path: string; selection: TextSelection | null; onReveal(quote: string, line?: number): void }) {
  const all = useNotes((s) => s.notes)
  const notes = all.filter((n) => n.deck === path && n.quote)
  const open = notes.filter((n) => n.status === 'open').length
  const [draft, setDraft] = useState<TextSelection | null>(null)
  const [list, setList] = useState(false)
  return (
    <div className="relative flex items-center gap-0.5" data-keep-selection>
      <button
        className="tool-btn"
        disabled={!selection}
        title={selection ? 'Add a note for the AI agent about the selected text' : 'Select some text to add a note for the AI agent about it'}
        onMouseDown={(e) => e.preventDefault() /* keep the selection */}
        onClick={() => { setDraft(selection); setList(false) }}
      >
        <BotMessageSquare size={14} /> Note for AI
      </button>
      {notes.length > 0 && (
        <button className={clsx('tool-btn', open && 'text-amber-800')} title="Notes on this file" onClick={() => { setList(!list); setDraft(null) }}>
          <StickyNote size={13} /> {open ? `${open} open` : `${notes.length}`}
        </button>
      )}
      {draft && (
        <QuoteNoteBox
          heading={`Note for the agent · line${draft.fromLine === draft.toLine ? '' : 's'} ${linesOf(draft)}`}
          quote={draft.text}
          placeholder="e.g. tighten this paragraph, check these numbers"
          onPin={(text) => useNotes.getState().add({ deck: path, slideId: '', slideIndex: draft.fromLine, x: 0, y: 0, quote: draft.text, lines: linesOf(draft), text })}
          actNow={(note) => actNowPrompt(note, 'text')}
          onClose={() => setDraft(null)}
        />
      )}
      {list && <NotesList title="Notes on this file" notes={notes} onReveal={(n) => { setList(false); onReveal(n.quote!, n.slideIndex) }} onClose={() => setList(false)} />}
    </div>
  )
}

/**
 * The box for a note about some quoted text: the quote, the note, and Pin note
 * (the agent sees it with the next message) or Act now (pin it and send the
 * agent a message about it right away). `above` opens it upwards (a pane at
 * the bottom of the window); `fixed` places it at a viewport point instead.
 */
export function QuoteNoteBox({ heading, quote, placeholder, onPin, actNow, onClose, above, fixed }: {
  heading: string
  quote: string
  placeholder?: string
  onPin(text: string): Promise<Note | undefined>
  actNow(note: Note): string
  onClose(): void
  above?: boolean
  fixed?: { left: number; top: number }
}) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const agentBusy = useChat((s) => chatIsRunning(s, s.activeId))
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => ref.current?.focus(), [])
  const save = async (now: boolean) => {
    if (!text.trim() || (now && agentBusy)) return
    setBusy(true)
    const note = await onPin(text.trim())
    setBusy(false)
    onClose()
    if (now && note) await sendToAgent(actNow(note))
  }
  return (
    <div
      className={clsx('z-50 w-80 rounded-lg border border-hair bg-white p-3 text-sm shadow-xl', fixed ? 'fixed' : clsx('absolute right-0', above ? 'bottom-8' : 'top-8'))}
      style={fixed ? { left: fixed.left, top: fixed.top } : undefined}
      onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') onClose() }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="mb-1 text-xs text-ink-3">{heading}</div>
      <div className="mb-2 line-clamp-3 whitespace-pre-wrap border-l-2 border-amber-400 bg-amber-50/60 px-2 py-1 text-[11px] text-ink-2">{clip(quote, 400)}</div>
      <textarea
        ref={ref}
        className="h-20 w-full resize-none rounded border border-hair p-2 text-sm outline-none focus:border-accent"
        placeholder={placeholder ?? 'What should the agent do about this?'}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void save(e.shiftKey) }}
      />
      <div className="mt-2 flex items-center gap-2">
        <button className="btn-ghost border border-hair text-amber-900" disabled={busy || !text.trim() || agentBusy} onClick={() => void save(true)} title={agentBusy ? 'The agent is working — pin the note now, or act when its turn ends' : 'Pin it and have the agent handle it right away (⌘⇧Enter)'}>
          <Zap size={13} /> Act now
        </button>
        <span className="flex-1" />
        <button className="btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn-primary" disabled={busy || !text.trim()} onClick={() => void save(false)} title="Pin it — the agent sees it with your next message (⌘Enter)">Pin note</button>
      </div>
    </div>
  )
}

/** Notes about quoted text, with resolve / reopen / delete; click a quote to show it. */
export function NotesList({ title, notes, onReveal, onClose, above, fixed }: {
  title: string
  notes: Note[]
  onReveal(n: Note): void
  onClose(): void
  above?: boolean
  fixed?: { left: number; top: number }
}) {
  const { update, remove } = useNotes()
  const all = useNotes((s) => s.notes)
  return (
    <div
      className={clsx('z-50 max-h-96 w-96 overflow-y-auto rounded-lg border border-hair bg-white p-2 text-sm shadow-xl', fixed ? 'fixed' : clsx('absolute right-0', above ? 'bottom-8' : 'top-8'))}
      style={fixed ? { left: fixed.left, top: fixed.top } : undefined}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="mb-1 flex items-center px-1 text-xs font-medium text-ink-3">
        {title} <button className="ml-auto text-ink-3 hover:text-ink" onClick={onClose}><X size={14} /></button>
      </div>
      {notes.map((n) => (
        <div key={n.id} className={clsx('rounded-md p-2 hover:bg-paper', n.status === 'resolved' && 'opacity-60')}>
          <button className="mb-1 block w-full truncate border-l-2 border-amber-400 pl-2 text-left font-mono text-[11px] text-ink-2 hover:text-ink" title="Show it" onClick={() => onReveal(n)}>
            {n.lines ? `L${n.lines} · ` : ''}{clip(n.quote ?? '', 90)}
          </button>
          <div className="whitespace-pre-wrap text-ink">{n.text}</div>
          {n.status === 'resolved' && <div className="mt-1 text-xs text-emerald-700">Resolved{n.resolvedBy === 'agent' ? ' by the agent' : ''}: {n.resolution || 'done'}</div>}
          <div className="mt-1 flex items-center gap-1 text-xs">
            {n.status === 'open' && <span className="rounded bg-note px-1.5 py-0.5 font-semibold text-amber-950">{noteNumber(n, all)}</span>}
            <span className={clsx('rounded px-1.5 py-0.5 font-medium', n.author === 'agent' ? 'bg-violet-100 text-violet-800' : 'bg-amber-100 text-amber-900')}>{n.author === 'agent' ? 'Agent' : 'You'}</span>
            {n.status === 'open'
              ? <button className="btn-ghost h-6 px-1.5" onClick={() => void update(n.id, { status: 'resolved' })}><Check size={12} /> Resolve</button>
              : <button className="btn-ghost h-6 px-1.5" onClick={() => void update(n.id, { status: 'open' })}><RotateCcw size={12} /> Reopen</button>}
            <button className="btn-ghost ml-auto h-6 px-1.5 text-red-600" onClick={() => void remove(n.id)}><Trash2 size={12} /></button>
          </div>
        </div>
      ))}
    </div>
  )
}
