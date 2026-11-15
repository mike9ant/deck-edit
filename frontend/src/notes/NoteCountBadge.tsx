/** A small "open notes for the agent" tag shown next to a file's name (file tree, tabs). */

import { StickyNote } from 'lucide-react'
import { useNotes } from '../store/notesStore'

/** Open notes on the file at `path` (a number: a stable selector result). */
export const useOpenNoteCount = (path: string) =>
  useNotes((s) => s.notes.reduce((k, n) => k + (n.deck === path && n.status === 'open' ? 1 : 0), 0))

export function NoteCountBadge({ path }: { path: string }) {
  const count = useOpenNoteCount(path)
  if (!count) return null
  return (
    <span
      className="flex shrink-0 items-center gap-0.5 rounded-full bg-note px-1.5 text-[10px] font-semibold leading-4 text-amber-950 ring-1 ring-amber-300"
      title={`${count} open note${count > 1 ? 's' : ''} for the AI agent`}
    >
      <StickyNote size={9} /> {count}
    </span>
  )
}
