/** Header: app name, project picker (a project = a folder + its chats), new project. */

import { useEffect, useRef, useState } from 'react'
import { ChevronDown, FolderOpen, FolderPlus, Presentation, Trash2 } from 'lucide-react'
import clsx from 'clsx'
import { useApp, currentProject } from '../store/appStore'
import { api } from '../api/client'

export function TopBar() {
  const { projects, projectId, selectProject, loadProjects } = useApp()
  const project = currentProject()
  const [menu, setMenu] = useState(false)
  const [creating, setCreating] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menu) return
    const close = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenu(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [menu])

  return (
    <div className="flex h-11 shrink-0 items-center gap-3 border-b border-hair bg-panel px-3">
      <div className="flex items-center gap-1.5 font-semibold text-ink">
        <Presentation size={18} className="text-accent" /> PDF Edit
      </div>
      <div className="h-5 w-px bg-hair" />
      <div className="relative" ref={menuRef}>
        <button className="flex items-center gap-1.5 rounded-md px-2 py-1 text-sm hover:bg-paper" onClick={() => setMenu(!menu)}>
          <span className="font-medium">{project?.name ?? 'No project'}</span>
          <ChevronDown size={14} className="text-ink-3" />
        </button>
        {menu && (
          <div className="absolute left-0 top-9 z-50 w-80 rounded-lg border border-hair bg-white p-1 shadow-xl">
            {projects.map((p) => (
              <div key={p.id} className={clsx('group flex items-center rounded-md px-2 py-1.5 hover:bg-paper', p.id === projectId && 'bg-accent-soft')}>
                <button className="min-w-0 flex-1 text-left" onClick={() => { setMenu(false); void selectProject(p.id) }}>
                  <div className="truncate text-sm font-medium">{p.name}</div>
                  <div className="truncate text-[11px] text-ink-3">{p.folder}</div>
                </button>
                <button
                  className="ml-1 hidden text-ink-3 hover:text-red-600 group-hover:block"
                  title="Remove project (the folder is not touched)"
                  onClick={async () => {
                    if (!confirm(`Remove project “${p.name}”? The folder and its files are not touched.`)) return
                    await api.deleteProject(p.id)
                    if (p.id === projectId) await selectProject(null)
                    await loadProjects()
                  }}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
            {projects.length > 0 && <div className="my-1 h-px bg-hair" />}
            <button className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-paper" onClick={() => { setMenu(false); setCreating(true) }}>
              <FolderPlus size={15} /> New project…
            </button>
          </div>
        )}
      </div>
      {project && (
        <button className="flex min-w-0 items-center gap-1 truncate text-xs text-ink-3 hover:text-ink" title="Reveal in Finder" onClick={() => void api.reveal(project.id, '')}>
          <FolderOpen size={13} /> <span className="truncate">{project.folder}</span>
        </button>
      )}
      {creating && <NewProjectDialog onClose={() => setCreating(false)} />}
    </div>
  )
}

export function NewProjectDialog({ onClose }: { onClose(): void }) {
  const { loadProjects, selectProject } = useApp()
  const [folder, setFolder] = useState('')
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const pick = async () => {
    const { path } = await api.pickFolder()
    if (path) {
      setFolder(path)
      if (!name) setName(path.split('/').pop() ?? '')
    }
  }
  const create = async () => {
    setBusy(true)
    setError(null)
    try {
      const p = await api.createProject(folder.trim(), name.trim() || undefined, true)
      await loadProjects()
      await selectProject(p.id)
      onClose()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onMouseDown={onClose}>
      <div className="w-[480px] rounded-xl bg-white p-5 shadow-2xl" onMouseDown={(e) => e.stopPropagation()}>
        <h2 className="mb-1 text-base font-semibold">New project</h2>
        <p className="mb-4 text-sm text-ink-3">A project is a folder of decks (PPTX, PDF, notes) plus the agent chats that work on it.</p>
        <label className="mb-1 block text-xs font-medium text-ink-2">Folder</label>
        <div className="mb-3 flex gap-2">
          <input className="input flex-1" value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="/Users/you/Decks/My pitch" />
          <button className="btn-ghost border border-hair" onClick={() => void pick()}>Choose…</button>
        </div>
        <label className="mb-1 block text-xs font-medium text-ink-2">Name</label>
        <input className="input mb-3 w-full" value={name} onChange={(e) => setName(e.target.value)} placeholder="(folder name)" />
        <p className="mb-3 text-xs text-ink-3">A folder that doesn’t exist yet is created.</p>
        {error && <div className="mb-3 rounded bg-red-50 p-2 text-sm text-red-700">{error}</div>}
        <div className="flex justify-end gap-2">
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={!folder.trim() || busy} onClick={() => void create()}>Create project</button>
        </div>
      </div>
    </div>
  )
}
