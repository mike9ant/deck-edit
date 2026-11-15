/**
 * The agent panel: chat tabs (each a Claude Code conversation), the live
 * transcript, and the composer. Each message carries the user's current view
 * and their edits since the last turn; open slide notes ride along too.
 * After a turn, the files it changed are listed with a one-click Revert.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  AlertTriangle, BotMessageSquare, Check, ChevronDown, ChevronRight, CircleDot, FileEdit, History, Loader2, MessageSquare, SquarePlus, Trash2,
  Plus, RotateCcw, Send, Square, Terminal, Wrench, X, StickyNote, Pencil, Play, ImagePlus, Library,
} from 'lucide-react'
import clsx from 'clsx'
import { askConfirm } from '../components/confirmDialog'
import { QuoteNoteBox } from '../notes/TextNotes'
import { NotePopover, actNowPrompt } from '../notes/NotePins'
import { setQuoteHighlight } from '../notes/quoteHighlight'
import { domRangeOf } from '../viewers/textRanges'
import { useChat } from '../store/chatStore'
import { useApp } from '../store/appStore'
import { notePlaceLabel, noteNumber, notesForChat, useNotes } from '../store/notesStore'
import { useAgent } from '../store/agentStore'
import { useDecks } from '../deck/deckStore'
import { usePdfs } from '../pdf/pdfStore'
import type { Chat, Posture, Turn, TurnEvent } from '../api/types'
import { buildTurnContext, pendingEditCount } from './turnContext'
import { useTextEditTick } from '../viewers/textEdits'
import { PosturePopover } from './PosturePopover'
import { ConversationsPanel } from './ConversationsPanel'
import { APPROVAL_MODES, FALLBACK_MODELS, chatPosture, turnPostureLabel } from './posture'
import { api } from '../api/client'
import { MAX_IMAGES, dragHasFiles, maxImageEdgeFor, prepareImage, splitImageFiles, type PendingImage } from './imageAttachments'

export function ChatPanel() {
  const { openIds, activeId, chats, summaries, newChat, openChat, closeChat } = useChat()
  const [history, setHistory] = useState(false)
  const [library, setLibrary] = useState(false)
  const active = activeId ? chats[activeId] : undefined
  return (
    <div className="flex h-full min-h-0 flex-col bg-panel">
      <div className="flex h-9 shrink-0 items-end gap-0.5 overflow-x-auto border-b border-hair bg-paper px-1">
        {openIds.map((id) => {
          const c = chats[id]
          const running = summaries.find((s) => s.id === id)?.running || !!c?.turns.some((t) => t.status === 'running')
          return (
            <div
              key={id}
              className={clsx(
                'group flex h-8 max-w-[180px] cursor-pointer items-center gap-1.5 rounded-t-md border border-b-0 px-2.5 text-xs',
                id === activeId ? 'border-hair bg-panel text-ink' : 'border-transparent text-ink-3 hover:bg-black/5',
              )}
              onClick={() => { setHistory(false); setLibrary(false); void openChat(id) }}
            >
              {running ? <Loader2 size={12} className="shrink-0 animate-spin text-violet-600" /> : <MessageSquare size={12} className="shrink-0" />}
              <span className="truncate">{c?.title ?? '…'}</span>
              <button className="ml-0.5 hidden shrink-0 text-ink-3 hover:text-ink group-hover:block" onClick={(e) => { e.stopPropagation(); closeChat(id) }}><X size={12} /></button>
            </div>
          )
        })}
        <button className="icon-btn mb-1" title="New chat" onClick={() => { setHistory(false); void newChat() }}><Plus size={15} /></button>
        <button
          className={clsx('icon-btn mb-1 ml-auto', library && 'bg-black/10 text-ink')}
          title={library ? 'Back to the conversation' : 'Claude conversations on this computer — search Cowork, Claude Code and desktop sessions'}
          aria-pressed={library}
          onClick={() => { setHistory(false); setLibrary(!library) }}
        >
          <Library size={15} />
        </button>
        <button
          className={clsx('icon-btn mb-1', history && 'bg-black/10 text-ink')}
          title={history ? 'Back to the conversation' : 'Chat history — every chat in this project'}
          aria-pressed={history}
          onClick={() => {
            if (!history) void useChat.getState().refreshSummaries()
            setLibrary(false)
            setHistory(!history)
          }}
        >
          <History size={15} />
        </button>
      </div>
      {library ? (
        <ConversationsPanel onDone={() => setLibrary(false)} />
      ) : history ? (
        <HistoryPanel onDone={() => setHistory(false)} />
      ) : active ? (
        <ChatBody chat={active} />
      ) : (
        <div className="flex flex-1 items-center justify-center text-sm text-ink-3">Start a chat with +</div>
      )}
    </div>
  )
}

/** Compact relative time ("just now", "3h ago", "2d ago"). */
function relativeTime(iso: string): string {
  const secs = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
  if (Number.isNaN(secs)) return ''
  if (secs < 60) return 'just now'
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

/**
 * Every chat in the project (as in Code Navigator's conversation history):
 * which are open in a tab, which is this tab, which are running. Click a row
 * to show it — an open chat jumps to its tab, a closed one opens in this tab;
 * the row's buttons open it in a new tab or delete it.
 */
function HistoryPanel({ onDone }: { onDone(): void }) {
  // Esc closes the panel, like its × button.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onDone()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onDone])
  const { summaries, openIds, activeId, chats, openChat, openInThisTab, remove } = useChat()
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const activeBusy = !!(activeId && chats[activeId]?.turns.some((t) => t.status === 'running'))
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
      <div className="mb-1 flex items-center px-1 text-[11px] font-semibold uppercase tracking-wide text-ink-3">
        Chats in this project
        <span className="ml-1.5 font-normal normal-case tracking-normal">· {summaries.length}</span>
        <button className="icon-btn ml-auto h-6 w-6" title="Close — back to the current chat (Esc)" onClick={onDone}>
          <X size={14} />
        </button>
      </div>
      {summaries.length === 0 && <p className="px-1 py-2 text-sm text-ink-3">No chats yet.</p>}
      <ul className="space-y-0.5">
        {summaries.map((s) => {
          const open = openIds.includes(s.id)
          const here = s.id === activeId
          const running = s.running || !!chats[s.id]?.turns.some((t) => t.status === 'running')
          return (
            <li key={s.id} className="group flex items-center gap-1">
              <button
                className={clsx('min-w-0 flex-1 rounded-md px-2 py-1.5 text-left hover:bg-paper', here && 'bg-accent-soft/60')}
                title={here ? 'This is the chat in the current tab' : open ? 'Already open — go to its tab' : activeBusy ? 'The current tab is busy, so it opens in a new tab' : 'Open in this tab'}
                onClick={() => {
                  if (open) void openChat(s.id)
                  else if (activeBusy) void openChat(s.id)
                  else void openInThisTab(s.id)
                  onDone()
                }}
              >
                <div className="flex min-w-0 items-center gap-1.5">
                  {running && <Loader2 size={12} className="shrink-0 animate-spin text-violet-600" />}
                  <span className="truncate text-sm text-ink">{s.title || 'Untitled'}</span>
                  {open && (
                    <span className="shrink-0 whitespace-nowrap rounded border border-hair bg-white px-[5px] py-px text-[9px] font-medium uppercase tracking-wide text-ink-3">
                      {here ? 'This tab' : 'Open'}
                    </span>
                  )}
                </div>
                <div className="text-[10px] text-ink-3">
                  {relativeTime(s.updatedAt)} · {s.turnCount} turn{s.turnCount === 1 ? '' : 's'}{running ? ' · working…' : ''}
                </div>
              </button>
              {confirmDelete === s.id ? (
                <span className="flex shrink-0 items-center gap-1">
                  <button className="rounded px-1.5 py-0.5 text-[11px] font-medium text-red-600 hover:bg-red-50" onClick={() => { setConfirmDelete(null); void remove(s.id) }}>Delete</button>
                  <button className="rounded px-1.5 py-0.5 text-[11px] text-ink-3 hover:bg-paper" onClick={() => setConfirmDelete(null)}>Cancel</button>
                </span>
              ) : (
                <>
                  {!open && (
                    <button className="rounded p-1 text-ink-3 opacity-0 hover:bg-paper hover:text-ink group-hover:opacity-100" title="Open in a new tab" onClick={() => { void openChat(s.id); onDone() }}>
                      <SquarePlus size={14} />
                    </button>
                  )}
                  <button
                    className="rounded p-1 text-ink-3 opacity-0 hover:bg-paper hover:text-red-600 group-hover:opacity-100 disabled:opacity-30"
                    disabled={running}
                    title={running ? 'Stop its turn first' : 'Delete chat'}
                    onClick={() => setConfirmDelete(s.id)}
                  >
                    <Trash2 size={14} />
                  </button>
                </>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function ChatBody({ chat }: { chat: Chat }) {
  const drafts = useChat((s) => s.drafts)
  const scroller = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const last = chat.turns[chat.turns.length - 1]
  const draft = last ? drafts[last.id] : ''
  useEffect(() => {
    const el = scroller.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [chat.turns, draft])
  return (
    <>
      <div
        ref={scroller}
        className="relative min-h-0 flex-1 overflow-y-auto px-3 py-3"
        onScroll={(e) => {
          const el = e.currentTarget
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60
        }}
      >
        {chat.turns.length === 0 && <EmptyChat />}
        {chat.turns.map((t, i) => (
          <TurnView key={t.id} chat={chat} turn={t} draft={drafts[t.id]} isLast={i === chat.turns.length - 1} />
        ))}
        <ChatNoteBadges chat={chat} scroller={scroller} />
      </div>
      <ChatQuoteNotes chat={chat} scroller={scroller} />
      <Composer key={chat.id} chat={chat} />
    </>
  )
}

/**
 * Notes for the agent on selected text in the conversation: select part of a
 * message → "Note for AI" next to the selection → pin it (the agent sees it
 * with the next message — this chat's agent only) or act on it right away.
 * Open notes are highlighted in the messages, with a badge to open each (ChatNoteBadges);
 * the composer's notes list shows them with the project's other open notes.
 */
function ChatQuoteNotes({ chat, scroller }: { chat: Chat; scroller: RefObject<HTMLDivElement | null> }) {
  const allNotes = useNotes((s) => s.notes)
  const openNotes = allNotes.filter((n) => n.target === 'chat' && n.slideId === chat.id && n.status === 'open')
  const [sel, setSel] = useState<{ quote: string; left: number; top: number } | null>(null)
  const [draft, setDraft] = useState<{ quote: string; left: number; top: number } | null>(null)

  useEffect(() => {
    const el = scroller.current
    // The button appears once the selection settles (mouse released, or keyboard). Shown mid-drag,
    // it would sit under the pointer, and the selection would jump to it — past the whole chat.
    let dragging = false
    const update = () => {
      if (dragging) return
      const s = window.getSelection()
      const quote = s && !s.isCollapsed && el?.contains(s.anchorNode) && el.contains(s.focusNode) ? s.toString().trim() : ''
      if (!quote || !s) return setSel(null)
      const rects = s.getRangeAt(0).getClientRects()
      const end = rects[rects.length - 1] ?? s.getRangeAt(0).getBoundingClientRect()
      const box = el!.getBoundingClientRect()
      if (end.bottom < box.top || end.top > box.bottom) return setSel(null) // scrolled out of view
      setSel({ quote, left: Math.min(Math.max(end.right - 50, box.left + 4), window.innerWidth - 120), top: Math.min(end.bottom + 6, box.bottom - 30) })
    }
    const down = (e: PointerEvent) => {
      if (e.button !== 0 || (e.target as Element | null)?.closest?.('[data-chat-selbtn]')) return
      dragging = true
      setSel(null)
    }
    const up = () => {
      if (!dragging) return
      dragging = false
      requestAnimationFrame(update)
    }
    document.addEventListener('selectionchange', update)
    document.addEventListener('pointerdown', down)
    document.addEventListener('pointerup', up)
    el?.addEventListener('scroll', update)
    return () => {
      document.removeEventListener('selectionchange', update)
      document.removeEventListener('pointerdown', down)
      document.removeEventListener('pointerup', up)
      el?.removeEventListener('scroll', update)
    }
  }, [scroller])

  const quotesKey = openNotes.map((n) => n.quote).join('\u0000')
  useEffect(() => setQuoteHighlight('chat-note-quote', scroller.current, openNotes.map((n) => n.quote ?? ''), true), [quotesKey, chat.turns, scroller]) // eslint-disable-line react-hooks/exhaustive-deps


  return (
    <>
      {sel && !draft && (
        <button
          data-chat-selbtn
          className="fixed z-50 flex items-center gap-1 rounded-md border border-hair bg-white px-2 py-1 text-xs text-ink-2 shadow-lg hover:bg-paper hover:text-ink"
          style={{ left: sel.left, top: sel.top }}
          title="Add a note for the AI agent about the selected text"
          onMouseDown={(e) => e.preventDefault() /* keep the selection */}
          onClick={() => { setDraft(sel); setSel(null) }}
        >
          <BotMessageSquare size={13} /> Note for AI
        </button>
      )}
      {draft && (
        <QuoteNoteBox
          fixed={{ left: Math.max(8, Math.min(draft.left - 160, window.innerWidth - 330)), top: Math.max(8, Math.min(draft.top, window.innerHeight - 270)) }}
          heading="Note for the agent · on this part of the chat"
          quote={draft.quote}
          placeholder="e.g. use this wording on slide 4, expand on this point"
          onPin={(text) => useNotes.getState().add({ deck: '', slideId: chat.id, slideIndex: 0, x: 0, y: 0, quote: draft.quote, target: 'chat', text })}
          actNow={(n) => actNowPrompt(n, 'chat')}
          onClose={() => setDraft(null)}
        />
      )}
    </>
  )
}

/**
 * Each open note's number just above the end of the text it's about, scrolling
 * with the messages; click it for the note's card (edit, resolve, delete).
 * Re-placed whenever the conversation's content or layout changes (a message
 * streams in, a tool group opens, the panel is resized…), not just when turns change.
 */
function ChatNoteBadges({ chat, scroller }: { chat: Chat; scroller: RefObject<HTMLDivElement | null> }) {
  const all = useNotes((s) => s.notes)
  const notes = all.filter((n) => n.target === 'chat' && n.slideId === chat.id && n.status === 'open')
  const key = notes.map((n) => `${n.id}:${n.quote}`).join('\u0000')
  type Badge = { id: string; label: string; title: string; quote: string; top: number; left: number }
  const [badges, setBadges] = useState<Badge[]>([])
  const [open, setOpen] = useState<{ id: string; at: DOMRect } | null>(null)
  const notesRef = useRef(notes)
  notesRef.current = notes
  useEffect(() => {
    const el = scroller.current
    if (!el) return
    let frame = 0
    let last = ''
    const place = () => {
      frame = 0
      const box = el.getBoundingClientRect()
      const next: Badge[] = notesRef.current.flatMap((n) => {
        const q = n.quote ?? ''
        const r = domRangeOf(el, q, true) ?? domRangeOf(el, q.split('\n').map((l) => l.trim()).find(Boolean) ?? '', true)
        const rects = r ? [...r.getClientRects()].filter((x) => x.width > 0) : []
        const end = rects[rects.length - 1]
        if (!end) return []
        return [{
          id: n.id, label: String(noteNumber(n, useNotes.getState().notes)), title: n.text, quote: q,
          top: Math.round(end.top - box.top + el.scrollTop - 12),
          left: Math.round(Math.min(end.right - box.left + el.scrollLeft - 4, el.clientWidth - 22)),
        }]
      })
      const sig = JSON.stringify(next)
      if (sig !== last) {
        last = sig
        setBadges(next)
      }
    }
    const schedule = () => { if (!frame) frame = requestAnimationFrame(place) }
    place()
    const ro = new ResizeObserver(schedule)
    ro.observe(el)
    for (const c of el.children) ro.observe(c)
    // Content changes (streaming text, opened groups, new turns) — but not the badges' own updates.
    const mo = new MutationObserver((records) => {
      if (records.every((r) => (r.target as Element).closest?.('[data-chat-badges]') ?? r.target.parentElement?.closest('[data-chat-badges]'))) return
      for (const c of el.children) ro.observe(c)
      schedule()
    })
    mo.observe(el, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['open', 'class', 'style'] })
    // And whenever the view moves — a layout shift nothing above reported is fixed by the next scroll.
    el.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', schedule)
    return () => {
      ro.disconnect()
      mo.disconnect()
      el.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
      if (frame) cancelAnimationFrame(frame)
    }
  }, [key, scroller])
  return (
    <div data-chat-badges>
      {badges.map((b) => {
        const note = all.find((n) => n.id === b.id)
        return (
          <div key={b.id} className="absolute z-20" style={{ top: b.top, left: b.left }}>
            <span
              className="md-note-badge"
              style={{ top: 0, left: 0 }}
              title={`${b.title}\n(click to open the note)`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={(e) => setOpen(open?.id === b.id ? null : { id: b.id, at: e.currentTarget.getBoundingClientRect() })}
            >
              {b.label}
            </span>
            {open?.id === b.id && note && <NotePopover note={note} anchor={open.at} onClose={() => setOpen(null)} flipX flipY={false} />}
          </div>
        )
      })}
    </div>
  )
}

function EmptyChat() {
  return (
    <div className="mx-auto mt-8 max-w-sm text-center text-sm text-ink-3">
      <MessageSquare className="mx-auto mb-2 text-ink-3" size={22} />
      Ask the agent to change or create slides, e.g.
      <div className="mt-2 space-y-1 text-left text-[13px] text-ink-2">
        <div className="rounded bg-paper px-2 py-1">“Tighten the copy on this slide and make the headline punchier.”</div>
        <div className="rounded bg-paper px-2 py-1">“Address my notes on slides 4–6.”</div>
        <div className="rounded bg-paper px-2 py-1">“Add a slide after this one comparing us to three competitors.”</div>
      </div>
      <div className="mt-3 text-xs">It sees the slide you’re on, your selection, your edits and your notes. The deck reloads live as it saves.</div>
    </div>
  )
}

function contextSummary(t: Turn) {
  const c = t.context
  if (!c) return null
  const bits: string[] = []
  if (c.deck) bits.push(`${c.deck.split('/').pop()}${c.slideIndex ? ` · ${c.deck.toLowerCase().endsWith('.pdf') ? 'page' : 'slide'} ${c.slideIndex}` : ''}`)
  else if (c.openFile) bits.push(c.openFile.split('/').pop()!)
  if (c.selection?.length) bits.push(`${c.selection.length} selected`)
  if (c.userChanges?.length) bits.push(`${c.userChanges.length} edit${c.userChanges.length > 1 ? 's' : ''} shared`)
  return bits.join(' · ')
}

function TurnView({ chat, turn, draft, isLast }: { chat: Chat; turn: Turn; draft?: string; isLast: boolean }) {
  const { revert, unrevert, answer } = useChat()
  const openFile = useApp((s) => s.openFile)
  const resolved = useMemo(() => {
    const m = new Map<string, string>()
    for (const e of turn.events) if (e.kind === 'permissionResolved') m.set(e.requestId, e.decision)
    return m
  }, [turn.events])
  const ctx = contextSummary(turn)
  const later = chat.turns.slice(chat.turns.indexOf(turn) + 1).some((t) => t.changes.length && !t.reverted)
  const [showEdits, setShowEdits] = useState(false)
  const models = useAgent((s) => s.models)
  const posture = turnPostureLabel(turn, models.length ? models : FALLBACK_MODELS)
  const settingsAuth = useAgent((s) => s.settings?.auth ?? 'subscription')
  // A finished plan-mode turn offers to carry the plan out (the plan is the final message).
  const canImplement = isLast && turn.mode === 'plan' && turn.status === 'done' && !chat.turns.some((t) => t.status === 'running')
  const implement = async () => {
    const lastActing = [...chat.turns].reverse().find((t) => t.mode && t.mode !== 'plan')?.mode
    const p: Posture = { ...chatPosture(chat, { auth: settingsAuth }), mode: lastActing ?? 'acceptEdits' }
    await useChat.getState().send(chat.id, 'Implement the plan above.', await buildTurnContext(true), p)
  }

  return (
    <div className="mb-5">
      <div className="ml-8 rounded-lg bg-accent-soft px-3 py-2 text-sm text-ink">
        {turn.images && turn.images.length > 0 && (
          <div className="mb-1.5 flex flex-wrap gap-1.5">
            {turn.images.map((img) => (
              <a key={img.file} href={api.chatImageUrl(chat.id, img.file)} target="_blank" rel="noreferrer" title={img.name ?? 'attached image'}>
                <img src={api.chatImageUrl(chat.id, img.file)} alt={img.name ?? 'attached image'} className="h-16 max-w-[140px] rounded border border-hair bg-white object-cover" />
              </a>
            ))}
          </div>
        )}
        <div className="whitespace-pre-wrap">{turn.prompt}</div>
        {ctx && (
          <button className="mt-1 flex items-center gap-1 text-[11px] text-ink-3" onClick={() => setShowEdits(!showEdits)}>
            {turn.context?.userChanges?.length ? (showEdits ? <ChevronDown size={11} /> : <ChevronRight size={11} />) : null}
            {ctx}
          </button>
        )}
        {showEdits && turn.context?.userChanges?.length ? (
          <ul className="mt-1 list-disc pl-4 text-[11px] text-ink-2">{turn.context.userChanges.map((c, i) => <li key={i}>{c}</li>)}</ul>
        ) : null}
      </div>
      {posture && <div className="mt-0.5 text-right text-[10px] text-ink-3" title="How this turn ran: approval mode · model · effort">{posture}</div>}
      <div className="mt-2 space-y-1.5">
        {groupEvents(turn.events).map((g, i) =>
          g.type === 'tools' ? (
            <ToolGroup key={i} events={g.events} running={turn.status === 'running' && i === groupEvents(turn.events).length - 1} />
          ) : (
            <EventView key={i} e={g.event} resolved={resolved} onAnswer={answer} onOpen={openFile} />
          ),
        )}
        {draft && (
          <div className="prose prose-sm max-w-none text-ink"><ReactMarkdown remarkPlugins={[remarkGfm]}>{draft}</ReactMarkdown></div>
        )}
        {turn.status === 'running' && !draft && (
          <div className="flex items-center gap-2 text-xs text-ink-3"><Loader2 size={13} className="animate-spin" /> Working…</div>
        )}
        {turn.status === 'stopped' && <div className="text-xs text-ink-3">(Stopped.)</div>}
        {canImplement && (
          <button className="btn-primary mt-1" onClick={() => void implement()} title="Run a new turn that carries out this plan (leaves plan mode)">
            <Play size={13} /> Implement this plan
          </button>
        )}
      </div>
      {turn.status !== 'running' && turn.changes.length > 0 && (
        <div className="mt-2 rounded-lg border border-hair bg-paper p-2 text-xs">
          <div className="mb-1 flex items-center gap-2 font-medium text-ink-2">
            <FileEdit size={13} /> {turn.reverted ? 'Reverted' : 'Changed'} {turn.changes.length} file{turn.changes.length > 1 ? 's' : ''}
            <span className="ml-auto" />
            {turn.snapshotId && !turn.reverted && (
              <button
                className="flex items-center gap-1 rounded border border-hair bg-white px-2 py-0.5 hover:border-red-300 hover:text-red-700"
                title="Restore these files to how they were before this turn (a backup of the current state is kept)"
                onClick={async () => {
                  if (later && !(await askConfirm('Later turns also changed files. Reverting restores the folder to before this turn, undoing those too. Continue?', 'Revert'))) return
                  void revert(chat.id, turn.id)
                }}
              >
                <RotateCcw size={12} /> Revert
              </button>
            )}
            {turn.reverted && (
              <button className="flex items-center gap-1 rounded border border-hair bg-white px-2 py-0.5 hover:bg-paper" onClick={() => void unrevert(chat.id, turn.id)}>
                Undo revert
              </button>
            )}
          </div>
          {turn.changes.map((c) => (
            <button key={c.path} className={clsx('flex w-full items-center gap-1.5 truncate rounded px-1 py-0.5 text-left hover:bg-white', turn.reverted && 'line-through opacity-60')} onClick={() => c.kind !== 'deleted' && openFile(c.path)}>
              <span className={clsx('w-14 shrink-0 text-[10px] uppercase', c.kind === 'created' ? 'text-emerald-700' : c.kind === 'deleted' ? 'text-red-700' : c.kind === 'moved' ? 'text-sky-700' : 'text-amber-700')}>{c.kind}</span>
              <span className="truncate" title={c.from ? `${c.from} → ${c.path}` : c.path}>
                {c.from ? <><span className="text-ink-3">{c.from} → </span>{c.path}</> : c.path}
              </span>
            </button>
          ))}
        </div>
      )}
      {turn.status !== 'running' && <UsageLine turn={turn} />}
    </div>
  )
}

const fmtTokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n))

/** Tokens for every turn; dollars only when the turn was billed to the API key —
 *  on a Claude subscription the CLI's dollar figure is notional, so it's not shown. */
function UsageLine({ turn }: { turn: Turn }) {
  const u = turn.usage
  const billed = turn.auth === 'key' && turn.costUsd != null && turn.costUsd > 0
  if (!u && !billed) return null
  const title = u
    ? `${u.input.toLocaleString()} input tokens (${u.cached.toLocaleString()} from the prompt cache) · ${u.output.toLocaleString()} output tokens` +
      (billed ? ` · billed to the API key` : turn.auth === 'key' ? '' : ' · on your Claude subscription (no per-token charge)')
    : 'Billed to the API key'
  return (
    <div className="mt-1 text-right text-[10px] text-ink-3" title={title}>
      {u && `${fmtTokens(u.input)} in${u.cached ? ` (${fmtTokens(u.cached)} cached)` : ''} · ${fmtTokens(u.output)} out`}
      {billed && <span className="ml-1 font-medium text-ink-2">· ${turn.costUsd!.toFixed(3)}</span>}
    </div>
  )
}

type Group = { type: 'tools'; events: TurnEvent[] } | { type: 'event'; event: TurnEvent }
const TOOL_KINDS = new Set(['activity', 'command', 'fileEdited'])
function groupEvents(events: TurnEvent[]): Group[] {
  const out: Group[] = []
  for (const e of events) {
    if (TOOL_KINDS.has(e.kind)) {
      const last = out[out.length - 1]
      if (last?.type === 'tools') last.events.push(e)
      else out.push({ type: 'tools', events: [e] })
    } else if (e.kind !== 'permissionResolved') out.push({ type: 'event', event: e })
  }
  return out
}

function ToolGroup({ events, running }: { events: TurnEvent[]; running: boolean }) {
  const [open, setOpen] = useState(false)
  const lastActivity = [...events].reverse().find((e) => e.kind === 'activity') as Extract<TurnEvent, { kind: 'activity' }> | undefined
  const steps = events.filter((e) => e.kind === 'activity').length
  const commands = events.filter((e) => e.kind === 'command').length
  const edits = events.filter((e) => e.kind === 'fileEdited').length
  const failed = events.some((e) => e.kind === 'command' && e.exitCode !== 0)
  // A finished last step (e.g. the backup) stops spinning — the wait is now the agent ("Working…" below).
  const spinning = running && !lastActivity?.done
  return (
    <div className="rounded-md border border-hair bg-paper/60 text-xs">
      <button className="flex w-full items-center gap-1.5 px-2 py-1 text-left text-ink-3 hover:text-ink" onClick={() => setOpen(!open)}>
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        {spinning ? <Loader2 size={12} className="animate-spin" /> : <Wrench size={12} />}
        <span className="truncate">
          {(spinning || (steps === 1 && events.length === 1)) && lastActivity
            ? `${toolLabel(lastActivity.tool)} ${lastActivity.detail}`
            : [
                steps ? `${steps} step${steps > 1 ? 's' : ''}` : '',
                commands ? `${commands} command${commands > 1 ? 's' : ''}` : '',
                edits ? `${edits} file edit${edits > 1 ? 's' : ''}` : '',
              ].filter(Boolean).join(' · ')}
        </span>
        {failed && <AlertTriangle size={12} className="ml-auto shrink-0 text-amber-600" />}
      </button>
      {open && (
        <div className="space-y-1 border-t border-hair px-2 py-1.5">
          {events.map((e, i) =>
            e.kind === 'activity' ? (
              <div key={i} className="flex gap-1.5 text-ink-2"><span className="shrink-0 font-medium">{toolLabel(e.tool)}</span><span className="truncate text-ink-3">{e.detail}</span></div>
            ) : e.kind === 'command' ? (
              <details key={i} className="rounded bg-white p-1">
                <summary className="flex cursor-pointer items-center gap-1.5">
                  <Terminal size={11} /> <code className="truncate">{e.command.split('\n')[0]}</code>
                  <span className={clsx('ml-auto shrink-0', e.exitCode === 0 ? 'text-emerald-700' : 'text-red-700')}>{e.exitCode === 0 ? 'ok' : 'failed'}</span>
                </summary>
                <pre className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap break-words text-[11px] text-ink-2">{e.command}{e.output ? `\n\n${e.output}` : ''}</pre>
              </details>
            ) : e.kind === 'fileEdited' ? (
              <div key={i} className="flex items-center gap-1.5 text-emerald-800"><FileEdit size={11} /> {e.path}</div>
            ) : null,
          )}
        </div>
      )}
    </div>
  )
}

const toolLabel = (t: string) =>
  ({ Bash: 'Ran', Read: 'Read', Write: 'Wrote', Edit: 'Edited', MultiEdit: 'Edited', Grep: 'Searched', Glob: 'Listed', backup: 'Backup', list_notes: 'Notes', resolve_note: 'Resolved note', add_note: 'Added note', screenshot_slide: 'Looked at', get_user_view: 'Checked view', WebSearch: 'Searched web', WebFetch: 'Fetched', Task: 'Agent' } as Record<string, string>)[t] ?? t

function EventView({ e, resolved, onAnswer, onOpen }: { e: TurnEvent; resolved: Map<string, string>; onAnswer: (rid: string, d: 'allow' | 'allowAlways' | 'deny') => Promise<void>; onOpen(p: string): void }) {
  switch (e.kind) {
    case 'message':
      return <div className="prose prose-sm max-w-none text-ink prose-p:my-1.5 prose-ul:my-1.5 prose-pre:text-xs"><ReactMarkdown remarkPlugins={[remarkGfm]}>{e.text}</ReactMarkdown></div>
    case 'todos':
      return (
        <div className="rounded-md border border-hair bg-white p-2 text-xs">
          {e.items.map((t, i) => (
            <div key={i} className={clsx('flex items-start gap-1.5 py-0.5', t.status === 'completed' && 'text-ink-3 line-through')}>
              {t.status === 'completed' ? <Check size={12} className="mt-0.5 text-emerald-600" /> : t.status === 'in_progress' ? <Loader2 size={12} className="mt-0.5 animate-spin text-violet-600" /> : <CircleDot size={12} className="mt-0.5 text-ink-3" />}
              {t.text}
            </div>
          ))}
        </div>
      )
    case 'permission': {
      const d = resolved.get(e.requestId)
      const isEdit = e.tool === 'Edit'
      const isConnector = e.tool === 'Connector'
      const isWeb = e.tool === 'Web'
      return (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-2 text-xs">
          <div className="mb-1 font-medium text-amber-900">
            {isEdit ? `${e.description === 'create' ? 'Create' : 'Edit'} ${e.detail}?`
              : isConnector ? `Use a connector: ${e.detail}?`
                : isWeb ? (e.description === 'search the web' ? 'Search the web?' : 'Fetch this web page?')
                : `Run this command?${e.description ? ` — ${e.description}` : ''}`}
          </div>
          {isConnector ? (
            e.description && <pre className="mb-2 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-white p-1.5 text-[11px]">{e.description}</pre>
          ) : isWeb ? (
            <div className="mb-2 rounded bg-white p-1.5 text-[11px]">
              <div className="break-all font-mono">{e.detail}</div>
              {e.description && e.description !== 'search the web' && <div className="mt-1 text-ink-3">{e.description}</div>}
            </div>
          ) : isEdit ? (
            e.preview && (
              <div className="mb-2 max-h-48 overflow-auto rounded bg-white font-mono text-[11px]">
                {e.preview.old !== undefined && e.preview.old !== '' && <pre className="whitespace-pre-wrap bg-red-50 p-1.5 text-red-900">{e.preview.old}</pre>}
                {e.preview.new !== undefined && <pre className="whitespace-pre-wrap bg-emerald-50 p-1.5 text-emerald-900">{e.preview.new}</pre>}
              </div>
            )
          ) : (
            <pre className="mb-2 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-white p-1.5 text-[11px]">{e.detail}</pre>
          )}
          {d ? (
            <div className={d === 'allow' ? 'text-emerald-700' : 'text-red-700'}>{d === 'allow' ? 'Allowed' : 'Denied'}</div>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              <button className="btn-primary" onClick={() => void onAnswer(e.requestId, 'allow')}>Allow</button>
              <button className="btn-ghost border border-hair bg-white" onClick={() => void onAnswer(e.requestId, 'allowAlways')}>
                Always allow {isEdit ? 'edits' : isConnector ? `${e.detail.split(' · ')[0]}` : isWeb ? 'web access' : 'commands'} in this chat
              </button>
              <button className="btn-ghost text-red-700" onClick={() => void onAnswer(e.requestId, 'deny')}>Deny</button>
            </div>
          )}
        </div>
      )
    }
    case 'notice':
      return <div className="rounded bg-amber-50 px-2 py-1 text-xs text-amber-900">{e.text}</div>
    case 'error':
      return <div className="rounded border border-red-200 bg-red-50 px-2 py-1.5 text-xs text-red-800">{e.text}</div>
    case 'fileEdited':
      return <button className="text-xs text-emerald-800" onClick={() => onOpen(e.path)}>Edited {e.path}</button>
    default:
      return null
  }
}

/**
 * Unsent drafts, per chat: kept while the composer is hidden (the Claude
 * conversations or chat-history panel replaces it) and across chat tabs. The
 * text also survives a reload (localStorage); pasted images live in memory.
 */
const composerDrafts = new Map<string, { text: string; images: PendingImage[] }>()
const draftKey = (chatId: string) => `pdfedit-draft-${chatId}`

function Composer({ chat }: { chat: Chat }) {
  const { send, stop, update, setMode } = useChat()
  const runningModes = useChat((s) => s.runningModes)
  const { settings, models, update: updateDefaults } = useAgent()
  const pid = useApp((s) => s.projectId)
  const activePath = useApp((s) => s.activePath)
  const notes = notesForChat(useNotes((s) => s.notes), chat.id)
  // Re-render when edits are made so the "edits will be shared" hint stays current.
  useDecks((s) => s.sessions)
  usePdfs((s) => s.sessions)
  const [text, setText] = useState(() => composerDrafts.get(chat.id)?.text ?? localStorage.getItem(draftKey(chat.id)) ?? '')
  const [showNotes, setShowNotes] = useState(false)
  const [images, setImages] = useState<PendingImage[]>(() => composerDrafts.get(chat.id)?.images ?? [])
  useEffect(() => {
    if (text || images.length) composerDrafts.set(chat.id, { text, images })
    else composerDrafts.delete(chat.id)
    if (text) localStorage.setItem(draftKey(chat.id), text)
    else localStorage.removeItem(draftKey(chat.id))
  }, [chat.id, text, images])
  const [imageNote, setImageNote] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const textArea = useRef<HTMLTextAreaElement>(null)
  useComposerAutoGrow(textArea, text)
  const composerInsert = useChat((s) => s.composerInsert)
  useEffect(() => {
    if (!composerInsert) return
    setText((t) => (t && !t.endsWith(' ') && !t.endsWith('\n') ? `${t} ` : t) + composerInsert)
    useChat.getState().insertIntoComposer(null)
    requestAnimationFrame(() => textArea.current?.focus())
  }, [composerInsert])
  const runningTurn = chat.turns.find((t) => t.status === 'running')
  const running = !!runningTurn
  const openNotes = notes.filter((n) => n.status === 'open')
  useTextEditTick((s) => s.n) // re-render when a text file's edit is saved or reported
  const edits = pendingEditCount(pid, activePath)
  const apiKeyAvailable = !!settings?.apiKeyAvailable
  const posture: Posture = chatPosture(chat, { auth: settings?.auth ?? 'subscription' })
  if (!apiKeyAvailable) posture.auth = 'subscription'
  const runningMode = running ? (runningModes[chat.id] ?? runningTurn?.mode ?? null) : null

  /** A posture pick applies to this chat AND becomes the default for new chats (as in Code Navigator). */
  const changePosture = (p: Partial<Posture>) => {
    if (p.mode) void setMode(chat.id, p.mode)
    const rest = { ...p }
    delete rest.mode
    if (Object.keys(rest).length) void update(chat.id, rest)
    void updateDefaults({
      ...(p.mode ? { defaultMode: p.mode } : {}),
      ...(p.model !== undefined ? { defaultModel: p.model } : {}),
      ...(p.effort !== undefined ? { defaultEffort: p.effort } : {}),
      ...(p.fast !== undefined ? { fast: p.fast } : {}),
      ...(p.auth ? { auth: p.auth } : {}),
    })
  }
  const cycleMode = () => {
    const i = APPROVAL_MODES.findIndex((m) => m.id === posture.mode)
    changePosture({ mode: APPROVAL_MODES[(i + 1) % APPROVAL_MODES.length].id })
  }

  /** Take pasted/dropped/picked image files (up to MAX_IMAGES per message). */
  const addImages = async (files: FileList | File[] | null | undefined) => {
    const { images: accepted, rejected } = splitImageFiles(files)
    const room = MAX_IMAGES - images.length
    const take = accepted.slice(0, Math.max(0, room))
    const notes: string[] = []
    if (rejected) notes.push(`${rejected} file${rejected > 1 ? 's' : ''} skipped — only PNG, JPEG, GIF and WebP images can be attached`)
    if (accepted.length > take.length) notes.push(`at most ${MAX_IMAGES} images per message`)
    const prepared: PendingImage[] = []
    for (const f of take) {
      try {
        prepared.push(await prepareImage(f, maxImageEdgeFor(posture.model)))
      } catch (e) {
        notes.push((e as Error).message)
      }
    }
    if (prepared.length) setImages((prev) => [...prev, ...prepared].slice(0, MAX_IMAGES))
    setImageNote(notes.length ? notes.join('; ') : null)
  }

  const submit = async () => {
    const t = text.trim()
    if ((!t && !images.length) || running) return
    // `/fast on|off` toggles fast mode instead of sending (as in Code Navigator).
    const fastCmd = t.match(/^\/fast\s+(on|off)$/i)
    if (fastCmd) {
      changePosture({ fast: fastCmd[1].toLowerCase() === 'on' })
      setText('')
      return
    }
    const ctx = await buildTurnContext(true)
    const sentImages = images
    setText('')
    setImages([])
    setImageNote(null)
    const ok = await send(chat.id, t, ctx, posture, sentImages.map((i) => ({ data: i.data, name: i.name, width: i.width, height: i.height })))
    if (!ok) {
      setText(t)
      setImages(sentImages)
    }
  }

  return (
    <div
      className={clsx('relative shrink-0 border-t border-hair bg-panel p-2', dragOver && 'bg-accent-soft')}
      onDragOver={(e) => {
        if (!dragHasFiles(e.dataTransfer)) return
        e.preventDefault()
        setDragOver(true)
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false)
      }}
      onDrop={(e) => {
        if (!dragHasFiles(e.dataTransfer)) return
        e.preventDefault()
        setDragOver(false)
        void addImages(e.dataTransfer.files)
      }}
    >
      {dragOver && (
        <div className="pointer-events-none absolute inset-1 z-10 flex items-center justify-center rounded-lg border-2 border-dashed border-accent/60 text-xs font-medium text-accent">
          Drop images to attach
        </div>
      )}
      {(openNotes.length > 0 || edits > 0) && (
        <div className="mb-1.5 flex flex-wrap items-center gap-1.5 text-[11px] text-ink-3">
          {edits > 0 && <span className="flex items-center gap-1 rounded bg-paper px-1.5 py-0.5"><Pencil size={11} /> {edits} edit{edits > 1 ? 's' : ''} since last turn will be shared</span>}
          {openNotes.length > 0 && (
            <button className="flex items-center gap-1 rounded bg-amber-50 px-1.5 py-0.5 text-amber-900" onClick={() => setShowNotes(!showNotes)}>
              <StickyNote size={11} /> {openNotes.length} open note{openNotes.length > 1 ? 's' : ''} shared with the agent
            </button>
          )}
        </div>
      )}
      {showNotes && <NotesList chatId={chat.id} onPick={() => setShowNotes(false)} />}
      {images.length > 0 && (
        <div className="mb-1.5 flex flex-wrap gap-1.5">
          {images.map((img) => (
            <div key={img.id} className="group relative" title={`${img.name ?? 'image'} · ${img.width}×${img.height} · ${Math.round(img.bytes / 1024)} KB`}>
              <img src={img.previewUrl} alt={img.name ?? 'attached image'} className="h-14 max-w-[110px] rounded border border-hair bg-white object-cover" />
              <button
                className="absolute -right-1.5 -top-1.5 hidden h-4 w-4 items-center justify-center rounded-full bg-ink text-white group-hover:flex"
                title="Remove"
                onClick={() => setImages((prev) => prev.filter((x) => x.id !== img.id))}
              >
                <X size={10} />
              </button>
            </div>
          ))}
        </div>
      )}
      {imageNote && <div className="mb-1 text-[11px] text-amber-800">{imageNote}</div>}
      <textarea
        ref={textArea}
        className="block w-full resize-none rounded-lg border border-hair bg-white p-2 text-sm outline-none focus:border-accent"
        placeholder={running ? 'The agent is working…' : 'Ask the agent to change the deck…  (Enter to send, Shift+Enter for a new line)'}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onPaste={(e) => {
          // Pasted screenshots/images attach to the message (text pastes normally).
          const files = Array.from(e.clipboardData?.files ?? [])
          if (files.some((f) => f.type.startsWith('image/'))) {
            e.preventDefault()
            void addImages(files)
          }
        }}
        onKeyDown={(e) => {
          // ⇧Tab cycles the approval mode, Claude Code-style.
          if (e.key === 'Tab' && e.shiftKey) {
            e.preventDefault()
            cycleMode()
            return
          }
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            void submit()
          }
        }}
      />
      <div className="mt-1.5 flex items-center gap-2">
        <PosturePopover
          posture={posture}
          models={models.length ? models : FALLBACK_MODELS}
          runningMode={runningMode}
          running={running}
          apiKeyAvailable={apiKeyAvailable}
          onChange={changePosture}
        />
        <button className="icon-btn" title={`Attach images (or paste / drop them) — up to ${MAX_IMAGES}`} disabled={images.length >= MAX_IMAGES} onClick={() => fileInput.current?.click()}>
          <ImagePlus size={15} />
        </button>
        <input
          ref={fileInput}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          multiple
          hidden
          onChange={(e) => {
            void addImages(e.target.files)
            e.target.value = ''
          }}
        />
        <div className="ml-auto" />
        {running ? (
          <button className="btn-ghost border border-hair" onClick={() => void stop(chat.id)}><Square size={13} /> Stop</button>
        ) : (
          <button className="btn-primary" disabled={!text.trim() && !images.length} onClick={() => void submit()}><Send size={13} /> Send</button>
        )}
      </div>
    </div>
  )
}

/**
 * The open notes shared with this chat's agent. Each shows its number (the same as on its pin or
 * badge), where it is, and — for a note on chat text — the start of the selection; click to go
 * there, or delete it.
 */
function NotesList({ chatId, onPick }: { chatId: string; onPick(): void }) {
  const all = useNotes((s) => s.notes)
  const remove = useNotes((s) => s.remove)
  const notes = notesForChat(all, chatId).filter((n) => n.status === 'open')
  const openFile = useApp((s) => s.openFile)
  const pid = useApp((s) => s.projectId)
  const words = (t: string, n = 6) => {
    const w = t.replace(/\s+/g, ' ').trim().split(' ')
    return w.length > n ? `${w.slice(0, n).join(' ')}…` : w.join(' ')
  }
  const go = (n: (typeof notes)[number]) => {
    onPick()
    if (n.target === 'chat') return // on this chat's messages: its badge is in the conversation
    openFile(n.deck)
    if (!pid) return
    // Jump to the note's slide / page once the file is open.
    setTimeout(() => {
      const s = useDecks.getState().sessions[`${pid}:${n.deck}`]
      const i = s?.pres?.slides.findIndex((sl) => s.sldIds.get(sl.id) === n.slideId) ?? -1
      if (s && i >= 0) useDecks.getState().setSlide(s.key, i)
      else if (s) useDecks.getState().setSlide(s.key, n.slideIndex - 1)
      else usePdfs.getState().setPage(`${pid}:${n.deck}`, n.slideIndex - 1)
    }, 300)
  }
  return (
    <div className="mb-1.5 max-h-48 overflow-y-auto rounded border border-hair bg-paper p-1 text-xs">
      {notes.map((n) => (
        <div key={n.id} className="group flex items-start gap-1.5 rounded px-1.5 py-1 hover:bg-white">
          <button className="flex min-w-0 flex-1 items-start gap-1.5 text-left" onClick={() => go(n)} title={n.target === 'chat' ? 'A note on this chat' : 'Show it'}>
            <span className={clsx('shrink-0 rounded px-1 font-medium', n.author === 'agent' ? 'bg-violet-100 text-violet-800' : 'bg-note text-amber-950')}>
              {n.author === 'agent' ? 'AI' : noteNumber(n, all)}
            </span>
            <span className="min-w-0">
              <span className="block truncate text-ink-3">
                {n.target === 'chat'
                  ? <>This chat · <span className="italic">“{words(n.quote ?? '')}”</span></>
                  : `${n.deck.split('/').pop()} · ${notePlaceLabel(n)}`}
              </span>
              <span className="text-ink">{n.text}</span>
            </span>
          </button>
          <button
            className="shrink-0 rounded p-0.5 text-ink-3 opacity-0 hover:bg-red-50 hover:text-red-600 group-hover:opacity-100"
            title="Delete this note"
            onClick={() => void remove(n.id)}
          >
            <Trash2 size={12} />
          </button>
        </div>
      ))}
    </div>
  )
}

const COMPOSER_MIN_PX = 80

/**
 * The composer grows with what's typed — from 80 px up to 40% of the window
 * (at most 320 px), then scrolls. Re-fits when the panel is resized.
 */
function useComposerAutoGrow(ref: React.RefObject<HTMLTextAreaElement | null>, text: string) {
  const fit = useCallback(() => {
    const ta = ref.current
    if (!ta) return
    const max = Math.max(COMPOSER_MIN_PX, Math.min(320, Math.round(window.innerHeight * 0.4)))
    ta.style.height = 'auto'
    const want = ta.scrollHeight + 2 // + borders
    ta.style.height = `${Math.min(Math.max(want, COMPOSER_MIN_PX), max)}px`
    ta.style.overflowY = want > max ? 'auto' : 'hidden'
  }, [ref])
  useLayoutEffect(fit, [fit, text])
  useEffect(() => {
    const ta = ref.current
    if (!ta) return
    let width = ta.clientWidth
    const ro = new ResizeObserver(() => {
      if (ta.clientWidth !== width) {
        width = ta.clientWidth
        fit()
      }
    })
    ro.observe(ta)
    window.addEventListener('resize', fit)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', fit)
    }
  }, [ref, fit])
}
