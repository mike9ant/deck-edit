/**
 * The project folder as a tree, Finder-style:
 * - click selects (a file also opens, as a preview tab); double-click opens and
 *   keeps its tab; ⌘-click / ⇧-click select several; ↑/↓ move the selection;
 * - rename in place: click the selected item again after a pause, or Enter / F2;
 * - drag items onto a folder (or the empty space below, for the top level) to
 *   move them; images can also be dragged onto slides;
 * - new folder, and delete (⌫ — after a confirmation; files go to the Trash,
 *   folders only when empty) from the header or the keyboard;
 * - files dragged in from Finder are copied in — onto a folder row to land in
 *   that folder — never overwriting (a taken name gets " (2)");
 * - long names are shortened in the middle, keeping their end and extension.
 */

import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronRight, File, FileImage, FileSpreadsheet, FileText, Folder, FolderPlus, Loader2, PanelLeftClose, Presentation, RefreshCw, FileType2, Trash2, Upload,
} from 'lucide-react'
import clsx from 'clsx'
import type { TreeNode } from '../api/types'
import { docKind, useApp } from '../store/appStore'
import { collectDropped, isOsFileDrag, uploadDropped } from './fileDrop'
import { baseName, deletePaths, joinPath, movePaths, newFolder, parentOf, planMove, splitForMiddleEllipsis } from './fileOps'

const MOVE_TYPE = 'application/x-pdfedit-paths'
/** A second click on the selected item between these delays renames it (a faster one is a double-click). */
const RENAME_CLICK_MIN_MS = 450
const RENAME_CLICK_MAX_MS = 1600

const icon = (path: string) => {
  switch (docKind(path)) {
    case 'pptx': return <Presentation size={14} className="text-orange-600" />
    case 'pdf': return <FileType2 size={14} className="text-red-600" />
    case 'markdown':
    case 'text': return <FileText size={14} className="text-ink-3" />
    case 'image': return <FileImage size={14} className="text-emerald-600" />
    case 'sheet': return <FileSpreadsheet size={14} className="text-green-700" />
    default: return <File size={14} className="text-ink-3" />
  }
}

/** The folder a drop at this element lands in: a folder row's own path, a file row's folder, else the root. */
function dropDirAt(target: EventTarget | null): string {
  const el = (target as HTMLElement | null)?.closest?.('[data-drop-dir]')
  return el?.getAttribute('data-drop-dir') ?? ''
}

/** Visible rows, top to bottom (for ⇧-click ranges and arrow keys). */
function visible(nodes: TreeNode[], open: Set<string>, out: TreeNode[] = []): TreeNode[] {
  for (const n of nodes) {
    out.push(n)
    if (n.kind === 'dir' && open.has(n.path) && n.children) visible(n.children, open, out)
  }
  return out
}

interface TreeCtxValue {
  selected: string[]
  editing: string | null
  open: Set<string>
  dropDir: string | null
  justAdded: Set<string>
  activePath: string | null
  onRowClick(n: TreeNode, e: React.MouseEvent, onName: boolean): void
  onRowDoubleClick(n: TreeNode): void
  toggle(path: string): void
  onDragStart(n: TreeNode, e: React.DragEvent): void
  finishRename(n: TreeNode, name: string | null): void
}
const TreeCtx = createContext<TreeCtxValue>(null as never)

export function FileTree() {
  const { tree, treeError, refreshTree, projectId, openFile, keepTab, toast, activePath, setFilesCollapsed } = useApp()
  const [selected, setSelected] = useState<string[]>([])
  const [editing, setEditing] = useState<string | null>(null)
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [confirm, setConfirm] = useState<string[] | null>(null)
  const [dropDir, setDropDir] = useState<string | null>(null)
  const [dropKind, setDropKind] = useState<'copy' | 'move'>('copy')
  const [uploading, setUploading] = useState<{ done: number; total: number } | null>(null)
  const [justAdded, setJustAdded] = useState<Set<string>>(new Set())
  const anchor = useRef<string | null>(null)
  const lastClick = useRef<{ path: string; t: number } | null>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // Top-level folders start open (once per project).
  const initFor = useRef<string | null>(null)
  useEffect(() => {
    if (!projectId || initFor.current === projectId || !tree.length) return
    initFor.current = projectId
    setOpen(new Set(tree.filter((n) => n.kind === 'dir').map((n) => n.path)))
    setSelected([])
  }, [projectId, tree])

  // The file in view (switching tabs) is selected here too: its folders open, its row scrolled into view.
  // The panel may have been collapsed meanwhile — this runs again when it reopens.
  useEffect(() => {
    if (!activePath || !tree.length) return
    const parts = activePath.split('/')
    const dirs = parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('/'))
    if (dirs.some((d) => !open.has(d))) setOpen((o) => new Set([...o, ...dirs]))
    setSelected((sel) => (sel.length === 1 && sel[0] === activePath) || sel.includes(activePath) ? sel : [activePath])
    requestAnimationFrame(() => {
      const row = listRef.current?.querySelector(`[title="${CSS.escape(activePath)}"][draggable]`)
      row?.scrollIntoView({ block: 'nearest' })
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePath, tree])

  const rows = useMemo(() => visible(tree, open), [tree, open])
  const byPath = useMemo(() => new Map(rows.map((n) => [n.path, n])), [rows])
  const toggle = (path: string) => setOpen((o) => { const n = new Set(o); if (n.has(path)) n.delete(path); else n.add(path); return n })
  const select = (paths: string[]) => { setSelected(paths); listRef.current?.focus({ preventScroll: true }) }

  const onRowClick = (n: TreeNode, e: React.MouseEvent, onName: boolean) => {
    if (editing === n.path) return
    const now = Date.now()
    if (e.metaKey || e.ctrlKey) {
      select(selected.includes(n.path) ? selected.filter((p) => p !== n.path) : [...selected, n.path])
      anchor.current = n.path
      return
    }
    if (e.shiftKey && anchor.current) {
      const a = rows.findIndex((r) => r.path === anchor.current)
      const b = rows.findIndex((r) => r.path === n.path)
      if (a >= 0 && b >= 0) select(rows.slice(Math.min(a, b), Math.max(a, b) + 1).map((r) => r.path))
      return
    }
    // A second, unhurried click on the (only) selected item's name: rename.
    const prev = lastClick.current
    if (onName && selected.length === 1 && selected[0] === n.path && prev?.path === n.path && now - prev.t > RENAME_CLICK_MIN_MS && now - prev.t < RENAME_CLICK_MAX_MS) {
      lastClick.current = null
      setEditing(n.path)
      return
    }
    const quickRepeat = prev?.path === n.path && now - prev.t <= RENAME_CLICK_MIN_MS
    lastClick.current = { path: n.path, t: now }
    select([n.path])
    anchor.current = n.path
    if (quickRepeat) return // the second click of a double-click
    if (n.kind === 'dir') toggle(n.path)
    else openFile(n.path)
  }

  const onRowDoubleClick = (n: TreeNode) => {
    if (n.kind === 'file' && projectId) {
      openFile(n.path)
      keepTab(projectId, n.path)
    }
  }

  const finishRename = async (n: TreeNode, name: string | null) => {
    setEditing(null)
    listRef.current?.focus({ preventScroll: true })
    if (!projectId || name === null) return
    const t = name.trim()
    if (!t || t === n.name) return
    if (/[/\\]/.test(t) || t.startsWith('.')) return toast('A name can’t contain “/” or start with “.”.', 'error')
    const done = await movePaths(projectId, [[n.path, joinPath(parentOf(n.path), t)]])
    if (done.length) setSelected([done[0][1]])
  }

  const onDragStart = (n: TreeNode, e: React.DragEvent) => {
    const paths = selected.includes(n.path) ? selected : [n.path]
    if (!selected.includes(n.path)) setSelected([n.path])
    e.dataTransfer.setData(MOVE_TYPE, JSON.stringify(paths))
    // A single image can also be dropped onto a slide.
    if (paths.length === 1 && docKind(paths[0]) === 'image') e.dataTransfer.setData('application/x-pdfedit-path', paths[0])
    e.dataTransfer.effectAllowed = 'copyMove'
  }

  const createFolder = async () => {
    if (!projectId) return
    const one = selected.length === 1 ? byPath.get(selected[0]) : undefined
    const dir = one ? (one.kind === 'dir' ? one.path : parentOf(one.path)) : ''
    const path = await newFolder(projectId, dir)
    if (!path) return
    if (dir) setOpen((o) => new Set(o).add(dir))
    setSelected([path])
    setEditing(path)
  }

  const doDelete = async (paths: string[]) => {
    setConfirm(null)
    listRef.current?.focus({ preventScroll: true })
    if (!projectId) return
    const deleted = await deletePaths(projectId, paths)
    if (deleted.length) {
      setSelected([])
      toast(`Moved ${deleted.length === 1 ? `“${baseName(deleted[0])}”` : `${deleted.length} items`} to the Trash.`)
    }
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (editing || confirm) return
    if ((e.key === 'Enter' || e.key === 'F2') && selected.length === 1) {
      e.preventDefault()
      setEditing(selected[0])
    } else if ((e.key === 'Backspace' || e.key === 'Delete') && selected.length) {
      e.preventDefault()
      setConfirm(selected)
    } else if (e.key === 'Escape') {
      setSelected([])
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const i = rows.findIndex((r) => r.path === (selected[selected.length - 1] ?? ''))
      const next = rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))]
      if (!next) return
      select([next.path])
      anchor.current = next.path
      if (next.kind === 'file') openFile(next.path)
    }
  }

  const onDrop = (e: React.DragEvent) => {
    if (!projectId) return
    const dir = dropDirAt(e.target)
    setDropDir(null)
    // Rows dragged within the tree: move them.
    const moving = e.dataTransfer.getData(MOVE_TYPE)
    if (moving) {
      e.preventDefault()
      const plan = planMove(JSON.parse(moving) as string[], dir)
      if (!plan.length) return
      void movePaths(projectId, plan).then((done) => {
        if (!done.length) return
        if (dir) setOpen((o) => new Set(o).add(dir))
        setSelected(done.map(([, to]) => to))
        toast(`Moved ${done.length === 1 ? `“${baseName(done[0][0])}”` : `${done.length} items`} into ${dir || 'the project folder'}.`)
      })
      return
    }
    if (!isOsFileDrag(e.dataTransfer)) return
    e.preventDefault()
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

  const ctx: TreeCtxValue = { selected, editing, open, dropDir, justAdded, activePath, onRowClick, onRowDoubleClick, toggle, onDragStart, finishRename: (n, name) => void finishRename(n, name) }

  return (
    <div
      className="relative flex h-full min-h-0 flex-col bg-paper"
      onDragOver={(e) => {
        if (!projectId) return
        const internal = e.dataTransfer.types.includes(MOVE_TYPE)
        if (!internal && !isOsFileDrag(e.dataTransfer)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = internal ? 'move' : 'copy'
        setDropKind(internal ? 'move' : 'copy')
        setDropDir(dropDirAt(e.target))
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropDir(null)
      }}
      onDrop={onDrop}
    >
      <div className="flex h-9 shrink-0 items-center justify-between pl-3 pr-1 text-[11px] font-semibold uppercase tracking-wide text-ink-3">
        Files
        <span className="flex items-center">
          {uploading && (
            <span className="mr-1 flex items-center gap-1 font-normal normal-case tracking-normal">
              <Loader2 size={12} className="animate-spin" /> {uploading.done}/{uploading.total}
            </span>
          )}
          <button className="icon-btn" title="New folder" disabled={!projectId} onClick={() => void createFolder()}><FolderPlus size={14} /></button>
          <button className="icon-btn" title="Delete… (⌫) — files go to the Trash; folders only when empty" disabled={!selected.length} onClick={() => setConfirm(selected)}><Trash2 size={13} /></button>
          <button className="icon-btn" title="Refresh" onClick={() => void refreshTree()}><RefreshCw size={13} /></button>
          <button className="icon-btn" title="Hide the files panel" onClick={() => setFilesCollapsed(true)}><PanelLeftClose size={14} /></button>
        </span>
      </div>
      <TreeCtx.Provider value={ctx}>
        <div
          ref={listRef}
          tabIndex={0}
          onKeyDown={onKeyDown}
          className={clsx('min-h-0 flex-1 overflow-y-auto pb-4 text-[13px] outline-none', dropDir === '' && 'bg-accent-soft/60 ring-2 ring-inset ring-accent/40')}
          onMouseDown={(e) => { if (e.target === e.currentTarget) setSelected([]) }}
        >
          {!projectId && <div className="px-3 text-ink-3">No project selected.</div>}
          {treeError && <div className="px-3 text-red-700">{treeError}</div>}
          {projectId && !treeError && tree.length === 0 && <div className="px-3 text-ink-3">This folder is empty — drop files here.</div>}
          {tree.map((n) => <Row key={n.path} node={n} depth={0} />)}
        </div>
      </TreeCtx.Provider>
      {dropDir !== null && (
        <div className="pointer-events-none absolute inset-x-2 bottom-2 flex items-center justify-center gap-1.5 rounded-md bg-ink/85 px-2 py-1.5 text-xs text-white">
          <Upload size={13} /> {dropKind === 'move' ? 'Move into' : 'Copy into'} {dropDir || 'the project folder'}
        </div>
      )}
      {confirm && <ConfirmDelete paths={confirm} onCancel={() => { setConfirm(null); listRef.current?.focus() }} onConfirm={() => void doDelete(confirm)} />}
    </div>
  )
}

/** A name shortened in the middle when the row is narrow: "Acme — Board Rev…raft_3.pptx". */
function Name({ name }: { name: string }) {
  const [head, tail] = splitForMiddleEllipsis(name)
  return (
    <span className="flex min-w-0">
      <span className="truncate">{head}</span>
      {tail && <span className="shrink-0 whitespace-pre">{tail}</span>}
    </span>
  )
}

function RenameBox({ node }: { node: TreeNode }) {
  const { finishRename } = useContext(TreeCtx)
  const [value, setValue] = useState(node.name)
  const ref = useRef<HTMLInputElement>(null)
  const done = useRef(false)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.focus()
    // Select the name without its extension, as Finder does.
    const dot = node.kind === 'file' ? node.name.lastIndexOf('.') : -1
    el.setSelectionRange(0, dot > 0 ? dot : node.name.length)
  }, [node])
  const end = (name: string | null) => {
    if (done.current) return
    done.current = true
    finishRename(node, name)
  }
  return (
    <input
      ref={ref}
      className="min-w-0 flex-1 rounded border border-accent bg-white px-1 py-0 text-[13px] text-ink outline-none"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') end(value)
        if (e.key === 'Escape') end(null)
      }}
      onBlur={() => end(value)}
      draggable={false}
      onDragStart={(e) => e.preventDefault()}
    />
  )
}

function Row({ node, depth }: { node: TreeNode; depth: number }) {
  const c = useContext(TreeCtx)
  const isDir = node.kind === 'dir'
  const isOpen = isDir && (c.open.has(node.path) || [...c.justAdded].some((p) => p.startsWith(`${node.path}/`)))
  const isSelected = c.selected.includes(node.path)
  const isEditing = c.editing === node.path
  const target = isDir && c.dropDir === node.path
  const row = (
    <div
      data-drop-dir={isDir ? node.path : parentOf(node.path)}
      className={clsx(
        'flex w-full cursor-default select-none items-center gap-1.5 py-[3px] pr-2',
        isSelected ? 'bg-accent-soft' : 'hover:bg-black/5',
        !isDir && c.activePath === node.path && 'font-medium text-accent',
        c.justAdded.has(node.path) && 'bg-emerald-50 font-medium text-emerald-800',
      )}
      style={{ paddingLeft: 8 + depth * 14 + (isDir ? 0 : 17) }}
      title={node.path}
      draggable={!isEditing}
      onDragStart={(e) => c.onDragStart(node, e)}
      onClick={(e) => c.onRowClick(node, e, !!(e.target as HTMLElement).closest('[data-name]'))}
      onDoubleClick={() => c.onRowDoubleClick(node)}
    >
      {isDir && (
        <span className="-my-1 shrink-0 py-1" onClick={(e) => { e.stopPropagation(); c.toggle(node.path) }} title={isOpen ? 'Collapse' : 'Expand'}>
          <ChevronRight size={13} className={clsx('text-ink-3 transition-transform', isOpen && 'rotate-90')} />
        </span>
      )}
      <span className="shrink-0">{isDir ? <Folder size={14} className="text-sky-700" /> : icon(node.path)}</span>
      {isEditing ? <RenameBox node={node} /> : <span data-name className="flex min-w-0"><Name name={node.name} /></span>}
    </div>
  )
  if (!isDir) return row
  return (
    <div data-drop-dir={node.path} className={clsx(target && 'bg-accent-soft/70 ring-2 ring-inset ring-accent/40')}>
      {row}
      {isOpen && node.children?.map((ch) => <Row key={ch.path} node={ch} depth={depth + 1} />)}
    </div>
  )
}

function ConfirmDelete({ paths, onCancel, onConfirm }: { paths: string[]; onCancel(): void; onConfirm(): void }) {
  const ok = useRef<HTMLButtonElement>(null)
  useEffect(() => ok.current?.focus(), [])
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onMouseDown={onCancel} onKeyDown={(e) => e.key === 'Escape' && onCancel()}>
      <div className="w-[380px] rounded-xl bg-white p-4 shadow-2xl" onMouseDown={(e) => e.stopPropagation()}>
        <div className="mb-2 text-sm font-semibold">
          Move {paths.length === 1 ? `“${baseName(paths[0])}”` : `${paths.length} items`} to the Trash?
        </div>
        {paths.length > 1 && (
          <ul className="mb-2 max-h-40 overflow-y-auto text-xs text-ink-2">
            {paths.slice(0, 12).map((p) => <li key={p} className="truncate">• {p}</li>)}
            {paths.length > 12 && <li>…and {paths.length - 12} more</li>}
          </ul>
        )}
        <p className="text-xs text-ink-3">You can restore files from the Trash. Folders are deleted only when empty.</p>
        <div className="mt-3 flex justify-end gap-2">
          <button className="btn-ghost" onClick={onCancel}>Cancel</button>
          <button ref={ok} className="btn-primary bg-red-600 hover:bg-red-700" onClick={onConfirm}>Move to Trash</button>
        </div>
      </div>
    </div>
  )
}
