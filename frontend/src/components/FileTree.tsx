/** The project folder as a tree. Click opens a file in a tab; images can be dragged onto slides. */

import { useState } from 'react'
import { ChevronRight, File, FileImage, FileText, Folder, Presentation, RefreshCw, FileType2 } from 'lucide-react'
import clsx from 'clsx'
import type { TreeNode } from '../api/types'
import { docKind, useApp } from '../store/appStore'

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

export function FileTree() {
  const { tree, treeError, refreshTree, projectId } = useApp()
  return (
    <div className="flex h-full min-h-0 flex-col bg-paper">
      <div className="flex h-9 shrink-0 items-center justify-between px-3 text-[11px] font-semibold uppercase tracking-wide text-ink-3">
        Files
        <button className="icon-btn" title="Refresh" onClick={() => void refreshTree()}><RefreshCw size={13} /></button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pb-4 text-[13px]">
        {!projectId && <div className="px-3 text-ink-3">No project selected.</div>}
        {treeError && <div className="px-3 text-red-700">{treeError}</div>}
        {projectId && !treeError && tree.length === 0 && <div className="px-3 text-ink-3">This folder is empty.</div>}
        {tree.map((n) => <Node key={n.path} node={n} depth={0} />)}
      </div>
    </div>
  )
}

function Node({ node, depth }: { node: TreeNode; depth: number }) {
  const { activePath, openFile } = useApp()
  const [open, setOpen] = useState(depth < 1)
  const pad = { paddingLeft: 8 + depth * 14 }
  if (node.kind === 'dir') {
    return (
      <div>
        <button className="flex w-full items-center gap-1 py-[3px] pr-2 text-left hover:bg-black/5" style={pad} onClick={() => setOpen(!open)}>
          <ChevronRight size={13} className={clsx('shrink-0 text-ink-3 transition-transform', open && 'rotate-90')} />
          <Folder size={14} className="shrink-0 text-sky-700" />
          <span className="truncate">{node.name}</span>
        </button>
        {open && node.children?.map((c) => <Node key={c.path} node={c} depth={depth + 1} />)}
      </div>
    )
  }
  const isImage = docKind(node.path) === 'image'
  return (
    <button
      className={clsx('flex w-full items-center gap-1.5 py-[3px] pr-2 text-left hover:bg-black/5', activePath === node.path && 'bg-accent-soft text-accent')}
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
