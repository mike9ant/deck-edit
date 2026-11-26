/**
 * A PPTX document: toolbar + [mini-slides rail | main slide]. Owns the
 * deck session's lifetime (open on mount) and shows the live state: saving,
 * "agent is working" (editing paused), and "updated by the agent".
 */

import { useEffect, useRef, useState } from 'react'
import {
  AlignCenterHorizontal, AlignCenterVertical, AlignEndHorizontal, AlignEndVertical,
  AlignStartHorizontal, AlignStartVertical, ExternalLink, Eye, EyeOff, Loader2, MessageSquareText, Redo2, Type, Undo2, Sparkles, X,
} from 'lucide-react'
import clsx from 'clsx'
import { useDecks, deckKey } from './deckStore'
import { SlideRail } from './SlideRail'
import { SlideEditor, type AlignKind, type FormatState, type NodeOrder, type SlideActions } from './SlideEditor'
import { FormatTools } from './FormatTools'
import { NotesPane } from './NotesPane'
import { FindBar, FindMarks, useFindShortcuts } from './FindBar'
import { useFind } from './find'
import { useMenuActions } from '../desktopMenu'
import { CompareWithDialog } from './CompareWithDialog'
import { askConfirm } from '../components/confirmDialog'
import { NoteToolButton, SelectToolButton, useEscapeEndsNoteMode } from '../notes/NoteDrawing'
import { Splitter } from '../components/Splitter'
import { useInnerWidth } from '../components/useInnerWidth'
import { useApp } from '../store/appStore'
import { useReveal } from '../store/revealStore'
import { useEditMode } from '../store/editGuard'
import { EditDisabledChip } from '../components/EditNotice'
import { useChat } from '../store/chatStore'
import { api } from '../api/client'
import { compareForAgent, reviewUnsaved, useCompare } from './compareStore'
import { BaseSlideView, CompareBar, DiffOverlay, SlideFrame, useCompareDiff, type SlideMark } from './CompareView'
import { CommentMarkers, useDeckComments } from './CommentsView'
import { AppliedNote, ReviewHeader } from './ReviewView'
import { reviewItems, rowItems, rowKey, rowState, shapeKey, type Decision, type Decisions } from './review'
import type { SlideDiff } from './deckDiff'
import type { PresentationData } from '@diceui/pptx-core'

/** A render version per review preview (each rebuild is a new presentation, so its slides render anew). */
const previewVersions = new WeakMap<PresentationData, number>()
let previewCounter = 1_000_000
const previewVersion = (p: PresentationData) => previewVersions.get(p) ?? (previewVersions.set(p, ++previewCounter), previewCounter)

/** Accept / reject a whole slide (all its changes), in a banner. */
function SlideDecision({ row, decisions, decide, labels }: { row: SlideDiff; decisions: Decisions; decide(keys: string[], d: Decision | null): void; labels: [string, string] }) {
  const items = rowItems(row)
  if (!items.length) return null
  const st = rowState(items, decisions)
  const keys = items.map((i) => i.key)
  // When the speaker notes changed too: accept the slide with its notes, or without them.
  const notes = items.filter((i) => i.kind === 'notes')
  const rest = items.filter((i) => i.kind !== 'notes')
  const withoutNotes = notes.length > 0 && rest.length > 0 && rowState(rest, decisions) === 'accept' && notes.every((i) => decisions[i.key] !== 'accept')
  const on = 'border-emerald-600 bg-emerald-600 text-white'
  const off = 'border-emerald-300 bg-white text-emerald-700 hover:bg-emerald-50'
  return (
    <span className="ml-2 inline-flex flex-wrap items-center gap-1">
      {notes.length > 0 && rest.length > 0 ? (
        <>
          <button className={clsx('rounded border px-1.5 py-px', st === 'accept' ? on : off)} title="Accept every change on this slide, and its speaker notes" onClick={() => decide(keys, st === 'accept' ? null : 'accept')}>✓ {labels[0]} + notes</button>
          <button
            className={clsx('rounded border px-1.5 py-px', withoutNotes ? on : off)}
            title="Accept the slide's changes but not its speaker notes (they stay as in From)"
            onClick={() => {
              if (withoutNotes) return decide(rest.map((i) => i.key), null)
              decide(rest.map((i) => i.key), 'accept')
              if (notes.some((i) => decisions[i.key] === 'accept')) decide(notes.map((i) => i.key), null)
            }}
          >✓ {labels[0]} − notes</button>
        </>
      ) : (
        <button className={clsx('rounded border px-1.5 py-px', st === 'accept' ? on : off)} onClick={() => decide(keys, st === 'accept' ? null : 'accept')}>✓ {labels[0]}</button>
      )}
      <button className={clsx('rounded border px-1.5 py-px', st === 'reject' ? 'border-ink-3 bg-ink-3 text-white' : 'border-hair bg-white text-ink-2 hover:bg-paper')} onClick={() => decide(keys, st === 'reject' ? null : 'reject')}>✗ {labels[1]}</button>
      {st === 'mixed' && !withoutNotes && <span className="text-ink-3">(some accepted)</span>}
    </span>
  )
}

/** Width of the "what changed" column beside the thumbnails while comparing. */
const SUMMARY_W = 168

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
  const actions = useRef<SlideActions>({ addTextBox() {}, align() {}, arrange() {}, setFont() {}, setSize() {}, stepSize() {}, setColor() {}, holdSelection() {}, releaseSelection() {} })
  const [fmt, setFmt] = useState<FormatState | null>(null)
  const editOff = useEditMode() === 'off'
  // PowerPoint review comments: counted always (toolbar, thumbnails), shown on the slide when toggled on.
  const comments = useDeckComments(session?.pres)
  const [showComments, setShowComments] = useState(false)
  const compare = useCompare((s) => s.compares[key])
  useCompareDiff(session, compare)
  useFindShortcuts(key)
  const findOpen = useFind((s) => s.deck === key)
  const [comparingWith, setComparingWith] = useState(false)

  // The desktop app's Deck and View menus. (Read when the app asks — after this render, so only
  // values set up above, never ones computed below the early returns.)
  useMenuActions(() => {
    const pres = session?.pres
    const reviewing = !!compare?.review
    const fromView = !!(compare?.baseSide?.pres && (compare.removed || compare.view === 'before'))
    const editable = !!pres && !editOff && !reviewing
    const i = session?.slideIndex ?? 0
    const go = (to: number) => {
      useDecks.getState().setSlide(key, to)
      if (compare) useCompare.getState().showRemoved(key, null)
    }
    const leaveReview = async (verb: string, label: string) => {
      const n = reviewUnsaved(compare)
      return !n || (await askConfirm(`${verb}? Your ${n} accepted change(s) haven't been applied and will be lost.`, label))
    }
    return {
      'new-text-box': { enabled: editable && !fromView, run: () => { setNoteMode(false); actions.current.addTextBox() } },
      'note-for-ai': { enabled: !!pres, checked: noteMode, run: () => setNoteMode(!noteMode) },
      'toggle-comments': { enabled: comments.size > 0, checked: showComments && comments.size > 0, run: () => setShowComments(!showComments) },
      'toggle-resolved': { enabled: !!pres, checked: showResolved, run: () => setShowResolved(!showResolved) },
      'next-slide': { enabled: !!pres && i < pres.slides.length - 1, run: () => go(i + 1) },
      'prev-slide': { enabled: !!pres && i > 0, run: () => go(i - 1) },
      'compare-with': { enabled: !!pres && !reviewing, run: () => setComparingWith(true) },
      'review-changes': {
        enabled: !!compare?.diff,
        checked: reviewing,
        run: async () => {
          if (!reviewing) return void useCompare.getState().startReview(key)
          if (await leaveReview('Leave the review', 'Leave review')) useCompare.getState().stopReview(key)
        },
      },
      'close-compare': { enabled: !!compare, run: async () => { if (await leaveReview('Close the comparison', 'Close')) useCompare.getState().close(key) } },
      'open-powerpoint': { enabled: !!pres, run: () => void api.openExternal(pid, path) },
    }
  })

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
        compare: compareForAgent(pid, path),
      }).catch(() => {})
    }, 300)
    return () => clearTimeout(t)
  }, [pid, path, session?.slideIndex, session?.selection, session?.version, compare?.diff, compare?.view, compare?.removed])

  if (!session || (session.loading && !session.pres)) {
    return <Centered><Loader2 className="animate-spin" size={18} /> Opening {path.split('/').pop()}…</Centered>
  }
  if (session.error && !session.pres) return <Centered className="text-red-700">{session.error}</Centered>
  const pres = session.pres!

  // Comparing: the current slide's changes, and what the main view shows (the live slide, its base
  // version, or a removed slide).
  const current = pres.slides[session.slideIndex]
  const diffRow = compare?.diff?.rows.find((r) => r.newSlide === current?.id)
  const basePres = compare?.baseSide?.pres ?? null
  const removedRow = compare?.removed ? compare.diff?.rows.find((r) => r.oldSlide === compare.removed) : undefined
  const baseName = compare?.baseInfo?.name ?? compare?.base.path.split('/').pop() ?? ''
  const review = compare?.review ?? null
  const decide = (keys: string[], d: Decision | null) => useCompare.getState().decide(key, keys, d)
  const baseView = compare && basePres && (compare.removed || compare.view === 'before')
    ? compare.removed
      ? <BaseSlideView deckKey={key} pres={basePres} slideId={compare.removed} shapes={[]} marks={false}
          frame={{ kind: 'removed', label: `Removed slide (was slide ${(removedRow?.oldIndex ?? 0) + 1})` }}
          banner={<>Removed slide — slide {(removedRow?.oldIndex ?? 0) + 1} of <b>{baseName}</b>{compare.baseInfo?.detail ? ` (${compare.baseInfo.detail})` : ''}, read-only{review && removedRow && <SlideDecision row={removedRow} decisions={review.decisions} decide={decide} labels={['Remove it', 'Keep it']} />}</>} />
      : <BaseSlideView deckKey={key} pres={basePres} slideId={diffRow?.oldSlide ?? null} shapes={diffRow?.shapes ?? []} marks={compare.marks}
          banner={<>From — slide {diffRow?.oldIndex != null ? diffRow.oldIndex + 1 : '–'} of <b>{baseName}</b>{compare.baseInfo?.detail ? ` (${compare.baseInfo.detail})` : ''}, read-only. Switch to <b>To</b> to edit.</>} />
    : null
  const ratio = basePres ? pres.width / basePres.width : 1
  // Reviewing: the slide shows what Apply would make of it — To with the rejected changes put back
  // (the preview), read-only — with each change's decision on its tag.
  const reviewFrame: SlideMark | undefined = review && diffRow
    ? diffRow.status === 'added'
      ? review.decisions[`${rowKey(diffRow)}|slide-added`] === 'reject' ? { kind: 'removed', label: 'New slide — not added' } : { kind: 'added', label: review.decisions[`${rowKey(diffRow)}|slide-added`] === 'accept' ? '✓ New slide — accepted' : 'Added slide' }
      : diffRow.movedFrom ? { kind: 'moved', label: review.decisions[`${rowKey(diffRow)}|slide-moved`] === 'accept' ? `✓ Moved to slide ${(diffRow.newIndex ?? 0) + 1} from ${diffRow.movedFrom}` : review.decisions[`${rowKey(diffRow)}|slide-moved`] === 'reject' ? `Stays at slide ${diffRow.movedFrom} (move not accepted)` : `Moved to slide ${(diffRow.newIndex ?? 0) + 1} from ${diffRow.movedFrom}` }
        : undefined
    : undefined
  const reviewView = review && !baseView && current ? (
    <BaseSlideView
      deckKey={`${key}#review`}
      pres={review.preview ?? pres}
      version={review.preview ? previewVersion(review.preview) : (session.slideVersions[current.id] ?? session.version)}
      slideId={current.id}
      shapes={[]}
      marks={false}
      tone="violet"
      frame={reviewFrame}
      banner={<>
        <b>Reviewing</b> — accept (✓) or reject (✗) each change, or the whole slide; the slide shows the result (rejected changes put back). Read-only.
        {review.building && <Loader2 size={11} className="ml-1 inline animate-spin" />}
        {review.error && <span className="ml-1 text-red-700">{review.error}</span>}
        {diffRow && <SlideDecision row={diffRow} decisions={review.decisions} decide={decide} labels={['Accept slide', 'Reject slide']} />}
      </>}
      overlay={(scale) => diffRow && diffRow.shapes.length > 0 ? (
        <DiffOverlay
          shapes={diffRow.shapes}
          scale={scale}
          side="after"
          ratio={ratio}
          focus={compare!.hover}
          review={{ decisionOf: (s) => review.decisions[shapeKey(diffRow, s)], onDecide: (ss, d) => decide(ss.map((s) => shapeKey(diffRow, s)), d) }}
        />
      ) : null}
    />
  ) : null
  const slideComments = (current && comments.get(current.id)) ?? []
  // The slide itself: new, or moved (with marks on, a frame around it says so).
  const slideMark: SlideMark | undefined = !compare?.marks || !diffRow ? undefined
    : diffRow.status === 'added' ? { kind: 'added', label: 'Added slide' }
      : diffRow.movedFrom ? { kind: 'moved', label: `Moved to slide ${(diffRow.newIndex ?? 0) + 1} from ${diffRow.movedFrom}` }
        : undefined
  const diffMarks = !!(compare?.marks && diffRow && (diffRow.shapes.length || slideMark))

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
    <div className="flex min-h-0 flex-1 flex-col" onKeyDown={onKeyDown} data-deck-root="">
      {comparingWith && <CompareWithDialog pid={pid} path={path} onClose={() => setComparingWith(false)} />}
      {compare && <CompareBar compare={compare} session={session} />}
      {compare?.review?.applied && <AppliedNote compare={compare} />}
      <div className="toolbar-fit flex h-10 shrink-0 items-center gap-1 border-b border-hair bg-panel px-2">
        {editOff || compare?.review ? (
          <>
            <SelectToolButton active={!noteMode} onSelect={() => setNoteMode(false)} />
            <div className="mx-1 h-5 w-px bg-hair" />
            {compare?.review ? <span className="rounded-full bg-violet-100 px-2 py-0.5 text-[11px] font-medium text-violet-800">Reviewing — read-only</span> : <EditDisabledChip />}
          </>
        ) : (
          <>
            <button className="icon-btn" title="Undo (⌘Z)" disabled={!session.undo.length} onClick={() => undo(key)}><Undo2 size={16} /></button>
            <button className="icon-btn" title="Redo (⇧⌘Z)" disabled={!session.redo.length} onClick={() => void redo(key)}><Redo2 size={16} /></button>
            <div className="mx-1 h-5 w-px bg-hair" />
            <SelectToolButton active={!noteMode} onSelect={() => setNoteMode(false)} />
            <button className="tool-btn" onClick={() => { setNoteMode(false); actions.current.addTextBox() }} title="Add a text box"><Type size={15} /> <span className="tb-label">Text</span></button>
            {fmt && !noteMode && <FormatTools fmt={fmt} pres={pres} version={session.version} actions={actions} />}
            {session.selection.length >= 1 && <ArrangeTools onArrange={(o) => actions.current.arrange(o)} />}
            {session.selection.length >= 2 && <AlignTools count={session.selection.length} onAlign={(k) => actions.current.align(k)} />}
          </>
        )}
        <div className="ml-2 min-w-0 truncate whitespace-nowrap text-xs text-ink-3">
          Slide {session.slideIndex + 1} / {pres.slides.length}
          {session.selection.length > 0 && ` · ${session.selection.length} selected`}
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-2 whitespace-nowrap text-xs text-ink-3">
          {/* Notes for the agent — not an editing tool, so they sit apart from the edit tools. */}
          <NoteToolButton active={noteMode} onToggle={() => setNoteMode(!noteMode)} />
          {comments.size > 0 && (
            <button
              className={clsx('tool-btn', showComments && 'bg-sky-100 text-sky-800 hover:bg-sky-100')}
              aria-pressed={showComments}
              title={`${showComments ? 'Hide' : 'Show'} the deck's review comments (${[...comments.values()].reduce((n, c) => n + c.length, 0)} in all) — this slide has ${slideComments.length || 'none'}`}
              onClick={() => setShowComments(!showComments)}
            >
              <MessageSquareText size={15} />
              <span className="tb-label">Comments</span>
              {slideComments.length > 0 && <span className={clsx('rounded-full px-1.5 text-[10px] font-semibold leading-4', showComments ? 'bg-sky-600 text-white' : 'bg-sky-100 text-sky-800')}>{slideComments.length}</span>}
            </button>
          )}
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
        <SlideRail
          session={session}
          width={railShown + (compare ? SUMMARY_W : 0)}
          comments={comments}
          compare={compare ? {
            diff: compare.diff, basePres, removed: compare.removed, summaryW: SUMMARY_W,
            onShowRemoved: (id) => useCompare.getState().showRemoved(key, id),
            // A summary line: its slide, its shapes selected (marks stay on), on the live slide.
            onPick: (i, line) => {
              useDecks.getState().setSlide(key, i)
              useCompare.getState().update(key, { removed: null, view: 'after', marks: true, hover: null })
              const slide = useDecks.getState().sessions[key]?.pres?.slides[i]
              const ids = line?.kind === 'removed' ? [] : (line?.ids ?? []).filter((id) => slide?.nodes.some((n) => n.id === id))
              useDecks.getState().setSelection(key, ids)
            },
            // Hovering a line of the slide in view marks its shapes there.
            onHover: (i, ids) => useCompare.getState().update(key, { hover: ids && i === useDecks.getState().sessions[key]?.slideIndex ? ids : null }),
            review: review && compare.diff ? { decisions: review.decisions, decide, header: <ReviewHeader compare={compare} items={reviewItems(compare.diff)} onDecide={decide} /> } : undefined,
          } : undefined}
        />
        <Splitter width={railShown} min={120} max={420} onChange={(w) => setWidth('rail', w)} />
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="relative flex min-h-0 flex-1 flex-col">
            {baseView ?? reviewView ?? (
              <SlideEditor
                session={session}
                noteMode={noteMode}
                setNoteMode={setNoteMode}
                showResolved={showResolved}
                registerActions={(a) => (actions.current = a)}
                onFormat={setFmt}
                overlay={(diffMarks || findOpen || (showComments && slideComments.length > 0)) ? (scale) => (
                  <>
                    {diffMarks && diffRow.shapes.length > 0 && <DiffOverlay shapes={diffRow.shapes} scale={scale} side="after" focus={compare.hover} ratio={ratio} />}
                    {diffMarks && slideMark && <SlideFrame mark={slideMark} />}
                    {findOpen && <FindMarks deckKey={key} slideIndex={session.slideIndex} scale={scale} />}
                    {showComments && current && slideComments.length > 0 && <CommentMarkers comments={slideComments} slide={current} scale={scale} slideW={pres.width} />}
                  </>
                ) : undefined}
              />
            )}
            <ReloadingBadge active={session.reloading} />
            {findOpen && <FindBar session={session} />}
          </div>
          <NotesPane session={session} />
        </div>
      </div>
    </div>
  )
}

/**
 * Over the slide while the deck reloads after a save from outside (the agent) — only when that
 * takes more than a moment, so a quick reload doesn't flash it.
 */
function ReloadingBadge({ active }: { active: boolean }) {
  const [shown, setShown] = useState(false)
  useEffect(() => {
    if (!active) return setShown(false)
    const t = setTimeout(() => setShown(true), 100)
    return () => clearTimeout(t)
  }, [active])
  if (!shown) return null
  return (
    <div className="pointer-events-none absolute bottom-3 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-ink/80 px-3 py-1 text-xs text-white shadow-lg" data-deck-reloading="">
      <Loader2 size={12} className="animate-spin" /> Updating the deck with the latest save…
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
