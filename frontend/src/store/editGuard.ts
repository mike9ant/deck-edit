/**
 * Protection from editing files without knowing it. The first time the user edits a deck, PDF or
 * text / Markdown file in a project, the app says that it auto-saves (so the agent sees the change) and that some of
 * the file's data could be lost — [OK] turns editing on, [Disable Edit] makes the project's files
 * read-only in the app (notes for the agent still work). The choice is kept per project (backend
 * `Project.editing`, shared by the desktop app and the browser version); "Edit disabled" in a
 * viewer's toolbar brings the notice back to turn editing on.
 *
 * Every edit goes through `requestEdit()` — the deck and PDF stores check it (a catch-all), and the
 * viewers check it where a gesture starts (dragging, resizing, typing), so nothing moves first and
 * snaps back; text editors stop the attempt before it lands (`useEditIntercept`).
 */

import { useEffect } from 'react'
import { create } from 'zustand'
import { api } from '../api/client'
import { useApp } from './appStore'

export type EditMode = 'ask' | 'on' | 'off'

interface EditGuardState {
  /** The notice is showing. */
  prompt: boolean
  openPrompt(): void
  closePrompt(): void
  /** Record the choice for the current project. */
  choose(mode: 'on' | 'off'): Promise<void>
}

const currentMode = (s: ReturnType<typeof useApp.getState>): EditMode => {
  const p = s.projects.find((x) => x.id === s.projectId)
  return p?.editing ?? 'ask'
}

/** The current project's editing mode. */
export const editMode = (): EditMode => currentMode(useApp.getState())
export const useEditMode = (): EditMode => useApp((s) => currentMode(s))

export const useEditGuard = create<EditGuardState>((set) => ({
  prompt: false,
  openPrompt: () => set({ prompt: true }),
  closePrompt: () => set({ prompt: false }),
  async choose(mode) {
    set({ prompt: false })
    const app = useApp.getState()
    const pid = app.projectId
    if (!pid) return
    // Show it at once; the project list comes back from the server with it.
    useApp.setState({ projects: app.projects.map((p) => (p.id === pid ? { ...p, editing: mode } : p)) })
    try {
      const updated = await api.updateProject(pid, { editing: mode })
      useApp.setState({ projects: useApp.getState().projects.map((p) => (p.id === pid ? updated : p)) })
    } catch (e) {
      useApp.getState().toast(`Couldn't save the editing choice: ${(e as Error).message}`, 'error')
    }
  },
}))

let offToastAt = 0

/**
 * May the user change a file now? Yes when editing is on. Not asked yet: shows the notice and
 * says no (the user repeats the edit after OK). Off: says how to turn it on.
 */
export function requestEdit(): boolean {
  const mode = editMode()
  if (mode === 'on') return true
  if (mode === 'ask') {
    useEditGuard.getState().openPrompt()
    return false
  }
  if (Date.now() - offToastAt > 4000) {
    offToastAt = Date.now()
    useApp.getState().toast('Editing is off in this project — click “Edit disabled” in the toolbar to turn it on. Notes for the agent still work.')
  }
  return false
}

/** Keys that change text in an editor (not moving, selecting, copying or finding). */
function isEditingKey(e: KeyboardEvent): boolean {
  if (e.isComposing) return true
  const k = e.key
  if (e.metaKey || e.ctrlKey) return ['v', 'x', 'z', 'y', 'b', 'i', 'u', 'k', 'd', 'Backspace', 'Delete', 'Enter'].includes(k.length === 1 ? k.toLowerCase() : k)
  return k.length === 1 || k === 'Backspace' || k === 'Delete' || k === 'Enter' || k === 'Tab'
}

/**
 * For a text editor while editing isn't on: an attempt to change the text inside `ref` (an editing
 * key, typing, pasting, cutting, dropping) is stopped before it lands and asks first (see
 * `requestEdit`). Moving around, selecting and copying — and notes for the agent, in their own
 * boxes — still work.
 */
export function useEditIntercept(ref: React.RefObject<HTMLElement | null>, active: boolean) {
  useEffect(() => {
    const el = ref.current
    if (!el || !active) return
    // A note's own text box (inside the editor area) types as usual.
    const ownField = (t: EventTarget | null) => t instanceof HTMLElement && !!t.closest('textarea, input')
    const stop = (e: Event) => {
      if (ownField(e.target)) return
      e.preventDefault()
      e.stopPropagation()
      requestEdit()
    }
    const onKey = (e: KeyboardEvent) => { if (isEditingKey(e)) stop(e) }
    const opts = { capture: true }
    el.addEventListener('keydown', onKey, opts)
    for (const t of ['beforeinput', 'paste', 'cut', 'drop'] as const) el.addEventListener(t, stop, opts)
    return () => {
      el.removeEventListener('keydown', onKey, opts)
      for (const t of ['beforeinput', 'paste', 'cut', 'drop'] as const) el.removeEventListener(t, stop, opts)
    }
  }, [ref, active])
}
