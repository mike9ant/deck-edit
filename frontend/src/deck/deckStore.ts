/**
 * Open PPTX decks: load, live reload, edit, undo/redo, save.
 *
 * Editing goes through @diceui/pptx-core's `applyEdit`, which mutates the
 * parsed XML of only the parts an edit touches; `writePptx` copies every other
 * part through byte-for-byte, and `repairPackage` fixes the notes-page
 * relationships the engine doesn't model. Saves are debounced and guarded by
 * the file's etag, so an edit never silently overwrites a change made on disk
 * (by the agent or PowerPoint) since the deck was loaded.
 *
 * Live reload: a watcher event for the open deck that isn't our own save
 * re-reads the file, keeps the user on the same slide (by stable slide id)
 * and flags the slides whose XML changed, so the rail can badge them.
 */

import { create } from 'zustand'
import {
  applyEdit, buildPresentation, readPptx, writePptx,
  type EditOperation, type EditResult, type PresentationData,
} from '@diceui/pptx-core'
import { loadEmbeddedFonts } from '@diceui/pptx-core/fonts'
import { api, ApiError, CLIENT_ID } from '../api/client'
import { useApp } from '../store/appStore'
import { repairPackage } from './packageHygiene'
import { readSlideIds, slideTitle, slideXmlBySldId } from './deckModel'

export interface UndoEntry {
  undo: () => void
  /** Re-applies the edit (a single op, or a whole transaction). */
  redo: () => Promise<unknown>
  description: string
  /** Consecutive edits with the same key (e.g. nudging one shape) read as one change for the agent. */
  coalesceKey?: string
}

export interface DeckSession {
  key: string
  pid: string
  path: string
  pres: PresentationData | null
  etag: string
  loading: boolean
  error: string | null
  /** Bumped on every model change; renderers key off it. */
  version: number
  /** slide id → version of its last change (thumbnails re-render only those). */
  slideVersions: Record<string, number>
  slideIndex: number
  selection: string[]
  undo: UndoEntry[]
  redo: UndoEntry[]
  /** Undo-stack length when the last agent turn was sent: newer entries are "edits since your last turn". */
  turnBaseline: number
  dirty: boolean
  saving: boolean
  /** slide part path → stable sldId */
  sldIds: Map<string, string>
  /** Stable ids of slides changed by the last external (agent/PowerPoint) save. */
  externallyChanged: string[]
  externalAt: number
  lastSlideXml: Map<string, string>
}

interface DeckStore {
  sessions: Record<string, DeckSession>
  open(pid: string, path: string): Promise<void>
  reload(key: string, external: boolean): Promise<void>
  close(key: string): void
  apply(key: string, op: EditOperation, description: string, coalesceKey?: string): Promise<string[] | undefined>
  /**
   * Several edits as ONE undo step, for edits that depend on each other's
   * results (e.g. add a slide, then paste onto it). `fn` gets a runner that
   * applies one op and returns its result; if `fn` throws, everything it
   * applied is rolled back.
   */
  /**
   * An edit the engine doesn't model (speaker notes): `run` changes the package
   * and returns its undo. Saved, undoable and reported to the agent like any other.
   */
  applyCustom(key: string, description: string, run: () => Promise<() => void>, coalesceKey?: string): Promise<boolean>
  transaction<T>(key: string, description: string, fn: (run: (op: EditOperation) => Promise<EditResult>, pres: PresentationData) => Promise<T>): Promise<T | undefined>
  undo(key: string): void
  redo(key: string): Promise<void>
  setSlide(key: string, index: number): void
  setSelection(key: string, ids: string[]): void
  saveNow(key: string): Promise<void>
  /** "Edits since your last turn" for the agent; then starts a new baseline. */
  takeUserChanges(key: string): string[]
  peekUserChanges(key: string): string[]
}

export const deckKey = (pid: string, path: string) => `${pid}:${path}`

const saveTimers = new Map<string, ReturnType<typeof setTimeout>>()
const fontHandles = new Map<string, ReturnType<typeof loadEmbeddedFonts>>()
const SAVE_DEBOUNCE_MS = 600

/** Set by the chat store: is an agent turn running in this project (editing is paused)? */
export let isProjectBusy: (pid: string) => boolean = () => false
export const setBusyProbe = (f: (pid: string) => boolean) => {
  isProjectBusy = f
}

async function parse(bytes: ArrayBuffer): Promise<PresentationData> {
  const files = await readPptx(bytes, { keepSourcePackage: true })
  return buildPresentation(files)
}

export const useDecks = create<DeckStore>((set, get) => {
  const patch = (key: string, p: Partial<DeckSession>) => {
    const s = get().sessions[key]
    if (!s) return
    set({ sessions: { ...get().sessions, [key]: { ...s, ...p } } })
  }

  const publishMap = (s: DeckSession) => {
    if (!s.pres) return
    const slides = s.pres.slides.map((sl, i) => ({ slideId: s.sldIds.get(sl.id) ?? '', index: i + 1, title: slideTitle(sl) }))
    api.putDeckMap(s.pid, s.path, slides).catch(() => {})
  }

  const scheduleSave = (key: string) => {
    clearTimeout(saveTimers.get(key))
    saveTimers.set(key, setTimeout(() => void get().saveNow(key), SAVE_DEBOUNCE_MS))
  }

  return {
    sessions: {},

    async open(pid, path) {
      const key = deckKey(pid, path)
      if (get().sessions[key]) return
      const s: DeckSession = {
        key, pid, path, pres: null, etag: '', loading: true, error: null, version: 0, slideVersions: {},
        slideIndex: 0, selection: [], undo: [], redo: [], turnBaseline: 0, dirty: false, saving: false,
        sldIds: new Map(), externallyChanged: [], externalAt: 0, lastSlideXml: new Map(),
      }
      set({ sessions: { ...get().sessions, [key]: s } })
      await get().reload(key, false)
    },

    async reload(key, external) {
      const s0 = get().sessions[key]
      if (!s0) return
      patch(key, { loading: !s0.pres })
      // A save from python-pptx/PowerPoint can be observed mid-write; retry briefly.
      let lastErr: unknown
      for (let attempt = 0; attempt < 6; attempt++) {
        try {
          const { bytes, etag } = await api.readFile(s0.pid, s0.path)
          const keep = bytes.slice(0)
          const pres = await parse(bytes)
          if (!fontHandles.has(key)) fontHandles.set(key, loadEmbeddedFonts(pres))
          await fontHandles.get(key)!.ready
          const [sldIds, slideXml] = await Promise.all([readSlideIds(keep), slideXmlBySldId(keep)])
          const s = get().sessions[key]
          if (!s) return
          // Stay on the same slide (by stable id) across the reload.
          const prevSlide = s.pres?.slides[s.slideIndex]
          const prevSid = prevSlide ? s.sldIds.get(prevSlide.id) : undefined
          let slideIndex = Math.min(s.slideIndex, pres.slides.length - 1)
          if (prevSid) {
            const i = pres.slides.findIndex((sl) => sldIds.get(sl.id) === prevSid)
            if (i >= 0) slideIndex = i
          }
          const changed: string[] = []
          if (external) for (const [sid, xml] of slideXml) if (s.lastSlideXml.get(sid) !== xml) changed.push(sid)
          const version = s.version + 1
          const slideVersions: Record<string, number> = {}
          for (const sl of pres.slides) slideVersions[sl.id] = version
          const next: DeckSession = {
            ...s, pres, etag, loading: false, error: null, version, slideVersions, slideIndex: Math.max(0, slideIndex),
            selection: external ? [] : s.selection,
            // An external change invalidates the undo history (it describes the old file).
            undo: external ? [] : s.undo, redo: external ? [] : s.redo, turnBaseline: external ? 0 : s.turnBaseline,
            dirty: false, sldIds, lastSlideXml: slideXml,
            externallyChanged: external ? changed : s.externallyChanged,
            externalAt: external ? Date.now() : s.externalAt,
          }
          set({ sessions: { ...get().sessions, [key]: next } })
          publishMap(next)
          return
        } catch (e) {
          lastErr = e
          if (e instanceof ApiError && e.status === 404) break
          await new Promise((r) => setTimeout(r, 400 + attempt * 300))
        }
      }
      patch(key, { loading: false, error: `Couldn't open the deck: ${(lastErr as Error)?.message ?? lastErr}` })
    },

    close(key) {
      const { [key]: _gone, ...rest } = get().sessions
      fontHandles.get(key)?.dispose()
      fontHandles.delete(key)
      set({ sessions: rest })
    },

    async apply(key, op, description, coalesceKey) {
      const s = get().sessions[key]
      if (!s?.pres) return
      if (isProjectBusy(s.pid)) {
        useApp.getState().toast('The agent is working on this project — editing resumes when its turn ends.')
        return
      }
      try {
        const res = await applyEdit(s.pres, op)
        const cur = get().sessions[key]!
        const version = cur.version + 1
        const slideVersions = { ...cur.slideVersions }
        for (const id of res.affectedSlideIds) slideVersions[id] = version
        if (res.createdSlideId) slideVersions[res.createdSlideId] = version
        patch(key, {
          version, slideVersions, dirty: true,
          undo: [...cur.undo, { undo: res.undo, redo: () => get().apply(key, op, description, coalesceKey), description, coalesceKey }],
          redo: [],
        })
        scheduleSave(key)
        return res.createdNodeIds ?? (res.createdSlideId ? [res.createdSlideId] : [])
      } catch (e) {
        console.error(e)
        useApp.getState().toast(`Edit failed: ${(e as Error).message}`, 'error')
      }
    },

    undo(key) {
      const s = get().sessions[key]
      if (!s?.pres || !s.undo.length) return
      if (isProjectBusy(s.pid)) return
      const entry = s.undo[s.undo.length - 1]
      try {
        entry.undo()
      } catch (e) {
        useApp.getState().toast(`Undo failed: ${(e as Error).message}`, 'error')
        return
      }
      const version = s.version + 1
      const slideVersions: Record<string, number> = {}
      for (const sl of s.pres.slides) slideVersions[sl.id] = version
      patch(key, {
        version, slideVersions, dirty: true, selection: [],
        undo: s.undo.slice(0, -1), redo: [...s.redo, entry],
        turnBaseline: Math.min(s.turnBaseline, s.undo.length - 1),
        slideIndex: Math.min(s.slideIndex, s.pres.slides.length - 1),
      })
      scheduleSave(key)
    },

    async redo(key) {
      const s = get().sessions[key]
      if (!s?.pres || !s.redo.length) return
      const entry = s.redo[s.redo.length - 1]
      const redoRest = s.redo.slice(0, -1)
      await entry.redo()
      patch(key, { redo: redoRest })
    },

    async applyCustom(key, description, runEdit, coalesceKey) {
      const s = get().sessions[key]
      if (!s?.pres) return false
      if (isProjectBusy(s.pid)) {
        useApp.getState().toast('The agent is working on this project — editing resumes when its turn ends.')
        return false
      }
      try {
        const undo = await runEdit()
        const cur = get().sessions[key]!
        patch(key, {
          version: cur.version + 1,
          dirty: true,
          undo: [...cur.undo, { undo, redo: () => get().applyCustom(key, description, runEdit, coalesceKey), description, coalesceKey }],
          redo: [],
        })
        scheduleSave(key)
        return true
      } catch (e) {
        useApp.getState().toast(`Edit failed: ${(e as Error).message}`, 'error')
        return false
      }
    },

    async transaction(key, description, fn) {
      const s = get().sessions[key]
      if (!s?.pres) return
      if (isProjectBusy(s.pid)) {
        useApp.getState().toast('The agent is working on this project — editing resumes when its turn ends.')
        return
      }
      const pres = s.pres
      const undos: (() => void)[] = []
      const run = async (op: EditOperation) => {
        const r = await applyEdit(pres, op)
        undos.push(r.undo)
        return r
      }
      const rollback = () => [...undos].reverse().forEach((u) => u())
      let result: Awaited<ReturnType<typeof fn>>
      try {
        result = await fn(run, pres)
      } catch (e) {
        try { rollback() } catch { /* best effort */ }
        console.error(e)
        useApp.getState().toast(`Edit failed: ${(e as Error).message}`, 'error')
        const cur = get().sessions[key]!
        patch(key, { version: cur.version + 1, slideVersions: Object.fromEntries(pres.slides.map((sl) => [sl.id, cur.version + 1])) })
        return
      }
      if (!undos.length) return result
      const cur = get().sessions[key]!
      const version = cur.version + 1
      patch(key, {
        version,
        slideVersions: Object.fromEntries(pres.slides.map((sl) => [sl.id, version])),
        dirty: true,
        undo: [...cur.undo, { undo: rollback, redo: () => get().transaction(key, description, fn), description }],
        redo: [],
      })
      scheduleSave(key)
      return result
    },

    setSlide(key, index) {
      const s = get().sessions[key]
      if (!s?.pres) return
      const i = Math.max(0, Math.min(index, s.pres.slides.length - 1))
      if (i !== s.slideIndex) patch(key, { slideIndex: i, selection: [] })
    },

    setSelection(key, ids) {
      patch(key, { selection: ids })
    },

    async saveNow(key) {
      clearTimeout(saveTimers.get(key))
      const s = get().sessions[key]
      if (!s?.pres || !s.dirty) return
      if (s.saving) {
        scheduleSave(key)
        return
      }
      patch(key, { saving: true, dirty: false })
      try {
        const raw = await writePptx(s.pres)
        const { bytes } = await repairPackage(raw)
        const { etag } = await api.writeFile(s.pid, s.path, bytes, s.etag)
        const [sldIds, slideXml] = await Promise.all([readSlideIds(bytes), slideXmlBySldId(bytes)])
        patch(key, { etag, saving: false, sldIds, lastSlideXml: slideXml })
        publishMap(get().sessions[key]!)
      } catch (e) {
        patch(key, { saving: false })
        if (e instanceof ApiError && e.status === 409) {
          useApp.getState().toast('The file changed on disk (agent or PowerPoint) — reloaded it. Your last edit was not saved.', 'error')
          await get().reload(key, true)
        } else {
          patch(key, { dirty: true })
          useApp.getState().toast(`Save failed: ${(e as Error).message}`, 'error')
        }
      }
    },

    peekUserChanges(key) {
      const s = get().sessions[key]
      if (!s) return []
      const entries = s.undo.slice(s.turnBaseline)
      const out: string[] = []
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i]
        // Keep only the last of a run of coalescable edits.
        if (e.coalesceKey && entries[i + 1]?.coalesceKey === e.coalesceKey) continue
        out.push(e.description)
      }
      return out
    },

    takeUserChanges(key) {
      const out = get().peekUserChanges(key)
      const s = get().sessions[key]
      if (s) patch(key, { turnBaseline: s.undo.length })
      return out
    },
  }
})

/** Route watcher events to open decks. */
export function handleDeckFileEvent(pid: string, path: string, etag: string | null, writer: string) {
  const key = deckKey(pid, path)
  const s = useDecks.getState().sessions[key]
  if (!s || etag === null) return
  if (writer === CLIENT_ID || etag === s.etag) return
  void useDecks.getState().reload(key, true)
}
