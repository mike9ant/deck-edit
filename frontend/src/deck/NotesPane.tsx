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
import type { PresentationData, SlideData } from '@diceui/pptx-core'
import { registerPendingCommit, useDecks, type DeckSession } from './deckStore'
import { readNotesParagraphs, writeNotes } from './speakerNotes'
import { buildParagraphs, notesText, parseParagraphs, renderNotes, styleRange, type StyleProp, type StyledParagraph } from './notesRich'
import { domPointAt, paragraphsText, readParagraphs, readParagraphsAt, watchBullets, type TextPoint } from './textEdit'
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
import { clearNotesChangeMarks, markNotesChanges } from './notesChangeMarks'
import { useFind } from './find'
import { useMenuActions } from '../desktopMenu'
import { setTyping } from './liveTyping'

const LS_OPEN = 'deckedit-notes-open'
const LS_HEIGHT = 'deckedit-notes-height'
/**
 * Typing becomes a deck edit (one undo step) after this long without a keystroke — and at once when
 * you leave the notes, go to another slide, undo, or the decks are flushed. (Writing the file is
 * separate: deckStore `SAVE_DEBOUNCE_MS`.)
 */
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
  /**
   * With a comparison's change to these notes: the change read-only ('changes'), editing with it
   * marked ('marked': removed text struck through, new text highlighted), or plain editing ('edit').
   */
  const [view, setView] = useState<'changes' | 'marked' | 'edit'>('changes')
  // Comparing, with a removed slide (only in From) in view: its notes, read-only, instead of these.
  const removedId = useCompare((s) => s.compares[session.key]?.removed ?? null)
  const basePres = useCompare((s) => s.compares[session.key]?.baseSide?.pres ?? null)
  const removedNo = useCompare((s) => {
    const c = s.compares[session.key]
    const r = c?.removed ? c.diff?.rows.find((x) => x.oldSlide === c.removed) : undefined
    return r?.oldIndex != null ? r.oldIndex + 1 : null
  })
  const removedSlide = removedId && basePres ? basePres.slides.find((x) => x.id === removedId) : undefined
  const [removedText, setRemovedText] = useState('')
  // Find (⌘F) stepping to a match in this slide's notes: the panel opens (and shows the editable notes) to show it.
  const findInNotes = useFind((s) => {
    const m = s.deck === session.key ? s.matches[s.current] : undefined
    return m?.where === 'notes' ? `${m.slideId}#${m.occurrence}` : null
  })
  useEffect(() => {
    if (!findInNotes || !slide || !findInNotes.startsWith(`${slide.id}#`)) return
    setOpen(true)
    setView('edit')
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

  /** The notes edit being made (a flush waits for it: leaving the notes starts one just before). */
  const committing = useRef<Promise<unknown>>(Promise.resolve())
  const commit = (sid: string, xml: string[], value: string) => {
    const p = commitNow(sid, xml, value)
    committing.current = p
    return p
  }
  const commitNow = async (sid: string, xml: string[], value: string) => {
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
    // The typed text is in the deck now: the comparison reads it there (no stale preview later).
    if (ok && !dirty.current) setTyping(session.key, null)
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

  // Typing not yet made an edit is made one when the decks are flushed (before an agent turn…).
  const saveRef = useRef(save)
  saveRef.current = save
  useEffect(() => registerPendingCommit(async () => {
    await saveRef.current()
    await committing.current
  }), [])

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
      setTyping(session.key, null)
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
  useEffect(() => () => {
    void save()
    setTyping(session.key, null)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const onInput = () => {
    const el = editor.current
    if (!el) return
    dirty.current = true
    const typed = paragraphsText(readParagraphs(el))
    setText(typed)
    // Comparing: the notes' change shows as you type (before the save).
    if (shown.current) setTyping(session.key, { slide: shown.current, text: typed })
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
    const decks = useDecks.getState()
    const before = decks.sessions[session.key]
    // Nothing typed since the last save, and nothing to undo / redo: nothing happens (no re-render).
    if (!dirty.current && !(redo ? before?.redo.length : before?.undo.length)) return
    if (dirty.current) await save()
    const oldText = paragraphsText(readParagraphs(el))
    const xml = (els: Element[]) => els.map((e) => new XMLSerializer().serializeToString(e)).join('')
    const notesNow = async () => {
      const p = useDecks.getState().sessions[session.key]?.pres
      const sl = p?.slides.find((x) => x.id === shown.current)
      return p && sl ? readNotesParagraphs(p, sl) : null
    }
    const was = await notesNow()
    if (redo) await decks.redo(session.key)
    else decks.undo(session.key)
    const ps = await notesNow()
    if (!ps) return
    // The step undone was elsewhere (a slide edit): the notes are as they were — leave them be.
    if (was && xml(ps) === xml(was)) return
    base.current = ps
    savedText.current = notesText(ps)
    setText(savedText.current)
    render()
    setTyping(session.key, null)
    el.focus()
    // The caret goes where the change undone (redone) was — the end of the text that came back, or
    // where text went — as text editors do.
    const at = domPointAt(el, changeEnd(oldText, savedText.current))
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

  // While reviewing, the notes show the decision's result: no editing with marks.
  const shownView = reviewing && view === 'marked' ? 'changes' : view

  /** Typing in the Changes view: edit with the change marked, at that spot, starting with that key. */
  const typeFromChanges = (at: TextPoint | null, key: string) => {
    setView('marked')
    requestAnimationFrame(() => {
      const el = editor.current
      if (!el) return
      el.focus()
      const sel = window.getSelection()
      const point = (at && domPointAt(el, at)) ?? domPointAt(el, { p: Math.max(0, el.children.length - 1), o: Number.MAX_SAFE_INTEGER })
      if (point) sel?.collapse(...point)
      if (key.length === 1) document.execCommand('insertText', false, key)
      else if (key === 'Enter') document.execCommand('insertParagraph')
      else if (key === 'Backspace') document.execCommand('delete')
      else if (key === 'Delete') document.execCommand('forwardDelete')
    })
  }

  // Edit + marks: the change marked in the editor, the way the Changes view shows it — at once
  // when the notes (re)render, and after a pause while typing.
  const otherNotes = notesRow?.notes?.old ?? null
  const marking = shownView === 'marked' && otherNotes != null && !removedSlide
  const markedAt = useRef<{ text: string; rendered: number } | null>(null)
  useEffect(() => {
    const el = editor.current
    if (!marking || !el) {
      clearNotesChangeMarks(el)
      markedAt.current = null
      return
    }
    const typing = markedAt.current && markedAt.current.rendered === rendered && markedAt.current.text !== text
    const t = setTimeout(() => {
      markNotesChanges(el, otherNotes!)
      markedAt.current = { text, rendered }
    }, typing ? 250 : 0)
    return () => clearTimeout(t)
  }, [marking, otherNotes, text, rendered]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => clearNotesChangeMarks(editor.current), [])

  const shownText = removedSlide ? removedText : text
  const preview = shownText.trim() ? short(shownText, 110) : 'No speaker notes'

  return (
    <div className="shrink-0 border-t border-hair bg-panel" data-notes-pane="">
      {open && <div className="h-1 cursor-row-resize hover:bg-accent/20" onPointerDown={startResize} title="Drag to resize" />}
      <div className="relative flex items-center pr-2 hover:bg-paper">
        <button className="flex min-w-0 flex-1 items-center gap-1.5 px-3 py-1.5 text-left text-xs text-ink-2" onClick={toggle}>
          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          <span className="shrink-0 font-medium">Speaker notes</span>
          <span className="shrink-0 text-ink-3">{removedSlide ? `· removed slide${removedNo ? ` (was slide ${removedNo})` : ''} — read-only` : `· slide ${slideNo}`}</span>
          {!open && <span className="ml-2 truncate text-ink-3">{preview}</span>}
          {saving && <Loader2 size={12} className="ml-auto shrink-0 animate-spin text-ink-3" />}
        </button>
        {notesDiff && !removedSlide && (
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
        {open && notesDiff && !removedSlide && (
          <span className="mr-2 shrink-0 text-[11px]" title="Words removed and added in these notes, compared with the other version">
            <WordCounts {...wordDiff(notesDiff.old, notesDiff.new)} />
          </span>
        )}
        {open && notesDiff && !removedSlide && (
          <div className="mr-1 flex shrink-0 overflow-hidden rounded border border-hair bg-white text-[11px]" role="group" aria-label="Speaker notes view">
            {(reviewing ? (['changes', 'edit'] as const) : (['changes', 'marked', 'edit'] as const)).map((v) => (
              <button
                key={v}
                className={clsx('px-1.5 py-px', v === shownView ? 'bg-ink text-white' : 'text-ink-2 hover:bg-paper')}
                title={{
                  changes: 'How these notes changed: removed text struck through, new text in green. Read-only — start typing in it to edit with the changes marked',
                  marked: 'Edit with the changes marked: removed text struck through (not editable, not kept), new text highlighted',
                  edit: 'Edit the notes as they are now, without marks',
                }[v]}
                onClick={() => setView(v)}
              >
                {{ changes: 'Changes', marked: 'Edit + marks', edit: 'Edit' }[v]}
              </button>
            ))}
          </div>
        )}
        {open && !removedSlide && (
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
          {!text.trim() && !removedSlide && <div className="pointer-events-none absolute left-4 top-2 text-[13px] text-ink-3">Click to add speaker notes</div>}
          <div
            ref={editor}
            data-notes-editor=""
            className="h-full overflow-auto whitespace-pre-wrap break-words px-4 py-2 text-[13px] leading-relaxed text-ink outline-none"
            contentEditable={!!slide && !editOff}
            suppressContentEditableWarning
            spellCheck={false}
            title="Speaker notes — ⌘B / ⌘I / ⌘U for bold, italic, underline"
            onInput={onInput}
            // Editing while the view is Changes (the notes only start to differ as you type): with marks,
            // so the Changes view doesn't cover the editor mid-word.
            onFocus={() => view === 'changes' && setView(reviewing ? 'edit' : 'marked')}
            onBlur={() => void save().finally(() => setTyping(session.key, null))}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
          />
          {removedSlide && basePres && <RemovedSlideNotes pres={basePres} slide={removedSlide} onText={setRemovedText} />}
          {notesDiff && shownView === 'changes' && !removedSlide && (
            <NotesDiffView
              before={notesDiff.old}
              after={notesDiff.new}
              decision={reviewing ? notesDecision : undefined}
              onType={!reviewing && !editOff && slide ? typeFromChanges : undefined}
            />
          )}
        </div>
      )}
    </div>
  )
}

/** Where a change from `a` to `b` ends in `b`, as a paragraph + offset (paragraphs: "\n"-separated). */
function changeEnd(a: string, b: string): TextPoint {
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let end = 0
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++
  const at = b.length - end
  const before = b.slice(0, at).split('\n')
  return { p: before.length - 1, o: before[before.length - 1].length }
}

/**
 * A removed slide's notes (it's only in the From deck), formatted like the editor's, read-only —
 * over the editor, which stays mounted (and keeps any typing) underneath.
 */
function RemovedSlideNotes({ pres, slide, onText }: { pres: PresentationData; slide: SlideData; onText(t: string): void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [empty, setEmpty] = useState(false)
  useEffect(() => {
    let live = true
    void readNotesParagraphs(pres, slide).then((ps) => {
      if (!live || !ref.current) return
      renderNotes(ref.current, ps)
      const t = notesText(ps)
      setEmpty(!t.trim())
      onText(t)
    })
    return () => {
      live = false
    }
  }, [pres, slide]) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="absolute inset-0 overflow-auto bg-red-50/40 px-4 py-2 text-[13px] leading-relaxed text-ink" data-notes-removed="">
      <div ref={ref} className="whitespace-pre-wrap break-words" />
      {empty && <div className="text-ink-3">No speaker notes</div>}
    </div>
  )
}

/**
 * The notes' change in place. Undecided (or not reviewing): kept text as is, removed text struck
 * through in red, new text in green. In a review, as the decision would leave them — accepted: the
 * new notes, their new words green; not accepted: the old notes, the words that come back on a
 * light red dashed background (kept, not struck).
 */
function NotesDiffView({ before, after, decision, onType }: { before: string; after: string; decision?: Decision; onType?: (at: TextPoint | null, key: string) => void }) {
  const paras = paragraphOps(before, after)
  const afterParas = after.split('\n')
  const ADD = 'rounded-sm bg-emerald-100 text-emerald-900'
  const RESTORED = 'rounded-sm bg-red-50 outline-dashed outline-1 outline-red-300'
  // Every piece of text knows where it is in the new notes — its paragraph (data-np) and its first
  // word (data-nw) or character (data-o) — so typing here starts editing at that spot.
  const runs = (ops: Op[], np: number) => {
    let nw = 0
    return ops.map((o) => {
      const at = nw
      if (o.k !== 'del') nw += o.t.split(' ').length
      return { o, at }
    })
      .filter(({ o }) => (decision === 'accept' ? o.k !== 'del' : decision === 'reject' ? o.k !== 'add' : true))
      .map(({ o, at }, i) => (
        <Fragment key={i}>
          {i > 0 && ' '}
          <span data-np={np} data-nw={at} data-k={o.k} className={o.k === 'same' ? undefined : decision === 'accept' ? ADD : decision === 'reject' ? RESTORED : o.k === 'del' ? 'text-red-600 line-through decoration-red-500/80' : 'rounded-sm bg-emerald-100 px-px font-medium text-emerald-800'}>{o.t}</span>
        </Fragment>
      ))
  }

  /** Where the caret (or the click) is, as a position in the new notes. */
  const caretAt = (): TextPoint | null => {
    const sel = window.getSelection()
    let node = sel?.focusNode ?? null
    let offset = sel?.focusOffset ?? 0
    if (!node) return null
    let host = (node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element))?.closest<HTMLElement>('[data-np]') ?? null
    if (!host) {
      // Between two pieces (the space between them): the start of the next one.
      for (let n = node.nextSibling; n && !host; n = n.nextSibling) if (n instanceof HTMLElement && n.dataset.np != null) host = n
      if (!host) return null
      node = host
      offset = 0
    }
    const np = Number(host.dataset.np)
    if (np >= afterParas.length) {
      const last = Math.max(0, afterParas.length - 1)
      return { p: last, o: afterParas[last]?.length ?? 0 }
    }
    const text = afterParas[np]
    const r = document.createRange()
    r.setStart(host, 0)
    r.setEnd(node, offset)
    const within = r.toString().length
    if (host.dataset.o != null) return { p: np, o: host.dataset.k === 'del' ? 0 : Math.min(within, text.length) }
    const words = [...text.matchAll(/\S+/g)].map((m) => ({ s: m.index!, e: m.index! + m[0].length }))
    const nw = Number(host.dataset.nw)
    if (host.dataset.k === 'del') return { p: np, o: words[nw]?.s ?? text.length }
    const head = (host.textContent ?? '').slice(0, within) // (a run's words are joined with single spaces)
    const w = words[nw + (head.match(/ /g)?.length ?? 0)]
    return w ? { p: np, o: Math.min(w.s + within - (head.lastIndexOf(' ') + 1), w.e) } : { p: np, o: text.length }
  }

  let np = 0
  return (
    <div
      className={clsx(
        'absolute inset-0 select-text overflow-auto bg-white px-4 py-2 text-[13px] leading-relaxed text-ink outline-none',
        decision === 'accept' && 'border-l-4 border-emerald-500',
        decision === 'reject' && 'border-l-4 border-ink-3/40',
      )}
      data-notes-diff={decision ?? ''}
      tabIndex={onType ? 0 : undefined}
      // Read-only: clicking or selecting doesn't edit; typing does — "Edit + marks", at the caret.
      onKeyDown={onType ? (e) => {
        if (e.metaKey || e.ctrlKey || e.altKey) return
        if (e.key.length !== 1 && !['Enter', 'Backspace', 'Delete'].includes(e.key)) return
        e.preventDefault()
        e.stopPropagation()
        onType(caretAt(), e.key)
      } : undefined}
      title={onType ? 'Read-only — start typing to edit here with the changes marked (or pick Edit + marks / Edit)' : undefined}
    >
      {decision && (
        <div className={clsx('mb-1 text-[11px] font-medium', decision === 'accept' ? 'text-emerald-700' : 'text-ink-3')}>
          {decision === 'accept' ? '✓ Accepted — the new notes' : '↺ Not accepted — the notes stay as they were'}
        </div>
      )}
      {paras.map((p, i) => {
        const at = p.k === 'del' ? np : np++
        // A whole paragraph removed or added: dropped when the decision leaves it out.
        if ((decision === 'accept' && p.k === 'del') || (decision === 'reject' && p.k === 'add')) return null
        const whole = decision === 'accept' ? ADD : decision === 'reject' ? RESTORED : p.k === 'del' ? 'text-red-600 line-through decoration-red-500/80' : 'bg-emerald-50 text-emerald-800'
        return (
          <p key={i} className="min-h-[1.2em] whitespace-pre-wrap break-words">
            {p.k === 'edit' ? runs(p.ops, at)
              : p.k === 'same' ? <span data-np={at} data-o={0}>{p.ops.map((o) => o.t).join(' ')}</span>
                : <span data-np={at} data-o={0} data-k={p.k} className={whole}>{p.ops.map((o) => o.t).join(' ')}</span>}
          </p>
        )
      })}
    </div>
  )
}
