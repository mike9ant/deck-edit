/**
 * Links to places in the project, as the agent writes them in chat (see the system prompt in
 * backend chat.rs): a project-relative path plus a location —
 *   `Deck.pptx#slide=5`, `Report.pdf#page=3`, `notes/plan.md#line=42` (or `#line=42-48`, `#L42`),
 *   `Model.xlsx#cell=Sheet1!B4` / `#sheet=Sheet1`; no `#…` just opens the file.
 *
 * Clicking one opens the file (`goTo`) and leaves the location here as `pending`; the file's
 * viewer takes it (`take`) once it has loaded — the deck / PDF / text / spreadsheet views each
 * go there their own way.
 */

import { create } from 'zustand'
import type { TreeNode } from '../api/types'
import { useApp } from './appStore'

export interface Location {
  path: string
  slide?: number
  page?: number
  line?: number
  endLine?: number
  sheet?: string
  cell?: string
}

/** A link target as a project location, or null for web / mail / in-page links. */
export function parseLocation(href: string | undefined, projectFolder?: string): Location | null {
  if (!href || href.startsWith('#') || (/^[a-z][a-z0-9+.-]*:/i.test(href) && !href.startsWith('file:'))) return null
  let raw = href.replace(/^file:\/\//, '')
  let decoded = raw
  try { decoded = decodeURIComponent(raw) } catch { /* keep it as written */ }
  raw = decoded
  const hash = raw.indexOf('#')
  let path = hash >= 0 ? raw.slice(0, hash) : raw
  const frag = hash >= 0 ? raw.slice(hash + 1) : ''
  // An absolute path inside the project folder → relative to it.
  const root = projectFolder?.replace(/\/+$/, '')
  if (root && (path === root || path.startsWith(`${root}/`))) path = path.slice(root.length)
  path = path.replace(/^(\.\/)+/, '').replace(/^\/+/, '')
  if (!path) return null
  const loc: Location = { path }
  const num = (s: string | undefined) => {
    const n = Number(s)
    return Number.isFinite(n) && n >= 1 ? Math.floor(n) : undefined
  }
  // One location per link (no `&`: sheet names like "P&L" contain it).
  const lines = frag.match(/^(?:line=|L)(\d+)(?:-L?(\d+))?$/i)
  if (lines) {
    loc.line = num(lines[1])
    loc.endLine = num(lines[2])
    return loc
  }
  const eq = frag.indexOf('=')
  const key = frag.slice(0, eq).toLowerCase()
  const v = frag.slice(eq + 1)
  if (key === 'slide') loc.slide = num(v)
  else if (key === 'page') loc.page = num(v)
  else if (key === 'sheet') loc.sheet = v || undefined
  else if (key === 'cell') {
    const bang = v.lastIndexOf('!')
    if (bang >= 0) { loc.sheet = v.slice(0, bang).replace(/^'|'$/g, '') || undefined; loc.cell = v.slice(bang + 1) || undefined }
    else loc.cell = v || undefined
  }
  return loc
}

/** "slide 5", "page 3", "line 42", "Sheet1!B4" — for a link's tooltip. */
export function locationLabel(loc: Location): string {
  const at = loc.slide ? `slide ${loc.slide}` : loc.page ? `page ${loc.page}` : loc.line ? (loc.endLine && loc.endLine > loc.line ? `lines ${loc.line}–${loc.endLine}` : `line ${loc.line}`) : loc.cell ? (loc.sheet ? `${loc.sheet}!${loc.cell}` : loc.cell) : loc.sheet ?? ''
  return at ? `${loc.path} · ${at}` : loc.path
}

/** Every file path in the project tree. */
export function* filePaths(nodes: TreeNode[]): Generator<string> {
  for (const n of nodes) {
    if (n.kind === 'file') yield n.path
    else if (n.children) yield* filePaths(n.children)
  }
}

/** The project file a link means: as written, or else the one file with that name (or path ending). */
export function resolvePath(path: string, tree: TreeNode[]): string | null {
  const all = [...filePaths(tree)]
  if (all.includes(path)) return path
  const lower = path.toLowerCase()
  const same = all.filter((p) => p.toLowerCase() === lower)
  if (same.length === 1) return same[0]
  const ending = all.filter((p) => p.toLowerCase().endsWith(`/${lower}`))
  return ending.length === 1 ? ending[0] : null
}

interface RevealState {
  /** Where the last clicked link points, until its file's viewer has gone there. */
  pending: (Location & { seq: number }) | null
  /** Open the file and go to the location. */
  goTo(loc: Location): void
  /** The pending location, if it is in `path` (and clear it). */
  take(path: string): Location | null
}

let seq = 0

export const useReveal = create<RevealState>((set, get) => ({
  pending: null,
  goTo(loc) {
    const app = useApp.getState()
    const path = resolvePath(loc.path, app.tree)
    if (!path) return app.toast(`Couldn't find ${loc.path} in this project.`, 'error')
    const at = { ...loc, path }
    set({ pending: at.slide || at.page || at.line || at.sheet || at.cell ? { ...at, seq: ++seq } : null })
    app.openFile(path)
  },
  take(path) {
    const p = get().pending
    if (!p || p.path !== path) return null
    set({ pending: null })
    return p
  },
}))
