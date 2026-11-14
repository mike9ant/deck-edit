/**
 * Notes on selected text in a text/code/Markdown file: select some text, then
 * "Note" — the agent gets the file, the lines and the quoted text. The text of
 * open notes is highlighted in the editor; the notes list shows them (click a
 * quote to jump to it), with resolve / reopen / delete.
 */

import { useEffect, useRef, useState } from 'react'
import { BotMessageSquare, Check, RotateCcw, StickyNote, Trash2, X, Zap } from 'lucide-react'
import clsx from 'clsx'
import type { Note } from '../api/types'
import { useNotes } from '../store/notesStore'
import { useChat } from '../store/chatStore'
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
      {draft && <TextNoteBox path={path} sel={draft} onClose={() => setDraft(null)} />}
      {list && <NotesList notes={notes} onReveal={(n) => { setList(false); onReveal(n.quote!, n.slideIndex) }} onClose={() => setList(false)} />}
    </div>
  )
}

function TextNoteBox({ path, sel, onClose }: { path: string; sel: TextSelection; onClose(): void }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const agentBusy = useChat((s) => !!s.pid && !!s.busyProjects[s.pid])
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => ref.current?.focus(), [])
  const save = async (actNow: boolean) => {
    if (!text.trim() || (actNow && agentBusy)) return
    setBusy(true)
    const note = await useNotes.getState().add({ deck: path, slideId: '', slideIndex: sel.fromLine, x: 0, y: 0, quote: sel.text, lines: linesOf(sel), text: text.trim() })
    setBusy(false)
    onClose()
    if (actNow && note) await sendToAgent(actNowPrompt(note, 'text'))
  }
  return (
    <div className="absolute right-0 top-8 z-40 w-80 rounded-lg border border-hair bg-white p-3 text-sm shadow-xl" onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') onClose() }}>
      <div className="mb-1 text-xs text-ink-3">Note for the agent · line{sel.fromLine === sel.toLine ? '' : 's'} {linesOf(sel)}</div>
      <div className="mb-2 line-clamp-3 border-l-2 border-amber-400 bg-amber-50/60 px-2 py-1 font-mono text-[11px] text-ink-2">{clip(sel.text, 400)}</div>
      <textarea
        ref={ref}
        className="h-20 w-full resize-none rounded border border-hair p-2 text-sm outline-none focus:border-accent"
        placeholder="e.g. tighten this paragraph, check these numbers"
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

function NotesList({ notes, onReveal, onClose }: { notes: Note[]; onReveal(n: Note): void; onClose(): void }) {
  const { update, remove } = useNotes()
  return (
    <div className="absolute right-0 top-8 z-40 max-h-96 w-96 overflow-y-auto rounded-lg border border-hair bg-white p-2 text-sm shadow-xl">
      <div className="mb-1 flex items-center px-1 text-xs font-medium text-ink-3">
        Notes on this file <button className="ml-auto text-ink-3 hover:text-ink" onClick={onClose}><X size={14} /></button>
      </div>
      {notes.map((n) => (
        <div key={n.id} className={clsx('rounded-md p-2 hover:bg-paper', n.status === 'resolved' && 'opacity-60')}>
          <button className="mb-1 block w-full truncate border-l-2 border-amber-400 pl-2 text-left font-mono text-[11px] text-ink-2 hover:text-ink" title="Show it in the file" onClick={() => onReveal(n)}>
            {n.lines ? `L${n.lines} · ` : ''}{clip(n.quote ?? '', 90)}
          </button>
          <div className="whitespace-pre-wrap text-ink">{n.text}</div>
          {n.status === 'resolved' && <div className="mt-1 text-xs text-emerald-700">Resolved{n.resolvedBy === 'agent' ? ' by the agent' : ''}: {n.resolution || 'done'}</div>}
          <div className="mt-1 flex items-center gap-1 text-xs">
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
