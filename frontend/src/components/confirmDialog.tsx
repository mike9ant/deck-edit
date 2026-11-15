/**
 * An in-app confirmation dialog, instead of `window.confirm` — which the
 * desktop app's web view doesn't reliably show (a missing dialog would read as
 * "cancel" and silently block the action).
 */

import { useEffect } from 'react'
import { createRoot } from 'react-dom/client'

export function askConfirm(message: string, confirmLabel = 'Continue'): Promise<boolean> {
  return new Promise((resolve) => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const done = (ok: boolean) => {
      root.unmount()
      host.remove()
      resolve(ok)
    }
    root.render(<ConfirmDialog message={message} confirmLabel={confirmLabel} onDone={done} />)
  })
}

function ConfirmDialog({ message, confirmLabel, onDone }: { message: string; confirmLabel: string; onDone(ok: boolean): void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onDone(false)
      if (e.key === 'Enter') onDone(true)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onDone])
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/30" onMouseDown={() => onDone(false)}>
      <div className="w-[420px] rounded-xl bg-white p-5 shadow-2xl" onMouseDown={(e) => e.stopPropagation()}>
        <p className="mb-4 whitespace-pre-wrap text-sm text-ink">{message}</p>
        <div className="flex justify-end gap-2">
          <button className="btn-ghost" onClick={() => onDone(false)}>Cancel</button>
          <button className="btn-primary" autoFocus onClick={() => onDone(true)}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  )
}
