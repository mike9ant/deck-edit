/**
 * App-level state: projects, the current project's folder tree, open
 * document tabs, panel widths and toasts. Per-project tab lists and panel
 * widths persist in localStorage.
 */

import { create } from 'zustand'
import { api } from '../api/client'
import type { Project, TreeNode } from '../api/types'

export type DocKind = 'pptx' | 'pdf' | 'markdown' | 'text' | 'image' | 'other'

export function docKind(path: string): DocKind {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  if (ext === 'pptx' || ext === 'potx') return 'pptx'
  if (ext === 'pdf') return 'pdf'
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
  activePath: string | null
  widths: Widths
  toasts: Toast[]
  loadProjects(): Promise<void>
  selectProject(id: string | null): Promise<void>
  refreshTree(): Promise<void>
  openFile(path: string): void
  closeTab(path: string): void
  setWidth(key: keyof Widths, px: number): void
  toast(text: string, kind?: Toast['kind']): void
}

const LS_PROJECT = 'pdfedit-project'
const lsTabs = (pid: string) => `pdfedit-tabs-${pid}`

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
  activePath: null,
  widths: savedWidths(),
  toasts: [],

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
      set({ projectId: null, tree: [], tabs: [], activePath: null })
      localStorage.removeItem(LS_PROJECT)
      return
    }
    localStorage.setItem(LS_PROJECT, id)
    let saved: { tabs: string[]; active: string | null } = { tabs: [], active: null }
    try {
      saved = { ...saved, ...JSON.parse(localStorage.getItem(lsTabs(id)) ?? '{}') }
    } catch {
      /* */
    }
    set({ projectId: id, tree: [], treeError: null, tabs: saved.tabs, activePath: saved.active })
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
    const { tabs, projectId } = get()
    const next = tabs.includes(path) ? tabs : [...tabs, path]
    set({ tabs: next, activePath: path })
    if (projectId) localStorage.setItem(lsTabs(projectId), JSON.stringify({ tabs: next, active: path }))
  },

  closeTab(path) {
    const { tabs, activePath, projectId } = get()
    const i = tabs.indexOf(path)
    const next = tabs.filter((t) => t !== path)
    const active = activePath === path ? (next[Math.min(i, next.length - 1)] ?? null) : activePath
    set({ tabs: next, activePath: active })
    if (projectId) localStorage.setItem(lsTabs(projectId), JSON.stringify({ tabs: next, active }))
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
