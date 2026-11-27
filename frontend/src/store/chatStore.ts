/**
 * Agent chats for the current project: open chat tabs, full transcripts,
 * live streaming drafts, and which projects have an agent turn running
 * (deck editing pauses while one does).
 */

import { create } from 'zustand'
import { ApiError, api, type OutgoingImage } from '../api/client'
import { askConfirm } from '../components/confirmDialog'
import type { ApprovalMode, Chat, ChatSummary, Posture, ServerEvent, TurnContext } from '../api/types'
import { flushDeckSaves, flushHeldEdits, setBusyProbe } from '../deck/deckStore'
import { useApp } from './appStore'

interface ChatState {
  pid: string | null
  summaries: ChatSummary[]
  openIds: string[]
  activeId: string | null
  /** Open chat → its tab number (see tabNumbers): shown on the tab and on the notes meant for it. */
  numbers: Record<string, number>
  /** The number the next tab gets while still counting up from 1 to 9 (after that: the lowest free one). */
  nextNumber: number
  chats: Record<string, Chat>
  /** turn id → streamed text not yet completed into a message */
  drafts: Record<string, string>
  /** turn id → its live status line (e.g. "Waiting for the agent in …"), while it lasts. */
  statuses: Record<string, { text: string; kill?: boolean }>
  busyProjects: Record<string, boolean>
  /** chat id → project id, for every chat with a running turn (several agents may work in one project). */
  runningChats: Record<string, string>
  load(pid: string): Promise<void>
  refreshSummaries(): Promise<void>
  newChat(): Promise<string | undefined>
  openChat(id: string): Promise<void>
  closeChat(id: string): void
  /** Show a chat in the active tab (replacing what the tab showed), or go to its tab if already open. */
  openInThisTab(id: string): Promise<void>
  reloadChat(id: string): Promise<void>
  send(chatId: string, text: string, context: TurnContext, posture: Posture, images?: OutgoingImage[], split?: boolean): Promise<boolean>
  stop(chatId: string): Promise<void>
  revert(chatId: string, turnId: string): Promise<void>
  unrevert(chatId: string, turnId: string): Promise<void>
  answer(requestId: string, decision: 'allow' | 'allowAlways' | 'deny'): Promise<void>
  update(chatId: string, body: { title?: string } & Partial<Posture>): Promise<void>
  /** Switch the approval mode; a running turn switches too unless plan is involved. */
  setMode(chatId: string, mode: ApprovalMode): Promise<void>
  /** Text another panel wants added to the composer (consumed by the composer). */
  composerInsert: string | null
  insertIntoComposer(text: string | null): void
  /** chat id → the mode governing its running turn */
  runningModes: Record<string, ApprovalMode>
  remove(chatId: string): Promise<void>
  handleEvent(ev: ServerEvent): void
}

const lsTabs = (pid: string) => `deckedit-chats-${pid}`

/** Up to this number new tabs count up; after it they take the lowest free number. */
const COUNT_UP_TO = 9

/**
 * Tab numbers for the open chats: a chat keeps its number while its tab is open, and a closed
 * tab's number is free again. New tabs count up 1, 2, … 9 (so a just-closed number isn't handed
 * straight to another chat); past 9 a new tab takes the lowest free number. With no tabs open the
 * count starts over at 1.
 */
export function tabNumbers(openIds: string[], numbers: Record<string, number>, nextNumber: number): { numbers: Record<string, number>; nextNumber: number } {
  const kept: Record<string, number> = {}
  for (const id of openIds) if (numbers[id]) kept[id] = numbers[id]
  let next = Object.keys(kept).length ? nextNumber : 1
  const used = new Set(Object.values(kept))
  for (const id of openIds) {
    if (kept[id]) continue
    let n: number
    if (next <= COUNT_UP_TO && !used.has(next)) n = next++
    else {
      n = 1
      while (used.has(n)) n++
      next = COUNT_UP_TO + 1
    }
    kept[id] = n
    used.add(n)
  }
  return { numbers: kept, nextNumber: next }
}

export const useChat = create<ChatState>((set, get) => {
  /** Show these tabs (numbering new ones, freeing closed ones' numbers) and remember them. */
  const setTabs = (openIds: string[], activeId: string | null, extra: Partial<ChatState> = {}) => {
    set({ ...extra, openIds, activeId, ...tabNumbers(openIds, get().numbers, get().nextNumber) })
    const { pid, numbers, nextNumber } = get()
    if (pid) localStorage.setItem(lsTabs(pid), JSON.stringify({ openIds, activeId, numbers, nextNumber }))
  }

  return {
    pid: null,
    summaries: [],
    openIds: [],
    activeId: null,
    numbers: {},
    nextNumber: 1,
    chats: {},
    drafts: {},
    statuses: {},
    busyProjects: {},
    runningChats: {},
    runningModes: {},
    composerInsert: null,
    // Inserts made while the composer isn't on screen (e.g. several quotes
    // from the Conversations panel) accumulate until it takes them.
    insertIntoComposer(text) {
      set({ composerInsert: text === null ? null : (get().composerInsert ?? '') + text })
    },

    async load(pid) {
      let saved: { openIds: string[]; activeId: string | null; numbers: Record<string, number>; nextNumber: number } = { openIds: [], activeId: null, numbers: {}, nextNumber: 1 }
      try {
        saved = { ...saved, ...JSON.parse(localStorage.getItem(lsTabs(pid)) ?? '{}') }
      } catch {
        /* */
      }
      set({ pid, summaries: [], openIds: [], activeId: null, numbers: saved.numbers, nextNumber: saved.nextNumber })
      const summaries = await api.chats(pid)
      const ids = new Set(summaries.map((s) => s.id))
      let openIds = saved.openIds.filter((id) => ids.has(id))
      if (!openIds.length && summaries.length) openIds = [summaries[0].id]
      const activeId = openIds.includes(saved.activeId ?? '') ? saved.activeId : (openIds[0] ?? null)
      setTabs(openIds, activeId, { summaries, busyProjects: { ...get().busyProjects, [pid]: summaries.some((s) => s.running) } })
      await Promise.all(openIds.map((id) => get().reloadChat(id)))
      if (!openIds.length) await get().newChat()
    },

    async refreshSummaries() {
      const pid = get().pid
      if (!pid) return
      const summaries = await api.chats(pid)
      const runningChats = Object.fromEntries(Object.entries(get().runningChats).filter(([, p]) => p !== pid))
      for (const s of summaries) if (s.running) runningChats[s.id] = pid
      set({ summaries, runningChats, busyProjects: { ...get().busyProjects, [pid]: summaries.some((s) => s.running) } })
    },

    async newChat() {
      const pid = get().pid
      if (!pid) return
      const chat = await api.createChat(pid)
      setTabs([...get().openIds, chat.id], chat.id, {
        chats: { ...get().chats, [chat.id]: chat },
        summaries: [{ id: chat.id, title: chat.title, updatedAt: chat.updatedAt, turnCount: 0, running: false }, ...get().summaries],
      })
      return chat.id
    },

    async openChat(id) {
      setTabs(get().openIds.includes(id) ? get().openIds : [...get().openIds, id], id)
      if (!get().chats[id]) await get().reloadChat(id)
    },

    async openInThisTab(id) {
      const { openIds, activeId } = get()
      if (openIds.includes(id)) return get().openChat(id)
      const i = activeId ? openIds.indexOf(activeId) : -1
      const next = i >= 0 ? openIds.map((x, k) => (k === i ? id : x)) : [...openIds, id]
      setTabs(next, id)
      if (!get().chats[id]) await get().reloadChat(id)
    },

    closeChat(id) {
      const { openIds, activeId } = get()
      const i = openIds.indexOf(id)
      const next = openIds.filter((x) => x !== id)
      setTabs(next, activeId === id ? (next[Math.min(i, next.length - 1)] ?? null) : activeId)
    },

    async reloadChat(id) {
      try {
        const chat = await api.chat(id)
        set({ chats: { ...get().chats, [id]: chat } })
      } catch {
        /* deleted */
      }
    },

    async send(chatId, text, context, posture, images = [], split = false) {
      const pid = get().pid
      try {
        const { turnId } = await api.sendTurn(chatId, text, context, posture, images, split)
        const chat = get().chats[chatId]
        if (chat && !chat.turns.some((t) => t.id === turnId)) {
          const turn = {
            id: turnId, prompt: text, context, startedAt: new Date().toISOString(), status: 'running' as const, events: [], changes: [],
            mode: posture.mode, model: posture.model || undefined, effort: posture.effort || undefined, fast: posture.fast, auth: posture.auth,
          }
          set({ chats: { ...get().chats, [chatId]: { ...chat, ...posture, model: posture.model || undefined, effort: posture.effort || undefined, turns: [...chat.turns, turn], runningTurnId: turnId } } })
        }
        set({ runningModes: { ...get().runningModes, [chatId]: posture.mode } })
        if (pid) set({ busyProjects: { ...get().busyProjects, [pid]: true }, runningChats: { ...get().runningChats, [chatId]: pid } })
        return true
      } catch (e) {
        useApp.getState().toast((e as Error).message, 'error')
        return false
      }
    },

    async stop(chatId) {
      await api.stop(chatId)
    },

    async revert(chatId, turnId) {
      await flushDeckSaves() // (the files go back as they were: edits not yet written would be lost, or clash)
      try {
        try {
          await api.revert(chatId, turnId)
        } catch (e) {
          // A later turn (another agent's) also changed some of these files: ask before undoing that too.
          if (!(e instanceof ApiError) || e.status !== 428) throw e
          if (!(await askConfirm(e.message, 'Revert anyway'))) return
          await api.revert(chatId, turnId, true)
        }
        await get().reloadChat(chatId)
        useApp.getState().toast('Reverted the files this turn changed to how they were before it.')
      } catch (e) {
        useApp.getState().toast((e as Error).message, 'error')
      }
    },

    async unrevert(chatId, turnId) {
      await flushDeckSaves()
      try {
        await api.unrevert(chatId, turnId)
        await get().reloadChat(chatId)
      } catch (e) {
        useApp.getState().toast((e as Error).message, 'error')
      }
    },

    async answer(requestId, decision) {
      await api.answerPermission(requestId, decision)
    },

    async setMode(chatId, mode) {
      const prev = get().chats[chatId]
      if (prev) set({ chats: { ...get().chats, [chatId]: { ...prev, mode } } })
      const r = await api.setMode(chatId, mode)
      if (r.runningMode) {
        set({ runningModes: { ...get().runningModes, [chatId]: r.runningMode } })
        if (!r.applied) useApp.getState().toast(`This turn keeps running in ${r.runningMode === 'plan' ? 'plan' : r.runningMode} mode — ${mode} applies to your next message.`)
      }
    },

    async update(chatId, body) {
      const prevChat = get().chats[chatId]
      if (prevChat) set({ chats: { ...get().chats, [chatId]: { ...prevChat, ...body } as Chat } })
      const chat = await api.updateChat(chatId, body)
      const prev = get().chats[chatId]
      set({ chats: { ...get().chats, [chatId]: { ...chat, runningTurnId: prev?.runningTurnId } } })
      if (body.title) void get().refreshSummaries()
    },

    async remove(chatId) {
      try {
        await api.deleteChat(chatId)
      } catch (e) {
        useApp.getState().toast((e as Error).message, 'error')
        return
      }
      get().closeChat(chatId)
      const { [chatId]: _gone, ...rest } = get().chats
      set({ chats: rest, summaries: get().summaries.filter((s) => s.id !== chatId) })
    },

    handleEvent(ev) {
      if (ev.type === 'chat') {
        const chat = get().chats[ev.chatId]
        if (!chat) return
        const turn = chat.turns.find((t) => t.id === ev.turnId)
        if (!turn) {
          void get().reloadChat(ev.chatId)
          return
        }
        const e = ev.event
        if (e.kind === 'delta') {
          set({ drafts: { ...get().drafts, [ev.turnId]: (get().drafts[ev.turnId] ?? '') + e.text } })
          return
        }
        if (e.kind === 'thinking') return
        if (e.kind === 'status') {
          const { [ev.turnId]: _s, ...statuses } = get().statuses
          set({ statuses: e.text ? { ...statuses, [ev.turnId]: { text: e.text, kill: e.kill } } : statuses })
          return
        }
        const drafts = e.kind === 'message' ? { ...get().drafts, [ev.turnId]: '' } : get().drafts
        const events = e.kind === 'todos' ? turn.events.filter((x) => x.kind !== 'todos') : turn.events
        let nextEvents = [...events, e]
        if (e.kind === 'activity' && e.done) {
          // A step finished: update its earlier event in place.
          const at = events.map((x) => x.kind === 'activity' && x.tool === e.tool).lastIndexOf(true)
          if (at >= 0) nextEvents = events.map((x, i) => (i === at ? e : x))
        }
        const nextTurn = { ...turn, events: nextEvents }
        set({
          drafts,
          chats: { ...get().chats, [ev.chatId]: { ...chat, turns: chat.turns.map((t) => (t.id === turn.id ? nextTurn : t)) } },
        })
      } else if (ev.type === 'turn') {
        // The project stays busy while any of its chats still has a turn running.
        const runningChats = { ...get().runningChats }
        if (ev.status === 'running') runningChats[ev.chatId] = ev.projectId
        else delete runningChats[ev.chatId]
        set({ runningChats, busyProjects: { ...get().busyProjects, [ev.projectId]: Object.values(runningChats).includes(ev.projectId) } })
        if (ev.projectId === get().pid) {
          void get().reloadChat(ev.chatId)
          void get().refreshSummaries()
        }
        if (ev.status !== 'running') {
          const { [ev.turnId]: _d, ...drafts } = get().drafts
          const { [ev.turnId]: _s, ...statuses } = get().statuses
          set({ statuses })
          const { [ev.chatId]: _m, ...runningModes } = get().runningModes
          set({ drafts, runningModes })
        }
      } else if (ev.type === 'chatUpdated') {
        if (get().chats[ev.chatId]) void get().reloadChat(ev.chatId)
      } else if (ev.type === 'hello' || ev.type === 'resync') {
        const { pid, openIds } = get()
        if (pid) {
          void get().refreshSummaries()
          openIds.forEach((id) => void get().reloadChat(id))
        }
      }
    },
  }
})

setBusyProbe((pid) => !!useChat.getState().busyProjects[pid])

// A turn ended: save the deck edits the user made while the agent worked (held, then replayed onto its version).
useChat.subscribe((s, prev) => {
  if (s.busyProjects === prev.busyProjects) return
  for (const pid of Object.keys(prev.busyProjects)) if (prev.busyProjects[pid] && !s.busyProjects[pid]) void flushHeldEdits(pid)
})

/** Whether the chat's own turn is running (other chats of the project may run at the same time). */
export const chatIsRunning = (s: { chats: Record<string, Chat> }, chatId: string | null | undefined) =>
  !!chatId && !!s.chats[chatId]?.turns.some((t) => t.status === 'running')
