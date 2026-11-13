/**
 * The project folder as a tree. Click opens a file in a tab; images can be
 * dragged onto slides. Files (and folders) dragged in from Finder are copied
 * into the project — onto a folder row to land in that folder, anywhere else
 * for the project root — never overwriting (a taken name gets " (2)").
 */

import { useState } from 'react'
import { ChevronRight, File, FileImage, FileText, Folder, Loader2, Presentation, RefreshCw, FileType2, Upload } from 'lucide-react'
import clsx from 'clsx'
import type { TreeNode } from '../api/types'
import { docKind, useApp } from '../store/appStore'
import { collectDropped, isOsFileDrag, uploadDropped } from './fileDrop'

const icon = (path: string) => {
  switch (docKind(path)) {
    case 'pptx': return <Presentation size={14} className="text-orange-600" />
    case 'pdf': return <FileType2 size={14} className="text-red-600" />
    case 'markdown':
    case 'text': return <FileText size={14} className="text-ink-3" />
    case 'image': return <FileImage size={14} className="text-emerald-600" />
    default: return <File size={14} className="text-ink-3" />
  }
}

/** The folder a drop at this element lands in: a folder row's own path, a file row's folder, else the root. */
function dropDirAt(target: EventTarget | null): string {
  const el = (target as HTMLElement | null)?.closest?.('[data-drop-dir]')
  return el?.getAttribute('data-drop-dir') ?? ''
}

export function FileTree() {
  const { tree, treeError, refreshTree, projectId, openFile, toast } = useApp()
  const [dropDir, setDropDir] = useState<string | null>(null)
  const [uploading, setUploading] = useState<{ done: number; total: number } | null>(null)
  const [justAdded, setJustAdded] = useState<Set<string>>(new Set())

  const onDrop = (e: React.DragEvent) => {
    if (!isOsFileDrag(e.dataTransfer) || !projectId) return
    e.preventDefault()
    const dir = dropDirAt(e.target)
    setDropDir(null)
    // Entries must be read synchronously inside the drop handler.
    const collecting = collectDropped(e.dataTransfer)
    void (async () => {
      const files = await collecting
      if (!files.length) return
      setUploading({ done: 0, total: files.length })
      try {
        const written = await uploadDropped(projectId, dir, files, (done, total) => setUploading({ done, total }))
        await refreshTree()
        setJustAdded(new Set(written))
        setTimeout(() => setJustAdded(new Set()), 5000)
        const renamed = written.filter((w, i) => w !== (dir ? `${dir}/${files[i].rel}` : files[i].rel)).length
        toast(
          `Copied ${written.length} file${written.length > 1 ? 's' : ''} into ${dir || 'the project folder'}` +
            (renamed ? ` (${renamed} renamed to avoid overwriting)` : ''),
        )
        // A single deck/document opens right away.
        if (written.length === 1 && docKind(written[0]) !== 'other') openFile(written[0])
      } catch (err) {
        toast(`Couldn't copy the files: ${(err as Error).message}`, 'error')
      } finally {
        setUploading(null)
      }
    })()
  }

  return (
    <div
      className="relative flex h-full min-h-0 flex-col bg-paper"
      onDragOver={(e) => {
        if (!isOsFileDrag(e.dataTransfer) || !projectId) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
        setDropDir(dropDirAt(e.target))
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropDir(null)
      }}
      onDrop={onDrop}
    >
      <div className="flex h-9 shrink-0 items-center justify-between px-3 text-[11px] font-semibold uppercase tracking-wide text-ink-3">
        Files
        <span className="flex items-center gap-1">
          {uploading && (
            <span className="flex items-center gap-1 font-normal normal-case tracking-normal">
              <Loader2 size={12} className="animate-spin" /> {uploading.done}/{uploading.total}
            </span>
          )}
          <button className="icon-btn" title="Refresh" onClick={() => void refreshTree()}><RefreshCw size={13} /></button>
        </span>
      </div>
      <div className={clsx('min-h-0 flex-1 overflow-y-auto pb-4 text-[13px]', dropDir === '' && 'bg-accent-soft/60 ring-2 ring-inset ring-accent/40')}>
        {!projectId && <div className="px-3 text-ink-3">No project selected.</div>}
        {treeError && <div className="px-3 text-red-700">{treeError}</div>}
        {projectId && !treeError && tree.length === 0 && <div className="px-3 text-ink-3">This folder is empty — drop files here.</div>}
        {tree.map((n) => <Node key={n.path} node={n} depth={0} dropDir={dropDir} justAdded={justAdded} />)}
      </div>
      {dropDir !== null && (
        <div className="pointer-events-none absolute inset-x-2 bottom-2 flex items-center justify-center gap-1.5 rounded-md bg-ink/85 px-2 py-1.5 text-xs text-white">
          <Upload size={13} /> Copy into {dropDir || 'the project folder'}
        </div>
      )}
    </div>
  )
}

function Node({ node, depth, dropDir, justAdded }: { node: TreeNode; depth: number; dropDir: string | null; justAdded: Set<string> }) {
  const { activePath, openFile } = useApp()
  const [open, setOpen] = useState(depth < 1)
  const pad = { paddingLeft: 8 + depth * 14 }
  if (node.kind === 'dir') {
    const target = dropDir === node.path
    const hasNew = [...justAdded].some((p) => p.startsWith(`${node.path}/`))
    return (
      <div data-drop-dir={node.path} className={clsx(target && 'bg-accent-soft/70 ring-2 ring-inset ring-accent/40')}>
        <button className="flex w-full items-center gap-1 py-[3px] pr-2 text-left hover:bg-black/5" style={pad} onClick={() => setOpen(!open)}>
          <ChevronRight size={13} className={clsx('shrink-0 text-ink-3 transition-transform', (open || hasNew) && 'rotate-90')} />
          <Folder size={14} className="shrink-0 text-sky-700" />
          <span className="truncate">{node.name}</span>
        </button>
        {(open || hasNew) && node.children?.map((c) => <Node key={c.path} node={c} depth={depth + 1} dropDir={dropDir} justAdded={justAdded} />)}
      </div>
    )
  }
  const isImage = docKind(node.path) === 'image'
  const parent = node.path.includes('/') ? node.path.slice(0, node.path.lastIndexOf('/')) : ''
  return (
    <button
      data-drop-dir={parent}
      className={clsx(
        'flex w-full items-center gap-1.5 py-[3px] pr-2 text-left hover:bg-black/5',
        activePath === node.path && 'bg-accent-soft text-accent',
        justAdded.has(node.path) && 'bg-emerald-50 font-medium text-emerald-800',
      )}
      style={{ paddingLeft: 8 + depth * 14 + 17 }}
      onClick={() => openFile(node.path)}
      title={node.path}
      draggable={isImage}
      onDragStart={(e) => {
        e.dataTransfer.setData('application/x-pdfedit-path', node.path)
        e.dataTransfer.effectAllowed = 'copy'
      }}
    >
      <span className="shrink-0">{icon(node.path)}</span>
      <span className="truncate">{node.name}</span>
    </button>
  )
}
