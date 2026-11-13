/** Slide notes for the current project (pinned by the user or the agent). */

import { create } from 'zustand'
import { api } from '../api/client'
import type { Note } from '../api/types'

interface NotesState {
  pid: string | null
  notes: Note[]
  load(pid: string): Promise<void>
  add(n: Parameters<typeof api.addNote>[1]): Promise<Note | undefined>
  update(id: string, body: Parameters<typeof api.updateNote>[2]): Promise<void>
  remove(id: string): Promise<void>
}

export const useNotes = create<NotesState>((set, get) => ({
  pid: null,
  notes: [],
  async load(pid) {
    const notes = await api.notes(pid)
    if (get().pid === pid || get().pid === null) set({ pid, notes })
    else set({ pid, notes })
  },
  async add(n) {
    const pid = get().pid
    if (!pid) return
    const note = await api.addNote(pid, n)
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
export function notesForSlide(notes: Note[], deck: string, slideId: string, slideNumber: number): Note[] {
  return notes.filter((n) => n.deck === deck && (n.slideId ? n.slideId === slideId : n.slideIndex === slideNumber))
}
