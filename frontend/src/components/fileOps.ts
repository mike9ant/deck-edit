/**
 * File-panel operations (new folder, rename/move, delete) with the app kept in
 * step: pending saves of open decks and text files are written first (so
 * nothing is saved to a path that just moved away), open tabs follow renames
 * and close on deletes, and notes on moved decks follow (backend). Not while
 * the agent works — it may be editing those very files.
 */

import { api } from '../api/client'
import { useApp } from '../store/appStore'
import { useDecks } from '../deck/deckStore'
import { flushTextSaves } from '../viewers/textEdits'
import { agentBusy } from '../chat/sendToAgent'

const under = (p: string, roots: string[]) => roots.some((r) => p === r || p.startsWith(`${r}/`))

/** Write pending saves for open files under these paths, and let go of their deck sessions. */
async function settle(pid: string, paths: string[]) {
  await flushTextSaves()
  const decks = useDecks.getState()
  for (const s of Object.values(decks.sessions)) {
    if (s.pid !== pid || !under(s.path, paths)) continue
    await decks.saveNow(s.key)
    decks.close(s.key)
  }
}

function blocked(): boolean {
  if (!agentBusy()) return false
  useApp.getState().toast('The agent is working — rearrange files when its turn ends.')
  return true
}

const errText = (e: unknown) => (e as Error).message || String(e)

/** Rename/move files and folders. Returns the moves that happened, as [from, to]. */
export async function movePaths(pid: string, moves: [string, string][]): Promise<[string, string][]> {
  if (!moves.length || blocked()) return []
  await settle(pid, moves.map(([from]) => from))
  const done: [string, string][] = []
  for (const [from, to] of moves) {
    try {
      const r = await api.movePath(pid, from, to)
      done.push([from, r.path])
    } catch (e) {
      useApp.getState().toast(errText(e), 'error')
    }
  }
  if (done.length) useApp.getState().renameOpenPaths(done)
  await useApp.getState().refreshTree()
  return done
}

/** Move to the system Trash (folders only when empty). Returns what was deleted. */
export async function deletePaths(pid: string, paths: string[]): Promise<string[]> {
  if (!paths.length || blocked()) return []
  await settle(pid, paths)
  try {
    const { deleted } = await api.deletePaths(pid, paths)
    useApp.getState().closeOpenPaths(deleted)
    return deleted
  } catch (e) {
    useApp.getState().toast(errText(e), 'error')
    return []
  } finally {
    await useApp.getState().refreshTree()
  }
}

/** A new folder inside `dir` ('' = project root). Returns its path. */
export async function newFolder(pid: string, dir: string): Promise<string | null> {
  try {
    const { path } = await api.mkdir(pid, dir ? `${dir}/New folder` : 'New folder')
    await useApp.getState().refreshTree()
    return path
  } catch (e) {
    useApp.getState().toast(errText(e), 'error')
    return null
  }
}

export const parentOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '')
export const baseName = (p: string) => p.slice(p.lastIndexOf('/') + 1)
export const joinPath = (dir: string, name: string) => (dir ? `${dir}/${name}` : name)

/**
 * Where a set of paths would go when dropped on `dir`: skips items already
 * there and folders dropped into themselves (or their own subfolders), and
 * drops items nested inside another selected folder (they move with it).
 */
export function planMove(paths: string[], dir: string): [string, string][] {
  const top = paths.filter((p) => !paths.some((q) => q !== p && p.startsWith(`${q}/`)))
  return top
    .filter((p) => parentOf(p) !== dir && dir !== p && !dir.startsWith(`${p}/`))
    .map((p) => [p, joinPath(dir, baseName(p))])
}
