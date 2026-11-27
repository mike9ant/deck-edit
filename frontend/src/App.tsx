/**
 * Layout: project bar on top, then
 *   [folder tree] | [document: mini-slides + slide | PDF pages | reader] | [agent chat tabs]
 * and the wiring of server push events into the stores.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { Bot, FolderPlus, PanelLeftOpen, Pin, Presentation, X } from 'lucide-react'
import { TabStrip } from './components/TabStrip'
import { EditNotice } from './components/EditNotice'
import clsx from 'clsx'
import { TopBar, NewProjectDialog } from './components/TopBar'
import { FileTree } from './components/FileTree'
import { MiddleEllipsis } from './components/MiddleEllipsis'
import { NoteCountBadge } from './notes/NoteCountBadge'
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
import { decksUnsaved, flushDeck, flushDeckSaves, handleDeckFileEvent } from './deck/deckStore'
import { handlePdfFileEvent } from './pdf/pdfStore'
import { handleScreenshot } from './screenshot'
import { handleCompareRequest, handleReviewRequest, reviewUnsaved, useCompare } from './deck/compareStore'
import { askConfirm } from './components/confirmDialog'
import { markChangedOnFileEvent } from './store/tabKeeping'
import { useMenuActions, type MenuAction } from './desktopMenu'
import { flushTextSaves } from './viewers/textEdits'
import { api } from './api/client'

export default function App() {
  const { projectId, projects, loadProjects, widths, setWidth, filesCollapsed, setFilesCollapsed, chatCollapsed, setChatCollapsed, activePath } = useApp()
  const [loaded, setLoaded] = useState(false)
  const treeTimer = useRef<ReturnType<typeof setTimeout>>(undefined)

  // The desktop app's menu bar: File and View items about the window's panels and the open file.
  useMenuActions(() => ({
    save: { enabled: !!projectId, run: saveEverything },
    'close-tab': { enabled: !!(projectId && activePath), run: () => projectId && activePath && void closeTabAsking(projectId, activePath) },
    reveal: { enabled: !!projectId, run: () => projectId && void api.reveal(projectId, activePath ?? '') },
    'toggle-files': { enabled: !!projectId, checked: !!projectId && !filesCollapsed, run: () => setFilesCollapsed(!filesCollapsed) },
    'toggle-chat': { enabled: !!projectId, checked: !!projectId && !chatCollapsed, run: () => setChatCollapsed(!chatCollapsed) },
    ...agentMenuActions(projectId, () => setChatCollapsed(false)),
  }))

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
          case 'compare':
            void handleCompareRequest(ev)
            break
          case 'review':
            void handleReviewRequest(ev)
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

  // ⌘S (and File → Save): write everything with unsaved edits now — decks (typing in progress too)
  // and text files. (Otherwise ~10 s after the last edit, or when the file is needed.)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== 's') return
      e.preventDefault()
      saveEverything()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  // Leaving the app (another app, the window hidden or closed): write the decks' edits now.
  useEffect(() => {
    const flush = () => void flushDeckSaves()
    const onHidden = () => document.visibilityState === 'hidden' && flush()
    const onUnload = (e: BeforeUnloadEvent) => {
      if (!decksUnsaved()) return
      flush()
      e.preventDefault() // a browser asks before leaving (the desktop app waits for the flush itself)
    }
    window.addEventListener('blur', flush)
    document.addEventListener('visibilitychange', onHidden)
    window.addEventListener('beforeunload', onUnload)
    return () => {
      window.removeEventListener('blur', flush)
      document.removeEventListener('visibilitychange', onHidden)
      window.removeEventListener('beforeunload', onUnload)
    }
  }, [])

  // While a mouse drag is selecting text, floating note badges and buttons ignore the pointer: one
  // passed over mid-drag would pull the selection to it (they come after the text in the page).
  useEffect(() => {
    const root = document.documentElement
    const down = (e: PointerEvent) => {
      if (e.button === 0 && !(e.target as Element | null)?.closest?.('button, [data-note-popover], .md-note-badge')) root.classList.add('drag-selecting')
    }
    const up = () => root.classList.remove('drag-selecting')
    document.addEventListener('pointerdown', down, true)
    document.addEventListener('pointerup', up, true)
    document.addEventListener('pointercancel', up, true)
    return () => {
      document.removeEventListener('pointerdown', down, true)
      document.removeEventListener('pointerup', up, true)
      document.removeEventListener('pointercancel', up, true)
    }
  }, [])

  return (
    <div className="flex h-screen flex-col bg-paper font-ui text-ink">
      <TopBar />
      {projectId ? (
        // On a narrow window the side panels give way (down to their minimums) before the document pane,
        // which keeps 480px and clips what doesn't fit — nothing spills over the chat.
        <div className="flex min-h-0 flex-1 overflow-hidden">
          {filesCollapsed ? (
            <div className="flex w-8 shrink-0 flex-col items-center border-r border-hair bg-paper pt-1.5">
              <button className="icon-btn" title="Show the files panel" onClick={() => setFilesCollapsed(false)}><PanelLeftOpen size={15} /></button>
            </div>
          ) : (
            <>
              <div className="min-w-[160px] shrink" style={{ width: widths.tree }}><FileTree /></div>
              <Splitter width={widths.tree} min={160} max={480} onChange={(w) => setWidth('tree', w)} />
            </>
          )}
          <div className="flex min-w-[480px] flex-1 flex-col overflow-hidden bg-panel">
            <DocTabs />
            <DocArea pid={projectId} />
          </div>
          {chatCollapsed ? (
            <div className="flex w-8 shrink-0 flex-col items-center border-l border-hair bg-paper pt-1.5">
              <button className="icon-btn" title="Show the AI agent panel" onClick={() => setChatCollapsed(false)}><Bot size={15} /></button>
            </div>
          ) : (
            <>
              <Splitter width={widths.chat} min={300} max={900} side="right" onChange={(w) => setWidth('chat', w)} />
              <div className="min-w-[300px] shrink" style={{ width: widths.chat }}><ChatPanel /></div>
            </>
          )}
        </div>
      ) : loaded ? (
        <Welcome hasProjects={projects.length > 0} />
      ) : null}
      <Toasts />
      <EditNotice />
    </div>
  )
}

/**
 * The open files. When they don't fit: no scrollbar — the wheel scrolls them sideways, and ‹ / ›
 * appear on the side with more tabs. The active tab is kept in view.
 */
function DocTabs() {
  const { tabs, kept, activePath, projectId, openFile, closeTab, keepTab } = useApp()
  // The open tabs' names: each is shortened to keep what sets it apart from the others.
  const names = useMemo(() => tabs.map((t) => t.split('/').pop() ?? t), [tabs])
  if (!tabs.length) return null
  return (
    <div className="flex h-9 shrink-0 items-end border-b border-hair bg-paper">
    <TabStrip active={activePath} count={tabs.length}>
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
          data-active-tab={t === activePath || undefined}
          title={preview ? `${t}\nPreview — opening another file replaces this tab. Pin it (or double-click) to keep it open; it also stays once you or the agent change the file.` : t}
          data-preview={preview || undefined}
        >
          <MiddleEllipsis name={t.split('/').pop() ?? t} siblings={names} className={clsx(preview && 'italic')} />
          <NoteCountBadge path={t} />
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
          {/* Its space is kept while hidden: showing it on hover mustn't shift the tab's other buttons. */}
          <button className={clsx('shrink-0 text-ink-3 hover:text-ink group-hover:visible', t === activePath ? 'visible' : 'invisible')} title="Close (⌘W in the desktop app)" onClick={(e) => {
            e.stopPropagation()
            if (projectId) void closeTabAsking(projectId, t)
            else closeTab(t)
          }}><X size={12} /></button>
        </div>
        )
      })}
    </TabStrip>
    </div>
  )
}

/**
 * The AI Agent menu's items that don't need the chat panel open (read from the chat store when the
 * desktop app asks): a new chat, stopping the active chat's turn, reverting its last file changes.
 */
function agentMenuActions(projectId: string | null, showPanel: () => void): Record<string, MenuAction> {
  const chat = useChat.getState()
  const active = chat.activeId ? chat.chats[chat.activeId] : undefined
  const running = active?.turns.find((t) => t.status === 'running')
  // The latest turn that changed files and isn't reverted — revertable while its backup is still kept.
  const last = !running ? [...(active?.turns ?? [])].reverse().find((t) => t.changes.length > 0 && !t.reverted) : undefined
  const revertable = last?.snapshotId && !last.backupGone ? last : undefined
  return {
    'new-chat': { enabled: !!projectId, run: () => { showPanel(); void useChat.getState().newChat() } },
    'stop-agent': { enabled: !!running, run: () => active && void useChat.getState().stop(active.id) },
    'revert-last-turn': {
      enabled: !!revertable,
      run: async () => {
        if (!active || !revertable) return
        const n = revertable.changes.length
        const what = revertable.changes.slice(0, 3).map((c) => c.path.split('/').pop()).join(', ') + (n > 3 ? ', …' : '')
        if (!(await askConfirm(`Revert the agent's last changes (${n} file${n > 1 ? 's' : ''}: ${what})? A backup of the current state is kept — Undo revert brings them back.`, 'Revert'))) return
        showPanel()
        void useChat.getState().revert(active.id, revertable.id)
      },
    },
  }
}

/** Write every deck with unsaved edits (and pending text-file saves) now. */
function saveEverything() {
  void flushTextSaves()
  void flushDeckSaves()
}

/** Close a tab — asking first when a review in it has accepted changes not yet applied (they'd be lost). */
async function closeTabAsking(pid: string, path: string) {
  const pending = reviewUnsaved(useCompare.getState().compares[`${pid}:${path}`])
  if (pending && !(await askConfirm(`Close ${path.split('/').pop()}? Your ${pending} accepted change(s) haven't been applied and will be lost.`, 'Close'))) return
  useApp.getState().closeTab(path)
  if (docKind(path) === 'pptx') void flushDeck(`${pid}:${path}`)
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
