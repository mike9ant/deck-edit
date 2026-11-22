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
 *
 * Editing during an agent turn ("held edits"): the agent rewrites the whole
 * file (python-pptx), so the user's edits made while it works aren't saved —
 * they're held. Each agent save reloads its version and REPLAYS the held
 * edits on top (slide references translated through the stable slide ids,
 * since python-pptx renumbers slide parts); when the turn ends the result is
 * saved once. An edit whose slide/shape the agent removed is skipped, and
 * slides both changed are reported (`flushHeldEdits`).
 */

import { create } from 'zustand'
import {
  applyEdit, buildPresentation, readPptx, writePptx,
  type EditOperation, type EditResult, type PresentationData,
} from '@diceui/pptx-core'
import { loadEmbeddedFonts } from '@diceui/pptx-core/fonts'
import { api, ApiError, CLIENT_ID } from '../api/client'
import { useApp } from '../store/appStore'
import { requestEdit } from '../store/editGuard'
import { repairPackage, uniqueShapeIds } from './packageHygiene'
import { readSlideParts, slideIdsFromXml, slideTitle, slideXmlFromParts } from './deckModel'

/** How to apply an edit again onto a freshly loaded deck: data, or a function given the slide ids it refers to. */
export type Replay =
  | { kind: 'op'; op: EditOperation }
  | { kind: 'custom'; run: (pres: PresentationData, slideIds: string[]) => Promise<() => void>; slideIds: string[] }
  | { kind: 'tx'; fn: TxFn; slideIds: string[] }

type TxFn = (run: (op: EditOperation) => Promise<EditResult>, pres: PresentationData, slideIds: string[]) => Promise<unknown>

export interface UndoEntry {
  undo: () => void
  /** Re-applies the edit (a single op, or a whole transaction). */
  redo: () => Promise<unknown>
  description: string
  /** Consecutive edits with the same key (e.g. nudging one shape) read as one change for the agent. */
  coalesceKey?: string
  replay: Replay
  /** The slide part this edit created, if any (later held edits may refer to it). */
  created?: string
  /** Stable ids (sldId) of the slides it changed — to spot slides the agent changed too. */
  stable: string[]
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
  /** Reloading after a save from outside (the agent): shown over the deck when it takes a moment. */
  reloading: boolean
  lastSlideXml: Map<string, string>
  /** Undo index where edits made during the running agent turn begin (held, not saved); null when none. */
  heldFrom: number | null
  /** Stable ids of slides the agent changed while edits were held. */
  agentChangedWhileHeld: string[]
  /** Undo-stack length the file on disk reflects (edits beyond it aren't saved yet). */
  savedAt: number
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
  applyCustom(key: string, description: string, run: (pres: PresentationData, slideIds: string[]) => Promise<() => void>, coalesceKey?: string, slideIds?: string[]): Promise<boolean>
  transaction<T>(key: string, description: string, fn: (run: (op: EditOperation) => Promise<EditResult>, pres: PresentationData, slideIds: string[]) => Promise<T>, slideIds?: string[]): Promise<T | undefined>
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

/** Set by the chat store: is an agent turn running in this project (edits are held, not saved)? */
export let isProjectBusy: (pid: string) => boolean = () => false
export const setBusyProbe = (f: (pid: string) => boolean) => {
  isProjectBusy = f
}

/** An op with its slide references translated (`map` → null: that slide is gone). */
function remapOp(op: EditOperation, map: (id: string) => string | null): EditOperation | null {
  if (op.type === 'batch') {
    const ops = op.operations.map((o) => remapOp(o, map))
    return ops.some((o) => !o) ? null : { ...op, operations: ops as EditOperation[] }
  }
  const out = { ...op } as Record<string, unknown>
  for (const k of ['slideId', 'afterSlideId']) {
    if (typeof out[k] !== 'string') continue
    const m = map(out[k] as string)
    if (m === null) return null
    out[k] = m
  }
  return out as unknown as EditOperation
}

const reloadChains = new Map<string, Promise<void>>()
/** A reload waiting for the one before it to finish (at most one per deck). */
const queuedReloads = new Map<string, { external: boolean; done: Promise<void> }>()

/**
 * What the last read of each deck left for the next one (see `parse`): every zip entry it read with
 * its fingerprint, and the parts each slide depends on.
 */
interface ReadMemo {
  entryCache: NonNullable<Awaited<ReturnType<typeof readPptx>>['entryCache']>
  shared: string
  slideRels: Map<string, string>
}
const readMemos = new Map<string, ReadMemo>()

/**
 * Let the browser handle what's waiting — scrolling, resizing, painting — between the steps of a
 * reload, so a big deck reloading doesn't freeze the rest of the app for the whole of it. When
 * nothing waits it continues at once: `scheduler.yield()` where there is one (Chrome — made for
 * this, and the reload resumes ahead of other background work), else a MessageChannel message (the
 * desktop app's WebKit) — not `setTimeout`, which is clamped to 4 ms when nested and slowed to
 * once a second while the window is hidden.
 */
const yieldChannel = new MessageChannel()
const yieldWaiters: (() => void)[] = []
yieldChannel.port1.onmessage = () => yieldWaiters.shift()?.()
const breathe = (): Promise<void> => {
  const scheduler = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler
  if (scheduler?.yield) return scheduler.yield()
  return new Promise<void>((resolve) => {
    yieldWaiters.push(resolve)
    yieldChannel.port2.postMessage(null)
  })
}

/** Layouts, masters, themes, charts and diagrams: a change to any of them can change every slide. */
function sharedParts(files: Awaited<ReturnType<typeof readPptx>>): string {
  const maps = [files.slideLayouts, files.slideLayoutRels, files.slideMasters, files.slideMasterRels, files.themes, files.themeOverrides, files.charts, files.chartRels, files.chartStyles, files.chartColors, files.diagramDrawings]
  return JSON.stringify([files.tableStyles ?? '', ...maps.map((m) => (m ? [...m].sort(([a], [b]) => a.localeCompare(b)) : []))])
}

interface Parsed {
  pres: PresentationData
  sldIds: Map<string, string>
  /** Each slide's raw XML by stable id. */
  slideXml: Map<string, string>
  /** Stable ids of the slides that may render differently from the previous read (all of them when that can't be told). */
  changedSlides: Set<string> | 'all'
}

/**
 * Read a deck in one pass: the presentation, its stable slide ids and slide XML. Parts unchanged
 * since the previous read of `key` (media, fonts, layouts — most of a big deck's bytes) are reused
 * rather than inflated again, and it reports which slides changed, so only those re-render.
 */
async function parse(bytes: ArrayBuffer, key: string): Promise<Parsed> {
  const prev = readMemos.get(key)
  const files = await readPptx(bytes, { keepSourcePackage: true, reuse: prev })
  await breathe()
  const sldIds = slideIdsFromXml(files.presentation, files.presentationRels)
  const slideXml = slideXmlFromParts(sldIds, files.slides)
  const shared = sharedParts(files)
  const entryCache = files.entryCache ?? new Map()
  const slideRels = new Map<string, string>()
  for (const [part, sid] of sldIds) slideRels.set(sid, files.slideRels.get(part.replace(/slides\/([^/]+)$/, 'slides/_rels/$1.rels')) ?? '')
  // Media replaced under the same name, or a shared part changed: every slide may look different.
  const mediaReplaced = !!prev && [...entryCache].some(([path, e]) => /^ppt\/media\//.test(path) && prev.entryCache.has(path) && prev.entryCache.get(path)!.signature !== e.signature)
  let changedSlides: Set<string> | 'all' = 'all'
  if (prev && !mediaReplaced && prev.shared === shared) changedSlides = new Set([...slideRels].filter(([sid, rels]) => prev.slideRels.get(sid) !== rels).map(([sid]) => sid))
  readMemos.set(key, { entryCache, shared, slideRels })
  // Shapes are addressed by id: repeated ids (common in script-built decks) would make a click
  // select — and an edit change — the wrong shape.
  for (const [path, xml] of files.slides) files.slides.set(path, uniqueShapeIds(xml))
  return { pres: buildPresentation(files), sldIds, slideXml, changedSlides }
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

  const redoFor = (key: string, r: Replay, description: string, coalesceKey?: string): (() => Promise<unknown>) =>
    r.kind === 'op' ? () => get().apply(key, r.op, description, coalesceKey)
      : r.kind === 'custom' ? () => get().applyCustom(key, description, r.run, coalesceKey, r.slideIds)
        : () => get().transaction(key, description, r.fn, r.slideIds)

  /** A new undo entry; an edit made while the agent works starts (or extends) the held run. */
  const pushEdit = (key: string, entry: Omit<UndoEntry, 'redo' | 'stable'> & { touched: string[] }, extra: Partial<DeckSession>) => {
    const cur = get().sessions[key]!
    const { touched, ...rest } = entry
    const stable = touched.map((id) => cur.sldIds.get(id)).filter((x): x is string => !!x)
    // Arrow-key nudges of the same shapes in the same direction are one undo step ("nudge:" keys) —
    // unless the earlier one was already reported to the agent, or the agent started working in between.
    const last = cur.undo[cur.undo.length - 1]
    const at = cur.undo.length - 1
    if (
      entry.coalesceKey?.startsWith('nudge:') && last?.coalesceKey === entry.coalesceKey &&
      last.replay.kind === 'op' && entry.replay.kind === 'op' &&
      at >= cur.turnBaseline && !(cur.heldFrom != null && at < cur.heldFrom)
    ) {
      const ops = (op: EditOperation): EditOperation[] => (op.type === 'batch' ? op.operations : [op])
      const replay: Replay = { kind: 'op', op: { type: 'batch', operations: [...ops(last.replay.op), ...ops(entry.replay.op)] } }
      const merged: UndoEntry = {
        ...last,
        description: entry.description,
        undo: () => { rest.undo(); last.undo() },
        replay,
        stable: [...new Set([...last.stable, ...stable])],
        redo: redoFor(key, replay, entry.description, entry.coalesceKey),
      }
      patch(key, { ...extra, dirty: true, undo: [...cur.undo.slice(0, -1), merged], redo: [] })
      return
    }
    patch(key, {
      // An edit that removed slides (e.g. deleting the last one) must not leave the current slide past the end:
      // the views would render a slide that no longer exists.
      slideIndex: Math.max(0, Math.min(cur.slideIndex, (cur.pres?.slides.length ?? 1) - 1)),
      ...extra,
      dirty: true,
      heldFrom: cur.heldFrom ?? (isProjectBusy(cur.pid) ? cur.undo.length : null),
      undo: [...cur.undo, { ...rest, stable, redo: redoFor(key, entry.replay, entry.description, entry.coalesceKey) }],
      redo: [],
    })
  }

  /** Apply held edits onto a freshly loaded deck. Returns the rebuilt entries and the edits that couldn't apply. */
  const replayHeld = async (key: string, held: UndoEntry[], step: Map<string, string | null>, pres: PresentationData) => {
    const map = (id: string) => (step.has(id) ? step.get(id)! : id)
    const entries: UndoEntry[] = []
    const skipped: string[] = []
    for (const e of held) {
      try {
        const r = e.replay
        let undo: () => void
        let replay: Replay
        let created: string | undefined
        if (r.kind === 'op') {
          const op = remapOp(r.op, map)
          if (!op) throw new Error('its slide was removed')
          const res = await applyEdit(pres, op)
          ;({ undo } = res)
          created = res.createdSlideId
          replay = { kind: 'op', op }
        } else {
          const ids = r.slideIds.map(map)
          if (ids.some((x) => x === null)) throw new Error('its slide was removed')
          if (r.kind === 'custom') {
            undo = await r.run(pres, ids as string[])
            replay = { ...r, slideIds: ids as string[] }
          } else {
            const undos: (() => void)[] = []
            const rollback = () => [...undos].reverse().forEach((u) => u())
            try {
              await r.fn(async (op) => { const x = await applyEdit(pres, op); undos.push(x.undo); return x }, pres, ids as string[])
            } catch (err) {
              try { rollback() } catch { /* best effort */ }
              throw err
            }
            undo = rollback
            replay = { ...r, slideIds: ids as string[] }
          }
        }
        if (e.created && created) step.set(e.created, created)
        entries.push({ ...e, undo, replay, created, redo: redoFor(key, replay, e.description, e.coalesceKey) })
      } catch {
        skipped.push(e.description)
      }
    }
    return { entries, skipped }
  }

  const scheduleSave = (key: string) => {
    clearTimeout(saveTimers.get(key))
    saveTimers.set(key, setTimeout(() => void get().saveNow(key), SAVE_DEBOUNCE_MS))
  }

  const reloadOnce = async (key: string, external: boolean): Promise<void> => {
    const s0 = get().sessions[key]
    if (!s0) return
    patch(key, { loading: !s0.pres, reloading: !!s0.pres })
    try {
      await reloadAttempts(key, s0, external)
    } finally {
      if (get().sessions[key]?.reloading) patch(key, { reloading: false })
    }
  }

  const reloadAttempts = async (key: string, s0: DeckSession, external: boolean): Promise<void> => {
    // A save from python-pptx/PowerPoint can be observed mid-write; retry briefly.
    let lastErr: unknown
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        const { bytes, etag } = await api.readFile(s0.pid, s0.path)
        await breathe()
        const { pres, sldIds, slideXml, changedSlides } = await parse(bytes, key)
        await breathe()
        if (!fontHandles.has(key)) fontHandles.set(key, loadEmbeddedFonts(pres))
        await fontHandles.get(key)!.ready
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
        // Edits held during the agent's turn: replay them onto its version.
        const holding = external && s.heldFrom != null && s.heldFrom < s.undo.length
        let entries: UndoEntry[] = []
        const skipped: string[] = []
        if (holding) {
          // Old slide part → its part in the new file, by stable id (python-pptx renumbers slide parts).
          const byStable = new Map([...sldIds].map(([path, sid]) => [sid, path]))
          const step = new Map<string, string | null>()
          for (const [path, sid] of s.sldIds) step.set(path, byStable.get(sid) ?? null)
          let consumed = s.heldFrom!
          for (;;) {
            // Edits made while this replay ran are picked up too.
            const cur = get().sessions[key]
            if (!cur || cur.undo.length <= consumed) break
            const r = await replayHeld(key, cur.undo.slice(consumed), step, pres)
            consumed = cur.undo.length
            entries = [...entries, ...r.entries]
            skipped.push(...r.skipped)
          }
          if (skipped.length) {
            useApp.getState().toast(
              `${skipped.length} of your edits couldn't be re-applied on top of the agent's changes (the slide or shape is gone): ${skipped.slice(0, 3).join('; ')}${skipped.length > 3 ? '…' : ''}`,
              'error',
            )
          }
        }
        const version = s.version + 1
        const s1 = get().sessions[key] ?? s
        // Only slides that changed re-render: one the agent didn't touch keeps its version (by stable
        // id — python-pptx renumbers slide parts). Edits replayed onto the new file re-render all.
        // Not when the screen may show something the file doesn't: unsaved edits (dropped by this
        // reload) or a slide that moved (its slide number field). Nor when the slide's part was
        // renamed (python-pptx renumbers parts when it opens a deck): a rendered slide is tied to
        // its part name and version, and that name, at that version, showed a different slide.
        const prevAt = new Map<string, { version: number; index: number; part: string }>()
        if (s1.pres) s1.pres.slides.forEach((sl, index) => prevAt.set(s1.sldIds.get(sl.id) ?? '', { version: s1.slideVersions[sl.id] ?? s1.version, index, part: sl.id }))
        const reuse = external && !holding && !s1.dirty && changedSlides !== 'all'
        const slideVersions: Record<string, number> = {}
        pres.slides.forEach((sl, index) => {
          const sid = sldIds.get(sl.id) ?? ''
          const before = prevAt.get(sid)
          const same = reuse && sid && before && before.index === index && before.part === sl.id && !changedSlides.has(sid) && s1.lastSlideXml.get(sid) === slideXml.get(sid)
          slideVersions[sl.id] = same ? before.version : version
        })
        const next: DeckSession = {
          ...s1, pres, etag, loading: false, error: null, version, slideVersions, slideIndex: Math.max(0, slideIndex),
          selection: external ? [] : s1.selection,
          // An external change invalidates the undo history (it describes the old file) — except the
          // held edits, which were just replayed onto the new file.
          undo: external ? entries : s1.undo, redo: external ? [] : s1.redo, turnBaseline: external ? 0 : s1.turnBaseline,
          heldFrom: external ? (entries.length ? 0 : null) : s1.heldFrom,
          agentChangedWhileHeld: holding ? [...new Set([...s1.agentChangedWhileHeld, ...changed])] : s1.agentChangedWhileHeld,
          dirty: external ? entries.length > 0 : false, sldIds, lastSlideXml: slideXml,
          savedAt: external ? 0 : s1.savedAt,
          externallyChanged: external ? changed : s1.externallyChanged,
          externalAt: external ? Date.now() : s1.externalAt,
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
  }

  return {
    sessions: {},

    async open(pid, path) {
      const key = deckKey(pid, path)
      if (get().sessions[key]) return
      const s: DeckSession = {
        key, pid, path, pres: null, etag: '', loading: true, error: null, version: 0, slideVersions: {},
        slideIndex: 0, selection: [], undo: [], redo: [], turnBaseline: 0, dirty: false, saving: false,
        sldIds: new Map(), externallyChanged: [], externalAt: 0, lastSlideXml: new Map(), reloading: false,
        heldFrom: null, agentChangedWhileHeld: [], savedAt: 0,
      }
      set({ sessions: { ...get().sessions, [key]: s } })
      await get().reload(key, false)
    },

    reload(key, external) {
      // One reload at a time per deck: a replay must start from the previous one's result. Saves in
      // quick succession (the agent saving slide by slide) share one waiting reload — it reads the
      // file as it is when it starts, so the ones in between would only repeat the work.
      const waiting = queuedReloads.get(key)
      if (waiting && waiting.external === external) return waiting.done
      const done = (reloadChains.get(key) ?? Promise.resolve()).then(() => {
        if (queuedReloads.get(key)?.done === done) queuedReloads.delete(key)
        return reloadOnce(key, external)
      })
      queuedReloads.set(key, { external, done })
      reloadChains.set(key, done.catch(() => {}))
      return done
    },

    close(key) {
      const { [key]: _gone, ...rest } = get().sessions
      fontHandles.get(key)?.dispose()
      fontHandles.delete(key)
      readMemos.delete(key)
      set({ sessions: rest })
    },

    async apply(key, op, description, coalesceKey) {
      const s = get().sessions[key]
      if (!s?.pres || !requestEdit()) return
      try {
        const res = await applyEdit(s.pres, op)
        const cur = get().sessions[key]!
        const version = cur.version + 1
        const slideVersions = { ...cur.slideVersions }
        for (const id of res.affectedSlideIds) slideVersions[id] = version
        if (res.createdSlideId) slideVersions[res.createdSlideId] = version
        pushEdit(key, { undo: res.undo, description, coalesceKey, replay: { kind: 'op', op }, created: res.createdSlideId, touched: res.affectedSlideIds }, { version, slideVersions })
        scheduleSave(key)
        return res.createdNodeIds ?? (res.createdSlideId ? [res.createdSlideId] : [])
      } catch (e) {
        console.error(e)
        useApp.getState().toast(`Edit failed: ${(e as Error).message}`, 'error')
      }
    },

    undo(key) {
      const s = get().sessions[key]
      if (!s?.pres || !s.undo.length || !requestEdit()) return
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
        heldFrom: s.heldFrom != null && s.heldFrom >= s.undo.length - 1 ? null : s.heldFrom,
        savedAt: Math.min(s.savedAt, s.undo.length - 1),
        slideIndex: Math.min(s.slideIndex, s.pres.slides.length - 1),
      })
      scheduleSave(key)
    },

    async redo(key) {
      const s = get().sessions[key]
      if (!s?.pres || !s.redo.length || !requestEdit()) return
      const entry = s.redo[s.redo.length - 1]
      const redoRest = s.redo.slice(0, -1)
      await entry.redo()
      patch(key, { redo: redoRest })
    },

    async applyCustom(key, description, runEdit, coalesceKey, slideIds = []) {
      const s = get().sessions[key]
      if (!s?.pres || !requestEdit()) return false
      try {
        const undo = await runEdit(s.pres, slideIds)
        const cur = get().sessions[key]!
        pushEdit(key, { undo, description, coalesceKey, replay: { kind: 'custom', run: runEdit, slideIds }, touched: slideIds }, { version: cur.version + 1 })
        scheduleSave(key)
        return true
      } catch (e) {
        useApp.getState().toast(`Edit failed: ${(e as Error).message}`, 'error')
        return false
      }
    },

    async transaction(key, description, fn, slideIds = []) {
      const s = get().sessions[key]
      if (!s?.pres || !requestEdit()) return
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
        result = await fn(run, pres, slideIds)
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
      pushEdit(key, { undo: rollback, description, replay: { kind: 'tx', fn: fn as TxFn, slideIds }, touched: slideIds },
        { version, slideVersions: Object.fromEntries(pres.slides.map((sl) => [sl.id, version])) })
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
      // While the agent works, edits are held (it rewrites the whole file); flushHeldEdits saves them after.
      if (isProjectBusy(s.pid)) return
      if (s.saving) {
        scheduleSave(key)
        return
      }
      patch(key, { saving: true, dirty: false })
      const upTo = s.undo.length
      try {
        const raw = await writePptx(s.pres)
        const { bytes } = await repairPackage(raw)
        const { etag } = await api.writeFile(s.pid, s.path, bytes, s.etag)
        const { sldIds, slideXml } = await readSlideParts(bytes)
        patch(key, { etag, saving: false, sldIds, lastSlideXml: slideXml, heldFrom: null, agentChangedWhileHeld: [], savedAt: upTo })
        publishMap(get().sessions[key]!)
      } catch (e) {
        patch(key, { saving: false })
        if (e instanceof ApiError && e.status === 409) {
          // Changed on disk meanwhile: take that version and re-apply this edit run on top, then save again.
          const cur = get().sessions[key]!
          patch(key, { heldFrom: cur.heldFrom ?? Math.min(cur.savedAt, cur.undo.length) })
          await get().reload(key, true)
          if (get().sessions[key]?.dirty) scheduleSave(key)
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

/**
 * The agent's turn ended: save the edits held during it (already replayed onto
 * its latest version), and say which slides both of you changed.
 */
export async function flushHeldEdits(pid: string) {
  for (const s of Object.values(useDecks.getState().sessions)) {
    if (s.pid !== pid || s.heldFrom == null) continue
    await (reloadChains.get(s.key) ?? Promise.resolve())
    const cur = useDecks.getState().sessions[s.key]
    if (!cur?.pres || cur.heldFrom == null) continue
    const held = cur.undo.slice(cur.heldFrom)
    const both = new Set(held.flatMap((e) => e.stable).filter((sid) => cur.agentChangedWhileHeld.includes(sid)))
    if (both.size) {
      const nums = cur.pres.slides.map((sl, i) => (both.has(cur.sldIds.get(sl.id) ?? '') ? i + 1 : 0)).filter(Boolean)
      useApp.getState().toast(`You and the agent both changed slide${nums.length > 1 ? 's' : ''} ${nums.join(', ')} — your edits were applied on top of its changes; worth a look.`)
    }
    await useDecks.getState().saveNow(s.key)
  }
}

