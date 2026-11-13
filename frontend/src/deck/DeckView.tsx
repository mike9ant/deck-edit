/**
 * A PPTX document: toolbar + [mini-slides rail | main slide]. Owns the
 * deck session's lifetime (open on mount) and shows the live state: saving,
 * "agent is working" (editing paused), and "updated by the agent".
 */

import { useEffect, useRef, useState } from 'react'
import { ExternalLink, Eye, EyeOff, Loader2, MessageSquarePlus, Redo2, Type, Undo2, Sparkles, X } from 'lucide-react'
import clsx from 'clsx'
import { useDecks, deckKey } from './deckStore'
import { SlideRail } from './SlideRail'
import { SlideEditor } from './SlideEditor'
import { NotesPane } from './NotesPane'
import { Splitter } from '../components/Splitter'
import { useApp } from '../store/appStore'
import { useChat } from '../store/chatStore'
import { api } from '../api/client'

export function DeckView({ pid, path }: { pid: string; path: string }) {
  const key = deckKey(pid, path)
  const session = useDecks((s) => s.sessions[key])
  const { open, undo, redo, setSlide } = useDecks()
  const busy = useChat((s) => !!s.busyProjects[pid])
  const railW = useApp((s) => s.widths.rail)
  const setWidth = useApp((s) => s.setWidth)
  const [noteMode, setNoteMode] = useState(false)
  const [showResolved, setShowResolved] = useState(false)
  const [dismissedAt, setDismissedAt] = useState(0)
  const actions = useRef<{ addTextBox(): void }>({ addTextBox() {} })

  useEffect(() => {
    void open(pid, path)
  }, [pid, path, open])

  // Report what the user is looking at (the agent's get_user_view tool).
  const slide = session?.pres?.slides[session.slideIndex]
  useEffect(() => {
    if (!session?.pres || !slide) return
    const t = setTimeout(() => {
      api.putView(pid, {
        deck: path,
        slideNumber: session.slideIndex + 1,
        slideCount: session.pres!.slides.length,
        slideId: session.sldIds.get(slide.id) ?? '',
        selection: session.selection.map((id) => slide.nodes.find((n) => n.id === id)?.name ?? id),
      }).catch(() => {})
    }, 300)
    return () => clearTimeout(t)
  }, [pid, path, session?.slideIndex, session?.selection, session?.version])

  if (!session || (session.loading && !session.pres)) {
    return <Centered><Loader2 className="animate-spin" size={18} /> Opening {path.split('/').pop()}…</Centered>
  }
  if (session.error && !session.pres) return <Centered className="text-red-700">{session.error}</Centered>
  const pres = session.pres!

  const changedNums = session.externallyChanged
    .map((sid) => pres.slides.findIndex((s) => session.sldIds.get(s.id) === sid) + 1)
    .filter((n) => n > 0)
    .sort((a, b) => a - b)
  const showChanged = session.externalAt > dismissedAt && Date.now() - session.externalAt < 10 * 60_000

  const onKeyDown = (e: React.KeyboardEvent) => {
    const mod = e.metaKey || e.ctrlKey
    if (!mod || e.key.toLowerCase() !== 'z') return
    const t = e.target as HTMLElement
    if (t.isContentEditable || t.tagName === 'TEXTAREA' || t.tagName === 'INPUT') return
    e.preventDefault()
    if (e.shiftKey) void redo(key)
    else undo(key)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" onKeyDown={onKeyDown}>
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-hair bg-panel px-2">
        <button className="icon-btn" title="Undo (⌘Z)" disabled={!session.undo.length || busy} onClick={() => undo(key)}><Undo2 size={16} /></button>
        <button className="icon-btn" title="Redo (⇧⌘Z)" disabled={!session.redo.length || busy} onClick={() => void redo(key)}><Redo2 size={16} /></button>
        <div className="mx-1 h-5 w-px bg-hair" />
        <button className="tool-btn" disabled={busy} onClick={() => actions.current.addTextBox()} title="Add a text box"><Type size={15} /> Text</button>
        <button className={clsx('tool-btn', noteMode && 'bg-amber-100 text-amber-900')} onClick={() => setNoteMode(!noteMode)} title="Pin a note for the agent (click on the slide)">
          <MessageSquarePlus size={15} /> Note
        </button>
        <button className="icon-btn" onClick={() => setShowResolved(!showResolved)} title={showResolved ? 'Hide resolved notes' : 'Show resolved notes'}>
          {showResolved ? <Eye size={15} /> : <EyeOff size={15} />}
        </button>
        <div className="ml-2 text-xs text-ink-3">
          Slide {session.slideIndex + 1} / {pres.slides.length}
          {session.selection.length > 0 && ` · ${session.selection.length} selected`}
        </div>
        <div className="ml-auto flex items-center gap-2 text-xs text-ink-3">
          {session.saving ? <span className="flex items-center gap-1"><Loader2 size={12} className="animate-spin" /> Saving…</span> : session.dirty ? <span>Unsaved…</span> : <span>Saved</span>}
          <button className="tool-btn" title="Open this deck in PowerPoint" onClick={() => void api.openExternal(pid, path)}><ExternalLink size={14} /> PowerPoint</button>
        </div>
      </div>
      {busy && (
        <div className="flex items-center gap-2 border-b border-violet-200 bg-violet-50 px-3 py-1.5 text-xs text-violet-900">
          <Loader2 size={13} className="animate-spin" /> The agent is working. Editing is paused, and its changes appear here as it saves.
        </div>
      )}
      {!busy && showChanged && changedNums.length > 0 && (
        <div className="flex items-center gap-2 border-b border-violet-200 bg-violet-50 px-3 py-1.5 text-xs text-violet-900">
          <Sparkles size={13} /> Updated on disk — changed slide{changedNums.length > 1 ? 's' : ''}:
          {changedNums.slice(0, 20).map((n) => (
            <button key={n} className="rounded bg-white px-1.5 font-medium ring-1 ring-violet-200 hover:bg-violet-100" onClick={() => setSlide(key, n - 1)}>{n}</button>
          ))}
          <button className="ml-auto text-violet-700 hover:text-violet-900" onClick={() => setDismissedAt(Date.now())}><X size={14} /></button>
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        <SlideRail session={session} width={railW} />
        <Splitter width={railW} min={120} max={420} onChange={(w) => setWidth('rail', w)} />
        <div className="flex min-w-0 flex-1 flex-col">
          <SlideEditor
            session={session}
            noteMode={noteMode}
            setNoteMode={setNoteMode}
            showResolved={showResolved}
            registerActions={(a) => (actions.current = a)}
          />
          <NotesPane session={session} />
        </div>
      </div>
    </div>
  )
}

function Centered({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={clsx('flex flex-1 items-center justify-center gap-2 text-sm text-ink-3', className)}>{children}</div>
}
