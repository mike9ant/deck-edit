/**
 * A PDF document: page rail + main page with notes, limited editing
 * (drag to reorder pages, duplicate, delete, drop an image onto a page).
 *
 * The page's text is selectable (pdf.js text layer) — to copy it, or to put
 * a note for the agent on it; notes can also be pinned at a point or drawn.
 * The text of open notes is highlighted.
 */

import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { TextLayer, type PDFDocumentProxy } from 'pdfjs-dist'
import { degrees } from 'pdf-lib'
import { BotMessageSquare, Copy, CopyPlus, ExternalLink, Eye, EyeOff, Loader2, Redo2, Trash2, Undo2 } from 'lucide-react'
import clsx from 'clsx'
import { usePdfs, pdfKey, type PdfSession } from './pdfStore'
import { Splitter } from '../components/Splitter'
import { NotePins, actNowPrompt, type NoteDraft } from '../notes/NotePins'
import { sendToAgent } from '../chat/sendToAgent'
import { DrawLayer, NoteToolButton, SelectToolButton, pinFor, useEscapeEndsNoteMode } from '../notes/NoteDrawing'
import { notesForSlide, useNotes } from '../store/notesStore'
import { useApp } from '../store/appStore'
import { useChat } from '../store/chatStore'
import { api } from '../api/client'
import { prepareImage } from '../deck/images'
import { useInnerWidth } from '../components/useInnerWidth'
import { domRangeOf } from '../viewers/textRanges'

/** Render one page into a canvas at a CSS width. */
export const PageCanvas = memo(function PageCanvas({ doc, index, width, version }: { doc: PDFDocumentProxy; index: number; width: number; version: number }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const [aspect, setAspect] = useState(0.5625)
  useEffect(() => {
    let cancelled = false
    let task: { cancel(): void; promise: Promise<void> } | null = null
    void (async () => {
      const page = await doc.getPage(index + 1)
      if (cancelled) return
      const vp1 = page.getViewport({ scale: 1 })
      setAspect(vp1.height / vp1.width)
      const dpr = window.devicePixelRatio || 1
      const vp = page.getViewport({ scale: (width / vp1.width) * dpr })
      const canvas = ref.current
      if (!canvas) return
      canvas.width = Math.ceil(vp.width)
      canvas.height = Math.ceil(vp.height)
      task = page.render({ canvasContext: canvas.getContext('2d')!, viewport: vp })
      await task.promise.catch(() => {})
    })()
    return () => {
      cancelled = true
      task?.cancel()
    }
  }, [doc, index, width, version])
  return <canvas ref={ref} style={{ width, height: width * aspect, display: 'block', background: '#fff' }} />
})

/** The page's text as an invisible, selectable layer over the canvas (pdf.js TextLayer). */
const PageText = memo(function PageText({ doc, index, width, version, onReady }: { doc: PDFDocumentProxy; index: number; width: number; version: number; onReady(el: HTMLElement): void }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    let layer: TextLayer | null = null
    let cancelled = false
    void (async () => {
      const page = await doc.getPage(index + 1)
      if (cancelled) return
      const vp1 = page.getViewport({ scale: 1 })
      const viewport = page.getViewport({ scale: width / vp1.width })
      el.replaceChildren()
      el.style.setProperty('--scale-factor', String(viewport.scale))
      layer = new TextLayer({ textContentSource: await page.getTextContent(), container: el, viewport })
      await layer.render().catch(() => {})
      if (!cancelled) onReady(el)
    })()
    return () => {
      cancelled = true
      layer?.cancel()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, index, width, version])
  return <div ref={ref} className="textLayer" />
})

export function PdfView({ pid, path }: { pid: string; path: string }) {
  const key = pdfKey(pid, path)
  const session = usePdfs((s) => s.sessions[key])
  const { open, undo, redo } = usePdfs()
  const railW = useApp((s) => s.widths.rail)
  const setWidth = useApp((s) => s.setWidth)
  const busy = useChat((s) => !!s.busyProjects[pid])
  const changed = useApp((s) => s.changed.includes(path))
  const [noteMode, setNoteMode] = useState(false)
  const [showResolved, setShowResolved] = useState(false)
  useEscapeEndsNoteMode(noteMode, setNoteMode)

  useEffect(() => {
    void open(pid, path)
  }, [pid, path, open])

  useEffect(() => {
    if (!session?.doc) return
    api.putView(pid, { deck: path, pageNumber: session.pageIndex + 1, pageCount: session.doc.numPages }).catch(() => {})
  }, [pid, path, session?.pageIndex, session?.doc])

  if (!session || (session.loading && !session.doc)) return <div className="flex flex-1 items-center justify-center text-ink-3"><Loader2 className="animate-spin" size={18} /></div>
  if (session.error && !session.doc) return <div className="p-6 text-sm text-red-700">{session.error}</div>

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'z') return
    if ((e.target as HTMLElement).tagName === 'TEXTAREA') return
    e.preventDefault()
    void (e.shiftKey ? redo(key) : undo(key))
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" onKeyDown={onKeyDown}>
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-hair bg-panel px-2">
        <button className="icon-btn" title="Undo (⌘Z)" disabled={!session.undo.length || busy} onClick={() => void undo(key)}><Undo2 size={16} /></button>
        <button className="icon-btn" title="Redo (⇧⌘Z)" disabled={!session.redo.length || busy} onClick={() => void redo(key)}><Redo2 size={16} /></button>
        <div className="mx-1 h-5 w-px bg-hair" />
        <SelectToolButton active={!noteMode} onSelect={() => setNoteMode(false)} />
        <div className="ml-2 text-xs text-ink-3">Page {session.pageIndex + 1} / {session.doc!.numPages} · drop an image on the page to place it</div>
        <div className="ml-auto flex items-center gap-2 text-xs text-ink-3">
          <NoteToolButton active={noteMode} onToggle={() => setNoteMode(!noteMode)} />
          <button className="icon-btn" onClick={() => setShowResolved(!showResolved)} title={showResolved ? 'Hide resolved notes' : 'Show resolved notes'}>{showResolved ? <Eye size={15} /> : <EyeOff size={15} />}</button>
          <div className="h-5 w-px bg-hair" />
          {session.saving ? 'Saving…' : changed ? 'Saved' : null}
          <button className="tool-btn" onClick={() => void api.openExternal(pid, path)}><ExternalLink size={14} /> Open</button>
        </div>
      </div>
      {busy && <div className="border-b border-violet-200 bg-violet-50 px-3 py-1.5 text-xs text-violet-900">The agent is working. Editing is paused, and its changes appear here as it saves.</div>}
      <div className="flex min-h-0 flex-1">
        <PageRail session={session} width={railW} busy={busy} />
        <Splitter width={railW} min={120} max={420} onChange={(w) => setWidth('rail', w)} />
        <PageStage session={session} noteMode={noteMode} setNoteMode={setNoteMode} showResolved={showResolved} busy={busy} />
      </div>
    </div>
  )
}

function PageRail({ session, width, busy }: { session: PdfSession; width: number; busy: boolean }) {
  const { setPage, edit } = usePdfs()
  const [dragFrom, setDragFrom] = useState<number | null>(null)
  const [dragOver, setDragOver] = useState<number | null>(null)
  const notes = useNotes((s) => s.notes)
  const n = session.doc!.numPages
  const listRef = useRef<HTMLDivElement>(null)
  const thumbW = Math.max(60, Math.floor(useInnerWidth(listRef, width - 16) - 32))
  const move = async (from: number, to: number) => {
    const dest = from < to ? to - 1 : to
    if (dest === from) return
    await edit(session.key, `Moved page ${from + 1} to position ${dest + 1}`, async (doc) => {
      const [p] = await doc.copyPages(doc, [from])
      doc.removePage(from)
      doc.insertPage(dest, p)
    })
    setPage(session.key, dest)
  }
  return (
    <div className="flex h-full flex-col bg-paper" style={{ width }}>
      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto p-2 [scrollbar-gutter:stable]">
        {Array.from({ length: n }, (_, i) => {
          const open = notes.filter((x) => x.deck === session.path && x.status === 'open' && x.slideIndex === i + 1).length
          return (
            <div key={i}>
              <div className={clsx('mx-1 h-1 rounded', dragOver === i && 'bg-accent')} />
              <div
                className="flex cursor-pointer items-start gap-1.5 py-0.5"
                draggable={!busy}
                onDragStart={() => setDragFrom(i)}
                onDragOver={(e) => { if (dragFrom === null) return; e.preventDefault(); const r = e.currentTarget.getBoundingClientRect(); setDragOver(e.clientY < r.top + r.height / 2 ? i : i + 1) }}
                onDrop={(e) => { e.preventDefault(); if (dragFrom !== null && dragOver !== null) void move(dragFrom, dragOver); setDragFrom(null); setDragOver(null) }}
                onDragEnd={() => { setDragFrom(null); setDragOver(null) }}
                onClick={() => setPage(session.key, i)}
              >
                <div className="w-5 shrink-0 pt-0.5 text-right text-[11px] text-ink-3">{i + 1}</div>
                <div className={clsx('relative overflow-hidden rounded-[3px]', i === session.pageIndex ? 'ring-2 ring-accent' : 'ring-1 ring-hair')}>
                  <PageCanvas doc={session.doc!} index={i} width={thumbW} version={session.version} />
                  {open > 0 && <div className="absolute right-1 top-1 rounded-full bg-note px-1.5 text-[10px] font-bold">{open}</div>}
                </div>
              </div>
            </div>
          )
        })}
      </div>
      <div className="flex justify-center gap-1 border-t border-hair py-1">
        <button className="icon-btn" disabled={busy} title="Duplicate page" onClick={() => {
          const i = session.pageIndex
          void edit(session.key, `Duplicated page ${i + 1}`, async (doc) => { const [p] = await doc.copyPages(doc, [i]); doc.insertPage(i + 1, p) })
        }}><CopyPlus size={15} /></button>
        <button className="icon-btn" disabled={busy || n <= 1} title="Delete page" onClick={() => {
          const i = session.pageIndex
          void edit(session.key, `Deleted page ${i + 1}`, (doc) => doc.removePage(i))
        }}><Trash2 size={15} /></button>
      </div>
    </div>
  )
}

function PageStage({ session, noteMode, setNoteMode, showResolved, busy }: { session: PdfSession; noteMode: boolean; setNoteMode(v: boolean): void; showResolved: boolean; busy: boolean }) {
  const { edit } = usePdfs()
  const wrap = useRef<HTMLDivElement>(null)
  const [box, setBox] = useState({ w: 800, h: 600 })
  const [aspect, setAspect] = useState(0.5625)
  const [draft, setDraft] = useState<NoteDraft | null>(null)
  const notes = useNotes((s) => s.notes)
  const noteTool = useNotes((s) => s.tool)
  const drawing = noteMode && noteTool === 'draw'
  useEffect(() => setDraft(null), [noteMode, noteTool, session.pageIndex])
  const stageRef = useRef<HTMLDivElement>(null)
  const textRef = useRef<HTMLElement | null>(null)
  const [textReady, setTextReady] = useState(0)
  /** A text selection on the page: the bar over it offers a note or copy. */
  const [pick, setPick] = useState<{ text: string; x: number; y: number; barX: number; barY: number } | null>(null)
  useEffect(() => {
    const update = () => {
      const sel = window.getSelection()
      const r = sel?.rangeCount ? sel.getRangeAt(0) : null
      const stage = stageRef.current
      if (!r || r.collapsed || !stage || !textRef.current?.contains(r.commonAncestorContainer)) return setPick(null)
      const text = sel!.toString().trim()
      if (!text) return setPick(null)
      const rect = r.getBoundingClientRect()
      const sr = stage.getBoundingClientRect()
      setPick({ text, x: (rect.left - sr.left) / sr.width, y: (rect.top - sr.top) / sr.height, barX: rect.left + rect.width / 2, barY: rect.top })
    }
    document.addEventListener('selectionchange', update)
    return () => document.removeEventListener('selectionchange', update)
  }, [])
  useLayoutEffect(() => {
    const el = wrap.current!
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  useEffect(() => {
    void session.doc!.getPage(session.pageIndex + 1).then((p) => {
      const v = p.getViewport({ scale: 1 })
      setAspect(v.height / v.width)
    })
  }, [session.doc, session.pageIndex])
  const w = Math.max(100, Math.min(box.w - 48, (box.h - 48) / aspect))
  const h = w * aspect
  const pageNo = session.pageIndex + 1

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault()
    if (busy) return
    const r = (e.currentTarget.querySelector('[data-page-stage]') as HTMLElement).getBoundingClientRect()
    const fx = (e.clientX - r.left) / r.width, fy = (e.clientY - r.top) / r.height
    let blob: Blob | null = null
    let name = 'image.png'
    const treePath = e.dataTransfer.getData('application/x-pdfedit-path')
    if (treePath) {
      blob = new Blob([(await api.readFile(session.pid, treePath)).bytes])
      name = treePath.split('/').pop()!
    } else {
      const f = [...e.dataTransfer.files].find((x) => x.type.startsWith('image/'))
      if (f) { blob = f; name = f.name }
    }
    if (!blob) return
    const img = await prepareImage(blob, name)
    const index = session.pageIndex
    await edit(session.key, `Page ${pageNo}: placed image "${img.name}"`, async (doc) => {
      const page = doc.getPage(index)
      const { width: pw, height: ph } = page.getSize()
      const embedded = img.contentType === 'image/jpeg' ? await doc.embedJpg(img.data) : await doc.embedPng(img.contentType === 'image/png' ? img.data : (await prepareImage(new Blob([img.data as BlobPart]), 'x.png')).data)
      const s = Math.min(1, (pw * 0.4) / img.width, (ph * 0.4) / img.height)
      const iw = img.width * s, ih = img.height * s
      page.drawImage(embedded, { x: fx * pw - iw / 2, y: ph - fy * ph - ih / 2, width: iw, height: ih, rotate: degrees(0) })
    })
  }

  // Highlight the text of open notes on this page.
  const pageNotes = notesForSlide(notes, session.path, '', pageNo)
  const quotesKey = JSON.stringify(pageNotes.filter((n) => n.quote && n.status === 'open').map((n) => n.quote))
  useEffect(() => {
    const reg = (globalThis as { CSS?: { highlights?: Map<string, unknown> } }).CSS?.highlights
    const H = (globalThis as { Highlight?: new (...r: Range[]) => unknown }).Highlight
    const el = textRef.current
    if (!reg || !H || !el) return
    const quotes = JSON.parse(quotesKey) as string[]
    reg.set('note-quote', new H(...quotes.map((q) => domRangeOf(el, q)).filter((r): r is Range => !!r)))
    return () => { reg.delete('note-quote') }
  }, [quotesKey, textReady])

  return (
    <div ref={wrap} className="flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-[#e9e8e4]" onDragOver={(e) => e.preventDefault()} onDrop={(e) => void onDrop(e)}>
      {pick && !noteMode && !draft && (
        <div
          className="fixed z-40 flex -translate-x-1/2 -translate-y-full gap-0.5 rounded-md border border-hair bg-white p-0.5 shadow-lg"
          style={{ left: pick.barX, top: pick.barY - 6 }}
          onMouseDown={(e) => e.preventDefault() /* keep the selection */}
        >
          <button className="tool-btn h-6" title="Add a note for the AI agent about this text" onClick={() => { setDraft({ x: pick.x, y: pick.y, quote: pick.text }); window.getSelection()?.removeAllRanges() }}>
            <BotMessageSquare size={13} /> Note for AI
          </button>
          <button className="tool-btn h-6" title="Copy the text (⌘C)" onClick={() => { void navigator.clipboard.writeText(pick.text); useApp.getState().toast('Copied the selected text.') }}>
            <Copy size={13} /> Copy
          </button>
        </div>
      )}
      <div
        ref={stageRef}
        data-page-stage
        className={clsx('relative shadow-lg', noteMode && 'cursor-crosshair')}
        style={{ width: w, height: h }}
        onPointerDown={(e) => {
          if (!noteMode) return
          e.preventDefault() // the note's text box keeps the focus
          const r = e.currentTarget.getBoundingClientRect()
          setDraft({ x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height })
        }}
      >
        <PageCanvas doc={session.doc!} index={session.pageIndex} width={w} version={session.version} />
        <PageText doc={session.doc!} index={session.pageIndex} width={w} version={session.version} onReady={(el) => { textRef.current = el; setTextReady((n) => n + 1) }} />
        {drawing && (
          <DrawLayer
            width={w}
            height={h}
            onStroke={(st) => setDraft((d) => {
              const strokes = [...(d?.strokes ?? []), st]
              return { ...pinFor(strokes), strokes }
            })}
            onTap={(p) => setDraft((d) => (d?.strokes?.length ? d : p))}
          />
        )}
        <NotePins
          notes={pageNotes}
          width={w}
          height={h}
          showResolved={showResolved}
          draft={draft}
          onCancelDraft={() => setDraft(null)}
          onSaveDraft={async (text, actNow) => {
            const note = await useNotes.getState().add({ deck: session.path, slideId: '', slideIndex: pageNo, x: draft!.x, y: draft!.y, strokes: draft!.strokes, quote: draft!.quote, text })
            setDraft(null)
            setNoteMode(false)
            if (actNow && note) await sendToAgent(actNowPrompt(note, 'page'))
          }}
        />
      </div>
    </div>
  )
}
