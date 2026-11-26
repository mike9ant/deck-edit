/**
 * The comparison's pieces in the deck view (see compareStore):
 *
 *   ┌ From: Q3 deck.pptx · Nov 24 14:02 · by Ann  →  To: Q3 deck v2.pptx · …   3 changed · 1 added   [From|To] [×] ┐
 *   │ toolbar                                                                                                              │
 *   │ thumbnails │ what changed, per slide │            slide — changed shapes tinted, labelled             │
 *
 * Colors: green = added, orange = changed, red = removed (dashed: where a removed shape was),
 * blue = a slide that moved.
 */

import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ArrowRight, ArrowLeftRight, GitCompareArrows, History, Loader2, X } from 'lucide-react'
import clsx from 'clsx'
import { MiddleEllipsis } from '../components/MiddleEllipsis'
import type { PresentationData } from '@diceui/pptx-core'
import { useDecks, type DeckSession } from './deckStore'
import { SlideRender } from './SlideRender'
import { diffDecks, lcsKeep, type Box, type ChangeKind, type Op, type ShapeDiff, type SlideDiff, type SummaryLine } from './deckDiff'
import { liveInfo, liveSide, useCompare, type Compare, type SideInfo } from './compareStore'

export const KIND_COLORS: Record<ChangeKind | 'moved', { dot: string; box: string; tag: string; text: string }> = {
  added: { dot: 'bg-emerald-500', box: 'border-emerald-500 bg-emerald-400/15', tag: 'bg-emerald-600', text: 'text-emerald-800' },
  // Thin outlines (there are often many, and the slide should stay readable): added solid, changed and removed dashed.
  changed: { dot: 'bg-amber-500', box: 'border border-dashed border-amber-500 bg-amber-400/10', tag: 'bg-amber-600', text: 'text-amber-900' },
  removed: { dot: 'bg-red-500', box: 'border-dashed border-red-500 bg-red-400/10', tag: 'bg-red-600', text: 'text-red-800' },
  moved: { dot: 'bg-sky-500', box: '', tag: 'bg-sky-600', text: 'text-sky-800' },
}

/** Recompute the diff as the live deck changes (debounced while edits come in). */
export function useCompareDiff(session: DeckSession | undefined, compare: Compare | undefined) {
  const base = compare?.baseSide
  const key = session?.key
  const hasDiff = !!compare?.diff
  useEffect(() => {
    if (!base || !key || !session?.pres) return
    let live = true
    const t = setTimeout(async () => {
      const s = useDecks.getState().sessions[key]
      if (!s?.pres) return
      try {
        const now = await liveSide(s)
        if (live) useCompare.getState().setDiff(key, diffDecks(base, now))
      } catch (e) {
        console.error('deck diff', e)
      }
    }, hasDiff ? 300 : 0)
    return () => {
      live = false
      clearTimeout(t)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, base, session?.version, !!session?.pres])
}

const when = (ms?: number) => {
  if (!ms) return ''
  const d = new Date(ms)
  const sameYear = d.getFullYear() === new Date().getFullYear()
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }), hour: '2-digit', minute: '2-digit' })
}

function SideChip({ label, info, tone, backup }: { label: string; info: SideInfo | null; tone: 'before' | 'after'; backup?: boolean }) {
  const extra = info ? [info.detail, when(info.mtime), info.by && `by ${info.by}`].filter(Boolean).join(' · ') : ''
  // Two lines: which file, then when and by whom — the name gets the whole width.
  return (
    <span
      className={clsx(
        'flex min-w-0 flex-1 flex-col rounded border border-hair border-l-[3px] bg-white px-1.5 py-px leading-[15px]',
        tone === 'before' ? 'border-l-red-400' : 'border-l-emerald-500',
      )}
      title={info ? `${label}: ${info.name}${backup ? ' — the backup taken before an agent turn, not a file in the folder' : ''}${extra ? `\n${extra}` : ''}` : label}
    >
      <span className="flex min-w-0 items-baseline gap-1">
        <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-ink-3">{label}</span>
        {/* The deck as it was before an agent turn (its backup), not a file in the folder. */}
        {backup && <span className="flex shrink-0 items-center gap-0.5 self-center rounded bg-violet-100 px-1 text-[9px] font-semibold uppercase leading-[13px] tracking-wide text-violet-800"><History size={9} /> Backup</span>}
        <MiddleEllipsis name={info?.name ?? '…'} className="font-medium text-ink" />
      </span>
      <span className="truncate text-[10px] leading-[13px] text-ink-3">{extra || '\u00a0'}</span>
    </span>
  )
}

/** The line over the deck while comparing: what is compared with what, the totals, and the controls. */
export function CompareBar({ compare, session }: { compare: Compare; session: DeckSession }) {
  const { swap, close, setView, update } = useCompare()
  const [now, setNow] = useState<SideInfo | null>(null)
  useEffect(() => {
    let live = true
    void liveInfo(session).then((i) => live && setNow(i))
    return () => { live = false }
  }, [session.etag, session.path]) // eslint-disable-line react-hooks/exhaustive-deps
  const d = compare.diff
  const counts = d?.counts
  const parts: { kind: ChangeKind | 'moved'; n: number; word: string }[] = counts
    ? [
        { kind: 'changed', n: counts.changed, word: 'changed' },
        { kind: 'added', n: counts.added, word: 'added' },
        { kind: 'removed', n: counts.removed, word: 'removed' },
        { kind: 'moved', n: counts.moved, word: 'moved' },
      ].filter((p) => p.n > 0) as { kind: ChangeKind | 'moved'; n: number; word: string }[]
    : []
  return (
    // When the pane gets narrow, the totals and controls wrap onto a second line (the files keep the first).
    <div className="flex min-h-11 shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-amber-200 bg-amber-50/70 px-2 py-1 text-xs" data-compare-bar>
      <GitCompareArrows size={15} className="shrink-0 text-amber-800" />
      {/* The files take the first line's room (long names show more of themselves); the rest grows
          only when it has a line of its own. */}
      <div className="flex min-w-[min(100%,340px)] items-center gap-1.5" style={{ flex: '999 1 340px' }}>
        <SideChip label="From" info={compare.baseInfo ?? (compare.base ? { name: compare.base.path.split('/').pop() ?? '' } : null)} tone="before" backup={compare.base.kind === 'snapshot'} />
        <ArrowRight size={14} className="shrink-0 text-ink-3" />
        <SideChip label="To" info={now} tone="after" />
        {compare.base.kind === 'file' && (
          <button className="icon-btn h-6 w-6 shrink-0" title="Swap — show the other file, compared with this one" onClick={() => swap(session.key)}>
            <ArrowLeftRight size={13} />
          </button>
        )}
      </div>
      {/* Totals, then the controls at the right — on the first line after the files, or across a
          second line of their own when the pane is narrow (totals left, controls right). */}
      <div className="flex grow flex-wrap items-center gap-x-3 gap-y-1">
      <div className="flex shrink-0 items-center gap-2 text-ink-2">
        {compare.loading ? (
          <span className="flex items-center gap-1 text-ink-3"><Loader2 size={12} className="animate-spin" /> Reading…</span>
        ) : compare.error ? (
          <span className="text-red-700">{compare.error}</span>
        ) : !d ? (
          <span className="flex items-center gap-1 text-ink-3"><Loader2 size={12} className="animate-spin" /> Comparing…</span>
        ) : d.unrelated || !d.common ? (
          <span className="flex items-center gap-1.5 whitespace-nowrap" title="Slides are paired by their content; none (or few) of them appear in both decks">
            <span className="text-ink-3">{d.common ? `Only ${d.common} slide${d.common === 1 ? '' : 's'} in common` : 'No slides in common'} ·</span>
            {parts.map((p) => (
              <span key={p.kind} className="flex items-center gap-1"><span className={clsx('h-2 w-2 rounded-full', KIND_COLORS[p.kind].dot)} /> {p.n} {p.word}</span>
            ))}
          </span>
        ) : parts.length || d.deck.length ? (
          parts.map((p) => (
            <span key={p.kind} className="flex items-center gap-1 whitespace-nowrap">
              <span className={clsx('h-2 w-2 rounded-full', KIND_COLORS[p.kind].dot)} /> {p.n} {p.word}
            </span>
          ))
        ) : (
          <span className="text-ink-3">No differences</span>
        )}
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        <label className="flex cursor-pointer items-center gap-1 text-ink-2" title="Mark the changes on the slide">
          <input type="checkbox" className="accent-amber-600" checked={compare.marks} onChange={(e) => update(session.key, { marks: e.target.checked })} /> Marks
        </label>
        <div className="flex overflow-hidden rounded border border-hair bg-white" role="group" aria-label="Show">
          {(['before', 'after'] as const).map((v) => (
            <button
              key={v}
              className={clsx('px-2 py-0.5', compare.view === v && !compare.removed ? 'bg-ink text-white' : 'text-ink-2 hover:bg-paper')}
              title={v === 'before' ? 'Show this slide in the From deck (read-only)' : 'Show the To deck — the one open here (editable)'}
              onClick={() => setView(session.key, v)}
            >
              {v === 'before' ? 'From' : 'To'}
            </button>
          ))}
        </div>
        <button className="flex items-center gap-1 rounded border border-hair bg-white px-1.5 py-0.5 text-ink-2 hover:bg-paper" title="Stop comparing — back to the file" onClick={() => close(session.key)}>
          <X size={12} /> Close
        </button>
      </div>
      </div>
    </div>
  )
}

/** "−X words" in red, "+Y words" in green. */
export function WordCounts({ added, removed }: { added: number; removed: number }) {
  return (
    <>
      {removed > 0 && <span className="text-red-600">−{removed}</span>}
      {removed > 0 && added > 0 && ' '}
      {added > 0 && <span className="text-emerald-700">+{added}</span>}
      {(added || removed) > 0 && ` word${added + removed === 1 ? '' : 's'}`}
    </>
  )
}

/** Words removed (struck, red) and added (green) among the words kept. */
export function OpsText({ ops }: { ops: Op[] }) {
  return (
    <>
      {ops.map((o, i) => (
        <Fragment key={i}>
          {i > 0 && ' '}
          <span className={o.k === 'del' ? 'text-red-600 line-through decoration-red-500/80' : o.k === 'add' ? 'rounded-sm bg-emerald-100 px-px font-medium text-emerald-800' : undefined}>{o.t}</span>
        </Fragment>
      ))}
    </>
  )
}

/**
 * Where the words of a rendered shape that aren't in `other` are, as client rects: the words added
 * (on the live slide, `other` = the old text) or removed (on the base slide, `other` = the new
 * text). Words are read across runs (a word split over two runs is one word); bullets are skipped.
 */
function changedWordRects(el: Element, other: string): DOMRect[] {
  const pieces: { node: Text; at: number }[] = []
  let text = ''
  let para: Element | null = null
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
  while (walker.nextNode()) {
    const node = walker.currentNode as Text
    if (node.parentElement?.closest('[data-pptx-bullet]')) continue
    const p = node.parentElement?.closest('[data-pptx-p]') ?? null
    if (p !== para && text) text += ' ' // paragraphs don't run into each other
    para = p
    pieces.push({ node, at: text.length })
    text += node.data
  }
  const words = [...text.matchAll(/\S+/g)].map((m) => ({ w: m[0], start: m.index!, end: m.index! + m[0].length }))
  const keep = lcsKeep(words.map((w) => w.w), other.split(/\s+/).filter(Boolean))
  if (!keep) return []
  const pointAt = (pos: number, end: boolean): [Text, number] => {
    let k = pieces.length - 1
    while (k > 0 && (end ? pieces[k].at >= pos : pieces[k].at > pos)) k--
    return [pieces[k].node, Math.min(pos - pieces[k].at, pieces[k].node.data.length)]
  }
  const out: DOMRect[] = []
  words.forEach((w, i) => {
    if (keep[i] || !/[\p{L}\p{N}]/u.test(w.w)) return
    const r = document.createRange()
    r.setStart(...pointAt(w.start, false))
    r.setEnd(...pointAt(w.end, true))
    out.push(...r.getClientRects())
  })
  return out
}

/** On the slide a changed shape's tag says only what changed — the shape itself is right there. */
type Rect = { x: number; y: number; w: number; h: number }

/**
 * Where the changed words of `shapes` are in the slide rendered next to `host` (in the same
 * parent), relative to `host`: the added words (side 'after') or the removed ones ('before').
 * Worked out after the slide renders, and again once its fonts have loaded (text moves).
 */
function useWordMarks(host: React.RefObject<HTMLElement | null>, shapes: ShapeDiff[], side: 'before' | 'after', scale: number): Rect[] {
  const [rects, setRects] = useState<Rect[]>([])
  useLayoutEffect(() => {
    let live = true
    const find = () => {
      const el = host.current, slide = el?.parentElement
      if (!live || !el || !slide) return
      const box = el.getBoundingClientRect()
      const out: Rect[] = []
      for (const s of shapes) {
        if (s.kind !== 'changed' || !s.text) continue
        const id = side === 'after' ? s.id : s.oldId ?? s.id
        const node = slide.querySelector(`[data-pptx-node-id="${CSS.escape(id)}"]`)
        if (!node) continue
        for (const r of changedWordRects(node, side === 'after' ? s.text.old : s.text.new)) {
          if (r.width && r.height) out.push({ x: r.left - box.left, y: r.top - box.top, w: r.width, h: r.height })
        }
      }
      setRects(out)
    }
    const raf = requestAnimationFrame(find)
    const t = setTimeout(find, 500)
    void document.fonts?.ready.then(find)
    return () => {
      live = false
      cancelAnimationFrame(raf)
      clearTimeout(t)
    }
  }, [host, shapes, side, scale])
  return rects
}

/**
 * On a thumbnail: just the words inserted into its text, in green — no boxes, arrows or removed
 * words — so the edited parts show at a glance. Sits in the thumbnail's frame, over its render.
 */
export function ThumbWordMarks({ shapes, width }: { shapes: ShapeDiff[]; width: number }) {
  const host = useRef<HTMLDivElement>(null)
  const words = useWordMarks(host, shapes, 'after', width)
  return (
    <div ref={host} className="pointer-events-none absolute inset-0" aria-hidden>
      {words.map((r, i) => (
        <div key={i} className="absolute rounded-[1px] bg-emerald-400/55 mix-blend-multiply" style={{ left: r.x, top: r.y, width: r.w, height: r.h }} />
      ))}
    </div>
  )
}

/** More added (or removed) shapes than this on a slide share one tag. */
const MAX_GROUP_TAGS = 6

const tagText = (s: ShapeDiff) =>
  s.kind !== 'changed' ? (s.what === 'Text' ? s.kind : `${s.what} ${s.kind}`) : s.details.map(onSlide).join(', ')

/** A change as said on the slide: shorter than in the list (the pixel sizes are left to the list and its tooltip). */
const onSlide = (d: string) => (d.startsWith('image resized') ? 'image resized' : d)

type Seg = { x1: number; y1: number; x2: number; y2: number }
/** Below this (slide px) an edge or corner didn't move. */
const MOVE_TOL = 0.75

/**
 * Arrows for how a shape moved or was resized, from where it was to where it is (`o` → `n`, in
 * overlay px): resized — one arrow at the middle of each edge that moved, across it; only moved —
 * one arrow at the corner trailing the move (so it comes from outside the shape, not under it).
 */
function moveArrows(o: Box, n: Box, k: number): Seg[] {
  const edges = {
    left: n.x - o.x, right: n.x + n.w - (o.x + o.w), top: n.y - o.y, bottom: n.y + n.h - (o.y + o.h),
  }
  const resized = Math.abs(n.w - o.w) > MOVE_TOL || Math.abs(n.h - o.h) > MOVE_TOL
  if (!resized) {
    const dx = edges.left, dy = edges.top
    if (Math.abs(dx) <= MOVE_TOL && Math.abs(dy) <= MOVE_TOL) return []
    const cx = dx >= 0 ? n.x : n.x + n.w, cy = dy >= 0 ? n.y : n.y + n.h
    return [{ x1: (cx - dx) * k, y1: (cy - dy) * k, x2: cx * k, y2: cy * k }]
  }
  const out: Seg[] = []
  const midY = (n.y + n.h / 2) * k, midX = (n.x + n.w / 2) * k
  if (Math.abs(edges.left) > MOVE_TOL) out.push({ x1: o.x * k, y1: midY, x2: n.x * k, y2: midY })
  if (Math.abs(edges.right) > MOVE_TOL) out.push({ x1: (o.x + o.w) * k, y1: midY, x2: (n.x + n.w) * k, y2: midY })
  if (Math.abs(edges.top) > MOVE_TOL) out.push({ x1: midX, y1: o.y * k, x2: midX, y2: n.y * k })
  if (Math.abs(edges.bottom) > MOVE_TOL) out.push({ x1: midX, y1: (o.y + o.h) * k, x2: midX, y2: (n.y + n.h) * k })
  return out
}

/** An arrow from (x1, y1) to (x2, y2), at least long enough to show its head. */
function Arrow({ x1, y1, x2, y2 }: Seg) {
  const len = Math.hypot(x2 - x1, y2 - y1)
  if (len < 0.5) return null
  const ux = (x2 - x1) / len, uy = (y2 - y1) / len
  const L = Math.max(len, 9)
  const sx = x2 - ux * L, sy = y2 - uy * L
  const head = 5
  const hx = x2 - ux * head, hy = y2 - uy * head
  return (
    <g>
      <line x1={sx} y1={sy} x2={hx} y2={hy} stroke="white" strokeWidth={4} strokeLinecap="round" />
      <line x1={sx} y1={sy} x2={hx} y2={hy} stroke="#d97706" strokeWidth={2} strokeLinecap="round" />
      <circle cx={sx} cy={sy} r={2} fill="#d97706" stroke="white" strokeWidth={1} />
      <path d={`M${x2},${y2} L${hx - uy * head * 0.8},${hy + ux * head * 0.8} L${hx + uy * head * 0.8},${hy - ux * head * 0.8} Z`} fill="#d97706" stroke="white" strokeWidth={1} strokeLinejoin="round" />
    </g>
  )
}

/**
 * The changed shapes of one slide, tinted, each with a short tag above it. `side` 'after' marks
 * the live slide (added and changed shapes, and dashed outlines where removed ones were); 'before'
 * marks the base version (removed and changed shapes where they were). Never takes the pointer.
 */
export function DiffOverlay({ shapes, scale, side, focus, ratio = 1 }: { shapes: ShapeDiff[]; scale: number; side: 'before' | 'after'; focus?: string[] | null; ratio?: number }) {
  // The changed words themselves, found in the rendered slide: added ones green (after), removed red (before).
  const host = useRef<HTMLDivElement>(null)
  const words = useWordMarks(host, shapes, side, scale)
  /** Room above the slide in the view (px): tags of shapes at the slide's top go there rather than over the text. */
  const [above, setAbove] = useState(0)
  /** The slide's height in the view (px): tags stay on the slide. */
  const [height, setHeight] = useState(10_000)
  useLayoutEffect(() => {
    const stage = host.current?.parentElement
    const pane = stage?.parentElement
    if (!stage || !pane) return
    setAbove(Math.max(0, stage.getBoundingClientRect().top - pane.getBoundingClientRect().top - 2))
    setHeight(stage.getBoundingClientRect().height)
  }, [scale])
  const shown = shapes
    .filter((s) => (side === 'after' ? true : s.kind !== 'added'))
    .map((s) => {
      // Removed shapes (and, on the base, changed ones) are where they were in the base deck.
      const old = s.kind === 'removed' || side === 'before'
      const b: Box = side === 'before' && s.kind === 'changed' ? s.oldBox ?? s.box : s.box
      const k = old && side === 'after' ? scale * ratio : scale
      return { s, r: { x: b.x * k, y: b.y * k, w: b.w * k, h: b.h * k, rotation: b.rotation } }
    })
  // Tags above their shapes, pushed down where they would cover one another — never past the
  // slide's bottom (a tag with no room left is dropped; its shape keeps its box). Many added or removed
  // shapes share one tag instead of one each.
  const many = (kind: ChangeKind) => {
    const all = shown.filter(({ s }) => s.kind === kind)
    return all.length > MAX_GROUP_TAGS ? all : null
  }
  const grouped = { added: many('added'), removed: many('removed') }
  // The move / resize arrows (drawn on the live slide), worked out once: drawn below, and kept clear of the tags.
  const arrows = side !== 'after' ? [] : shown.flatMap(({ s }) =>
    s.kind === 'changed' && s.oldBox && s.details.some((d) => /^(moved|resized|moved, resized)$/.test(d))
      ? moveArrows({ ...s.oldBox, x: s.oldBox.x * ratio, y: s.oldBox.y * ratio, w: s.oldBox.w * ratio, h: s.oldBox.h * ratio }, s.box, scale).map((seg, j) => ({ seg, key: `a${s.id}${j}` }))
      : [])
  // Each arrow's footprint (its line and head, at least the length drawn), padded a little.
  const arrowBoxes = arrows.map(({ seg }) => {
    const len = Math.hypot(seg.x2 - seg.x1, seg.y2 - seg.y1) || 1
    const L = Math.max(len, 9)
    const sx = seg.x2 - ((seg.x2 - seg.x1) / len) * L, sy = seg.y2 - ((seg.y2 - seg.y1) / len) * L
    const pad = 6
    return { x1: Math.min(sx, seg.x2) - pad, y1: Math.min(sy, seg.y2) - pad, x2: Math.max(sx, seg.x2) + pad, y2: Math.max(sy, seg.y2) + pad }
  })
  const placed: { x: number; y: number; w: number }[] = []
  const tags = shown.map(({ s, r }) => {
    const group = s.kind === 'added' || s.kind === 'removed' ? grouped[s.kind] : null
    if (group) {
      if (s !== group[0].s) return null
      const top = Math.min(...group.map((x) => x.r.y)), left = Math.min(...group.map((x) => x.r.x))
      return place(`${group.length} shapes ${s.kind}`, { x: left, y: top })
    }
    return place(tagText(s), r)
  })
  function place(text: string, r: { x: number; y: number }) {
    const w = Math.min(260, 10 + text.length * 5.6)
    let y = r.y - 16 >= -above ? r.y - 16 : r.y + 2
    let x = Math.max(0, r.x)
    // Clear of the other tags (down a line) and of the arrows (just past one, sideways).
    for (let tries = 0; tries < 40; tries++) {
      if (placed.some((p) => Math.abs(p.y - y) < 15 && x < p.x + p.w && p.x < x + w)) { y += 16; continue }
      const hit = arrowBoxes.find((a) => x < a.x2 && a.x1 < x + w && y < a.y2 && a.y1 < y + 14)
      if (!hit) break
      x = hit.x2 + 2
    }
    if (y > height - 14) return null
    placed.push({ x, y, w })
    return { text, x, y }
  }
  return (
    <div ref={host} className="pointer-events-none absolute inset-0 z-[5]" data-diff-overlay={side}>
      {words.map((r, i) => (
        <div
          key={`w${i}`}
          className={clsx('absolute rounded-[2px] mix-blend-multiply', side === 'after' ? 'bg-emerald-400/45' : 'bg-red-400/45')}
          style={{ left: r.x - 1, top: r.y, width: r.w + 2, height: r.h }}
        />
      ))}
      {side === 'after' && (
        // How shapes moved or were resized: arrows from where they were to where they are.
        <svg className="absolute inset-0 h-full w-full overflow-visible" aria-hidden>
          {arrows.map(({ seg, key }) => <Arrow key={key} {...seg} />)}
        </svg>
      )}
      {shown.map(({ s, r }, i) => (
        <div
          key={`b${s.kind}${s.id}${i}`}
          className={clsx('absolute rounded-[2px] border', KIND_COLORS[s.kind].box, focus?.includes(s.id) && 'animate-pulse shadow-[0_0_0_3px_rgba(245,158,11,0.55)]')}
          style={{ left: r.x - 2, top: r.y - 2, width: r.w + 4, height: r.h + 4, rotate: r.rotation ? `${r.rotation}deg` : undefined }}
        />
      ))}
      {shown.map(({ s }, i) => (
        // A text change shows its words (white tag, so the red and green read); other changes a colored tag.
        !tags[i] ? null : s.ops ? (
          <div
            key={`t${s.kind}${s.id}${i}`}
            className="absolute max-w-[320px] truncate whitespace-nowrap rounded border border-amber-500 bg-white px-1 text-[10px] font-medium leading-[13px] text-ink-2 shadow"
            style={{ left: tags[i]!.x, top: tags[i]!.y }}
          >
            <OpsText ops={s.ops} />
            {s.details.filter((d) => !/word|text edited/.test(d)).map((d) => <span key={d} className="text-amber-800">, {onSlide(d)}</span>)}
          </div>
        ) : (
          <div
            key={`t${s.kind}${s.id}${i}`}
            className={clsx('absolute max-w-[260px] truncate whitespace-nowrap rounded px-1 text-[10px] font-medium leading-[14px] text-white shadow', KIND_COLORS[s.kind].tag)}
            style={{ left: tags[i]!.x, top: tags[i]!.y }}
          >
            {tags[i]!.text}
          </div>
        )
      ))}
    </div>
  )
}

/** How the slide itself changed: added, removed or moved. */
export type SlideMark = { kind: 'added' | 'removed' | 'moved'; label: string }

/**
 * A frame around the whole slide, its label just above it: green for a slide that's new, red for
 * one that was removed, blue for one that moved. Drawn inside the slide's stage (its margin holds
 * the label).
 */
export function SlideFrame({ mark }: { mark: SlideMark }) {
  const c = { added: ['border-emerald-500', 'bg-emerald-600'], removed: ['border-red-500', 'bg-red-600'], moved: ['border-sky-500', 'bg-sky-600'] }[mark.kind]
  return (
    <div className="pointer-events-none absolute -inset-[4px] z-[6]" data-slide-frame={mark.kind}>
      <div className={clsx('absolute inset-0 rounded-[3px] border-[3px]', c[0])} />
      <div className={clsx('absolute -top-[20px] left-0 rounded px-1.5 text-[11px] font-semibold leading-[17px] text-white shadow', c[1])}>{mark.label}</div>
    </div>
  )
}

/** A slide of the base deck, read-only and fitted to the view, with its changes marked. */
export function BaseSlideView({ deckKey, pres, slideId, banner, shapes, marks, frame }: { deckKey: string; pres: PresentationData; slideId: string | null; banner: React.ReactNode; shapes: ShapeDiff[]; marks: boolean; frame?: SlideMark }) {
  const wrap = useRef<HTMLDivElement>(null)
  const [box, setBox] = useState({ w: 800, h: 500 })
  useLayoutEffect(() => {
    const el = wrap.current
    if (!el) return
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    setBox({ w: el.clientWidth, h: el.clientHeight })
    return () => ro.disconnect()
  }, [])
  const slide = slideId ? pres.slides.find((s) => s.id === slideId) : undefined
  const scale = Math.max(0.1, Math.min((box.w - 48) / pres.width, (box.h - 48) / pres.height))
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-red-200 bg-red-50 px-3 py-1 text-xs text-red-900">{banner}</div>
      <div ref={wrap} className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-[#e9e8e4]">
        {slide ? (
          <div className="relative shadow-lg" style={{ width: pres.width * scale, height: pres.height * scale }}>
            <SlideRender deckKey={`${deckKey}#base`} pres={pres} slide={slide} version={0} width={pres.width * scale} />
            {marks && <DiffOverlay shapes={shapes} scale={scale} side="before" />}
            {frame && <SlideFrame mark={frame} />}
          </div>
        ) : (
          <div className="text-sm text-ink-3">This slide is new — the From deck has no version of it.</div>
        )}
      </div>
    </div>
  )
}

/** A summary line with its color dot. */
function Line({ kind, text, ops, what, counts, lines, onPick, onHover }: { kind: ChangeKind | 'moved'; text: string; ops?: Op[]; what?: string; counts?: { added: number; removed: number }; lines: 1 | 2 | 3; onPick?(): void; onHover?(on: boolean): void }) {
  const tip = ops ? `${what ? `${what}: ` : ''}${ops.map((o) => (o.k === 'del' ? `[−${o.t}]` : o.k === 'add' ? `[+${o.t}]` : o.t)).join(' ')}` : text
  // One line cut short, or two or three lines wrapped (when the row has room for them).
  const fit = lines === 3 ? 'line-clamp-3 break-words' : lines === 2 ? 'line-clamp-2 break-words' : 'truncate'
  return (
    <div
      className={clsx('flex min-w-0 items-start gap-1 rounded-sm', onPick && 'cursor-pointer hover:bg-black/5')}
      title={tip}
      onClick={onPick && ((e) => { e.stopPropagation(); onPick() })}
      onPointerDown={onPick && ((e) => e.stopPropagation()) /* not a slide drag */}
      onMouseEnter={onHover && (() => onHover(true))}
      onMouseLeave={onHover && (() => onHover(false))}
    >
      <span className={clsx('mt-[4px] h-1.5 w-1.5 shrink-0 rounded-full', KIND_COLORS[kind].dot)} />
      {ops ? (
        <span className={clsx(fit, 'min-w-0 text-ink-2')}>{what && <><span className={KIND_COLORS[kind].text}>{what}</span>{counts && <> (<WordCounts {...counts} />)</>}<span className={KIND_COLORS[kind].text}>:</span> </>}<OpsText ops={ops} /></span>
      ) : (
        <span className={clsx(fit, 'min-w-0', KIND_COLORS[kind].text)}>{text}</span>
      )}
    </div>
  )
}

/**
 * What changed on a slide, beside its thumbnail: as many lines as fit, then "+N more". Lines that
 * show words (text, notes) get a second line when the row has room. Clicking a line goes to its
 * shape (`onPick`); hovering one marks it on the slide (`onHover`).
 */
export function DiffSummary({ row, maxLines, onPick, onHover }: { row: SlideDiff | undefined; maxLines: number; onPick?(l: SummaryLine | null): void; onHover?(ids: string[] | null): void }) {
  if (!row || row.status === 'same') return <div className="pt-0.5 text-[10px] text-ink-3/60">—</div>
  const lines: (SummaryLine | { kind: 'moved'; text: string })[] = [
    ...(row.movedFrom ? [{ kind: 'moved' as const, text: `Moved from ${row.movedFrom}` }] : []),
    ...row.lines,
  ]
  const fit = lines.length > maxLines ? Math.max(1, maxLines - 1) : lines.length
  const rest = lines.slice(fit)
  let spare = maxLines - fit - (rest.length ? 1 : 0)
  // Spare room: more lines for the lines that show words, in order — up to three for notes (long text), two for the rest.
  const height = lines.slice(0, fit).map((l): 1 | 2 | 3 => {
    if (!('ops' in l) || !l.ops || spare <= 0) return 1
    const extra = Math.min(spare, 'counts' in l && l.counts ? 2 : 1)
    spare -= extra
    return (1 + extra) as 2 | 3
  })
  return (
    <div className="min-w-0 pt-0.5 text-[10px] leading-[13px]">
      {lines.slice(0, fit).map((l, i) => {
        const line = 'ids' in l || 'ops' in l || l.kind !== 'moved' ? (l as SummaryLine) : null
        return (
          <Line
            key={i}
            kind={l.kind}
            text={l.text}
            ops={line?.ops}
            what={line?.what}
            counts={line?.counts}
            lines={height[i]}
            onPick={onPick && (() => onPick(line))}
            onHover={onHover && line?.ids?.length ? (on) => onHover(on ? line.ids! : null) : undefined}
          />
        )
      })}
      {rest.length > 0 && (
        <div className="pl-2.5 text-ink-3" title={rest.map((l) => l.text).join('\n')}>+{rest.length} more</div>
      )}
    </div>
  )
}
