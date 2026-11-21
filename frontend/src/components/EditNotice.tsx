/**
 * The auto-save notice (see store/editGuard.ts): over the top of the app the first time the user
 * edits a deck, PDF or text / Markdown file in a project — [OK] turns editing on, [Disable Edit] makes the project's
 * files read-only in the app. With editing off, "Edit disabled" takes the editing tools' place in
 * a viewer's toolbar; clicking it brings the notice back to turn editing on.
 */

import { useEffect, useRef } from 'react'
import { Lock, ShieldAlert } from 'lucide-react'
import { useEditGuard, useEditMode } from '../store/editGuard'

export function EditNotice() {
  const open = useEditGuard((s) => s.prompt)
  const { choose, closePrompt } = useEditGuard()
  const mode = useEditMode()
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (open) box.current?.focus({ preventScroll: true })
  }, [open])
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closePrompt() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, closePrompt])
  if (!open) return null
  const off = mode === 'off'
  return (
    <>
      <div className="fixed inset-0 z-[70]" onMouseDown={closePrompt} />
      {/* Focus goes to the notice itself, not its OK button: it often opens mid-typing, and the next
          Enter or space must not answer it. */}
      <div ref={box} tabIndex={-1} role="dialog" aria-label="Editing files" data-edit-notice="" className="outline-none fixed left-1/2 top-14 z-[71] w-[min(520px,calc(100vw-32px))] -translate-x-1/2 rounded-xl border border-amber-200 bg-white p-4 shadow-2xl">
        <div className="flex gap-3">
          <ShieldAlert size={20} className="mt-0.5 shrink-0 text-amber-600" />
          <div className="min-w-0 text-sm text-ink-2">
            <div className="mb-1 font-semibold text-ink">{off ? 'Editing is off in this project' : 'Editing files in Deck Edit'}</div>
            <p>
              Deck Edit auto-saves files to allow agents to see changes. We try to keep PowerPoint data intact, but some aspects could be lost;
              please back up if you believe it is necessary.
            </p>
            {off && <p className="mt-1.5 text-xs text-ink-3">While editing is off, decks and documents are read-only here — notes for the AI still work, and the agent can still change files.</p>}
            <div className="mt-3 flex justify-end gap-2">
              {off ? (
                <>
                  <button className="btn-ghost h-8 border border-hair px-3 text-sm" onClick={closePrompt}>Keep disabled</button>
                  <button className="btn-primary h-8 px-4 text-sm" onClick={() => void choose('on')}>Enable Edit</button>
                </>
              ) : (
                <>
                  <button className="btn-ghost h-8 border border-hair px-3 text-sm" onClick={() => void choose('off')}>Disable Edit</button>
                  <button className="btn-primary h-8 px-4 text-sm" onClick={() => void choose('on')}>OK</button>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  )
}

/** In place of a viewer's editing tools while editing is off: click to turn it back on. */
export function EditDisabledChip() {
  const openPrompt = useEditGuard((s) => s.openPrompt)
  return (
    <button
      className="flex h-7 shrink-0 items-center gap-1.5 rounded-md bg-amber-50 px-2 text-xs font-medium text-amber-900 ring-1 ring-amber-200 hover:bg-amber-100"
      title="Files are read-only in this project — click to turn editing on"
      data-edit-disabled=""
      onClick={openPrompt}
    >
      <Lock size={12} /> Edit disabled
    </button>
  )
}
