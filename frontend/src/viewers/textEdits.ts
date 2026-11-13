/**
 * Bookkeeping for text/Markdown files edited in the app, so the agent hears
 * about them like deck edits: open editors register a flush (a pending
 * autosave is written before a turn starts), and each save records the file
 * as edited until the next turn reports it.
 */

import { create } from 'zustand'

/** Bumped whenever the edited set changes, so the composer's "edits will be shared" hint updates. */
export const useTextEditTick = create<{ n: number }>(() => ({ n: 0 }))
const tick = () => useTextEditTick.setState((s) => ({ n: s.n + 1 }))

const savers = new Map<string, () => Promise<void>>()
const edited = new Map<string, Set<string>>()

export function registerTextSaver(id: string, flush: () => Promise<void>): () => void {
  savers.set(id, flush)
  return () => {
    if (savers.get(id) === flush) savers.delete(id)
  }
}

/** Write every pending autosave now. */
export async function flushTextSaves(): Promise<void> {
  await Promise.all([...savers.values()].map((f) => f().catch(() => {})))
}

export function markTextEdited(pid: string, path: string) {
  const set = edited.get(pid) ?? new Set<string>()
  set.add(path)
  edited.set(pid, set)
  tick()
}

/** The edited files as change lines for the agent; `consume` clears them. */
export function textEditLines(pid: string, consume: boolean): string[] {
  const set = edited.get(pid)
  if (!set?.size) return []
  const lines = [...set].map((p) => `Edited the text of ${p} in the app's editor (re-read it before changing it)`)
  if (consume) {
    edited.delete(pid)
    tick()
  }
  return lines
}
