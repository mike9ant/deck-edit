/**
 * App-level state: projects, the current project's folder tree, open
 * document tabs, panel widths and toasts. Per-project tab lists and panel
 * widths persist in localStorage.
 */

import { create } from 'zustand'
import { api } from '../api/client'
import type { Project, TreeNode } from '../api/types'

export type DocKind = 'pptx' | 'pdf' | 'markdown' | 'text' | 'image' | 'sheet' | 'other'

export function docKind(path: string): DocKind {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  if (ext === 'pptx' || ext === 'potx') return 'pptx'
  if (ext === 'pdf') return 'pdf'
  if (ext === 'xlsx' || ext === 'xlsm') return 'sheet'
  if (ext === 'md' || ext === 'markdown') return 'markdown'
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)) return 'image'
  if (['txt', 'csv', 'json', 'py', 'js', 'ts', 'yaml', 'yml', 'toml', 'html', 'css', 'log', 'xml', 'sh'].includes(ext))
    return 'text'
  return 'other'
}

export interface Toast {
  id: number
  text: string
  kind: 'info' | 'error'
}

interface Widths {
  tree: number
  rail: number
  chat: number
}

interface AppState {
  projects: Project[]
  projectId: string | null
  tree: TreeNode[]
  treeError: string | null
  tabs: string[]
  /**
   * Tabs that stay open. Any other tab is the *preview* tab (at most one):
   * opening another file replaces it. A tab is kept once the user or the
   * agent changes its file, or the user double-clicks it (see tabKeeping.ts).
   */
  kept: string[]
  /** Files of the current project changed this session — by the user or by the agent / another app. */
  changed: string[]
  activePath: string | null
  widths: Widths
  toasts: Toast[]
  /** The Files panel folded down to a thin strip. */
  filesCollapsed: boolean
  setFilesCollapsed(v: boolean): void
  /** Files/folders were renamed or moved: open tabs (and kept/changed marks) follow. */
  renameOpenPaths(pairs: [string, string][]): void
  /** Files/folders were deleted: close their tabs. */
  closeOpenPaths(paths: string[]): void
  loadProjects(): Promise<void>
  selectProject(id: string | null): Promise<void>
  refreshTree(): Promise<void>
  openFile(path: string): void
  closeTab(path: string): void
  /** Keep a project's open tab (no-op if it isn't open, or the project isn't current). */
  keepTab(pid: string, path: string): void
  /** Record that a file of the current project was changed (shows "Saved", keeps its tab). */
  markChanged(pid: string, path: string): void
  setWidth(key: keyof Widths, px: number): void
  toast(text: string, kind?: Toast['kind']): void
}

const LS_PROJECT = 'pdfedit-project'
const lsTabs = (pid: string) => `pdfedit-tabs-${pid}`
const saveTabs = (pid: string | null, tabs: string[], kept: string[], active: string | null) => {
  if (pid) localStorage.setItem(lsTabs(pid), JSON.stringify({ tabs, kept, active }))
}

const savedWidths = (): Widths => {
  try {
    return { tree: 240, rail: 200, chat: 420, ...JSON.parse(localStorage.getItem('pdfedit-widths') ?? '{}') }
  } catch {
    return { tree: 240, rail: 200, chat: 420 }
  }
}

let toastSeq = 0

export const useApp = create<AppState>((set, get) => ({
  projects: [],
  projectId: null,
  tree: [],
  treeError: null,
  tabs: [],
  kept: [],
  changed: [],
  activePath: null,
  widths: savedWidths(),
  toasts: [],
  filesCollapsed: localStorage.getItem('pdfedit-files-collapsed') === '1',
  setFilesCollapsed(v) {
    localStorage.setItem('pdfedit-files-collapsed', v ? '1' : '0')
    set({ filesCollapsed: v })
  },
  renameOpenPaths(pairs) {
    const map = (p: string) => {
      for (const [from, to] of pairs) {
        if (p === from) return to
        if (p.startsWith(`${from}/`)) return to + p.slice(from.length)
      }
      return p
    }
    const { tabs, kept, changed, activePath, projectId } = get()
    const next = { tabs: tabs.map(map), kept: kept.map(map), changed: changed.map(map), activePath: activePath && map(activePath) }
    set(next)
    saveTabs(projectId, next.tabs, next.kept, next.activePath)
  },
  closeOpenPaths(paths) {
    const gone = (p: string) => paths.some((d) => p === d || p.startsWith(`${d}/`))
    for (const t of get().tabs.filter(gone)) get().closeTab(t)
  },

  async loadProjects() {
    const projects = await api.projects()
    set({ projects })
    const want = get().projectId ?? localStorage.getItem(LS_PROJECT)
    if (want && projects.some((p) => p.id === want)) {
      if (get().projectId !== want) await get().selectProject(want)
    } else if (projects.length && !get().projectId) {
      await get().selectProject(projects[0].id)
    }
  },

  async selectProject(id) {
    if (id === null) {
      set({ projectId: null, tree: [], tabs: [], kept: [], changed: [], activePath: null })
      localStorage.removeItem(LS_PROJECT)
      return
    }
    localStorage.setItem(LS_PROJECT, id)
    let saved: { tabs: string[]; kept?: string[]; active: string | null } = { tabs: [], active: null }
    try {
      saved = { ...saved, ...JSON.parse(localStorage.getItem(lsTabs(id)) ?? '{}') }
    } catch {
      /* */
    }
    // Tabs saved before preview tabs existed are all kept.
    set({ projectId: id, tree: [], treeError: null, tabs: saved.tabs, kept: saved.kept ?? saved.tabs, changed: [], activePath: saved.active })
    api.updateProject(id, { touch: true }).catch(() => {})
    await get().refreshTree()
  },

  async refreshTree() {
    const pid = get().projectId
    if (!pid) return
    try {
      const tree = await api.tree(pid)
      if (get().projectId === pid) set({ tree, treeError: null })
    } catch (e) {
      set({ treeError: String((e as Error).message) })
    }
  },

  openFile(path) {
    const { tabs, kept, projectId } = get()
    let next = tabs
    if (!tabs.includes(path)) {
      // The new file takes the preview tab's place, if there is one.
      const preview = tabs.find((t) => !kept.includes(t))
      next = preview ? tabs.map((t) => (t === preview ? path : t)) : [...tabs, path]
    }
    set({ tabs: next, activePath: path })
    saveTabs(projectId, next, kept, path)
  },

  closeTab(path) {
    const { tabs, kept, activePath, projectId } = get()
    const i = tabs.indexOf(path)
    const next = tabs.filter((t) => t !== path)
    const nextKept = kept.filter((t) => t !== path)
    const active = activePath === path ? (next[Math.min(i, next.length - 1)] ?? null) : activePath
    set({ tabs: next, kept: nextKept, activePath: active })
    saveTabs(projectId, next, nextKept, active)
  },

  markChanged(pid, path) {
    if (pid !== get().projectId) return
    if (!get().changed.includes(path)) set({ changed: [...get().changed, path] })
    get().keepTab(pid, path)
  },

  keepTab(pid, path) {
    const { tabs, kept, activePath, projectId } = get()
    if (pid !== projectId || !tabs.includes(path) || kept.includes(path)) return
    const next = [...kept, path]
    set({ kept: next })
    saveTabs(projectId, tabs, next, activePath)
  },

  setWidth(key, px) {
    const widths = { ...get().widths, [key]: Math.round(px) }
    set({ widths })
    localStorage.setItem('pdfedit-widths', JSON.stringify(widths))
  },

  toast(text, kind = 'info') {
    const id = ++toastSeq
    set({ toasts: [...get().toasts, { id, text, kind }] })
    setTimeout(() => set({ toasts: get().toasts.filter((t) => t.id !== id) }), kind === 'error' ? 8000 : 4000)
  },
}))

export const currentProject = () => {
  const { projects, projectId } = useApp.getState()
  return projects.find((p) => p.id === projectId) ?? null
}
