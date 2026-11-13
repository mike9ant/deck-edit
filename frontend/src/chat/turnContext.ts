/**
 * What the agent is told about the user's view with each message: the open
 * deck and slide, the selected shapes, and the edits the user made since the
 * last turn (already saved to disk).
 */

import type { TurnContext } from '../api/types'
import { docKind, useApp } from '../store/appStore'
import { deckKey, useDecks } from '../deck/deckStore'
import { nodeText } from '../deck/deckModel'
import { pdfKey, usePdfs } from '../pdf/pdfStore'

/** `consume`: mark the reported edits as delivered (only when actually sending). */
export async function buildTurnContext(consume: boolean): Promise<TurnContext> {
  const { projectId, activePath } = useApp.getState()
  if (!projectId || !activePath) return {}
  const kind = docKind(activePath)
  if (kind === 'pptx') {
    const key = deckKey(projectId, activePath)
    const decks = useDecks.getState()
    // Flush a pending save so the agent reads the latest edits from disk.
    await decks.saveNow(key)
    const s = useDecks.getState().sessions[key]
    if (!s?.pres) return { deck: activePath }
    const slide = s.pres.slides[s.slideIndex]
    return {
      deck: activePath,
      slideIndex: s.slideIndex + 1,
      slideCount: s.pres.slides.length,
      slideId: slide ? s.sldIds.get(slide.id) : undefined,
      selection: slide
        ? s.selection.map((id) => {
            const n = slide.nodes.find((x) => x.id === id)
            return { name: n?.name ?? id, text: n ? nodeText(n) : undefined }
          })
        : [],
      userChanges: consume ? decks.takeUserChanges(key) : decks.peekUserChanges(key),
    }
  }
  if (kind === 'pdf') {
    const key = pdfKey(projectId, activePath)
    const p = usePdfs.getState()
    const s = p.sessions[key]
    return {
      deck: activePath,
      slideIndex: s ? s.pageIndex + 1 : undefined,
      slideCount: s?.doc?.numPages,
      userChanges: consume ? p.takeUserChanges(key) : p.peekUserChanges(key),
    }
  }
  return { openFile: activePath }
}

/** Edits pending for the next turn across every open deck/PDF (for the composer's hint). */
export function pendingEditCount(pid: string | null, path: string | null): number {
  if (!pid || !path) return 0
  if (docKind(path) === 'pptx') return useDecks.getState().peekUserChanges(deckKey(pid, path)).length
  if (docKind(path) === 'pdf') return usePdfs.getState().peekUserChanges(pdfKey(pid, path)).length
  return 0
}
