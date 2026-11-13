/** A counter per file, bumped by watcher events, so viewers reload when a file changes on disk. */

import { create } from 'zustand'

interface FileVersions {
  versions: Record<string, number>
  bump(pid: string, path: string): void
}

export const useFileVersions = create<FileVersions>((set, get) => ({
  versions: {},
  bump(pid, path) {
    const k = `${pid}:${path}`
    set({ versions: { ...get().versions, [k]: (get().versions[k] ?? 0) + 1 } })
  },
}))

export const useFileVersion = (pid: string, path: string) => useFileVersions((s) => s.versions[`${pid}:${path}`] ?? 0)
