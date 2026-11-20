/**
 * A PPTX document: toolbar + [mini-slides rail | main slide]. Owns the
 * deck session's lifetime (open on mount) and shows the live state: saving,
 * "agent is working" (editing paused), and "updated by the agent".
 */

import { useEffect, useRef, useState } from 'react'
import {
  AlignCenterHorizontal, AlignCenterVertical, AlignEndHorizontal, AlignEndVertical,
  AlignStartHorizontal, AlignStartVertical, ExternalLink, Eye, EyeOff, Loader2, Redo2, Type, Undo2, Sparkles, X,
} from 'lucide-react'
import clsx from 'clsx'
import { useDecks, deckKey } from './deckStore'
import { SlideRail } from './SlideRail'
import { SlideEditor, type AlignKind, type FormatState, type NodeOrder, type SlideActions } from './SlideEditor'
import { FormatTools } from './FormatTools'
import { NotesPane } from './NotesPane'
import { NoteToolButton, SelectToolButton, useEscapeEndsNoteMode } from '../notes/NoteDrawing'
import { Splitter } from '../components/Splitter'
import { useInnerWidth } from '../components/useInnerWidth'
import { useApp } from '../store/appStore'
import { useReveal } from '../store/revealStore'
import { useChat } from '../store/chatStore'
import { api } from '../api/client'

export function DeckView({ pid, path }: { pid: string; path: string }) {
  const key = deckKey(pid, path)
  const session = useDecks((s) => s.sessions[key])
  const { open, undo, redo, setSlide } = useDecks()
  const busy = useChat((s) => !!s.busyProjects[pid])
  const railW = useApp((s) => s.widths.rail)
  // On a narrow pane the rail takes at most 40% of it (the slide needs the room); the width you set comes back with space.
  const rowRef = useRef<HTMLDivElement>(null)
  const rowW = useInnerWidth(rowRef, 1200)
  const railShown = Math.min(railW, Math.max(120, Math.floor(rowW * 0.4)))
  const setWidth = useApp((s) => s.setWidth)
  const changed = useApp((s) => s.changed.includes(path))
  const held = session && session.heldFrom != null ? session.undo.length - session.heldFrom : 0
  const [noteMode, setNoteMode] = useState(false)
  const [showResolved, setShowResolved] = useState(false)
  useEscapeEndsNoteMode(noteMode, setNoteMode)
  const [dismissedAt, setDismissedAt] = useState(0)
  const actions = useRef<SlideActions>({ addTextBox() {}, align() {}, arrange() {}, setFont() {}, setSize() {}, stepSize() {}, setColor() {}, holdSelection() {} })
  const [fmt, setFmt] = useState<FormatState | null>(null)

  useEffect(() => {
    void open(pid, path)
  }, [pid, path, open])

  // A chat link to a slide of this deck: go there once the deck is loaded.
  const reveal = useReveal((s) => s.pending)
  const loaded = !!session?.pres
  useEffect(() => {
    if (!loaded || reveal?.path !== path) return
    const loc = useReveal.getState().take(path)
    if (loc?.slide) setSlide(key, loc.slide - 1)
  }, [reveal, loaded, path, key, setSlide])

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
      <div className="toolbar-fit flex h-10 shrink-0 items-center gap-1 border-b border-hair bg-panel px-2">
        <button className="icon-btn" title="Undo (⌘Z)" disabled={!session.undo.length} onClick={() => undo(key)}><Undo2 size={16} /></button>
        <button className="icon-btn" title="Redo (⇧⌘Z)" disabled={!session.redo.length} onClick={() => void redo(key)}><Redo2 size={16} /></button>
        <div className="mx-1 h-5 w-px bg-hair" />
        <SelectToolButton active={!noteMode} onSelect={() => setNoteMode(false)} />
        <button className="tool-btn" onClick={() => { setNoteMode(false); actions.current.addTextBox() }} title="Add a text box"><Type size={15} /> <span className="tb-label">Text</span></button>
        {fmt && !noteMode && <FormatTools fmt={fmt} pres={pres} version={session.version} actions={actions} />}
        {session.selection.length >= 1 && <ArrangeTools onArrange={(o) => actions.current.arrange(o)} />}
        {session.selection.length >= 2 && <AlignTools count={session.selection.length} onAlign={(k) => actions.current.align(k)} />}
        <div className="ml-2 min-w-0 truncate whitespace-nowrap text-xs text-ink-3">
          Slide {session.slideIndex + 1} / {pres.slides.length}
          {session.selection.length > 0 && ` · ${session.selection.length} selected`}
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-2 whitespace-nowrap text-xs text-ink-3">
          {/* Notes for the agent — not an editing tool, so they sit apart from the edit tools. */}
          <NoteToolButton active={noteMode} onToggle={() => setNoteMode(!noteMode)} />
          <button className="icon-btn" onClick={() => setShowResolved(!showResolved)} title={showResolved ? 'Hide resolved notes' : 'Show resolved notes'}>
            {showResolved ? <Eye size={15} /> : <EyeOff size={15} />}
          </button>
          <div className="h-5 w-px bg-hair" />
          {session.saving ? <span className="flex items-center gap-1"><Loader2 size={12} className="animate-spin" /> Saving…</span> : session.dirty ? <span>Unsaved…</span> : changed ? <span>Saved</span> : null}
          <button className="tool-btn" title="Open this deck in PowerPoint" onClick={() => void api.openExternal(pid, path)}><ExternalLink size={14} /> <span className="tb-label">PowerPoint</span></button>
        </div>
      </div>
      {busy && (
        <div className="flex items-center gap-2 border-b border-violet-200 bg-violet-50 px-3 py-1.5 text-xs text-violet-900">
          <Loader2 size={13} className="animate-spin" />
          {held > 0
            ? `The agent is working. Your ${held} edit${held > 1 ? 's are' : ' is'} held and re-applied on top of its changes; saved when it finishes.`
            : 'The agent is working — its changes appear here as it saves. You can keep editing: your edits are re-applied on top of its changes.'}
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
      <div ref={rowRef} className="flex min-h-0 flex-1 overflow-hidden">
        <SlideRail session={session} width={railShown} />
        <Splitter width={railShown} min={120} max={420} onChange={(w) => setWidth('rail', w)} />
        <div className="flex min-w-0 flex-1 flex-col">
          <SlideEditor
            session={session}
            noteMode={noteMode}
            setNoteMode={setNoteMode}
            showResolved={showResolved}
            registerActions={(a) => (actions.current = a)}
            onFormat={setFmt}
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

/** "Spread out evenly": three bars over a double-headed arrow spanning them (the vertical one, rotated, has it on the side). */
function DistributeIcon({ size = 15, vertical = false }: { size?: number; vertical?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" style={vertical ? { transform: 'rotate(90deg)' } : undefined}>
      <g fill="currentColor" stroke="none">
        <rect x="3" y="2.5" width="2.4" height="12.5" rx="1" />
        <rect x="10.8" y="2.5" width="2.4" height="12.5" rx="1" />
        <rect x="18.6" y="2.5" width="2.4" height="12.5" rx="1" />
      </g>
      <path d="M3 20h18M5.5 17.5 3 20l2.5 2.5M18.5 17.5 21 20l-2.5 2.5" />
    </svg>
  )
}
/**
 * Stacking order: two overlapping squares, the selected one (filled) drawn above the other for
 * front/forward and below it for back/backward; an arrow for the direction — double for all the
 * way, single for one step.
 */
function ArrangeIcon({ order, size = 18 }: { order: NodeOrder; size?: number }) {
  const up = order === 'front' || order === 'forward'
  const selected = <rect x="2.5" y="9.5" width="10" height="10" rx="2" fill="currentColor" stroke="currentColor" />
  const other = <rect x="7.5" y="4" width="10" height="10" rx="2" fill={up ? 'none' : 'white'} />
  const arrow = {
    front: 'M18 16.5l2.5-2.5 2.5 2.5M18 20.5l2.5-2.5 2.5 2.5',
    forward: 'M20.5 21v-8M18 15.5l2.5-2.5 2.5 2.5',
    backward: 'M20.5 13v8M18 18.5l2.5 2.5 2.5-2.5',
    back: 'M18 14l2.5 2.5 2.5-2.5M18 18l2.5 2.5 2.5-2.5',
  }[order]
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      {up ? <>{other}{selected}</> : <>{selected}{other}</>}
      <path d={arrow} />
    </svg>
  )
}

const ARRANGE: { order: NodeOrder; title: string }[] = [
  { order: 'front', title: 'Bring to front (⇧⌘↑)' },
  { order: 'forward', title: 'Bring forward (⌘↑)' },
  { order: 'backward', title: 'Send backward (⌘↓)' },
  { order: 'back', title: 'Send to back (⇧⌘↓)' },
]

/** Stacking-order buttons, shown while 1+ shapes are selected. */
function ArrangeTools({ onArrange }: { onArrange(o: NodeOrder): void }) {
  return (
    <div className="ml-1 flex items-center">
      <div className="mx-1 h-5 w-px bg-hair" />
      {ARRANGE.map(({ order, title }) => (
        <button key={order} className="icon-btn h-7 w-7" title={title} onClick={() => onArrange(order)}>
          <ArrangeIcon order={order} />
        </button>
      ))}
    </div>
  )
}

const DistributeH = ({ size }: { size?: number }) => <DistributeIcon size={size} />
const DistributeV = ({ size }: { size?: number }) => <DistributeIcon size={size} vertical />

const ALIGN_GROUPS: { kind: AlignKind; title: string; icon: (p: { size?: number }) => React.ReactNode }[][] = [
  [
    { kind: 'left', title: 'Align left', icon: AlignStartVertical },
    { kind: 'hcenter', title: 'Align centers', icon: AlignCenterVertical },
    { kind: 'right', title: 'Align right', icon: AlignEndVertical },
  ],
  [
    { kind: 'top', title: 'Align tops', icon: AlignStartHorizontal },
    { kind: 'vcenter', title: 'Align middles', icon: AlignCenterHorizontal },
    { kind: 'bottom', title: 'Align bottoms', icon: AlignEndHorizontal },
  ],
  [
    { kind: 'hdistribute', title: 'Distribute horizontally — equal gaps (3+ shapes)', icon: DistributeH },
    { kind: 'vdistribute', title: 'Distribute vertically — equal gaps (3+ shapes)', icon: DistributeV },
  ],
]

/** Compact align/distribute buttons, shown while 2+ shapes are selected. */
function AlignTools({ count, onAlign }: { count: number; onAlign(k: AlignKind): void }) {
  return (
    <div className="ml-1 flex items-center">
      {ALIGN_GROUPS.map((group, gi) => (
        <div key={gi} className="flex items-center">
          <div className="mx-1 h-5 w-px bg-hair" />
          {group.map(({ kind, title, icon: Icon }) => (
            <button
              key={kind}
              className="icon-btn h-7 w-7"
              title={title}
              disabled={kind.endsWith('distribute') && count < 3}
              onClick={() => onAlign(kind)}
            >
              <Icon size={15} />
            </button>
          ))}
        </div>
      ))}
    </div>
  )
}
