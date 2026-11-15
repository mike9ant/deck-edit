/**
 * Speaker notes under the slide: a collapsible, resizable, editable panel.
 * The notes show formatted (bold, colours, links, bullets…) and are edited in
 * place like slide text — ⌘B / ⌘I / ⌘U toggle formatting, and editing keeps
 * the formatting already there (see notesRich.ts). Typing saves into the
 * slide's notes page (debounced, and on blur) — an undoable deck edit the
 * agent is told about like any other. The panel's open state and height persist.
 */

import { useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, Loader2 } from 'lucide-react'
import type { SlideData } from '@diceui/pptx-core'
import { useDecks, type DeckSession } from './deckStore'
import { readNotesParagraphs, writeNotes } from './speakerNotes'
import { buildParagraphs, notesText, parseParagraphs, renderNotes, styleRange, type StyleProp, type StyledParagraph } from './notesRich'
import { domPointAt, paragraphsText, readParagraphs, readParagraphsAt, watchBullets } from './textEdit'
import { short } from './deckModel'

const LS_OPEN = 'pdfedit-notes-open'
const LS_HEIGHT = 'pdfedit-notes-height'
const SAVE_MS = 900
const STYLE_KEYS: Record<string, StyleProp> = { b: 'b', i: 'i', u: 'u' }

export function NotesPane({ session }: { session: DeckSession }) {
  const pres = session.pres!
  const slide: SlideData | undefined = pres.slides[session.slideIndex]
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

  const render = () => {
    const el = editor.current
    if (!el) return
    renderNotes(el, base.current)
    watchBullets(el)
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
    document.execCommand('insertText', false, e.clipboardData.getData('text/plain'))
  }

  const toggle = () => {
    setOpen(!open)
    localStorage.setItem(LS_OPEN, open ? '0' : '1')
  }

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
    <div className="shrink-0 border-t border-hair bg-panel">
      {open && <div className="h-1 cursor-row-resize hover:bg-accent/20" onPointerDown={startResize} title="Drag to resize" />}
      <button className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-xs text-ink-2 hover:bg-paper" onClick={toggle}>
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <span className="font-medium">Speaker notes</span>
        <span className="text-ink-3">· slide {slideNo}</span>
        {!open && <span className="ml-2 truncate text-ink-3">{preview}</span>}
        {saving && <Loader2 size={12} className="ml-auto animate-spin text-ink-3" />}
      </button>
      {open && (
        <div className="relative bg-white" style={{ height }}>
          {!text.trim() && <div className="pointer-events-none absolute left-4 top-2 text-[13px] text-ink-3">Click to add speaker notes</div>}
          <div
            ref={editor}
            data-notes-editor=""
            className="h-full overflow-auto whitespace-pre-wrap break-words px-4 py-2 text-[13px] leading-relaxed text-ink outline-none"
            contentEditable={!!slide}
            suppressContentEditableWarning
            spellCheck={false}
            title="Speaker notes — ⌘B / ⌘I / ⌘U for bold, italic, underline"
            onInput={onInput}
            onBlur={() => void save()}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
          />
        </div>
      )}
    </div>
  )
}
