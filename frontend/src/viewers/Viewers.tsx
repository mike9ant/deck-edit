/**
 * Viewers for non-deck files. Markdown opens formatted (its text editable in
 * place, see MarkdownEditable) or as Markdown source in the editor — the last
 * choice is remembered for the next Markdown file;
 * plain text and code/config files open in the editor. Edits autosave (see
 * TextEditor.tsx). Images are view-only. Everything reloads when the file
 * changes on disk (e.g. the agent edits a script or a speaker-notes .md).
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Eye, EyeOff, ExternalLink, Loader2, Pencil } from 'lucide-react'
import clsx from 'clsx'
import { api } from '../api/client'
import { useFileVersion } from '../store/fileVersions'
import { useChat } from '../store/chatStore'
import { useApp } from '../store/appStore'
import { CodeEditor, useTextDoc, type SaveStatus, type TextSelection } from './TextEditor'
import { TextNoteTools } from '../notes/TextNotes'
import { notesForSlide, useNotes, noteNumber } from '../store/notesStore'
import { NotePins, actNowPrompt, type NoteDraft } from '../notes/NotePins'
import { DrawLayer, NoteToolButton, SelectToolButton, pinFor, useEscapeEndsNoteMode } from '../notes/NoteDrawing'
import { sendToAgent } from '../chat/sendToAgent'
import { MarkdownEditable } from './MarkdownEditable'

type MdMode = 'preview' | 'edit'
const MD_MODE_KEY = 'deckedit-md-mode'

export function MarkdownView({ pid, path }: { pid: string; path: string }) {
  const [mode, setModeState] = useState<MdMode>(() => (localStorage.getItem(MD_MODE_KEY) === 'edit' ? 'edit' : 'preview'))
  const setMode = (m: MdMode) => {
    localStorage.setItem(MD_MODE_KEY, m)
    setModeState(m)
  }
  return (
    <TextDoc
      pid={pid}
      path={path}
      mode={mode}
      tools={
        <div className="flex rounded-md bg-black/5 p-0.5">
          {([['preview', 'Formatted', Eye, 'Formatted view — click any text to edit it'], ['edit', 'Markdown', Pencil, 'Markdown source']] as const).map(([m, label, Icon, title]) => (
            <button
              key={m}
              title={title}
              className={clsx('flex h-6 items-center gap-1 rounded px-2 text-xs', mode === m ? 'bg-white font-medium text-ink shadow-sm' : 'text-ink-3 hover:text-ink')}
              onClick={() => setMode(m)}
            >
              <Icon size={13} /> {label}
            </button>
          ))}
        </div>
      }
    />
  )
}

export function TextView({ pid, path }: { pid: string; path: string }) {
  return <TextDoc pid={pid} path={path} mode="edit" />
}

function TextDoc({ pid, path, mode, tools }: { pid: string; path: string; mode: MdMode; tools?: React.ReactNode }) {
  const { doc, status, error, change, flush, current } = useTextDoc(pid, path)
  const busy = useChat((s) => !!s.busyProjects[pid])
  const changed = useApp((s) => s.changed.includes(path))
  const [selection, setSelection] = useState<TextSelection | null>(null)
  const allNotes = useNotes((s) => s.notes)
  const marks = allNotes
    .filter((n) => n.deck === path && n.quote && n.status === 'open')
    .map((n) => ({ id: n.id, quote: n.quote!, line: n.slideIndex, label: String(noteNumber(n, allNotes)), title: n.text }))
  const revealRef = useRef<((quote: string, line?: number) => void) | null>(null)
  const reveal = (quote: string, line?: number) => {
    if (mode === 'edit') return revealRef.current?.(quote, line)
    // Formatted view: scroll the highlighted text into view.
    const art = document.querySelector('.md-editable')
    const w = art && document.createTreeWalker(art, NodeFilter.SHOW_TEXT)
    const probe = quote.replace(/[*_`~]/g, '').split('\n')[0].slice(0, 40)
    for (let n = w?.nextNode(); n; n = w!.nextNode()) if (n.textContent?.includes(probe)) return (n.parentElement as HTMLElement).scrollIntoView({ block: 'center' })
  }
  if (error && !doc) return <div className="p-6 text-sm text-red-700">{error}</div>
  if (!doc) return <Loading />
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-white">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-hair bg-panel px-3">
        {tools}
        <span className="truncate text-xs text-ink-3">{path}</span>
        <div className="ml-auto flex items-center gap-2 text-xs text-ink-3">
          <TextNoteTools path={path} selection={selection} onReveal={reveal} />
          <StatusLabel status={status} changed={changed} />
          <button className="tool-btn" title="Open with the default app" onClick={() => void api.openExternal(pid, path)}><ExternalLink size={14} /> Open</button>
        </div>
      </div>
      {busy && (
        <div className="border-b border-violet-200 bg-violet-50 px-3 py-1.5 text-xs text-violet-900">
          The agent is working — its changes appear here as it saves. You can keep editing: your typing is merged with its changes.
        </div>
      )}
      {mode === 'edit' ? (
        <CodeEditor path={path} doc={doc} initialText={current()} readOnly={false} onSelection={setSelection} marks={marks} revealRef={revealRef} onChange={change} onSave={() => void flush()} />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <MarkdownEditable text={current()} editable onChange={change} onSelection={setSelection} marks={marks} />
        </div>
      )}
    </div>
  )
}

/** Save state — "Saved" only once the file was actually changed (by the user or the agent). */
function StatusLabel({ status, changed }: { status: SaveStatus; changed: boolean }) {
  if (status === 'saving') return <span className="flex items-center gap-1"><Loader2 size={12} className="animate-spin" /> Saving…</span>
  if (status === 'dirty') return <span>Unsaved…</span>
  if (status === 'error') return <span className="text-red-700">Not saved</span>
  return changed ? <span>Saved</span> : null
}

/**
 * An image, with notes for the agent: pin a point or draw a mark on it
 * (positions are fractions of the image, so they hold at any size).
 */
export function ImageView({ pid, path }: { pid: string; path: string }) {
  const version = useFileVersion(pid, path)
  const wrap = useRef<HTMLDivElement>(null)
  const [box, setBox] = useState({ w: 800, h: 600 })
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null)
  const [noteMode, setNoteMode] = useState(false)
  const [showResolved, setShowResolved] = useState(false)
  const [draft, setDraft] = useState<NoteDraft | null>(null)
  const noteTool = useNotes((s) => s.tool)
  const allNotes = useNotes((s) => s.notes)
  useEscapeEndsNoteMode(noteMode, setNoteMode)
  useEffect(() => setDraft(null), [noteMode, noteTool])
  useLayoutEffect(() => {
    const el = wrap.current
    if (!el) return
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  // Fit the image into the view (never enlarged past its own size).
  const fit = natural ? Math.min(1, (box.w - 48) / natural.w, (box.h - 48) / natural.h) : 0
  const w = natural ? Math.max(1, Math.round(natural.w * fit)) : 0
  const h = natural ? Math.max(1, Math.round(natural.h * fit)) : 0
  const drawing = noteMode && noteTool === 'draw'
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-hair bg-panel px-2">
        <SelectToolButton active={!noteMode} onSelect={() => setNoteMode(false)} />
        <span className="ml-2 truncate text-xs text-ink-3">{natural ? `${natural.w} × ${natural.h}` : ''}</span>
        <div className="ml-auto flex items-center gap-2 text-xs text-ink-3">
          <NoteToolButton active={noteMode} onToggle={() => setNoteMode(!noteMode)} />
          <button className="icon-btn" onClick={() => setShowResolved(!showResolved)} title={showResolved ? 'Hide resolved notes' : 'Show resolved notes'}>{showResolved ? <Eye size={15} /> : <EyeOff size={15} />}</button>
          <div className="h-5 w-px bg-hair" />
          <button className="tool-btn" title="Open with the default app" onClick={() => void api.openExternal(pid, path)}><ExternalLink size={14} /> Open</button>
        </div>
      </div>
      <div ref={wrap} className="flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-[#e9e8e4]">
        <div
          className={clsx('relative shadow', noteMode && 'cursor-crosshair')}
          style={{ width: w, height: h }}
          onPointerDown={(e) => {
            if (!noteMode || drawing) return
            e.preventDefault() // the note box that opens takes the typing
            const r = e.currentTarget.getBoundingClientRect()
            setDraft({ x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height })
          }}
        >
          <img
            src={`${api.fileUrl(pid, path)}&v=${version}`}
            alt={path}
            draggable={false}
            className="block h-full w-full rounded-[2px] select-none"
            onLoad={(e) => setNatural({ w: e.currentTarget.naturalWidth || 800, h: e.currentTarget.naturalHeight || 600 })}
          />
          {drawing && (
            <DrawLayer
              width={w}
              height={h}
              onStroke={(st) => setDraft((d) => { const strokes = [...(d?.strokes ?? []), st]; return { ...pinFor(strokes), strokes } })}
              onTap={(p) => setDraft((d) => (d?.strokes?.length ? d : p))}
            />
          )}
          {natural && (
            <NotePins
              notes={notesForSlide(allNotes, path, '', 1)}
              width={w}
              height={h}
              showResolved={showResolved}
              draft={draft}
              onCancelDraft={() => setDraft(null)}
              onSaveDraft={async (text, actNow) => {
                const d = draft!
                setDraft(null)
                const note = await useNotes.getState().add({ deck: path, slideId: '', slideIndex: 1, x: d.x, y: d.y, strokes: d.strokes, text })
                setNoteMode(false)
                if (actNow && note) await sendToAgent(actNowPrompt(note, 'image'))
              }}
            />
          )}
        </div>
      </div>
    </div>
  )
}

export function OtherView({ pid, path }: { pid: string; path: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 text-sm text-ink-3">
      No preview for this file type.
      <button className="btn-ghost border border-hair" onClick={() => void api.openExternal(pid, path)}><ExternalLink size={14} /> Open with default app</button>
    </div>
  )
}

const Loading = () => (
  <div className="flex flex-1 items-center justify-center text-ink-3"><Loader2 className="animate-spin" size={18} /></div>
)
