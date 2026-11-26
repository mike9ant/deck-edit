/**
 * Reviewing a comparison: going through the To deck's changes (relative to From) and deciding,
 * item by item or a slide at a time, which to accept. Apply then writes From with the accepted
 * changes (or a new copy of it); the review preview shows To with the rejected ones put back.
 *
 * Items (each with a stable key, made from slide parts and shape ids):
 * - a slide only in To ("added": accept = add it), only in From ("removed": accept = remove it),
 *   or moved (accept = take To's place);
 * - on a slide in both: each changed / added / removed shape, the speaker notes, each comment
 *   thread added / removed / changed, and the slide's own properties (layout, background, hidden).
 * Undecided items count as not accepted: From keeps its version.
 */

import type { PresentationData } from '@diceui/pptx-core'
import type { DeckDiff, ShapeDiff, SlideDiff, SummaryLine } from './deckDiff'
import type { MergePlan, ShapeOp, SlideEdits } from './mergeDecks'

export type Decision = 'accept' | 'reject'
export type Decisions = Record<string, Decision>

export type ItemKind = 'slide-added' | 'slide-removed' | 'slide-moved' | 'shape' | 'notes' | 'comment' | 'props'

export interface ReviewItem {
  key: string
  kind: ItemKind
  /** The row it belongs to (see rowKey). */
  row: string
  shape?: ShapeDiff
  comment?: { kind: 'added' | 'removed' | 'changed'; id: string }
}

/** A row's key: its From slide when it has one, else its To slide. */
export const rowKey = (r: SlideDiff) => (r.oldSlide ? `o:${r.oldSlide}` : `n:${r.newSlide}`)
export const shapeKey = (r: SlideDiff, s: ShapeDiff) => `${rowKey(r)}|shape|${s.kind}|${s.oldId ?? ''}>${s.id}`

/** The decidable items of one row. */
export function rowItems(r: SlideDiff): ReviewItem[] {
  const row = rowKey(r)
  if (r.status === 'added') return [{ key: `${row}|slide-added`, kind: 'slide-added', row }]
  if (r.status === 'removed') return [{ key: `${row}|slide-removed`, kind: 'slide-removed', row }]
  const out: ReviewItem[] = []
  if (r.movedFrom) out.push({ key: `${row}|slide-moved`, kind: 'slide-moved', row })
  if (r.props) out.push({ key: `${row}|props`, kind: 'props', row })
  for (const s of r.shapes) out.push({ key: shapeKey(r, s), kind: 'shape', row, shape: s })
  if (r.notes) out.push({ key: `${row}|notes`, kind: 'notes', row })
  for (const c of r.comments ?? []) out.push({ key: `${row}|comment|${c.id}`, kind: 'comment', row, comment: c })
  return out
}

export const reviewItems = (d: DeckDiff) => d.rows.flatMap(rowItems)

/** The items a summary line (beside a thumbnail) stands for. `moved`: the "Moved from N" line. */
export function lineItems(r: SlideDiff, line: Pick<SummaryLine, 'text' | 'ids'> | { moved: true }): ReviewItem[] {
  const items = rowItems(r)
  if (r.status !== 'changed') return items
  if ('moved' in line) return items.filter((i) => i.kind === 'slide-moved')
  if (line.text.startsWith('Notes')) return items.filter((i) => i.kind === 'notes')
  if (line.text.startsWith('Comment')) return items.filter((i) => i.kind === 'comment' && line.ids?.includes(i.comment!.id))
  if (/^(Layout:|Background|Hidden|Shown again)/.test(line.text)) return items.filter((i) => i.kind === 'props')
  return items.filter((i) => i.kind === 'shape' && line.ids?.includes(i.shape!.id))
}

/** How far the review is: items in all, accepted, rejected. */
export function reviewCounts(items: ReviewItem[], decisions: Decisions) {
  let accepted = 0, rejected = 0
  for (const i of items) {
    if (decisions[i.key] === 'accept') accepted++
    else if (decisions[i.key] === 'reject') rejected++
  }
  return { total: items.length, accepted, rejected }
}

/** A row's state: all its items accepted, all rejected, mixed, or none decided. */
export function rowState(items: ReviewItem[], decisions: Decisions): 'accept' | 'reject' | 'mixed' | 'open' {
  if (!items.length) return 'open'
  const ds = items.map((i) => decisions[i.key])
  if (ds.every((d) => d === 'accept')) return 'accept'
  if (ds.every((d) => d === 'reject')) return 'reject'
  return ds.some(Boolean) ? 'mixed' : 'open'
}

/** The bulk choices: which items each selects. */
export const BULK: { id: string; label: string; pick: (i: ReviewItem) => boolean }[] = [
  { id: 'all', label: 'All changes', pick: () => true },
  { id: 'new', label: 'New slides', pick: (i) => i.kind === 'slide-added' },
  { id: 'removed', label: 'Removed slides', pick: (i) => i.kind === 'slide-removed' },
  { id: 'moved', label: 'Moved slides', pick: (i) => i.kind === 'slide-moved' },
  { id: 'text', label: 'Text and shape edits', pick: (i) => i.kind === 'shape' || i.kind === 'props' },
  { id: 'notes', label: 'Speaker notes', pick: (i) => i.kind === 'notes' },
  { id: 'comments', label: 'Comments', pick: (i) => i.kind === 'comment' },
]

// ─── Plans ─────────────────────────────────────────────────────────────────────────────────────

/** Node ids of a slide in stacking order. */
const order = (pres: PresentationData, part: string | undefined) => pres.slides.find((s) => s.id === part)?.nodes.map((n) => n.id) ?? []

/**
 * Where a shape copied from one side lands on the other: just above the nearest shape below it
 * (in its own slide) that has a counterpart on the other side.
 */
function afterOf(id: string, ownOrder: string[], counterpart: Map<string, string>): string | undefined {
  for (let i = ownOrder.indexOf(id) - 1; i >= 0; i--) {
    const c = counterpart.get(ownOrder[i])
    if (c) return c
  }
  return undefined
}

/**
 * Apply: From with the accepted changes. Slides keep From's order, except accepted moves and
 * accepted new slides, which take their place in To's order.
 */
export function applyPlan(d: DeckDiff, decisions: Decisions, from: PresentationData, to: PresentationData): MergePlan {
  const ok = (key: string) => decisions[key] === 'accept'
  const edits = new Map<string, SlideEdits>()
  type Entry = { target: string } | { source: string }
  let seq: { entry: Entry; row: SlideDiff }[] = []
  for (const r of d.rows) {
    const row = rowKey(r)
    if (r.status === 'added') {
      if (ok(`${row}|slide-added`)) seq.push({ entry: { source: r.newSlide! }, row: r })
      continue
    }
    if (r.status === 'removed') {
      if (!ok(`${row}|slide-removed`)) seq.push({ entry: { target: r.oldSlide! }, row: r })
      continue
    }
    seq.push({ entry: { target: r.oldSlide! }, row: r })
    const newToOld = new Map((r.pairs ?? []).map(([o, n]) => [n, o]))
    const toOrder = order(to, r.newSlide)
    const shapes: ShapeOp[] = []
    for (const s of r.shapes) {
      if (!ok(shapeKey(r, s))) continue
      if (s.kind === 'changed') shapes.push({ op: 'replace', targetId: s.oldId!, sourceId: s.id })
      else if (s.kind === 'added') shapes.push({ op: 'insert', sourceId: s.id, afterId: afterOf(s.id, toOrder, newToOld) })
      else shapes.push({ op: 'delete', targetId: s.id })
    }
    const comments = (r.comments ?? []).filter((c) => ok(`${row}|comment|${c.id}`))
    const e: SlideEdits = {
      sourcePart: r.newSlide!,
      shapes,
      notes: !!r.notes && ok(`${row}|notes`),
      props: !!r.props && ok(`${row}|props`),
      comments: comments.filter((c) => c.kind !== 'removed').map((c) => c.id),
      removeComments: comments.filter((c) => c.kind !== 'added').map((c) => c.id),
    }
    if (e.shapes.length || e.notes || e.props || e.comments?.length || e.removeComments?.length) edits.set(r.oldSlide!, e)
  }
  // A move not accepted: the slide goes back after the slide it followed in From.
  const fromIndex = new Map(from.slides.map((s, i) => [s.id, i]))
  for (const item of [...seq]) {
    const r = item.row
    if (!r.movedFrom || ok(`${rowKey(r)}|slide-moved`)) continue
    seq = seq.filter((x) => x !== item)
    const at = fromIndex.get(r.oldSlide!) ?? 0
    let pos = 0
    for (let i = at - 1; i >= 0; i--) {
      const prev = from.slides[i].id
      const k = seq.findIndex((x) => 'target' in x.entry && x.entry.target === prev)
      if (k >= 0) { pos = k + 1; break }
    }
    seq.splice(pos, 0, item)
  }
  return { order: seq.map((x) => x.entry), edits }
}

/**
 * The review preview: To with the rejected changes put back (From's version). Slides stay as in
 * To (rejected new / removed / moved slides are shown by their marks, not moved about).
 */
export function previewPlan(d: DeckDiff, decisions: Decisions, from: PresentationData, to: PresentationData): MergePlan {
  const no = (key: string) => decisions[key] === 'reject'
  const edits = new Map<string, SlideEdits>()
  for (const r of d.rows) {
    if (r.status !== 'changed' || !r.newSlide || !r.oldSlide) continue
    const row = rowKey(r)
    const oldToNew = new Map((r.pairs ?? []).map(([o, n]) => [o, n]))
    const fromOrder = order(from, r.oldSlide)
    const shapes: ShapeOp[] = []
    for (const s of r.shapes) {
      if (!no(shapeKey(r, s))) continue
      if (s.kind === 'changed') shapes.push({ op: 'replace', targetId: s.id, sourceId: s.oldId! })
      else if (s.kind === 'added') shapes.push({ op: 'delete', targetId: s.id })
      else shapes.push({ op: 'insert', sourceId: s.id, afterId: afterOf(s.id, fromOrder, oldToNew) })
    }
    const e: SlideEdits = { sourcePart: r.oldSlide, shapes, notes: !!r.notes && no(`${row}|notes`), props: !!r.props && no(`${row}|props`) }
    if (e.shapes.length || e.notes || e.props) edits.set(r.newSlide, e)
  }
  return { order: to.slides.map((s) => ({ target: s.id })), edits }
}
