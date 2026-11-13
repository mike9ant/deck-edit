/**
 * Browse and search the user's past Claude conversations on this machine —
 * Cowork sessions, Claude desktop Code sessions and Claude Code CLI sessions —
 * read a transcript, copy files a Cowork session produced into the project,
 * and attach a conversation to the chat so the agent picks it up (it reads it
 * with its `read_conversation` tool).
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ArrowLeft, FileDown, Link2, Loader2, Quote, Search, X } from 'lucide-react'
import clsx from 'clsx'
import { api } from '../api/client'
import type { ConversationDetail, ConversationHit } from '../api/types'
import { useApp } from '../store/appStore'
import { useChat } from '../store/chatStore'

const SOURCES: { id: string; label: string }[] = [
  { id: '', label: 'All' },
  { id: 'cowork', label: 'Cowork' },
  { id: 'desktop', label: 'Desktop Code' },
  { id: 'cli', label: 'Claude Code' },
]

const SOURCE_BADGE: Record<string, string> = {
  cowork: 'bg-violet-100 text-violet-800',
  desktop: 'bg-sky-100 text-sky-800',
  cli: 'bg-paper text-ink-2 ring-1 ring-hair',
}
const SOURCE_NAME: Record<string, string> = { cowork: 'Cowork', desktop: 'Desktop Code', cli: 'Claude Code' }

function when(ms: number) {
  if (!ms) return ''
  const d = new Date(ms)
  const days = (Date.now() - ms) / 86_400_000
  return days < 1 ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : days < 7 ? d.toLocaleDateString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : d.toLocaleDateString()
}

/** Wrap occurrences of `q` in <mark>. */
function Highlight({ text, q }: { text: string; q: string }) {
  if (!q.trim()) return <>{text}</>
  const words = q.trim().split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const parts = text.split(new RegExp(`(${words.join('|')})`, 'gi'))
  return <>{parts.map((p, i) => (i % 2 ? <mark key={i} className="rounded bg-amber-200 px-0.5 text-ink">{p}</mark> : p))}</>
}

export function ConversationsPanel({ onDone }: { onDone(): void }) {
  const [q, setQ] = useState('')
  const [source, setSource] = useState('')
  const [hits, setHits] = useState<ConversationHit[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState<{ id: string; jump?: number } | null>(null)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => input.current?.focus(), [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && (open ? setOpen(null) : onDone())
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onDone])

  useEffect(() => {
    let live = true
    setLoading(true)
    const t = setTimeout(() => {
      api.conversations(q, source).then((h) => live && setHits(h)).catch(() => live && setHits([])).finally(() => live && setLoading(false))
    }, q ? 300 : 0)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [q, source])

  if (open) return <ConversationViewer id={open.id} jump={open.jump} query={q} onBack={() => setOpen(null)} onDone={onDone} />

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b border-hair px-2 pb-2 pt-2">
        <div className="mb-1.5 flex items-center px-1 text-[11px] font-semibold uppercase tracking-wide text-ink-3">
          Claude conversations on this Mac
          <button className="icon-btn ml-auto h-6 w-6" title="Close (Esc)" onClick={onDone}><X size={14} /></button>
        </div>
        <div className="flex items-center gap-1.5 rounded-md border border-hair bg-white px-2 focus-within:border-accent">
          <Search size={13} className="text-ink-3" />
          <input
            ref={input}
            className="h-8 flex-1 bg-transparent text-sm outline-none"
            placeholder="Search titles, folders and full transcripts…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          {loading && <Loader2 size={13} className="animate-spin text-ink-3" />}
        </div>
        <div className="mt-1.5 flex flex-wrap gap-1">
          {SOURCES.map((s) => (
            <button
              key={s.id}
              className={clsx('rounded-full px-2 py-0.5 text-[11px]', source === s.id ? 'bg-ink text-white' : 'bg-paper text-ink-2 hover:bg-black/5')}
              onClick={() => setSource(s.id)}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-1.5">
        {hits?.length === 0 && <p className="px-1 py-3 text-sm text-ink-3">{q ? 'Nothing matches.' : 'No conversations found.'}</p>}
        <ul className="space-y-0.5">
          {hits?.map((h) => (
            <li key={h.id}>
              <button className="w-full rounded-md px-2 py-1.5 text-left hover:bg-paper" onClick={() => setOpen({ id: h.id, jump: h.snippets[0]?.message })}>
                <div className="flex min-w-0 items-center gap-1.5">
                  <span className={clsx('shrink-0 rounded px-1 py-px text-[9px] font-semibold uppercase tracking-wide', SOURCE_BADGE[h.source])}>{SOURCE_NAME[h.source]}</span>
                  <span className="truncate text-sm text-ink"><Highlight text={h.title} q={q} /></span>
                </div>
                <div className="mt-0.5 flex gap-1.5 text-[10.5px] text-ink-3">
                  <span className="shrink-0">{when(h.lastActivityAt)}</span>
                  {h.folders[0] && <span className="truncate">· {h.folders[0].replace(/^\/Users\/[^/]+/, '~')}{h.folders.length > 1 ? ` +${h.folders.length - 1}` : ''}</span>}
                  {h.outputCount > 0 && <span className="shrink-0">· {h.outputCount} file{h.outputCount > 1 ? 's' : ''}</span>}
                </div>
                {h.snippets.slice(0, 2).map((s, i) => (
                  <div key={i} className="mt-0.5 line-clamp-2 text-[11px] text-ink-2">
                    <span className="text-ink-3">{s.role === 'user' ? 'You' : 'Claude'}: </span>
                    <Highlight text={s.text} q={q} />
                  </div>
                ))}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

function ConversationViewer({ id, jump, query, onBack, onDone }: { id: string; jump?: number; query: string; onBack(): void; onDone(): void }) {
  const [data, setData] = useState<ConversationDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [find, setFind] = useState(query)
  const scroller = useRef<HTMLDivElement>(null)
  const pid = useApp((s) => s.projectId)
  const { toast, refreshTree, openFile } = useApp()

  useEffect(() => {
    api.conversation(id).then(setData).catch((e) => setError(String(e.message)))
  }, [id])

  // Land on the first matching message.
  useEffect(() => {
    if (!data || jump === undefined) return
    requestAnimationFrame(() => scroller.current?.querySelector(`[data-msg="${jump}"]`)?.scrollIntoView({ block: 'start' }))
  }, [data, jump])

  const matches = useMemo(() => {
    if (!data || !find.trim()) return []
    const f = find.trim().toLowerCase()
    return data.messages.map((m, i) => (m.text.toLowerCase().includes(f) ? i : -1)).filter((i) => i >= 0)
  }, [data, find])

  const refOf = () => (data ? `[Conversation: "${data.info.title}" — id ${data.info.id}]` : '')

  /** A link only: the agent fetches what it needs with read_conversation. */
  const attach = () => {
    if (!data) return
    useChat.getState().insertIntoComposer(find.trim() ? `${refOf()} (look for "${find.trim()}") ` : `${refOf()} `)
    onDone()
  }

  /** The exact text, quoted, with a link back to its conversation. */
  const quote = (text: string, who?: string) => {
    if (!data || !text.trim()) return
    const quoted = text.trim().split('\n').map((l) => `> ${l}`).join('\n')
    useChat.getState().insertIntoComposer(`\n${quoted}\n— ${who ? `${who}, ` : ''}from ${refOf()}\n\n`)
    window.getSelection()?.removeAllRanges()
    setSel(null)
    toast(`Quoted ${text.trim().length.toLocaleString()} characters — they'll be in your message when you close this panel`)
  }

  // Selecting text in the transcript offers "Quote in chat" next to it.
  const [sel, setSel] = useState<{ text: string; x: number; y: number } | null>(null)
  const onMouseUp = () => {
    const s = window.getSelection()
    const text = s?.toString() ?? ''
    if (!s || !text.trim() || !scroller.current?.contains(s.anchorNode)) return setSel(null)
    const r = s.getRangeAt(0).getBoundingClientRect()
    const box = scroller.current.getBoundingClientRect()
    setSel({ text, x: Math.min(r.right - box.left, box.width - 130), y: r.bottom - box.top + scroller.current.scrollTop + 4 })
  }

  const importOutput = async (path: string) => {
    if (!pid || !data) return
    try {
      const r = await api.importConversationOutput(data.info.id, pid, path)
      await refreshTree()
      toast(`Copied ${path.split('/').pop()} into the project`)
      openFile(r.path)
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b border-hair px-2 py-2">
        <div className="flex items-center gap-1">
          <button className="icon-btn h-7 w-7" title="Back to the list (Esc)" onClick={onBack}><ArrowLeft size={15} /></button>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium">{data?.info.title ?? '…'}</div>
            {data && (
              <div className="truncate text-[10.5px] text-ink-3">
                {SOURCE_NAME[data.info.source]} · {when(data.info.lastActivityAt)} · {data.messages.length} messages
                {data.info.folders[0] && ` · ${data.info.folders[0].replace(/^\/Users\/[^/]+/, '~')}`}
              </div>
            )}
          </div>
          <button
            className="btn-primary"
            disabled={!data}
            onClick={attach}
            title="Adds a one-line link to this conversation to your message (not the text). The agent reads only what it needs with its read_conversation tool — around your “find” words if you typed some. To paste exact text, select it below and use “Quote in chat”."
          >
            <Link2 size={13} /> Link in chat
          </button>
        </div>
        <div className="mt-1.5 flex items-center gap-1.5 rounded-md border border-hair bg-white px-2">
          <Search size={12} className="text-ink-3" />
          <input className="h-7 flex-1 bg-transparent text-xs outline-none" placeholder="Find in this conversation" value={find} onChange={(e) => setFind(e.target.value)} />
          {find.trim() && (
            <span className="flex items-center gap-1 text-[10.5px] text-ink-3">
              {matches.length} match{matches.length === 1 ? '' : 'es'}
              {matches.length > 0 && (
                <button
                  className="rounded px-1 hover:bg-paper"
                  onClick={() => {
                    const top = scroller.current?.scrollTop ?? 0
                    const next = matches.find((i) => ((scroller.current?.querySelector(`[data-msg="${i}"]`) as HTMLElement | null)?.offsetTop ?? 0) > top + 8) ?? matches[0]
                    scroller.current?.querySelector(`[data-msg="${next}"]`)?.scrollIntoView({ block: 'start' })
                  }}
                >
                  next ↓
                </button>
              )}
            </span>
          )}
        </div>
        {data && data.outputs.length > 0 && (
          <div className="mt-1.5 max-h-28 overflow-y-auto rounded border border-hair bg-paper p-1 text-xs">
            <div className="px-1 pb-0.5 text-[10px] font-semibold uppercase tracking-wide text-ink-3">Files this session produced</div>
            {data.outputs.map((o) => (
              <div key={o.path} className="group flex items-center gap-1.5 rounded px-1 py-0.5 hover:bg-white">
                <span className="truncate">{o.path}</span>
                <span className="shrink-0 text-ink-3">{Math.max(1, Math.round(o.size / 1024))} KB</span>
                <button className="ml-auto hidden shrink-0 items-center gap-1 text-accent group-hover:flex" title="Copy into this project" onClick={() => void importOutput(o.path)}>
                  <FileDown size={12} /> Copy to project
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
      <div ref={scroller} className="relative min-h-0 flex-1 overflow-y-auto px-3 py-2" onMouseUp={onMouseUp}>
        {sel && (
          <button
            className="absolute z-20 flex items-center gap-1 rounded-md bg-ink px-2 py-1 text-[11px] text-white shadow-lg hover:bg-black"
            style={{ left: Math.max(4, sel.x - 100), top: sel.y }}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => quote(sel.text)}
          >
            <Quote size={11} /> Quote in chat
          </button>
        )}
        {error && <div className="text-sm text-red-700">{error}</div>}
        {!data && !error && <div className="flex items-center gap-2 text-sm text-ink-3"><Loader2 size={14} className="animate-spin" /> Loading…</div>}
        {data?.messages.map((m, i) => (
          <div key={i} data-msg={i} className={clsx('group/msg relative mb-3', matches.includes(i) && 'rounded-md ring-2 ring-amber-300 ring-offset-2')}>
            <button
              className="absolute -top-2 right-0 z-10 hidden items-center gap-1 rounded border border-hair bg-white px-1.5 py-0.5 text-[10px] text-ink-2 shadow-sm hover:text-accent group-hover/msg:flex"
              title="Quote this whole message in your chat message"
              onClick={() => quote(m.text, m.role === 'user' ? 'me' : 'Claude')}
            >
              <Quote size={10} /> Quote
            </button>
            {m.role === 'user' ? (
              <div className="ml-6 whitespace-pre-wrap rounded-lg bg-accent-soft px-3 py-2 text-[13px] text-ink">
                <Highlight text={m.text.length > 4000 ? `${m.text.slice(0, 4000)}…` : m.text} q={find} />
              </div>
            ) : (
              <div className="text-[13px]">
                {m.text && (
                  <div className="prose prose-sm max-w-none text-ink prose-p:my-1.5 prose-pre:text-xs">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.text}</ReactMarkdown>
                  </div>
                )}
                {m.tools && m.tools.length > 0 && (
                  <div className="mt-1 rounded border border-hair bg-paper px-2 py-1 text-[11px] text-ink-3">
                    {m.tools.slice(0, 6).map((t, k) => <div key={k} className="truncate">{t}</div>)}
                    {m.tools.length > 6 && <div>+{m.tools.length - 6} more</div>}
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
