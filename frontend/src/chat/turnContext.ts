/**
 * What the agent is told about the user's view with each message: the open
 * deck and slide, the selected shapes, and the edits the user made since the
 * last turn (already saved to disk) — in decks, PDFs and text files.
 */

import type { TurnContext } from '../api/types'
import { docKind, useApp } from '../store/appStore'
import { deckKey, useDecks } from '../deck/deckStore'
import { nodeText } from '../deck/deckModel'
import { compareForAgent } from '../deck/compareStore'
import { pdfKey, usePdfs } from '../pdf/pdfStore'
import { flushTextSaves, textEditLines } from '../viewers/textEdits'

/** `consume`: mark the reported edits as delivered (only when actually sending). */
export async function buildTurnContext(consume: boolean): Promise<TurnContext> {
  const { projectId } = useApp.getState()
  if (!projectId) return {}
  // Text edits: write pending autosaves first so the agent reads the latest.
  await flushTextSaves()
  const ctx = await viewContext(projectId, consume)
  const { tabs, activePath } = useApp.getState()
  const others = tabs.filter((t) => t !== activePath)
  if (others.length) ctx.openTabs = others
  const text = textEditLines(projectId, consume)
  if (text.length) ctx.userChanges = [...(ctx.userChanges ?? []), ...text]
  return ctx
}

async function viewContext(projectId: string, consume: boolean): Promise<TurnContext> {
  const { activePath } = useApp.getState()
  if (!activePath) return {}
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
      compare: compareForAgent(projectId, activePath, s.slideIndex),
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
  if (!pid) return 0
  const text = textEditLines(pid, false).length
  if (!path) return text
  if (docKind(path) === 'pptx') return text + useDecks.getState().peekUserChanges(deckKey(pid, path)).length
  if (docKind(path) === 'pdf') return text + usePdfs.getState().peekUserChanges(pdfKey(pid, path)).length
  return text
}
