/** Slide notes for the current project (pinned by the user or the agent). */

import { create } from 'zustand'
import { api } from '../api/client'
import type { Note } from '../api/types'
import { useChat } from './chatStore'

/** How a new note is placed: a pin at a point, or a freehand mark around an area. */
export type NoteTool = 'pin' | 'draw'
const TOOL_KEY = 'deckedit-note-tool'

interface NotesState {
  pid: string | null
  notes: Note[]
  tool: NoteTool
  setTool(t: NoteTool): void
  load(pid: string): Promise<void>
  /** Add a note — for the agent of the chat open now (`chatId`), unless given. */
  add(n: Parameters<typeof api.addNote>[1]): Promise<Note | undefined>
  update(id: string, body: Parameters<typeof api.updateNote>[2]): Promise<void>
  remove(id: string): Promise<void>
}

export const useNotes = create<NotesState>((set, get) => ({
  pid: null,
  notes: [],
  tool: globalThis.localStorage?.getItem(TOOL_KEY) === 'draw' ? 'draw' : 'pin',
  setTool(tool) {
    globalThis.localStorage?.setItem(TOOL_KEY, tool)
    set({ tool })
  },
  async load(pid) {
    const notes = await api.notes(pid)
    if (get().pid === pid || get().pid === null) set({ pid, notes })
    else set({ pid, notes })
  },
  async add(n) {
    const pid = get().pid
    if (!pid) return
    const note = await api.addNote(pid, { chatId: useChat.getState().activeId ?? undefined, ...n })
    set({ notes: [...get().notes, note] })
    return note
  },
  async update(id, body) {
    const pid = get().pid
    if (!pid) return
    const note = await api.updateNote(pid, id, body)
    set({ notes: get().notes.map((n) => (n.id === id ? note : n)) })
  },
  async remove(id) {
    const pid = get().pid
    if (!pid) return
    await api.deleteNote(pid, id)
    set({ notes: get().notes.filter((n) => n.id !== id) })
  },
}))

/** Notes on one slide of a deck: matched by stable slide id, else by number (PDF pages). */
/**
 * The place a note is numbered in: a slide, a PDF page, a sheet or image, a
 * text file, a slide's speaker notes, or a chat. Pins, badges and lists all
 * number a note by its place, so the same note shows the same number everywhere.
 */
export function notePlace(n: Note): string {
  if (n.target === 'chat') return `chat:${n.slideId}`
  if (n.target === 'speakerNotes') return `speaker:${n.deck}:${n.slideId}`
  if (n.quote && !n.deck.toLowerCase().endsWith('.pdf')) return `file:${n.deck}` // text / Markdown
  return `${n.deck}:${n.slideId || n.slideIndex}`
}

/** A note's number: its position among the open notes in its place (oldest first); 0 when resolved. */
export function noteNumber(n: Note, all: Note[]): number {
  if (n.status !== 'open') return 0
  const place = notePlace(n)
  return all.filter((x) => x.status === 'open' && notePlace(x) === place).findIndex((x) => x.id === n.id) + 1
}

/** Where a note is, in a few words, for lists ("slide 23", "page 4", "line 12", "speaker notes, slide 3"…). */
export function notePlaceLabel(n: Note): string {
  const lower = n.deck.toLowerCase()
  if (n.target === 'chat') return 'This chat'
  if (n.target === 'speakerNotes') return `speaker notes, slide ${n.slideIndex}`
  if (lower.endsWith('.pdf')) return `page ${n.slideIndex}`
  if (n.quote) return n.lines ? `line${/[–-]/.test(n.lines) ? 's' : ''} ${n.lines}` : 'text'
  if (lower.endsWith('.xlsx') || lower.endsWith('.xlsm')) return `sheet ${n.slideId}`
  if (/\.(png|jpe?g|gif|webp|svg)$/.test(lower)) return 'image'
  return `slide ${n.slideIndex}`
}

/**
 * Whether a note is for the agent of chat `chatId`: taken in it or brought to it (a note with no
 * chats is for every chat), and a note on a chat's message only ever for that chat. Mirrors
 * backend `Note::visible_in_chat`.
 */
export const noteForChat = (n: Note, chatId: string) =>
  (n.target !== 'chat' || n.slideId === chatId) && (!n.chats?.length || n.chats.includes(chatId))

/** The notes for the agent of chat `chatId` (see noteForChat). */
export const notesForChat = (notes: Note[], chatId: string) => notes.filter((n) => noteForChat(n, chatId))

/** Open notes taken in other chats that the user could bring to chat `chatId` (not ones on another chat's messages). */
export const otherChatsNotes = (notes: Note[], chatId: string) =>
  notes.filter((n) => n.status === 'open' && n.target !== 'chat' && !noteForChat(n, chatId))

export function notesForSlide(notes: Note[], deck: string, slideId: string, slideNumber: number): Note[] {
  // Notes in the speaker notes or a chat aren't on the slide/page itself (no pin there).
  return notes.filter((n) => !n.target && n.deck === deck && (n.slideId ? n.slideId === slideId : n.slideIndex === slideNumber))
}
