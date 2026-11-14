/**
 * Agent chats for the current project: open chat tabs, full transcripts,
 * live streaming drafts, and which projects have an agent turn running
 * (deck editing pauses while one does).
 */

import { create } from 'zustand'
import { api, type OutgoingImage } from '../api/client'
import type { ApprovalMode, Chat, ChatSummary, Posture, ServerEvent, TurnContext } from '../api/types'
import { flushHeldEdits, setBusyProbe } from '../deck/deckStore'
import { useApp } from './appStore'

interface ChatState {
  pid: string | null
  summaries: ChatSummary[]
  openIds: string[]
  activeId: string | null
  chats: Record<string, Chat>
  /** turn id → streamed text not yet completed into a message */
  drafts: Record<string, string>
  busyProjects: Record<string, boolean>
  load(pid: string): Promise<void>
  refreshSummaries(): Promise<void>
  newChat(): Promise<string | undefined>
  openChat(id: string): Promise<void>
  closeChat(id: string): void
  /** Show a chat in the active tab (replacing what the tab showed), or go to its tab if already open. */
  openInThisTab(id: string): Promise<void>
  reloadChat(id: string): Promise<void>
  send(chatId: string, text: string, context: TurnContext, posture: Posture, images?: OutgoingImage[]): Promise<boolean>
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

const lsTabs = (pid: string) => `pdfedit-chats-${pid}`

export const useChat = create<ChatState>((set, get) => {
  const persistTabs = () => {
    const { pid, openIds, activeId } = get()
    if (pid) localStorage.setItem(lsTabs(pid), JSON.stringify({ openIds, activeId }))
  }

  return {
    pid: null,
    summaries: [],
    openIds: [],
    activeId: null,
    chats: {},
    drafts: {},
    busyProjects: {},
    runningModes: {},
    composerInsert: null,
    // Inserts made while the composer isn't on screen (e.g. several quotes
    // from the Conversations panel) accumulate until it takes them.
    insertIntoComposer(text) {
      set({ composerInsert: text === null ? null : (get().composerInsert ?? '') + text })
    },

    async load(pid) {
      let saved: { openIds: string[]; activeId: string | null } = { openIds: [], activeId: null }
      try {
        saved = { ...saved, ...JSON.parse(localStorage.getItem(lsTabs(pid)) ?? '{}') }
      } catch {
        /* */
      }
      set({ pid, summaries: [], openIds: [], activeId: null })
      const summaries = await api.chats(pid)
      const ids = new Set(summaries.map((s) => s.id))
      let openIds = saved.openIds.filter((id) => ids.has(id))
      if (!openIds.length && summaries.length) openIds = [summaries[0].id]
      const activeId = openIds.includes(saved.activeId ?? '') ? saved.activeId : (openIds[0] ?? null)
      set({
        summaries, openIds, activeId,
        busyProjects: { ...get().busyProjects, [pid]: summaries.some((s) => s.running) },
      })
      await Promise.all(openIds.map((id) => get().reloadChat(id)))
      if (!openIds.length) await get().newChat()
    },

    async refreshSummaries() {
      const pid = get().pid
      if (!pid) return
      const summaries = await api.chats(pid)
      set({ summaries, busyProjects: { ...get().busyProjects, [pid]: summaries.some((s) => s.running) } })
    },

    async newChat() {
      const pid = get().pid
      if (!pid) return
      const chat = await api.createChat(pid)
      set({
        chats: { ...get().chats, [chat.id]: chat },
        openIds: [...get().openIds, chat.id],
        activeId: chat.id,
        summaries: [{ id: chat.id, title: chat.title, updatedAt: chat.updatedAt, turnCount: 0, running: false }, ...get().summaries],
      })
      persistTabs()
      return chat.id
    },

    async openChat(id) {
      if (!get().openIds.includes(id)) set({ openIds: [...get().openIds, id] })
      set({ activeId: id })
      persistTabs()
      if (!get().chats[id]) await get().reloadChat(id)
    },

    async openInThisTab(id) {
      const { openIds, activeId } = get()
      if (openIds.includes(id)) return get().openChat(id)
      const i = activeId ? openIds.indexOf(activeId) : -1
      const next = i >= 0 ? openIds.map((x, k) => (k === i ? id : x)) : [...openIds, id]
      set({ openIds: next, activeId: id })
      persistTabs()
      if (!get().chats[id]) await get().reloadChat(id)
    },

    closeChat(id) {
      const { openIds, activeId } = get()
      const i = openIds.indexOf(id)
      const next = openIds.filter((x) => x !== id)
      set({ openIds: next, activeId: activeId === id ? (next[Math.min(i, next.length - 1)] ?? null) : activeId })
      persistTabs()
    },

    async reloadChat(id) {
      try {
        const chat = await api.chat(id)
        set({ chats: { ...get().chats, [id]: chat } })
      } catch {
        /* deleted */
      }
    },

    async send(chatId, text, context, posture, images = []) {
      const pid = get().pid
      try {
        const { turnId } = await api.sendTurn(chatId, text, context, posture, images)
        const chat = get().chats[chatId]
        if (chat && !chat.turns.some((t) => t.id === turnId)) {
          const turn = {
            id: turnId, prompt: text, context, startedAt: new Date().toISOString(), status: 'running' as const, events: [], changes: [],
            mode: posture.mode, model: posture.model || undefined, effort: posture.effort || undefined, fast: posture.fast, auth: posture.auth,
          }
          set({ chats: { ...get().chats, [chatId]: { ...chat, ...posture, model: posture.model || undefined, effort: posture.effort || undefined, turns: [...chat.turns, turn], runningTurnId: turnId } } })
        }
        set({ runningModes: { ...get().runningModes, [chatId]: posture.mode } })
        if (pid) set({ busyProjects: { ...get().busyProjects, [pid]: true } })
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
      try {
        await api.revert(chatId, turnId)
        await get().reloadChat(chatId)
        useApp.getState().toast('Reverted the files to how they were before that turn.')
      } catch (e) {
        useApp.getState().toast((e as Error).message, 'error')
      }
    },

    async unrevert(chatId, turnId) {
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
        const drafts = e.kind === 'message' ? { ...get().drafts, [ev.turnId]: '' } : get().drafts
        const events = e.kind === 'todos' ? turn.events.filter((x) => x.kind !== 'todos') : turn.events
        const nextTurn = { ...turn, events: [...events, e] }
        set({
          drafts,
          chats: { ...get().chats, [ev.chatId]: { ...chat, turns: chat.turns.map((t) => (t.id === turn.id ? nextTurn : t)) } },
        })
      } else if (ev.type === 'turn') {
        set({ busyProjects: { ...get().busyProjects, [ev.projectId]: ev.status === 'running' } })
        if (ev.projectId === get().pid) {
          void get().reloadChat(ev.chatId)
          void get().refreshSummaries()
        }
        if (ev.status !== 'running') {
          const { [ev.turnId]: _d, ...drafts } = get().drafts
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
