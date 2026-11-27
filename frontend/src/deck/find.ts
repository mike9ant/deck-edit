/**
 * Find in a deck: the slides' own text (shapes, tables, groups — not the layout's footers) and,
 * optionally, the speaker notes. A match is addressed by its slide, where it is (a shape or the
 * notes) and which occurrence it is there — so the same match can be found again in the rendered
 * slide, a thumbnail or the notes pane and highlighted (CSS Custom Highlight API: no DOM changes).
 */

import { create } from 'zustand'
import type { PresentationData } from '@diceui/pptx-core'
import { nodeText } from './deckDiff'

export interface FindOptions {
  matchCase: boolean
  wholeWord: boolean
  notes: boolean
}

export interface FindMatch {
  slideIndex: number
  /** The slide's part (its id in the model). */
  slideId: string
  where: 'slide' | 'notes'
  /** The shape it's in (where = slide). */
  nodeId?: string
  /** Which occurrence in that shape (or the notes): 0, 1, … */
  occurrence: number
  snippet: { before: string; match: string; after: string }
}

/** The query as a regular expression (null: nothing to look for). */
export function findRegex(query: string, o: Pick<FindOptions, 'matchCase' | 'wholeWord'>): RegExp | null {
  if (!query.trim()) return null
  const esc = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const body = o.wholeWord ? `(?<![\\p{L}\\p{N}_])${esc}(?![\\p{L}\\p{N}_])` : esc
  return new RegExp(body, `gu${o.matchCase ? '' : 'i'}`)
}

const SNIP = 32
function snippet(text: string, start: number, end: number) {
  const flat = (s: string) => s.replace(/\s+/g, ' ')
  const b = flat(text.slice(Math.max(0, start - SNIP), start))
  const a = flat(text.slice(end, end + SNIP))
  return { before: (start > SNIP ? '…' : '') + b, match: text.slice(start, end), after: a + (end + SNIP < text.length ? '…' : '') }
}

/** Shorter queries find on the slide in view only (a letter or two would match all over the deck). */
export const MIN_DECK_CHARS = 3

/** Whether the search spans the deck now: the Deck scope, and a long enough query. */
export const deckWide = (s: { scope: 'deck' | 'slide'; query: string }) => s.scope === 'deck' && s.query.trim().length >= MIN_DECK_CHARS

/** Each slide's shapes' text, worked out once per deck version (not again on every keystroke). */
const textCache = new WeakMap<PresentationData, { version: number; slides: Map<string, { nodeId: string; text: string }[]> }>()
function slideTexts(pres: PresentationData, version: number, slide: PresentationData['slides'][number]) {
  let c = textCache.get(pres)
  if (!c || c.version !== version) textCache.set(pres, (c = { version, slides: new Map() }))
  let t = c.slides.get(slide.id)
  if (!t) c.slides.set(slide.id, (t = slide.nodes.map((n) => ({ nodeId: n.id, text: nodeText(n) })).filter((x) => x.text)))
  return t
}

/**
 * Every match in the deck (or on slide `only`), in order: each slide's shapes (stacking order),
 * then its notes. `version`: the deck's, for the text cache.
 */
export function findInDeck(
  pres: PresentationData, notes: Map<string, string> | null, re: RegExp, o: FindOptions,
  { version = 0, only }: { version?: number; only?: number } = {},
): FindMatch[] {
  const out: FindMatch[] = []
  pres.slides.forEach((slide, slideIndex) => {
    if (only != null && slideIndex !== only) return
    for (const { nodeId, text } of slideTexts(pres, version, slide)) {
      let k = 0
      for (const m of text.matchAll(re)) {
        if (!m[0]) continue
        out.push({ slideIndex, slideId: slide.id, where: 'slide', nodeId, occurrence: k++, snippet: snippet(text, m.index!, m.index! + m[0].length) })
      }
    }
    const t = o.notes ? notes?.get(slide.id) : undefined
    if (t) {
      let k = 0
      for (const m of t.matchAll(re)) {
        if (!m[0]) continue
        out.push({ slideIndex, slideId: slide.id, where: 'notes', occurrence: k++, snippet: snippet(t, m.index!, m.index! + m[0].length) })
      }
    }
  })
  return out
}

/**
 * The matches inside a rendered element (a shape, the notes editor) as DOM ranges, in text order —
 * its text read across runs, paragraphs kept apart, bullets skipped.
 */
export function rangesIn(root: Element, re: RegExp): Range[] {
  const pieces: { node: Text; at: number }[] = []
  let text = ''
  let para: Element | null = null
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  while (walker.nextNode()) {
    const node = walker.currentNode as Text
    if (node.parentElement?.closest('[data-pptx-bullet], [data-text-ghost]')) continue
    const p = node.parentElement?.closest('[data-pptx-p], p, div') ?? null
    if (p !== para && text) text += '\n'
    para = p
    pieces.push({ node, at: text.length })
    text += node.data
  }
  if (!pieces.length) return []
  const pointAt = (pos: number, end: boolean): [Text, number] => {
    let k = pieces.length - 1
    while (k > 0 && (end ? pieces[k].at >= pos : pieces[k].at > pos)) k--
    return [pieces[k].node, Math.max(0, Math.min(pos - pieces[k].at, pieces[k].node.data.length))]
  }
  const out: Range[] = []
  for (const m of text.matchAll(new RegExp(re.source, re.flags))) {
    if (!m[0]) continue
    const r = document.createRange()
    r.setStart(...pointAt(m.index!, false))
    r.setEnd(...pointAt(m.index! + m[0].length, true))
    out.push(r)
  }
  return out
}

interface FindState extends FindOptions {
  /** The deck it's open on (pid:path), null when closed. */
  deck: string | null
  query: string
  scope: 'deck' | 'slide'
  /** Hide the thumbnails of slides without matches. */
  onlyMatching: boolean
  matches: FindMatch[]
  /** The current match (index into matches), -1 for none. */
  current: number
  /** Bumped to put the cursor in the find box. */
  focusTick: number
  open(deck: string): void
  close(): void
  set(p: Partial<FindState>): void
  /** Step to the next (1) or previous (-1) match; `slideIndex`: the slide in view, for picking a start. */
  step(dir: 1 | -1, slideIndex: number): void
}

const LS = 'deckedit-find'
const saved = (() => {
  try { return JSON.parse(globalThis.localStorage?.getItem(LS) ?? '{}') as Partial<FindOptions> } catch { return {} }
})()

export const useFind = create<FindState>((set, get) => ({
  deck: null,
  query: '',
  scope: 'deck',
  onlyMatching: false,
  matchCase: saved.matchCase ?? false,
  wholeWord: saved.wholeWord ?? false,
  notes: saved.notes ?? true,
  matches: [],
  current: -1,
  focusTick: 0,
  open(deck) {
    set({ deck, focusTick: get().focusTick + 1 })
  },
  close() {
    set({ deck: null, matches: [], current: -1 })
  },
  set(p) {
    set(p)
    if ('matchCase' in p || 'wholeWord' in p || 'notes' in p) {
      const { matchCase, wholeWord, notes } = get()
      globalThis.localStorage?.setItem(LS, JSON.stringify({ matchCase, wholeWord, notes }))
    }
  },
  step(dir, slideIndex) {
    const { matches, current, scope } = get()
    const pool = matches.map((m, i) => ({ m, i })).filter(({ m }) => scope === 'deck' || m.slideIndex === slideIndex)
    if (!pool.length) return
    // The current match counts as the start only while its slide is in view (moved elsewhere: start there).
    const at = matches[current]?.slideIndex === slideIndex ? pool.findIndex(({ i }) => i === current) : -1
    let next: number
    if (at >= 0) next = (at + dir + pool.length) % pool.length
    else {
      // Nothing current yet: the first match on or after the slide in view (or the last before it, backwards).
      if (dir === 1) {
        next = pool.findIndex(({ m }) => m.slideIndex >= slideIndex)
        if (next < 0) next = 0
      } else {
        next = pool.length - 1
        for (let k = pool.length - 1; k >= 0; k--) if (pool[k].m.slideIndex <= slideIndex) { next = k; break }
      }
    }
    set({ current: pool[next].i })
  },
}))
