/**
 * Layout: project bar on top, then
 *   [folder tree] | [document: mini-slides + slide | PDF pages | reader] | [agent chat tabs]
 * and the wiring of server push events into the stores.
 */

import { useEffect, useRef, useState } from 'react'
import { FolderPlus, PanelLeftOpen, Pin, Presentation, X } from 'lucide-react'
import clsx from 'clsx'
import { TopBar, NewProjectDialog } from './components/TopBar'
import { FileTree } from './components/FileTree'
import { MiddleEllipsis } from './components/MiddleEllipsis'
import { Splitter } from './components/Splitter'
import { ChatPanel } from './chat/ChatPanel'
import { DeckView } from './deck/DeckView'
import { PdfView } from './pdf/PdfView'
import { ImageView, MarkdownView, OtherView, TextView } from './viewers/Viewers'
import { SheetView } from './viewers/SheetView'
import { docKind, useApp } from './store/appStore'
import { useChat } from './store/chatStore'
import { useNotes } from './store/notesStore'
import { useAgent } from './store/agentStore'
import { useFileVersions } from './store/fileVersions'
import { onServerEvent } from './api/events'
import { handleDeckFileEvent } from './deck/deckStore'
import { handlePdfFileEvent } from './pdf/pdfStore'
import { handleScreenshot } from './screenshot'
import { markChangedOnFileEvent } from './store/tabKeeping'

export default function App() {
  const { projectId, projects, loadProjects, widths, setWidth, filesCollapsed, setFilesCollapsed } = useApp()
  const [loaded, setLoaded] = useState(false)
  const treeTimer = useRef<ReturnType<typeof setTimeout>>(undefined)

  useEffect(() => {
    loadProjects().finally(() => setLoaded(true))
    void useAgent.getState().load()
  }, [loadProjects])

  useEffect(() => {
    if (!projectId) return
    void useChat.getState().load(projectId)
    void useNotes.getState().load(projectId)
  }, [projectId])

  useEffect(
    () =>
      onServerEvent((ev) => {
        const pid = useApp.getState().projectId
        switch (ev.type) {
          case 'file':
            markChangedOnFileEvent(ev)
            useFileVersions.getState().bump(ev.projectId, ev.path)
            handleDeckFileEvent(ev.projectId, ev.path, ev.etag, ev.writer)
            handlePdfFileEvent(ev.projectId, ev.path, ev.etag, ev.writer)
            break
          case 'tree':
            if (ev.projectId === pid) {
              clearTimeout(treeTimer.current)
              treeTimer.current = setTimeout(() => void useApp.getState().refreshTree(), 300)
            }
            break
          case 'notes':
            if (ev.projectId === pid) void useNotes.getState().load(ev.projectId)
            break
          case 'screenshot':
            void handleScreenshot(ev)
            break
          case 'hello':
          case 'resync':
            if (pid) {
              void useNotes.getState().load(pid)
              void useApp.getState().refreshTree()
            }
            useChat.getState().handleEvent(ev)
            break
          default:
            useChat.getState().handleEvent(ev)
        }
      }),
    [],
  )

  return (
    <div className="flex h-screen flex-col bg-paper font-ui text-ink">
      <TopBar />
      {projectId ? (
        <div className="flex min-h-0 flex-1">
          {filesCollapsed ? (
            <div className="flex w-8 shrink-0 flex-col items-center border-r border-hair bg-paper pt-1.5">
              <button className="icon-btn" title="Show the files panel" onClick={() => setFilesCollapsed(false)}><PanelLeftOpen size={15} /></button>
            </div>
          ) : (
            <>
              <div className="shrink-0" style={{ width: widths.tree }}><FileTree /></div>
              <Splitter width={widths.tree} min={160} max={480} onChange={(w) => setWidth('tree', w)} />
            </>
          )}
          <div className="flex min-w-0 flex-1 flex-col bg-panel">
            <DocTabs />
            <DocArea pid={projectId} />
          </div>
          <Splitter width={widths.chat} min={300} max={900} side="right" onChange={(w) => setWidth('chat', w)} />
          <div className="shrink-0" style={{ width: widths.chat }}><ChatPanel /></div>
        </div>
      ) : loaded ? (
        <Welcome hasProjects={projects.length > 0} />
      ) : null}
      <Toasts />
    </div>
  )
}

function DocTabs() {
  const { tabs, kept, activePath, projectId, openFile, closeTab, keepTab } = useApp()
  if (!tabs.length) return null
  return (
    <div className="flex h-9 shrink-0 items-end gap-0.5 overflow-x-auto border-b border-hair bg-paper px-1">
      {tabs.map((t) => {
        const preview = !kept.includes(t)
        return (
        <div
          key={t}
          className={clsx(
            'group flex h-8 max-w-[220px] cursor-pointer items-center gap-1.5 rounded-t-md border border-b-0 px-2.5 text-xs',
            t === activePath ? 'border-hair bg-panel text-ink' : 'border-transparent text-ink-3 hover:bg-black/5',
          )}
          onClick={() => openFile(t)}
          onDoubleClick={() => projectId && keepTab(projectId, t)}
          title={preview ? `${t}\nPreview — opening another file replaces this tab. Pin it (or double-click) to keep it open; it also stays once you or the agent change the file.` : t}
          data-preview={preview || undefined}
        >
          <MiddleEllipsis name={t.split('/').pop() ?? t} className={clsx(preview && 'italic')} />
          {/* A preview tab can be kept with one click — the next file then opens in a new tab. */}
          {preview && (
            <button
              className={clsx('shrink-0 text-ink-3 hover:text-accent group-hover:block', t === activePath ? 'block' : 'hidden')}
              title="Keep this tab open — the next file opens in a new tab"
              onClick={(e) => { e.stopPropagation(); if (projectId) keepTab(projectId, t) }}
            >
              <Pin size={12} />
            </button>
          )}
          <button className="hidden shrink-0 text-ink-3 hover:text-ink group-hover:block" title="Close" onClick={(e) => { e.stopPropagation(); closeTab(t) }}><X size={12} /></button>
        </div>
        )
      })}
    </div>
  )
}

function DocArea({ pid }: { pid: string }) {
  const activePath = useApp((s) => s.activePath)
  if (!activePath) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 text-sm text-ink-3">
        <Presentation size={28} className="text-ink-3" />
        Open a deck (.pptx), a PDF or a document from the folder on the left.
      </div>
    )
  }
  switch (docKind(activePath)) {
    case 'pptx': return <DeckView key={activePath} pid={pid} path={activePath} />
    case 'pdf': return <PdfView key={activePath} pid={pid} path={activePath} />
    case 'markdown': return <MarkdownView key={activePath} pid={pid} path={activePath} />
    case 'text': return <TextView key={activePath} pid={pid} path={activePath} />
    case 'image': return <ImageView key={activePath} pid={pid} path={activePath} />
    case 'sheet': return <SheetView key={activePath} pid={pid} path={activePath} />
    default: return <OtherView pid={pid} path={activePath} />
  }
}

function Welcome({ hasProjects }: { hasProjects: boolean }) {
  const [creating, setCreating] = useState(false)
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
      <Presentation size={40} className="text-accent" />
      <div>
        <div className="text-lg font-semibold">Work on decks with an AI agent</div>
        <div className="mt-1 max-w-md text-sm text-ink-3">
          Pick a folder with your PowerPoint and PDF files. You and the agent take turns: your edits are saved straight into the file, and the agent’s changes appear live.
        </div>
      </div>
      <button className="btn-primary px-4 py-2" onClick={() => setCreating(true)}><FolderPlus size={16} /> {hasProjects ? 'New project' : 'Create your first project'}</button>
      {creating && <NewProjectDialog onClose={() => setCreating(false)} />}
    </div>
  )
}

function Toasts() {
  const toasts = useApp((s) => s.toasts)
  return (
    <div className="pointer-events-none fixed bottom-4 left-1/2 z-[100] flex -translate-x-1/2 flex-col items-center gap-2">
      {toasts.map((t) => (
        <div key={t.id} className={clsx('pointer-events-auto max-w-lg rounded-lg px-4 py-2 text-sm shadow-lg', t.kind === 'error' ? 'bg-red-700 text-white' : 'bg-ink text-white')}>
          {t.text}
        </div>
      ))}
    </div>
  )
}
