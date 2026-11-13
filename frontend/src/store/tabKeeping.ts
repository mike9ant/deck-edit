/**
 * Which files were changed this session (`changed` in appStore — the only
 * files whose status shows "Saved"), and when a document tab stops being the
 * replaceable *preview* tab and stays open (`kept`): a change by the user (any
 * deck or PDF edit, typing in a text/Markdown file) or by the agent / another
 * app (a file event from another writer) does both; pinning a note on a file,
 * or double-clicking its tab, only keeps the tab.
 *
 * Imported once for its side effects (App.tsx).
 */

import { CLIENT_ID } from '../api/client'
import type { ServerEvent } from '../api/types'
import { useApp } from './appStore'
import { useNotes } from './notesStore'
import { useDecks } from '../deck/deckStore'
import { usePdfs } from '../pdf/pdfStore'

const keep = (pid: string, path: string) => useApp.getState().keepTab(pid, path)
const changed = (pid: string, path: string) => useApp.getState().markChanged(pid, path)

/** Every user edit to a deck or PDF lands on its undo stack. */
function markEdited(sessions: Record<string, { pid: string; path: string; undo: unknown[] }>, prev: typeof sessions) {
  for (const [k, s] of Object.entries(sessions)) {
    if (s.undo.length > (prev[k]?.undo.length ?? 0)) changed(s.pid, s.path)
  }
}
useDecks.subscribe((s, prev) => {
  if (s.sessions !== prev.sessions) markEdited(s.sessions, prev.sessions)
})
usePdfs.subscribe((s, prev) => {
  if (s.sessions !== prev.sessions) markEdited(s.sessions, prev.sessions)
})

// A note pinned on a document.
useNotes.subscribe((s, prev) => {
  if (!s.pid || s.notes === prev.notes) return
  const before = new Set(prev.notes.map((n) => n.id))
  for (const n of s.notes) if (!before.has(n.id)) keep(s.pid, n.deck)
})

/** The agent (or another app) changed a file on disk. Our own saves carry our client id. */
export function markChangedOnFileEvent(ev: Extract<ServerEvent, { type: 'file' }>) {
  if (ev.writer !== CLIENT_ID) changed(ev.projectId, ev.path)
}
