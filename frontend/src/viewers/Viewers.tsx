/**
 * Viewers for non-deck files. Markdown opens formatted (its text editable in
 * place, see MarkdownEditable) or as Markdown source in the editor — the last
 * choice is remembered for the next Markdown file;
 * plain text and code/config files open in the editor. Edits autosave (see
 * TextEditor.tsx). Images are view-only. Everything reloads when the file
 * changes on disk (e.g. the agent edits a script or a speaker-notes .md).
 */

import { useState } from 'react'
import { Eye, ExternalLink, Loader2, Pencil } from 'lucide-react'
import clsx from 'clsx'
import { api } from '../api/client'
import { useFileVersion } from '../store/fileVersions'
import { useChat } from '../store/chatStore'
import { useApp } from '../store/appStore'
import { CodeEditor, useTextDoc, type SaveStatus } from './TextEditor'
import { MarkdownEditable } from './MarkdownEditable'

type MdMode = 'preview' | 'edit'
const MD_MODE_KEY = 'pptxedit-md-mode'

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
  if (error && !doc) return <div className="p-6 text-sm text-red-700">{error}</div>
  if (!doc) return <Loading />
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-white">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-hair bg-panel px-3">
        {tools}
        <span className="truncate text-xs text-ink-3">{path}</span>
        <div className="ml-auto flex items-center gap-2 text-xs text-ink-3">
          <StatusLabel status={status} changed={changed} />
          <button className="tool-btn" title="Open with the default app" onClick={() => void api.openExternal(pid, path)}><ExternalLink size={14} /> Open</button>
        </div>
      </div>
      {busy && (
        <div className="border-b border-violet-200 bg-violet-50 px-3 py-1.5 text-xs text-violet-900">
          The agent is working. Editing is paused, and its changes appear here as it saves.
        </div>
      )}
      {mode === 'edit' ? (
        <CodeEditor path={path} doc={doc} initialText={current()} readOnly={busy} onChange={change} onSave={() => void flush()} />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <MarkdownEditable text={current()} editable={!busy} onChange={change} />
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

export function ImageView({ pid, path }: { pid: string; path: string }) {
  const version = useFileVersion(pid, path)
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-[#e9e8e4] p-6">
      <img src={`${api.fileUrl(pid, path)}&v=${version}`} className="max-h-full max-w-full rounded shadow" alt={path} />
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
