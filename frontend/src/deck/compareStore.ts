/**
 * Comparing a deck with another version of it — another .pptx in the project, or the deck as it
 * was before an agent turn (a backup snapshot). The deck being compared stays the live, editable
 * deck ("after"); the other version (the base, "before") is read once, read-only. The diff is
 * worked out again as the live deck changes (DeckView), so edits — yours or the agent's — show
 * against the base as they happen.
 *
 * One comparison per deck tab, keyed like the deck sessions (`pid:path`).
 */

import { create } from 'zustand'
import { buildPresentation, materializeAllSlides, readPptx, type PresentationData } from '@diceui/pptx-core'
import { api } from '../api/client'
import { useApp } from '../store/appStore'
import { deckKey, type DeckSession } from './deckStore'
import { slideIdsFromXml } from './deckModel'
import { uniqueShapeIds } from './packageHygiene'
import { readNotes } from './speakerNotes'
import { describeDiff, fingerprintPictures, type DeckDiff, type DeckSide } from './deckDiff'
import { useDecks } from './deckStore'
import type { ServerEvent } from '../api/types'

/** The version a deck is compared with. */
export type BaseRef =
  | { kind: 'file'; path: string }
  /** The file as it was in a backup snapshot; `label` says which ("Before turn 3"). */
  | { kind: 'snapshot'; snapshotId: string; path: string; label: string }

/** What the compare bar says about one side. */
export interface SideInfo {
  name: string
  /** E.g. "before turn 3". */
  detail?: string
  /** Modified (ms since epoch), when known. */
  mtime?: number
  /** Who last saved it, as the file records it (PowerPoint's "last modified by"), when it does. */
  by?: string
}

export interface Compare {
  pid: string
  path: string
  base: BaseRef
  loading: boolean
  error: string | null
  baseSide: DeckSide | null
  baseInfo: SideInfo | null
  diff: DeckDiff | null
  /** The main view: the live slide with its changes marked, or the base version of it. */
  view: 'after' | 'before'
  /** A removed slide (its part in the base) shown read-only in the main view. */
  removed: string | null
  /** Mark the changes on the slide. */
  marks: boolean
  /** Shapes to emphasize on the slide (the summary line under the pointer). */
  hover: string[] | null
}

interface CompareStore {
  compares: Record<string, Compare>
  /** Compare the deck at `path` (shown, live) with `base`. */
  open(pid: string, path: string, base: BaseRef): Promise<void>
  /** Compare two decks of the project: the older one is the base, the newer one is shown. */
  openFiles(pid: string, a: string, b: string): Promise<void>
  /** Show the other file instead (and this one as the base). */
  swap(key: string): void
  close(key: string): void
  setDiff(key: string, diff: DeckDiff): void
  setView(key: string, view: Compare['view']): void
  showRemoved(key: string, oldSlide: string | null): void
  update(key: string, p: Partial<Compare>): void
}

/** Modified time (ms) from a version token (`<mtime ns>-<size>`). */
export function mtimeOf(etag: string): number | undefined {
  const ns = /^(\d+)-/.exec(etag)?.[1]
  return ns ? Number(BigInt(ns) / 1_000_000n) : undefined
}

/** "Last modified by" (else the author) from `docProps/core.xml`. */
export function savedBy(coreXml: string | undefined): string | undefined {
  if (!coreXml) return undefined
  const get = (tag: string) => new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`).exec(coreXml)?.[1]?.trim()
  return get('cp:lastModifiedBy') || get('dc:creator') || undefined
}

/** Speaker notes of every slide, by slide part. */
async function notesOf(pres: PresentationData): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  for (const s of pres.slides) out.set(s.id, await readNotes(pres, s).catch(() => ''))
  return out
}

/** Read a version of a deck for comparing (read-only: never saved). */
async function readSide(bytes: ArrayBuffer): Promise<{ side: DeckSide; by?: string }> {
  const files = await readPptx(bytes, { keepSourcePackage: true })
  // The same shape-id repair the live deck gets (deckStore `parse`), so ids line up.
  for (const [path, xml] of files.slides) files.slides.set(path, uniqueShapeIds(xml))
  const pres = buildPresentation(files)
  materializeAllSlides(pres)
  await fingerprintPictures(pres)
  const sldIds = slideIdsFromXml(files.presentation, files.presentationRels)
  const by = savedBy(await files.sourcePackage?.readText('docProps/core.xml'))
  return { side: { pres, sldIds, notes: await notesOf(pres) }, by }
}

/** The live deck as the diff reads it (ids and notes as they are now, edits included). */
export async function liveSide(session: DeckSession): Promise<DeckSide> {
  const pres = session.pres!
  materializeAllSlides(pres)
  await fingerprintPictures(pres) // (only new pictures: the rest are remembered)
  const pkg = pres.sourcePackage
  const sldIds = pkg ? slideIdsFromXml(await pkg.readText('ppt/presentation.xml'), await pkg.readText('ppt/_rels/presentation.xml.rels')) : session.sldIds
  return { pres, sldIds, notes: await notesOf(pres) }
}

/** What the compare bar says about the live deck. */
export async function liveInfo(session: DeckSession): Promise<SideInfo> {
  return {
    name: session.path.split('/').pop() ?? session.path,
    mtime: mtimeOf(session.etag),
    by: savedBy(await session.pres?.sourcePackage?.readText('docProps/core.xml')),
  }
}

const baseName = (p: string) => p.split('/').pop() ?? p

/**
 * The comparison open on a deck, for the agent: what's compared with what, which view shows, and
 * the differences found — all of them (get_user_view, asked for when needed), or with each message
 * just the totals and the slide in view (`slideIndex`, 0-based), to keep messages small.
 * Undefined when not comparing.
 */
export function compareForAgent(pid: string, path: string, onlySlide?: number) {
  const c = useCompare.getState().compares[deckKey(pid, path)]
  if (!c) return undefined
  const before = `${c.base.path}${c.base.kind === 'snapshot' ? ` (${c.base.label} — a backup, not a file in the folder)` : ''}`
  const diff = c.diff && onlySlide !== undefined
    ? { ...c.diff, rows: c.diff.rows.filter((r) => (c.removed ? r.oldSlide === c.removed : r.newIndex === onlySlide)) }
    : c.diff
  let summary = diff ? describeDiff(diff, before, path) : c.error ?? 'still comparing…'
  if (diff && onlySlide !== undefined && !diff.rows.some((r) => r.status !== 'same')) summary += '\nThe slide in view has no differences.'
  return {
    base: c.base.path,
    baseKind: c.base.kind,
    ...(c.base.kind === 'snapshot' ? { baseLabel: c.base.label } : {}),
    view: c.removed ? 'removed slide' : c.view,
    marks: c.marks,
    summary: summary.length > 6000 ? `${summary.slice(0, 6000)}\n… (truncated)` : summary,
    ...(onlySlide !== undefined ? { scope: 'slide in view' } : {}),
  }
}

/**
 * The agent's `compare_decks`: open the comparison (the user sees it too) and post the result back
 * as text once the diff is worked out.
 */
export async function handleCompareRequest(ev: Extract<ServerEvent, { type: 'compare' }>) {
  const reply = (text: string) => api.compareResult(ev.requestId, text).catch(() => {})
  if (useApp.getState().projectId !== ev.projectId) {
    // Another window may show this project and answer first.
    setTimeout(() => void reply('error: The app is showing another project — the user needs to open this one to compare its decks.'), 5000)
    return
  }
  if (!/\.pptx$/i.test(ev.deck) || !/\.pptx$/i.test(ev.base.path)) return reply('error: Only .pptx decks can be compared.')
  const key = deckKey(ev.projectId, ev.deck)
  await useCompare.getState().open(ev.projectId, ev.deck, ev.base)
  const done = await new Promise<string>((resolve) => {
    const started = Date.now()
    const check = () => {
      const c = useCompare.getState().compares[key]
      const deckError = useDecks.getState().sessions[key]?.error
      if (!c) return resolve('error: The comparison was closed.')
      if (c.error) return resolve(`error: ${c.error}`)
      if (deckError && !useDecks.getState().sessions[key]?.pres) return resolve(`error: Couldn't open ${ev.deck}: ${deckError}`)
      if (c.diff) {
        const before = `${c.baseInfo?.name ?? baseName(ev.base.path)}${c.baseInfo?.detail ? ` (${c.baseInfo.detail})` : ''}`
        return resolve(`${describeDiff(c.diff, before, baseName(ev.deck))}\n\n(The comparison is open in the app for the user.)`)
      }
      if (Date.now() - started > 80_000) return resolve('error: The comparison took too long.')
      setTimeout(check, 300)
    }
    check()
  })
  await reply(done)
}

export const useCompare = create<CompareStore>((set, get) => {
  const patch = (key: string, p: Partial<Compare>) => {
    const c = get().compares[key]
    if (c) set({ compares: { ...get().compares, [key]: { ...c, ...p } } })
  }

  return {
    compares: {},

    async open(pid, path, base) {
      const key = deckKey(pid, path)
      const app = useApp.getState()
      set({
        compares: {
          ...get().compares,
          [key]: { pid, path, base, loading: true, error: null, baseSide: null, baseInfo: null, diff: null, view: 'after', removed: null, marks: true, hover: null },
        },
      })
      app.openFile(path)
      app.keepTab(pid, path)
      try {
        const { bytes, etag } = base.kind === 'file' ? await api.readFile(pid, base.path) : await api.readSnapshotFile(pid, base.snapshotId, base.path)
        const { side, by } = await readSide(bytes)
        const info: SideInfo = { name: baseName(base.path), detail: base.kind === 'snapshot' ? base.label : undefined, mtime: mtimeOf(etag), by }
        if (get().compares[key]?.base !== base) return // replaced meanwhile
        patch(key, { loading: false, baseSide: side, baseInfo: info })
      } catch (e) {
        patch(key, { loading: false, error: `Couldn't read ${baseName(base.path)}: ${(e as Error).message}` })
      }
    },

    async openFiles(pid, a, b) {
      // The newer file is the one shown ("after"); recent changes read best that way round.
      let shown = b, other = a
      try {
        const [ea, eb] = await Promise.all([api.readFile(pid, a), api.readFile(pid, b)])
        if ((mtimeOf(ea.etag) ?? 0) > (mtimeOf(eb.etag) ?? 0)) [shown, other] = [a, b]
      } catch { /* keep the order given */ }
      await get().open(pid, shown, { kind: 'file', path: other })
    },

    swap(key) {
      const c = get().compares[key]
      if (!c || c.base.kind !== 'file') return
      const { [key]: _gone, ...rest } = get().compares
      set({ compares: rest })
      void get().open(c.pid, c.base.path, { kind: 'file', path: c.path })
    },

    close(key) {
      const c = get().compares[key]
      if (!c) return
      const { [key]: _gone, ...rest } = get().compares
      // The deck stays in view: it's the one being worked on.
      set({ compares: rest })
    },

    setDiff(key, diff) {
      patch(key, { diff })
    },
    setView(key, view) {
      patch(key, { view, removed: null })
    },
    showRemoved(key, removed) {
      patch(key, { removed })
    },
    update(key, p) {
      patch(key, p)
    },
  }
})

// A comparison ends with its tab: closing the file's tab (or its preview tab being taken by
// another file, or switching project) drops it, so the file opens fresh next time.
useApp.subscribe((app) => {
  const { compares } = useCompare.getState()
  const gone = Object.entries(compares).filter(([, c]) => c.pid !== app.projectId || !app.tabs.includes(c.path))
  if (!gone.length) return
  const rest = { ...compares }
  for (const [key] of gone) delete rest[key]
  useCompare.setState({ compares: rest })
})
