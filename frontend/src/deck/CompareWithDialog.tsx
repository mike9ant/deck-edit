/**
 * Deck → Compare With… (desktop menu): pick another deck of the project to compare this one with —
 * the same as dropping one deck onto another in the Files panel (the newer file is To).
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { Presentation } from 'lucide-react'
import clsx from 'clsx'
import { useApp } from '../store/appStore'
import type { TreeNode } from '../api/types'
import { useCompare } from './compareStore'

function decks(nodes: TreeNode[], out: string[] = []): string[] {
  for (const n of nodes) {
    if (n.kind === 'dir') decks(n.children ?? [], out)
    else if (/\.pptx$/i.test(n.name) && !n.name.startsWith('~$')) out.push(n.path)
  }
  return out
}

export function CompareWithDialog({ pid, path, onClose }: { pid: string; path: string; onClose(): void }) {
  const tree = useApp((s) => s.tree)
  const [filter, setFilter] = useState('')
  const [at, setAt] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const all = useMemo(() => decks(tree).filter((p) => p !== path), [tree, path])
  const shown = all.filter((p) => p.toLowerCase().includes(filter.trim().toLowerCase()))
  useEffect(() => input.current?.focus(), [])
  useEffect(() => setAt(0), [filter])

  const pick = (other: string) => {
    onClose()
    void useCompare.getState().openFiles(pid, other, path)
  }
  const onKey = (e: React.KeyboardEvent) => {
    e.stopPropagation()
    if (e.key === 'Escape') onClose()
    else if (e.key === 'ArrowDown') { e.preventDefault(); setAt((i) => Math.min(i + 1, shown.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setAt((i) => Math.max(i - 1, 0)) }
    else if (e.key === 'Enter' && shown[at]) pick(shown[at])
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 pt-[12vh]" onMouseDown={onClose}>
      <div className="w-[480px] rounded-xl bg-white p-3 text-sm shadow-2xl" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label="Compare with another deck">
        <div className="mb-2 font-medium">Compare <span className="text-ink-2">{path.split('/').pop()}</span> with…</div>
        <input
          ref={input}
          className="mb-2 w-full rounded-md border border-hair px-2 py-1.5 outline-none focus:border-accent"
          placeholder="Filter the project's decks"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={onKey}
        />
        <div className="max-h-72 overflow-y-auto">
          {shown.length === 0 && <div className="px-2 py-3 text-ink-3">{all.length ? 'No deck matches.' : 'There is no other deck in this project.'}</div>}
          {shown.map((p, i) => (
            <button
              key={p}
              className={clsx('flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left', i === at ? 'bg-accent/10' : 'hover:bg-paper')}
              onMouseEnter={() => setAt(i)}
              onClick={() => pick(p)}
            >
              <Presentation size={14} className="shrink-0 text-ink-3" />
              <span className="min-w-0 truncate">{p.split('/').pop()}</span>
              {p.includes('/') && <span className="ml-auto min-w-0 shrink truncate text-xs text-ink-3">{p.slice(0, p.lastIndexOf('/'))}</span>}
            </button>
          ))}
        </div>
        <div className="mt-2 text-[11px] text-ink-3">The newer of the two is shown as To. You can also drop one deck onto another in the Files panel.</div>
      </div>
    </div>
  )
}
