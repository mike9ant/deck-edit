/**
 * Speaker notes under the slide: a collapsible, resizable, editable panel.
 * The notes show formatted (bold, colours, links, bullets…) and are edited in
 * place like slide text — ⌘B / ⌘I / ⌘U toggle formatting, and editing keeps
 * the formatting already there (see notesRich.ts). Typing saves into the
 * slide's notes page (debounced, and on blur) — an undoable deck edit the
 * agent is told about like any other. The panel's open state and height persist.
 */

import { Fragment, useEffect, useRef, useState } from 'react'
import { BotMessageSquare, ChevronDown, ChevronRight, ListChecks, Loader2, StickyNote } from 'lucide-react'
import clsx from 'clsx'
import type { SlideData } from '@diceui/pptx-core'
import { useDecks, type DeckSession } from './deckStore'
import { readNotesParagraphs, writeNotes } from './speakerNotes'
import { buildParagraphs, notesText, parseParagraphs, renderNotes, styleRange, type StyleProp, type StyledParagraph } from './notesRich'
import { domPointAt, paragraphsText, readParagraphs, readParagraphsAt, watchBullets } from './textEdit'
import { short } from './deckModel'
import { useNotes } from '../store/notesStore'
import { requestEdit, useEditMode } from '../store/editGuard'
import { NotesList, QuoteNoteBox } from '../notes/TextNotes'
import { actNowPrompt } from '../notes/NotePins'
import { setQuoteHighlight } from '../notes/quoteHighlight'
import { domRangeOf } from '../viewers/textRanges'
import { useCompare } from './compareStore'
import { paragraphOps, wordDiff, type Op } from './deckDiff'
import { rowKey, type Decision } from './review'
import { WordCounts } from './CompareView'
import { useFind } from './find'
import { useMenuActions } from '../desktopMenu'

const LS_OPEN = 'deckedit-notes-open'
const LS_HEIGHT = 'deckedit-notes-height'
const SAVE_MS = 900
const STYLE_KEYS: Record<string, StyleProp> = { b: 'b', i: 'i', u: 'u' }

export function NotesPane({ session }: { session: DeckSession }) {
  const pres = session.pres!
  const slide: SlideData | undefined = pres.slides[session.slideIndex]
  const editOff = useEditMode() === 'off'
  const [open, setOpen] = useState(() => localStorage.getItem(LS_OPEN) !== '0')
  const [height, setHeight] = useState(() => Number(localStorage.getItem(LS_HEIGHT)) || 130)
  const [text, setText] = useState('')
  const [saving, setSaving] = useState(false)
  const editor = useRef<HTMLDivElement>(null)
  /** The notes paragraphs the editor was rendered from — what its data-pptx-p / -r indexes refer to. */
  const base = useRef<Element[]>([])
  /** The slide whose notes the editor shows (pending typing is saved there, even after switching slides). */
  const shown = useRef<string | null>(null)
  const savedText = useRef('')
  const dirty = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const undoRedoRef = useRef<(redo: boolean) => Promise<void>>(async () => {})
  const slideNo = session.slideIndex + 1
  // Comparing with another version: this slide's notes then (if they changed), shown as a diff.
  const notesRow = useCompare((s) => s.compares[session.key]?.diff?.rows.find((r) => r.newSlide === slide?.id))
  const notesDiff = notesRow?.notes
  // Reviewing the comparison: this slide's notes change can be accepted / rejected here too.
  const reviewing = useCompare((s) => !!s.compares[session.key]?.review)
  const notesKey = notesRow ? `${rowKey(notesRow)}|notes` : ''
  const notesDecision = useCompare((s) => (notesKey ? s.compares[session.key]?.review?.decisions[notesKey] : undefined))
  const [showDiff, setShowDiff] = useState(true)
  // Find (⌘F) stepping to a match in this slide's notes: the panel opens (and shows the editable notes) to show it.
  const findInNotes = useFind((s) => {
    const m = s.deck === session.key ? s.matches[s.current] : undefined
    return m?.where === 'notes' ? `${m.slideId}#${m.occurrence}` : null
  })
  useEffect(() => {
    if (!findInNotes || !slide || !findInNotes.startsWith(`${slide.id}#`)) return
    setOpen(true)
    setShowDiff(false)
  }, [findInNotes, slide?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const [rendered, setRendered] = useState(0)
  const render = () => {
    const el = editor.current
    if (!el) return
    renderNotes(el, base.current)
    watchBullets(el)
    setRendered((n) => n + 1)
  }

  // Notes for the agent on selected text in the speaker notes.
  const allNotes = useNotes((s) => s.notes)
  const shownSlide = pres.slides.find((x) => x.id === shown.current) ?? slide
  // Notes name slides by their stable id (p:sldId), like every deck note.
  const stableId = shownSlide ? (session.sldIds.get(shownSlide.id) ?? '') : ''
  const quoteNotes = shownSlide ? allNotes.filter((n) => n.target === 'speakerNotes' && n.deck === session.path && n.slideId === stableId) : []
  const openQuotes = quoteNotes.filter((n) => n.status === 'open')
  const [selQuote, setSelQuote] = useState('')
  const [noteDraft, setNoteDraft] = useState<string | null>(null)
  const [noteList, setNoteList] = useState(false)
  useEffect(() => {
    const onSel = () => {
      const el = editor.current
      const sel = window.getSelection()
      setSelQuote(sel && !sel.isCollapsed && el?.contains(sel.anchorNode) && el.contains(sel.focusNode) ? sel.toString().trim() : '')
    }
    document.addEventListener('selectionchange', onSel)
    return () => document.removeEventListener('selectionchange', onSel)
  }, [])
  const quotesKey = openQuotes.map((n) => n.quote).join('\u0000')
  useEffect(() => (open ? setQuoteHighlight('speaker-note-quote', editor.current, openQuotes.map((n) => n.quote ?? '')) : undefined), [quotesKey, rendered, open]) // eslint-disable-line react-hooks/exhaustive-deps
  const revealQuote = (quote: string) => {
    const el = editor.current
    const r = el && (domRangeOf(el, quote) ?? domRangeOf(el, quote.split('\n').map((l) => l.trim()).find(Boolean) ?? ''))
    if (!r) return
    el!.focus()
    const sel = window.getSelection()
    sel?.removeAllRanges()
    sel?.addRange(r)
    ;(r.startContainer.parentElement as HTMLElement | null)?.scrollIntoView({ block: 'nearest' })
  }

  const commit = async (sid: string, xml: string[], value: string) => {
    setSaving(true)
    const no = pres.slides.findIndex((s) => s.id === sid) + 1
    const before = savedText.current
    const ok = await useDecks.getState().applyCustom(
      session.key,
      value.trim()
        ? `Slide ${no}: edited the speaker notes${before.trim() ? '' : ' (new)'}: "${short(value, 160)}"`
        : `Slide ${no}: cleared the speaker notes`,
      // Given the deck and slide id at (re)apply time: edits made while the agent works are replayed onto its version.
      (p, [id]) => {
        const sl = p.slides.find((x) => x.id === id)
        if (!sl) throw new Error('the slide is gone')
        return writeNotes(p, sl, { paragraphs: xml })
      },
      `notes:${sid}`,
      [sid],
    )
    if (ok) savedText.current = value
    setSaving(false)
  }

  /** Save pending typing (reads the editor synchronously, so it's safe to call right before re-rendering). */
  const save = async () => {
    clearTimeout(timer.current)
    const el = editor.current
    const sid = shown.current
    if (!el || !sid || !dirty.current) return
    dirty.current = false
    const edited = readParagraphs(el)
    const value = paragraphsText(edited)
    // Typed and deleted again: nothing to save (and no empty undo step). Formatting only changes via toggles, saved there.
    if (value === savedText.current && !edited.some((p) => p.noBullet)) return
    await commit(sid, buildParagraphs(base.current, edited), value)
  }

  // Load the notes when the slide changes or the deck reloads — but never
  // overwrite what's being typed.
  useEffect(() => {
    if (!slide) return
    if (dirty.current) void save() // the previous slide's last keystrokes
    let live = true
    void readNotesParagraphs(pres, slide).then((ps) => {
      if (!live) return
      if (editor.current && document.activeElement === editor.current && shown.current === slide.id) return
      base.current = ps
      shown.current = slide.id
      savedText.current = notesText(ps)
      setText(savedText.current)
      render()
    })
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pres, slide?.id, session.version])

  // The editor mounts when the panel opens; save on unmount.
  useEffect(() => {
    if (!open) return
    render()
    // Edit menu → Undo / Redo arrives as a native history input: same as the shortcuts.
    const el = editor.current
    const onHistory = (e: InputEvent) => {
      // Any change (typing, deleting, pasting): the first one in a project asks first, and nothing
      // changes until editing is on.
      if (!requestEdit()) {
        e.preventDefault()
        return
      }
      if (e.inputType !== 'historyUndo' && e.inputType !== 'historyRedo') return
      e.preventDefault()
      void undoRedoRef.current(e.inputType === 'historyRedo')
    }
    el?.addEventListener('beforeinput', onHistory)
    return () => el?.removeEventListener('beforeinput', onHistory)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])
  useEffect(() => () => void save(), []) // eslint-disable-line react-hooks/exhaustive-deps

  const onInput = () => {
    const el = editor.current
    if (!el) return
    dirty.current = true
    setText(paragraphsText(readParagraphs(el)))
    clearTimeout(timer.current)
    timer.current = setTimeout(() => void save(), SAVE_MS)
  }

  /** ⌘B / ⌘I / ⌘U: Word-style — on, unless all of the selection (or the word at the caret) has it. */
  const toggleStyle = async (prop: StyleProp) => {
    const el = editor.current
    const sel = window.getSelection()
    const sid = shown.current
    if (!el || !sid || !sel?.rangeCount) return
    const r = sel.getRangeAt(0)
    if (!el.contains(r.startContainer) || !el.contains(r.endContainer)) return
    const read = readParagraphsAt(el, [[r.startContainer, r.startOffset], [r.endContainer, r.endOffset]])
    const paragraphs = read.paragraphs as StyledParagraph[]
    const [caretStart, caretEnd] = read.positions
    if (!caretStart || !caretEnd) return
    let start = caretStart
    let end = caretEnd
    const collapsed = start.p === end.p && start.o === end.o
    if (collapsed) {
      const t = paragraphs[start.p]?.runs.map((x) => x.text).join('') ?? ''
      let a = start.o
      let b = start.o
      while (a > 0 && /[\p{L}\p{N}_'’-]/u.test(t[a - 1])) a--
      while (b < t.length && /[\p{L}\p{N}_'’-]/u.test(t[b])) b++
      if (a === b) return
      start = { p: start.p, o: a }
      end = { p: end.p, o: b }
    }
    styleRange(base.current, paragraphs, start, end, prop)
    const xml = buildParagraphs(base.current, paragraphs)
    base.current = parseParagraphs(xml)
    render()
    // Put the selection (or the caret) back where it was.
    const from = domPointAt(el, caretStart, 'start')
    const to = collapsed ? from : domPointAt(el, caretEnd, 'end')
    if (from && to) {
      const range = document.createRange()
      range.setStart(...from)
      range.setEnd(...to)
      sel.removeAllRanges()
      sel.addRange(range)
    }
    clearTimeout(timer.current)
    dirty.current = false
    await commit(sid, xml, paragraphsText(paragraphs))
  }

  /**
   * ⌘Z / ⇧⌘Z in the notes: the deck's undo history (where every notes save is
   * a step — the browser's own undo can't follow formatting toggles, bullets or
   * re-renders). Saves pending typing first, then shows the result, caret kept.
   */
  const undoRedo = async (redo: boolean) => {
    const el = editor.current
    if (!el) return
    const sel = window.getSelection()
    const caret = sel?.anchorNode && el.contains(sel.anchorNode) ? readParagraphsAt(el, [[sel.anchorNode, sel.anchorOffset]]).positions[0] : null
    if (dirty.current) await save()
    const decks = useDecks.getState()
    if (redo) await decks.redo(session.key)
    else decks.undo(session.key)
    const p = useDecks.getState().sessions[session.key]?.pres
    const sl = p?.slides.find((x) => x.id === shown.current)
    if (!p || !sl) return
    const ps = await readNotesParagraphs(p, sl)
    base.current = ps
    savedText.current = notesText(ps)
    setText(savedText.current)
    render()
    el.focus()
    const at = (caret && domPointAt(el, caret)) ?? domPointAt(el, { p: Math.max(0, ps.length - 1), o: Number.MAX_SAFE_INTEGER })
    if (at) window.getSelection()?.collapse(...at)
  }

  undoRedoRef.current = undoRedo

  const onKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation() // the deck's shortcuts don't apply while typing notes
    const k = e.key.toLowerCase()
    if ((e.metaKey || e.ctrlKey) && !e.altKey && (k === 'z' || k === 'y')) {
      e.preventDefault()
      void undoRedo(k === 'y' || e.shiftKey)
      return
    }
    const prop = STYLE_KEYS[k]
    if (prop && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey) {
      e.preventDefault()
      void toggleStyle(prop)
    }
  }

  const onPaste = (e: React.ClipboardEvent) => {
    // Plain text only: pasted HTML would bring styles the notes page can't hold.
    e.preventDefault()
    if (!requestEdit()) return
    document.execCommand('insertText', false, e.clipboardData.getData('text/plain'))
  }

  const toggle = () => {
    setOpen(!open)
    localStorage.setItem(LS_OPEN, open ? '0' : '1')
  }

  useMenuActions(() => ({ 'toggle-notes': { checked: open, run: toggle } }))

  const startResize = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    const startY = e.clientY
    const startH = height
    const el = e.currentTarget
    el.setPointerCapture(e.pointerId)
    const move = (ev: PointerEvent) => setHeight(Math.max(60, Math.min(480, startH - (ev.clientY - startY))))
    const up = () => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      setHeight((h) => {
        localStorage.setItem(LS_HEIGHT, String(h))
        return h
      })
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
  }

  const preview = text.trim() ? short(text, 110) : 'No speaker notes'

  return (
    <div className="shrink-0 border-t border-hair bg-panel" data-notes-pane="">
      {open && <div className="h-1 cursor-row-resize hover:bg-accent/20" onPointerDown={startResize} title="Drag to resize" />}
      <div className="relative flex items-center pr-2 hover:bg-paper">
        <button className="flex min-w-0 flex-1 items-center gap-1.5 px-3 py-1.5 text-left text-xs text-ink-2" onClick={toggle}>
          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          <span className="shrink-0 font-medium">Speaker notes</span>
          <span className="shrink-0 text-ink-3">· slide {slideNo}</span>
          {!open && <span className="ml-2 truncate text-ink-3">{preview}</span>}
          {saving && <Loader2 size={12} className="ml-auto shrink-0 animate-spin text-ink-3" />}
        </button>
        {notesDiff && (
          reviewing ? (
            <span className="mr-2 flex shrink-0 items-center gap-1 text-[11px]">
              <button
                className={clsx('rounded border px-1.5 py-px', notesDecision === 'accept' ? 'border-emerald-600 bg-emerald-600 text-white' : 'border-emerald-300 bg-white text-emerald-700 hover:bg-emerald-50')}
                title={notesDecision === 'accept' ? 'Accepted — click to undecide' : 'Accept these notes (the To version)'}
                onClick={() => useCompare.getState().decide(session.key, [notesKey], notesDecision === 'accept' ? null : 'accept')}
              >✓ Accept notes</button>
              <button
                className={clsx('rounded border px-1.5 py-px', notesDecision === 'reject' ? 'border-ink-3 bg-ink-3 text-white' : 'border-hair bg-white text-ink-2 hover:bg-paper')}
                title={notesDecision === 'reject' ? 'Not accepted — click to undecide' : 'Keep the From version of the notes'}
                onClick={() => useCompare.getState().decide(session.key, [notesKey], notesDecision === 'reject' ? null : 'reject')}
              >✗</button>
            </span>
          ) : (
            <button
              className="mr-2 flex shrink-0 items-center gap-1 rounded border border-hair bg-white px-1.5 py-px text-[11px] text-ink-2 hover:bg-paper"
              title="Review the comparison's changes (accept or reject each, then apply them)"
              onClick={() => void useCompare.getState().startReview(session.key)}
            ><ListChecks size={11} /> Review</button>
          )
        )}
        {open && notesDiff && (
          <span className="mr-2 shrink-0 text-[11px]" title="Words removed and added in these notes, compared with the other version">
            <WordCounts {...wordDiff(notesDiff.old, notesDiff.new)} />
          </span>
        )}
        {open && notesDiff && (
          <div className="mr-1 flex shrink-0 overflow-hidden rounded border border-hair bg-white text-[11px]" role="group" aria-label="Speaker notes view">
            {([['diff', 'Changes'], ['edit', 'Edit']] as const).map(([v, label]) => (
              <button
                key={v}
                className={clsx('px-1.5 py-px', (v === 'diff') === showDiff ? 'bg-ink text-white' : 'text-ink-2 hover:bg-paper')}
                title={v === 'diff' ? 'How these notes changed: removed text struck through, new text in green' : 'Edit the notes as they are now'}
                onClick={() => setShowDiff(v === 'diff')}
              >
                {label}
              </button>
            ))}
          </div>
        )}
        {open && (
          <div className="flex shrink-0 items-center gap-0.5">
            <button
              className="tool-btn h-6"
              disabled={!selQuote}
              title={selQuote ? 'Add a note for the AI agent about the selected text' : 'Select some text in the speaker notes to add a note for the AI agent about it'}
              onMouseDown={(e) => e.preventDefault() /* keep the selection */}
              onClick={() => { setNoteDraft(selQuote); setNoteList(false) }}
            >
              <BotMessageSquare size={13} /> Note for AI
            </button>
            {quoteNotes.length > 0 && (
              <button className={clsx('tool-btn h-6', openQuotes.length && 'text-amber-800')} title="Notes on these speaker notes" onClick={() => { setNoteList(!noteList); setNoteDraft(null) }}>
                <StickyNote size={12} /> {openQuotes.length ? `${openQuotes.length} open` : quoteNotes.length}
              </button>
            )}
          </div>
        )}
        {noteDraft && shownSlide && (
          <QuoteNoteBox
            above
            heading={`Note for the agent · speaker notes of slide ${pres.slides.indexOf(shownSlide) + 1}`}
            quote={noteDraft}
            placeholder="e.g. shorten this, make it sound less scripted"
            onPin={(t) => useNotes.getState().add({ deck: session.path, slideId: stableId, slideIndex: pres.slides.indexOf(shownSlide) + 1, x: 0, y: 0, quote: noteDraft, target: 'speakerNotes', text: t })}
            actNow={(n) => actNowPrompt(n, 'speakerNotes')}
            onClose={() => setNoteDraft(null)}
          />
        )}
        {noteList && (
          <NotesList above title="Notes on these speaker notes" notes={quoteNotes} onReveal={(n) => { setNoteList(false); revealQuote(n.quote ?? '') }} onClose={() => setNoteList(false)} />
        )}
      </div>
      {open && (
        <div className="relative bg-white" style={{ height }}>
          {!text.trim() && <div className="pointer-events-none absolute left-4 top-2 text-[13px] text-ink-3">Click to add speaker notes</div>}
          <div
            ref={editor}
            data-notes-editor=""
            className="h-full overflow-auto whitespace-pre-wrap break-words px-4 py-2 text-[13px] leading-relaxed text-ink outline-none"
            contentEditable={!!slide && !editOff}
            suppressContentEditableWarning
            spellCheck={false}
            title="Speaker notes — ⌘B / ⌘I / ⌘U for bold, italic, underline"
            onInput={onInput}
            onBlur={() => void save()}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
          />
          {notesDiff && showDiff && <NotesDiffView before={notesDiff.old} after={notesDiff.new} onEdit={() => setShowDiff(false)} decision={reviewing ? notesDecision : undefined} />}
        </div>
      )}
    </div>
  )
}

/**
 * The notes' change in place. Undecided (or not reviewing): kept text as is, removed text struck
 * through in red, new text in green. In a review, as the decision would leave them — accepted: the
 * new notes, their new words green; not accepted: the old notes, the words that come back on a
 * light red dashed background (kept, not struck).
 */
function NotesDiffView({ before, after, onEdit, decision }: { before: string; after: string; onEdit(): void; decision?: Decision }) {
  const paras = paragraphOps(before, after)
  const ADD = 'rounded-sm bg-emerald-100 text-emerald-900'
  const RESTORED = 'rounded-sm bg-red-50 outline-dashed outline-1 outline-red-300'
  const runs = (ops: Op[]) =>
    ops
      .filter((o) => (decision === 'accept' ? o.k !== 'del' : decision === 'reject' ? o.k !== 'add' : true))
      .map((o, i) => (
        <Fragment key={i}>
          {i > 0 && ' '}
          <span className={o.k === 'same' ? undefined : decision === 'accept' ? ADD : decision === 'reject' ? RESTORED : o.k === 'del' ? 'text-red-600 line-through decoration-red-500/80' : 'rounded-sm bg-emerald-100 px-px font-medium text-emerald-800'}>{o.t}</span>
        </Fragment>
      ))
  return (
    <div
      className={clsx(
        'absolute inset-0 overflow-auto bg-white px-4 py-2 text-[13px] leading-relaxed text-ink',
        decision === 'accept' && 'border-l-4 border-emerald-500',
        decision === 'reject' && 'border-l-4 border-ink-3/40',
      )}
      data-notes-diff={decision ?? ''}
      onDoubleClick={onEdit}
      title="Double-click to edit the notes"
    >
      {decision && (
        <div className={clsx('mb-1 text-[11px] font-medium', decision === 'accept' ? 'text-emerald-700' : 'text-ink-3')}>
          {decision === 'accept' ? '✓ Accepted — the new notes' : '↺ Not accepted — the notes stay as they were'}
        </div>
      )}
      {paras.map((p, i) => {
        // A whole paragraph removed or added: dropped when the decision leaves it out.
        if ((decision === 'accept' && p.k === 'del') || (decision === 'reject' && p.k === 'add')) return null
        const whole = decision === 'accept' ? ADD : decision === 'reject' ? RESTORED : p.k === 'del' ? 'text-red-600 line-through decoration-red-500/80' : 'bg-emerald-50 text-emerald-800'
        return (
          <p key={i} className="min-h-[1.2em] whitespace-pre-wrap break-words">
            {p.k === 'edit' ? runs(p.ops) : p.k === 'same' ? p.ops.map((o) => o.t).join(' ') : <span className={whole}>{p.ops.map((o) => o.t).join(' ')}</span>}
          </p>
        )
      })}
    </div>
  )
}
