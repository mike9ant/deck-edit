/**
 * Reviewing a comparison (see review.ts): the tally and bulk choices above the thumbnails, the
 * Apply dialog (From with the accepted changes, over the From file after a backup, or as a new
 * deck), and what Apply did (with Undo apply / Compare with before).
 */

import { useEffect, useRef, useState } from 'react'
import { Check, ChevronDown, Loader2, RotateCcw, X } from 'lucide-react'
import clsx from 'clsx'
import { BULK, reviewCounts, type Decision, type ReviewItem } from './review'
import { reviewUnsaved, useCompare, type Compare } from './compareStore'
import { useApp } from '../store/appStore'

/** Above the thumbnails while reviewing: how far along, and choices for many items at once. */
export function ReviewHeader({ compare, items, onDecide }: { compare: Compare; items: ReviewItem[]; onDecide(keys: string[], d: Decision | null): void }) {
  const decisions = compare.review!.decisions
  const c = reviewCounts(items, decisions)
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [open])
  const choose = (pick: (i: ReviewItem) => boolean, d: Decision | null) => {
    onDecide(items.filter(pick).map((i) => i.key), d)
    setOpen(false)
  }
  return (
    <div ref={ref} className="relative mb-1.5 rounded border border-violet-200 bg-violet-50 px-2 py-1 text-[11px] text-violet-950" data-review-header>
      <div className="flex items-center gap-2">
        <span className="font-semibold">Review</span>
        <span className="flex items-center gap-0.5 text-emerald-700" title="Accepted"><Check size={11} /> {c.accepted}</span>
        <span className="flex items-center gap-0.5 text-ink-3" title="Not accepted (From's version kept)"><RotateCcw size={10} /> {c.rejected}</span>
        <span className="text-ink-3" title="Not decided yet (counts as not accepted)">· {c.total - c.accepted - c.rejected} open</span>
        <button className="ml-auto flex items-center gap-0.5 rounded border border-violet-200 bg-white px-1.5 py-px hover:bg-violet-100" onClick={() => setOpen(!open)}>
          Select <ChevronDown size={11} />
        </button>
      </div>
      {open && (
        <div className="absolute right-0 top-full z-30 mt-1 w-64 rounded-lg border border-hair bg-white p-1 text-xs text-ink shadow-xl">
          {BULK.map((b) => {
            const n = items.filter(b.pick).length
            return (
              <div key={b.id} className={clsx('flex items-center gap-1 rounded px-1.5 py-1', n ? 'hover:bg-paper' : 'opacity-40')}>
                <span className="min-w-0 flex-1 truncate">{b.label} <span className="text-ink-3">({n})</span></span>
                <button disabled={!n} className="rounded px-1.5 py-px text-emerald-700 hover:bg-emerald-50 disabled:pointer-events-none" title={`Accept: ${b.label.toLowerCase()}`} onClick={() => choose(b.pick, 'accept')}>✓ Accept</button>
                <button disabled={!n} className="rounded px-1.5 py-px text-ink-3 hover:bg-paper disabled:pointer-events-none" title={`Don't accept: ${b.label.toLowerCase()}`} onClick={() => choose(b.pick, 'reject')}>✗</button>
              </div>
            )
          })}
          <div className="my-1 border-t border-hair" />
          <button className="w-full rounded px-1.5 py-1 text-left text-ink-2 hover:bg-paper" onClick={() => choose(() => true, null)}>Clear all decisions</button>
        </div>
      )}
    </div>
  )
}

const stem = (p: string) => p.replace(/\.pptx$/i, '')

/** What Apply will do, and where it writes. */
export function ApplyDialog({ compare, items, onClose }: { compare: Compare; items: ReviewItem[]; onClose(): void }) {
  const { applyReview } = useCompare()
  const decisions = compare.review!.decisions
  const accepted = items.filter((i) => decisions[i.key] === 'accept')
  const slides = new Set(accepted.map((i) => i.row)).size
  const kinds = (k: ReviewItem['kind']) => accepted.filter((i) => i.kind === k).length
  const canOverwrite = compare.base.kind === 'file'
  const fromPath = compare.base.path
  const [mode, setMode] = useState<'overwrite' | 'new'>(canOverwrite ? 'overwrite' : 'new')
  const [name, setName] = useState(`${stem(fromPath)} (reviewed).pptx`)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !busy && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onClose])
  const go = async () => {
    setBusy(true)
    setError(null)
    try {
      const path = mode === 'overwrite' ? await applyReview(`${compare.pid}:${compare.path}`, { overwrite: true }) : await applyReview(`${compare.pid}:${compare.path}`, { newPath: name.endsWith('.pptx') ? name : `${name}.pptx` })
      useApp.getState().toast(`Applied ${accepted.length} change${accepted.length === 1 ? '' : 's'} to ${path.split('/').pop()}.`)
      onClose()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const parts = [
    kinds('slide-added') && `${kinds('slide-added')} new slide${kinds('slide-added') > 1 ? 's' : ''}`,
    kinds('slide-removed') && `${kinds('slide-removed')} slide${kinds('slide-removed') > 1 ? 's' : ''} removed`,
    kinds('slide-moved') && `${kinds('slide-moved')} moved`,
    (kinds('shape') + kinds('props')) && `${kinds('shape') + kinds('props')} shape or slide edit${kinds('shape') + kinds('props') > 1 ? 's' : ''}`,
    kinds('notes') && `${kinds('notes')} speaker notes`,
    kinds('comment') && `${kinds('comment')} comment${kinds('comment') > 1 ? 's' : ''}`,
  ].filter(Boolean)
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onMouseDown={() => !busy && onClose()}>
      <div className="w-[440px] rounded-xl bg-white p-4 text-sm shadow-2xl" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label="Apply the review">
        <div className="mb-2 text-base font-semibold">Apply the accepted changes</div>
        <p className="text-ink-2">
          <b>{accepted.length}</b> change{accepted.length === 1 ? '' : 's'} on {slides} slide{slides === 1 ? '' : 's'}
          {parts.length ? <> — {parts.join(', ')}</> : null} — go into <b>{fromPath.split('/').pop()}</b>.
          {' '}{items.length - accepted.length} other{items.length - accepted.length === 1 ? '' : 's'} not accepted: the From deck keeps its version.
        </p>
        {compare.diff?.deck.length ? <p className="mt-1 text-xs text-ink-3">Deck-wide differences ({compare.diff.deck.join(', ')}) aren't applied.</p> : null}
        <div className="mt-3 space-y-2">
          <label className={clsx('flex items-start gap-2', !canOverwrite && 'opacity-50')}>
            <input type="radio" className="mt-1" disabled={!canOverwrite} checked={mode === 'overwrite'} onChange={() => setMode('overwrite')} />
            <span>
              Update <b>{fromPath.split('/').pop()}</b>
              <span className="block text-xs text-ink-3">
                {canOverwrite ? 'A backup of the project is taken first — Undo apply puts the file back.' : 'The From side is a backup, not a file in the folder.'}
              </span>
            </span>
          </label>
          <label className="flex items-start gap-2">
            <input type="radio" className="mt-1" checked={mode === 'new'} onChange={() => setMode('new')} />
            <span className="min-w-0 flex-1">
              Save as a new deck
              <input
                className="mt-1 block w-full rounded border border-hair px-2 py-1 text-xs outline-none focus:border-accent"
                value={name}
                onFocus={() => setMode('new')}
                onChange={(e) => setName(e.target.value)}
              />
            </span>
          </label>
        </div>
        {error && <p className="mt-2 text-xs text-red-700">{error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <button className="btn-ghost" disabled={busy} onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={busy || !accepted.length} onClick={() => void go()}>
            {busy ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />} Apply
          </button>
        </div>
      </div>
    </div>
  )
}

/** After Apply: where it went, and the way back. */
export function AppliedNote({ compare }: { compare: Compare }) {
  const a = compare.review?.applied
  const { undoApply, open } = useCompare()
  const [hidden, setHidden] = useState<number | null>(null)
  if (!a || hidden === a.at) return null
  const name = a.path.split('/').pop()
  const stale = reviewUnsaved(compare) > 0
  return (
    <div className="flex items-center gap-2 border-b border-emerald-200 bg-emerald-50 px-3 py-1 text-xs text-emerald-900" data-review-applied>
      <Check size={13} /> Applied to <b>{name}</b>{stale ? ' — decisions changed since' : ''}.
      <button className="underline decoration-emerald-400 hover:text-emerald-700" onClick={() => useApp.getState().openFile(a.path)}>Open</button>
      {a.snapshotId && (
        <>
          <button className="underline decoration-emerald-400 hover:text-emerald-700" onClick={() => void open(compare.pid, a.path, { kind: 'snapshot', snapshotId: a.snapshotId!, path: a.path, label: 'before the review was applied' })}>Compare with before</button>
          <button className="flex items-center gap-0.5 underline decoration-emerald-400 hover:text-emerald-700" onClick={() => void undoApply(`${compare.pid}:${compare.path}`)}><RotateCcw size={11} /> Undo apply</button>
        </>
      )}
      <button className="icon-btn ml-auto h-5 w-5" title="Dismiss" onClick={() => setHidden(a.at)}><X size={12} /></button>
    </div>
  )
}
