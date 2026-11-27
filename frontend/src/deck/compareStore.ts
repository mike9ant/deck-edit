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
import { readNotes, readNotesCached } from './speakerNotes'
import { readDeckComments } from './comments'
import { describeDiff, fingerprintPictures, type DeckDiff, type DeckSide } from './deckDiff'
import { mergeDecks } from './mergeDecks'
import { applyPlan, previewPlan, reviewItems, rowKey, type Decision, type Decisions } from './review'
import { flushDeckSaves, useDecks } from './deckStore'
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
  /** The base deck's bytes (for building a merged deck). */
  baseBytes: ArrayBuffer | null
  /** Reviewing the To deck's changes (accept / reject each), null when not. */
  review: ReviewState | null
}

/**
 * A review: which of the To deck's changes are accepted, the preview (To with the rejected
 * changes put back), and what Apply did. See review.ts.
 */
export interface ReviewState {
  decisions: Decisions
  /** The To deck's bytes when the review started (the deck is read-only while reviewing). */
  toBytes: ArrayBuffer
  /** To with the rejected changes put back (null: none rejected — To as it is). */
  preview: PresentationData | null
  building: boolean
  error: string | null
  /** Apply's result: where it wrote, the backup taken first (overwrite), and the accepted changes it applied (acceptedSig). */
  applied: { at: number; path: string; overwrote: boolean; snapshotId?: string; decisions: string; before?: Decisions } | null
}

/**
 * What Apply would write: the accepted changes, in a fixed order (rejected and undecided ones
 * aren't applied — From keeps its version — so they don't count).
 */
export const acceptedSig = (d: Decisions) => JSON.stringify(Object.keys(d).filter((k) => d[k] === 'accept').sort())

/**
 * Accepted changes not yet applied (closing would lose them): none when nothing is accepted, or
 * when the accepted ones are exactly what Apply last wrote — however the decisions were toggled.
 */
export function reviewUnsaved(c: Compare | undefined): number {
  const r = c?.review
  if (!r) return 0
  const sig = acceptedSig(r.decisions)
  if (sig === (r.applied?.decisions ?? '[]')) return 0
  return Object.values(r.decisions).filter((d) => d === 'accept').length || 1
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
  /** Review the To deck's changes (the deck is read-only meanwhile). */
  startReview(key: string): Promise<void>
  stopReview(key: string): void
  /** Accept / reject items (null: undecided again). */
  decide(key: string, items: string[], d: Decision | null): void
  /** Write From with the accepted changes: over the From file (after a backup) or as a new file. Returns the path written. */
  applyReview(key: string, to: { overwrite: true } | { newPath: string }): Promise<string>
  /** Put the From file back as it was before Apply overwrote it. */
  undoApply(key: string): Promise<void>
}

/** Read a deck for display only (a review preview). */
async function readForView(bytes: Uint8Array | ArrayBuffer): Promise<PresentationData> {
  const files = await readPptx(bytes instanceof Uint8Array ? (bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer) : bytes, { keepSourcePackage: true })
  for (const [path, xml] of files.slides) files.slides.set(path, uniqueShapeIds(xml))
  const pres = buildPresentation(files)
  materializeAllSlides(pres)
  return pres
}

const previewTimers = new Map<string, ReturnType<typeof setTimeout>>()

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

/** Speaker notes of every slide, by slide part (`cached`: kept until a slide's notes are written). */
async function notesOf(pres: PresentationData, cached = false): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  for (const s of pres.slides) out.set(s.id, await (cached ? readNotesCached : readNotes)(pres, s).catch(() => ''))
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
  return { side: { pres, sldIds, notes: await notesOf(pres), comments: await readDeckComments(pres) }, by }
}

/**
 * The live deck as the diff reads it (ids and notes as they are now, edits included). `cached`:
 * notes read before and not written since are reused (a quick re-diff while editing).
 */
export async function liveSide(session: DeckSession, cached = false): Promise<DeckSide> {
  const pres = session.pres!
  materializeAllSlides(pres)
  await fingerprintPictures(pres) // (only new pictures: the rest are remembered)
  const pkg = pres.sourcePackage
  const sldIds = pkg ? slideIdsFromXml(await pkg.readText('ppt/presentation.xml'), await pkg.readText('ppt/_rels/presentation.xml.rels')) : session.sldIds
  return { pres, sldIds, notes: await notesOf(pres, cached), comments: await readDeckComments(pres) }
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

/** Reload the deck at `path` if it's open in a tab (after the app itself rewrote the file). */
async function reloadOpenDeck(pid: string, path: string) {
  const k = deckKey(pid, path)
  if (useDecks.getState().sessions[k]) await useDecks.getState().reload(k, true)
}

/** Read the From file again (it was just written), so the comparison is worked out anew. */
async function reloadBase(key: string) {
  const st = useCompare.getState()
  const c = st.compares[key]
  if (!c || c.base.kind !== 'file') return
  const { bytes, etag } = await api.readFile(c.pid, c.base.path)
  const { side, by } = await readSide(bytes)
  const now = useCompare.getState().compares[key]
  if (!now) return
  // A new base: the diff (DeckView) and then the preview are worked out again.
  useCompare.getState().update(key, { baseSide: side, baseBytes: bytes, diff: null, baseInfo: { ...(now.baseInfo ?? { name: baseName(c.base.path) }), mtime: mtimeOf(etag), by } })
  clearTimeout(previewTimers.get(key))
  previewTimers.set(key, setTimeout(() => void rebuildPreview(key), 600))
}

/** Rebuild a review's preview: the To deck with its rejected changes put back. */
async function rebuildPreview(key: string) {
  const st = useCompare.getState()
  const c = st.compares[key]
  const session = useDecks.getState().sessions[key]
  if (!c?.review || !c.diff || !c.baseSide || !c.baseBytes || !session?.pres) return
  const decisions = c.review.decisions
  if (!Object.values(decisions).includes('reject')) {
    st.update(key, { review: { ...c.review, preview: null, building: false, error: null } })
    return
  }
  st.update(key, { review: { ...c.review, building: true } })
  try {
    const plan = previewPlan(c.diff, decisions, c.baseSide.pres, session.pres)
    const pres = await readForView(await mergeDecks(c.review.toBytes, c.baseBytes, plan))
    const now = useCompare.getState().compares[key]?.review
    // A later click started another build: that one wins.
    if (!now || now.decisions !== decisions) return
    useCompare.getState().update(key, { review: { ...now, preview: pres, building: false, error: null } })
  } catch (e) {
    const now = useCompare.getState().compares[key]?.review
    if (now) useCompare.getState().update(key, { review: { ...now, building: false, error: (e as Error).message } })
  }
}

/**
 * The agent's `review_changes`: start the review, list its items, or decide some (by key, slide
 * number, kind). Answers with text for the agent.
 */
export async function handleReviewRequest(ev: Extract<ServerEvent, { type: 'review' }>) {
  const reply = (text: string) => api.compareResult(ev.requestId, text).catch(() => {})
  if (useApp.getState().projectId !== ev.projectId) {
    setTimeout(() => void reply('error: The app is showing another project.'), 5000)
    return
  }
  const key = deckKey(ev.projectId, ev.deck)
  const st = useCompare.getState()
  let c = st.compares[key]
  if (!c?.diff) return reply(`error: ${ev.deck} isn't open in a comparison — open one first (compare_decks).`)
  if (ev.action === 'start' || (ev.action === 'decide' && !c.review)) {
    await st.startReview(key)
    c = useCompare.getState().compares[key]
    if (ev.action === 'start') return reply('Review mode is on: the user sees each change with accept / reject, and the slide shows the result.')
  }
  const rows = c.diff!.rows
  const items = reviewItems(c.diff!)
  const slideOf = (row: string) => {
    const r = rows.find((x) => rowKey(x) === row)
    return r?.newIndex != null ? r.newIndex + 1 : r?.oldIndex != null ? r.oldIndex + 1 : 0
  }
  const decisions = c.review?.decisions ?? {}
  if (ev.action === 'decide') {
    const kinds = new Set(ev.kinds)
    const slides = new Set(ev.slides)
    const keys = new Set(ev.keys)
    const chosen = items.filter((i) => (!keys.size || keys.has(i.key)) && (!slides.size || slides.has(slideOf(i.row))) && (!kinds.size || kinds.has(i.kind)))
    if (!keys.size && !slides.size && !kinds.size) return reply('error: Say which changes: keys, slides and/or kinds.')
    const d = ev.decision === 'clear' ? null : ev.decision === 'reject' ? 'reject' : 'accept'
    useCompare.getState().decide(key, chosen.map((i) => i.key), d)
    return reply(`${d ?? 'cleared'}: ${chosen.length} change${chosen.length === 1 ? '' : 's'}. The user applies them with Apply.`)
  }
  // list
  const label = (i: (typeof items)[number]) => {
    const r = rows.find((x) => rowKey(x) === i.row)!
    if (i.kind === 'slide-added') return 'new slide'
    if (i.kind === 'slide-removed') return 'slide removed'
    if (i.kind === 'slide-moved') return `slide moved (was ${r.movedFrom})`
    if (i.kind === 'notes') return 'speaker notes changed'
    if (i.kind === 'props') return 'layout / background changed'
    if (i.kind === 'comment') return `comment ${i.comment!.kind}`
    const s = i.shape!
    return `${s.what} ${s.kind}${s.details.length ? `: ${s.details.join(', ')}` : ''}${s.text ? ` — “${s.text.old.slice(0, 60)}” → “${s.text.new.slice(0, 60)}”` : ''}`
  }
  const lines = items.map((i) => `- slide ${slideOf(i.row)} · ${label(i)} · ${decisions[i.key] ?? 'open'} · key: ${i.key}`)
  return reply(`${items.length} reviewable changes (${c.review ? 'review mode on' : 'review mode off — start it to let the user see your decisions'}):\n${lines.join('\n')}`.slice(0, 20000))
}

/** The review's items (for the agent and the bulk choices). */
export const itemsOf = (c: Compare) => (c.diff ? reviewItems(c.diff) : [])

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
          [key]: { pid, path, base, loading: true, error: null, baseSide: null, baseInfo: null, diff: null, view: 'after', removed: null, marks: true, hover: null, baseBytes: null, review: null },
        },
      })
      app.openFile(path)
      app.keepTab(pid, path)
      try {
        const { bytes, etag } = base.kind === 'file' ? await api.readFile(pid, base.path) : await api.readSnapshotFile(pid, base.snapshotId, base.path)
        const { side, by } = await readSide(bytes)
        const info: SideInfo = { name: baseName(base.path), detail: base.kind === 'snapshot' ? base.label : undefined, mtime: mtimeOf(etag), by }
        if (get().compares[key]?.base !== base) return // replaced meanwhile
        patch(key, { loading: false, baseSide: side, baseInfo: info, baseBytes: bytes })
      } catch (e) {
        patch(key, { loading: false, error: `Couldn't read ${baseName(base.path)}: ${(e as Error).message}` })
      }
    },

    async openFiles(pid, a, b) {
      await flushDeckSaves() // (both are read from disk: an open deck's edits first)
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
      // A review with rejected changes: its preview follows the new comparison.
      const r = get().compares[key]?.review
      if (r && Object.values(r.decisions).includes('reject')) {
        clearTimeout(previewTimers.get(key))
        previewTimers.set(key, setTimeout(() => void rebuildPreview(key), 250))
      }
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

    async startReview(key) {
      const c = get().compares[key]
      if (!c || c.review) return
      await useDecks.getState().saveNow(key)
      const { bytes } = await api.readFile(c.pid, c.path)
      patch(key, { view: 'after', removed: null, marks: true, review: { decisions: {}, toBytes: bytes, preview: null, building: false, error: null, applied: null } })
    },

    stopReview(key) {
      patch(key, { review: null })
    },

    decide(key, items, d) {
      const c = get().compares[key]
      if (!c?.review) return
      const decisions = { ...c.review.decisions }
      for (const k of items) {
        if (d) decisions[k] = d
        else delete decisions[k]
      }
      patch(key, { review: { ...c.review, decisions } })
      // The preview (rejected changes put back) is rebuilt once the clicking settles.
      clearTimeout(previewTimers.get(key))
      previewTimers.set(key, setTimeout(() => void rebuildPreview(key), 250))
    },

    async applyReview(key, to) {
      const c = get().compares[key]
      const session = useDecks.getState().sessions[key]
      if (!c?.review || !c.diff || !c.baseSide || !c.baseBytes || !session?.pres) throw new Error('The comparison isn\'t ready.')
      const plan = applyPlan(c.diff, c.review.decisions, c.baseSide.pres, session.pres)
      const bytes = await mergeDecks(c.baseBytes, c.review.toBytes, plan)
      let path: string
      let snapshotId: string | undefined
      if ('overwrite' in to) {
        if (c.base.kind !== 'file') throw new Error('A backup can\'t be overwritten — save the result as a new deck.')
        path = c.base.path
        snapshotId = (await api.createSnapshot(c.pid)).id
        await api.writeFile(c.pid, path, bytes)
      } else {
        path = to.newPath
        await api.writeFile(c.pid, path, bytes)
      }
      // A tab with that file open reloads: the app ignores change notices for its own writes
      // (they're normally its own saves), so it wouldn't on its own — and would show the old deck.
      await reloadOpenDeck(c.pid, path)
      const r = get().compares[key]?.review
      if (r) {
        if ('overwrite' in to) {
          // From now has the accepted changes: they're no longer differences, so they leave the
          // list (the comparison is worked out again against the updated file); the rest keep
          // their decisions. Undo apply brings the old decisions back.
          const kept = Object.fromEntries(Object.entries(r.decisions).filter(([, d]) => d !== 'accept')) as Decisions
          patch(key, { review: { ...r, decisions: kept, preview: null, applied: { at: Date.now(), path, overwrote: true, snapshotId, decisions: acceptedSig(kept), before: r.decisions } } })
          await reloadBase(key)
        } else {
          patch(key, { review: { ...r, applied: { at: Date.now(), path, overwrote: false, snapshotId, decisions: acceptedSig(r.decisions) } } })
        }
      }
      void useApp.getState().refreshTree()
      return path
    },

    async undoApply(key) {
      const c = get().compares[key]
      const a = c?.review?.applied
      if (!c || !a?.snapshotId) return
      await api.restoreSnapshotFile(c.pid, a.snapshotId, a.path)
      await reloadOpenDeck(c.pid, a.path)
      // The file is as it was: compare with it again, with the decisions made before Apply.
      patch(key, { review: { ...c.review!, decisions: a.before ?? c.review!.decisions, preview: null, applied: null } })
      if (a.overwrote) await reloadBase(key)
      clearTimeout(previewTimers.get(key))
      previewTimers.set(key, setTimeout(() => void rebuildPreview(key), 250))
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
