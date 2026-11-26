/**
 * ⌘F in a deck: a small bar over the top right of the slide. Finds in the slides' own text and
 * (optionally) the speaker notes, across the deck or on this slide only. ↵ / ⇧↵ (or ⌘G / ⇧⌘G)
 * step through the matches, going to their slide (and opening the notes for a match there);
 * every match is highlighted on the slide, its thumbnail and in the notes, the current one in
 * orange. The list (☰) shows them all by slide; thumbnails carry their slide's count (SlideRail).
 */

import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronUp, List, Search, StickyNote, X } from 'lucide-react'
import clsx from 'clsx'
import type { PresentationData } from '@diceui/pptx-core'
import { useDecks, type DeckSession } from './deckStore'
import { readNotes } from './speakerNotes'
import { useMenuActions } from '../desktopMenu'
import { deckWide, findInDeck, findRegex, MIN_DECK_CHARS, rangesIn, useFind, type FindMatch } from './find'

/** Every slide's notes text, per deck version (read once per version, shared by the searches). */
const notesCache = new WeakMap<PresentationData, { version: number; texts: Promise<Map<string, string>> }>()
function deckNotes(pres: PresentationData, version: number): Promise<Map<string, string>> {
  const hit = notesCache.get(pres)
  if (hit && hit.version === version) return hit.texts
  const texts = Promise.all(pres.slides.map(async (s) => [s.id, await readNotes(pres, s).catch(() => '')] as const)).then((e) => new Map(e))
  notesCache.set(pres, { version, texts })
  return texts
}

const sameMatch = (a: FindMatch, b: FindMatch) => a.slideId === b.slideId && a.where === b.where && a.nodeId === b.nodeId && a.occurrence === b.occurrence

/** The matches the bar steps through: all of them, or this slide's. */
export function scopedMatches(matches: FindMatch[], scope: 'deck' | 'slide', slideIndex: number) {
  return scope === 'deck' ? matches : matches.filter((m) => m.slideIndex === slideIndex)
}

// In the desktop app a shortcut may reach both the page and the menu: carried out once.
let lastFind = { id: '', at: 0 }
function once(id: string, run: () => void) {
  const now = performance.now()
  if (lastFind.id === id && now - lastFind.at < 200) return
  lastFind = { id, at: now }
  run()
}
function openFind(key: string) {
  const sel = window.getSelection()?.toString().trim() ?? ''
  if (sel && sel.length <= 80 && !sel.includes('\n')) useFind.getState().set({ query: sel })
  useFind.getState().open(key)
}
function stepFind(key: string, dir: 1 | -1) {
  if (useFind.getState().deck !== key) return openFind(key)
  useFind.getState().step(dir, useDecks.getState().sessions[key]?.slideIndex ?? 0)
}

/**
 * ⌘F opens find on this deck (with the selected text, if short), ⌘G / ⇧⌘G step — also from the
 * desktop app's Edit menu; closed when the deck goes.
 */
export function useFindShortcuts(key: string) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return
      const k = e.key.toLowerCase()
      if (k === 'f' && !e.shiftKey) {
        e.preventDefault()
        once('find', () => openFind(key))
      } else if (k === 'g' && useFind.getState().deck === key) {
        e.preventDefault()
        once(e.shiftKey ? 'find-prev' : 'find-next', () => stepFind(key, e.shiftKey ? -1 : 1))
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      if (useFind.getState().deck === key) useFind.getState().close()
    }
  }, [key])
  useMenuActions(() => ({
    find: { run: () => once('find', () => openFind(key)) },
    'find-next': { run: () => once('find-next', () => stepFind(key, 1)) },
    'find-prev': { run: () => once('find-prev', () => stepFind(key, -1)) },
  }))
}

export function FindBar({ session }: { session: DeckSession }) {
  const key = session.key
  const f = useFind()
  const pres = session.pres!
  const input = useRef<HTMLInputElement>(null)
  const [list, setList] = useState(false)
  const re = useMemo(() => findRegex(f.query, f), [f.query, f.matchCase, f.wholeWord]) // eslint-disable-line react-hooks/exhaustive-deps
  // A query of a letter or two finds on the slide in view only (the Deck choice greys out until it's longer).
  const wide = deckWide(f)
  const scope = wide ? f.scope : 'slide'
  const narrowSlide = wide ? -1 : session.slideIndex

  // Focus (and select) the query each time ⌘F is pressed.
  useEffect(() => {
    input.current?.focus()
    input.current?.select()
  }, [f.focusTick])

  // Search: the slide in view at once (short queries), the deck once typing pauses; the current
  // match kept across re-searches (an edit, the notes arriving), or — for a new query — the first
  // one from the slide in view.
  const lastQuery = useRef<string | null>(null)
  useEffect(() => {
    if (!re) {
      useFind.getState().set({ matches: [], current: -1 })
      lastQuery.current = null
      return
    }
    let live = true
    const sig = `${re.source}/${re.flags}/${narrowSlide}`
    const publish = (matches: FindMatch[]) => {
      if (!live) return
      const st = useFind.getState()
      const was = st.matches[st.current]
      let current = was && lastQuery.current === sig ? matches.findIndex((m) => sameMatch(m, was)) : -1
      if (lastQuery.current !== sig || !was) {
        const at = useDecks.getState().sessions[key]?.slideIndex ?? 0
        current = matches.findIndex((m) => m.slideIndex >= at)
        if (current < 0) current = matches.length ? 0 : -1
      }
      lastQuery.current = sig
      st.set({ matches, current })
    }
    const opts = { matchCase: f.matchCase, wholeWord: f.wholeWord, notes: f.notes }
    const where = { version: session.version, only: narrowSlide >= 0 ? narrowSlide : undefined }
    const run = () => {
      if (!f.notes) return publish(findInDeck(pres, null, re, opts, where))
      // The slides' matches show at once; the notes' join them when read (once per deck version).
      if (where.only != null) publish(findInDeck(pres, null, re, opts, where))
      void deckNotes(pres, session.version).then((notes) => publish(findInDeck(pres, notes, re, opts, where)))
    }
    const t = setTimeout(run, where.only != null ? 0 : 150)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [re, f.notes, pres, session.version, key, narrowSlide]) // eslint-disable-line react-hooks/exhaustive-deps

  // A new current match: its slide comes into view (not when a re-search only finds the same one again,
  // so going to another slide and editing there doesn't pull you back).
  const cur = f.matches[f.current]
  const went = useRef<FindMatch | undefined>(undefined)
  useEffect(() => {
    const prev = went.current
    went.current = cur
    if (!cur || (prev && sameMatch(prev, cur))) return
    if (cur.slideIndex !== useDecks.getState().sessions[key]?.slideIndex) useDecks.getState().setSlide(key, cur.slideIndex)
  }, [cur, key])

  useFindHighlights(session, re, scope)

  const pool = scopedMatches(f.matches, scope, session.slideIndex)
  const at = pool.indexOf(cur as FindMatch)
  const slidesHit = new Set(f.matches.map((m) => m.slideIndex)).size
  const inNotes = f.matches.filter((m) => m.where === 'notes').length
  const step = (dir: 1 | -1) => f.step(dir, session.slideIndex)

  const onKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation() // the deck's own shortcuts don't apply while typing here
    if (e.key === 'Enter') {
      e.preventDefault()
      step(e.shiftKey ? -1 : 1)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      f.close()
    } else if (e.key === 'ArrowDown' && list) {
      e.preventDefault()
      step(1)
    } else if (e.key === 'ArrowUp' && list) {
      e.preventDefault()
      step(-1)
    }
  }

  const toggle = (on: boolean, title: string, onClick: () => void, children: React.ReactNode) => (
    <button
      className={clsx('flex h-6 items-center gap-1 rounded px-1.5', on ? 'bg-amber-100 text-amber-900 ring-1 ring-amber-300' : 'text-ink-2 hover:bg-paper')}
      aria-pressed={on}
      title={title}
      onMouseDown={(e) => e.preventDefault() /* keep the focus in the box */}
      onClick={onClick}
    >
      {children}
    </button>
  )

  return (
    <div
      data-find-bar=""
      className="absolute right-3 top-2 z-30 w-[min(440px,calc(100%-24px))] rounded-lg border border-hair bg-white text-xs text-ink shadow-lg"
      onKeyDown={(e) => e.stopPropagation()}
    >
      <div className="flex items-center gap-1 px-2 pt-1.5">
        <Search size={13} className="shrink-0 text-ink-3" />
        <input
          ref={input}
          className="h-6 min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-ink-3"
          placeholder={f.scope === 'slide' ? 'Find on this slide' : 'Find in the deck'}
          value={f.query}
          spellCheck={false}
          onChange={(e) => f.set({ query: e.target.value })}
          onKeyDown={onKeyDown}
        />
        <span className={clsx('shrink-0 tabular-nums', re && !pool.length ? 'text-red-600' : 'text-ink-3')} data-find-count="">
          {!re ? '' : !pool.length ? 'No results' : `${at >= 0 ? at + 1 : '–'} of ${pool.length}`}
        </span>
        <button className="icon-btn h-6 w-6" title="Previous (⇧↵, ⇧⌘G)" disabled={!pool.length} onMouseDown={(e) => e.preventDefault()} onClick={() => step(-1)}><ChevronUp size={15} /></button>
        <button className="icon-btn h-6 w-6" title="Next (↵, ⌘G)" disabled={!pool.length} onMouseDown={(e) => e.preventDefault()} onClick={() => step(1)}><ChevronDown size={15} /></button>
        <button
          className={clsx('icon-btn h-6 w-6', list && 'bg-paper text-ink')}
          title="List all the matches, by slide"
          disabled={!f.matches.length}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setList(!list)}
        ><List size={14} /></button>
        <button className="icon-btn h-6 w-6" title="Close (Esc)" onClick={() => f.close()}><X size={14} /></button>
      </div>
      <div className="flex flex-wrap items-center gap-1 px-2 pb-1.5 pt-1 text-[11px]">
        <div className="flex overflow-hidden rounded border border-hair" role="group" aria-label="Where to find">
          {(['slide', 'deck'] as const).map((s) => {
            // Deck chosen but the query too short for it yet: greyed (this slide is searched meanwhile).
            const waiting = s === 'deck' && f.scope === 'deck' && !wide
            return (
              <button
                key={s}
                className={clsx('px-1.5 py-px', waiting ? 'bg-ink/25 text-white' : f.scope === s ? 'bg-ink text-white' : 'text-ink-2 hover:bg-paper')}
                title={s === 'deck' ? `Find in the whole deck (from ${MIN_DECK_CHARS} characters on — shorter, this slide only)` : 'Find on this slide only'}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => f.set({ scope: s })}
              >{s === 'slide' ? 'This slide' : 'Deck'}</button>
            )
          })}
        </div>
        {toggle(f.matchCase, 'Match case', () => f.set({ matchCase: !f.matchCase }), <span className="font-semibold">Aa</span>)}
        {toggle(f.wholeWord, 'Whole words only', () => f.set({ wholeWord: !f.wholeWord }), <span className="font-semibold underline decoration-dotted underline-offset-2">ab</span>)}
        {toggle(f.notes, 'Find in the speaker notes too', () => f.set({ notes: !f.notes }), <><StickyNote size={11} /> Notes</>)}
        {wide && toggle(f.onlyMatching, 'Show only the slides with matches in the thumbnails', () => f.set({ onlyMatching: !f.onlyMatching }), 'Only matching slides')}
        {re && f.scope === 'deck' && !wide && (
          <span className="ml-auto text-ink-3">this slide · {MIN_DECK_CHARS}+ characters for the deck</span>
        )}
        {re && wide && f.matches.length > 0 && (
          <span className="ml-auto text-ink-3" title={`${f.matches.length} match${f.matches.length > 1 ? 'es' : ''}${inNotes ? `, ${inNotes} in the speaker notes` : ''}`}>
            on {slidesHit} slide{slidesHit > 1 ? 's' : ''}
          </span>
        )}
      </div>
      {list && pool.length > 0 && <ResultList matches={f.matches} pool={pool} current={f.current} onPick={(i) => { f.set({ current: i }); useDecks.getState().setSlide(key, f.matches[i].slideIndex) }} />}
    </div>
  )
}

const MAX_LISTED = 300

/** All the matches (in scope), grouped by slide, each with its words around it; click to go there. */
function ResultList({ matches, pool, current, onPick }: { matches: FindMatch[]; pool: FindMatch[]; current: number; onPick(i: number): void }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    ref.current?.querySelector('[data-current]')?.scrollIntoView({ block: 'nearest' })
  }, [current])
  const shown = pool.slice(0, MAX_LISTED)
  return (
    <div ref={ref} className="max-h-72 overflow-y-auto border-t border-hair py-1" data-find-results="">
      {shown.map((m, k) => {
        const i = matches.indexOf(m)
        const head = k === 0 || shown[k - 1].slideIndex !== m.slideIndex
        const count = head ? pool.filter((x) => x.slideIndex === m.slideIndex).length : 0
        return (
          <Fragment key={i}>
            {head && (
              <div className="flex items-center gap-1 px-2 pb-0.5 pt-1 text-[10px] font-semibold uppercase tracking-wide text-ink-3">
                Slide {m.slideIndex + 1}<span className="ml-auto font-normal normal-case tracking-normal">{count}</span>
              </div>
            )}
            <button
              className={clsx('flex w-full items-baseline gap-1.5 px-3 py-0.5 text-left', i === current ? 'bg-amber-100' : 'hover:bg-paper')}
              data-current={i === current ? '' : undefined}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onPick(i)}
            >
              {m.where === 'notes' && <span className="shrink-0 rounded bg-ink/5 px-1 text-[10px] text-ink-3">notes</span>}
              <span className="min-w-0 truncate text-ink-2">
                {m.snippet.before}<mark className="rounded-sm bg-yellow-200 px-px text-ink">{m.snippet.match}</mark>{m.snippet.after}
              </span>
            </button>
          </Fragment>
        )
      })}
      {pool.length > MAX_LISTED && <div className="px-3 py-1 text-ink-3">…and {pool.length - MAX_LISTED} more</div>}
    </div>
  )
}

type HighlightRegistry = Map<string, unknown>
type HighlightCtor = new (...r: Range[]) => { priority: number }

/** Mutations other than inside `self` (a layer's own drawing doesn't call for measuring again). */
const outside = (records: MutationRecord[], self: Element | null) =>
  records.some((r) => !self?.contains(r.target instanceof Element ? r.target : r.target.parentElement))

/**
 * The matches in the speaker notes editor, highlighted (CSS Custom Highlight API — no DOM changes;
 * the editor's text is selectable, so WebKit paints them too), the current one scrolled into view.
 */
function useFindHighlights(session: DeckSession, re: RegExp | null, scope: 'deck' | 'slide') {
  const matches = useFind((s) => s.matches)
  const current = useFind((s) => s.current)
  const scrolled = useRef<FindMatch | null>(null)
  useEffect(() => {
    const reg = (globalThis as { CSS?: { highlights?: HighlightRegistry } }).CSS?.highlights
    const H = (globalThis as { Highlight?: HighlightCtor }).Highlight
    if (!reg || !H) return
    const clear = () => {
      reg.delete('find-match')
      reg.delete('find-current')
    }
    if (!re) return clear
    const slideIndex = session.slideIndex
    const paint = () => {
      const all: Range[] = []
      const now: Range[] = []
      const cm = matches[current]
      const notes = document.querySelector('[data-notes-editor]')
      const ranges = notes ? rangesIn(notes, re) : []
      for (const m of scopedMatches(matches, scope, slideIndex)) {
        if (m.where !== 'notes' || m.slideIndex !== slideIndex) continue
        const r = ranges[m.occurrence]
        if (!r) continue
        all.push(r)
        if (m === cm) now.push(r)
      }
      reg.set('find-match', new H(...all))
      const hc = new H(...now)
      hc.priority = 1
      reg.set('find-current', hc)
      // A current match in the notes: scrolled into view there (once per match).
      if (now[0] && notes && scrolled.current !== cm) {
        scrolled.current = cm
        const r = now[0].getBoundingClientRect(), box = notes.getBoundingClientRect()
        if (r.top < box.top || r.bottom > box.bottom) notes.scrollTop += r.top - box.top - box.height / 3
      }
    }
    let raf = requestAnimationFrame(paint)
    const t = setTimeout(paint, 400)
    // The notes editor (re)rendered or opened: highlight again.
    const root = document.querySelector('[data-deck-root]')
    const obs = new MutationObserver((records) => {
      if (!records.some((r) => (r.target instanceof Element ? r.target : r.target.parentElement)?.closest('[data-notes-editor], [data-notes-pane]'))) return
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(paint)
    })
    if (root) obs.observe(root, { childList: true, subtree: true, characterData: true })
    return () => {
      cancelAnimationFrame(raf)
      clearTimeout(t)
      obs.disconnect()
      clear()
    }
  }, [re, matches, current, scope, session.slideIndex, session.version])
}

interface MarkRect { x: number; y: number; w: number; h: number; current: boolean }

/**
 * The matches on a rendered slide — the one in view, or a thumbnail — marked over its text: a
 * layer beside the slide's render (in the same parent), measured from the text itself. (Not CSS
 * highlights: slide text isn't selectable, and WebKit doesn't paint highlights on such text.)
 * `scale`: the render's size, so the marks are measured again when it changes.
 */
export function FindMarks({ deckKey, slideIndex, scale, thumb = false }: { deckKey: string; slideIndex: number; scale: number; thumb?: boolean }) {
  const host = useRef<HTMLDivElement>(null)
  const on = useFind((s) => s.deck === deckKey)
  const matches = useFind((s) => s.matches)
  const current = useFind((s) => s.current)
  const query = useFind((s) => s.query)
  const matchCase = useFind((s) => s.matchCase)
  const wholeWord = useFind((s) => s.wholeWord)
  const [rects, setRects] = useState<MarkRect[]>([])
  useLayoutEffect(() => {
    const re = on ? findRegex(query, { matchCase, wholeWord }) : null
    const mine = matches.map((m, i) => ({ m, i })).filter(({ m }) => m.slideIndex === slideIndex && m.where === 'slide')
    if (!re || !mine.length) {
      setRects((r) => (r.length ? [] : r))
      return
    }
    let live = true
    const measure = () => {
      const el = host.current, root = el?.parentElement
      if (!live || !el || !root) return
      const box = el.getBoundingClientRect()
      const cache = new Map<string, Range[]>()
      const out: MarkRect[] = []
      for (const { m, i } of mine) {
        const id = m.nodeId ?? ''
        let ranges = cache.get(id)
        if (!ranges) {
          const node = root.querySelector(`[data-pptx-node-id="${CSS.escape(id)}"]`)
          cache.set(id, (ranges = node ? rangesIn(node, re) : []))
        }
        const r = ranges[m.occurrence]
        if (!r) continue
        for (const c of r.getClientRects()) {
          if (c.width > 0 && c.height > 0) out.push({ x: c.left - box.left, y: c.top - box.top, w: c.width, h: c.height, current: i === current })
        }
      }
      setRects(out)
    }
    measure()
    const raf = requestAnimationFrame(measure)
    const t = setTimeout(measure, 400)
    void document.fonts?.ready.then(measure)
    // The slide re-rendering (an edit, a reload, typing in a box): measure again.
    const obs = new MutationObserver((records) => {
      if (outside(records, host.current)) requestAnimationFrame(measure)
    })
    if (host.current?.parentElement) obs.observe(host.current.parentElement, { childList: true, subtree: true, characterData: true })
    return () => {
      live = false
      cancelAnimationFrame(raf)
      clearTimeout(t)
      obs.disconnect()
    }
  }, [on, query, matchCase, wholeWord, matches, current, slideIndex, scale])
  const pad = thumb ? 0.5 : 1.5
  return (
    <div ref={host} className="pointer-events-none absolute inset-0 z-[4]" aria-hidden data-find-marks={thumb ? 'thumb' : 'slide'}>
      {rects.map((r, k) => (
        <div
          key={k}
          className={clsx('absolute', thumb ? 'rounded-[1px]' : 'rounded-[2px]', r.current ? 'bg-orange-400/55 ring-orange-500' : 'bg-yellow-300/50 ring-yellow-400/80', thumb ? 'ring-0' : r.current ? 'ring-2' : 'ring-1')}
          style={{ left: r.x - pad, top: r.y - pad / 2, width: r.w + pad * 2, height: r.h + pad }}
        />
      ))}
    </div>
  )
}
