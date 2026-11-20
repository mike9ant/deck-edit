/**
 * Read-only spreadsheet preview (.xlsx / .xlsm), via ExcelJS (loaded only when
 * a spreadsheet opens): sheet tabs, column widths and row heights, merged
 * cells, basic styling (bold/italic/underline, font and fill colors,
 * alignment, wrapping) and values shown the way Excel formats them
 * (sheetFormat.ts). Only the visible cells are drawn, so big sheets scroll
 * smoothly. Clicking a cell shows its address and formula/value above the grid
 * and tells the agent where you are. Reloads when the file changes on disk.
 * Not shown: charts, images, pivot tables, conditional formatting.
 *
 * Notes for the agent work here as on slides — pin a point or draw a mark —
 * anchored to cells (stored in cell units: column/row + the fraction into the
 * cell), so they stay with the content; the agent gets the cell(s) and what
 * they contain.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { ExternalLink, Eye, EyeOff, Loader2 } from 'lucide-react'
import clsx from 'clsx'
import { api } from '../api/client'
import { useFileVersion } from '../store/fileVersions'
import { colName, parseRange, showCell, type Shown } from './sheetFormat'
import type { Note, Stroke } from '../api/types'
import { NotePins, actNowPrompt, type NoteDraft } from '../notes/NotePins'
import { DrawLayer, NoteToolButton, SelectToolButton, pinFor, strokesBox, useEscapeEndsNoteMode } from '../notes/NoteDrawing'
import { notesForSlide, useNotes } from '../store/notesStore'
import { sendToAgent } from '../chat/sendToAgent'
import { useReveal } from '../store/revealStore'

/** A lazily loaded chunk that no longer exists (Chrome / Safari / Firefox wording). */
const STALE_BUILD = /dynamically imported module|Importing a module script failed|error loading dynamically imported/i

interface CellView extends Shown {
  style?: React.CSSProperties
  raw?: string
}
interface SheetModel {
  name: string
  hidden: boolean
  cells: Map<string, CellView>
  colW: number[] // px, index = column (1-based; [0] unused)
  rowH: number[] // px, index = row
  maxRow: number
  maxCol: number
  merges: { r1: number; c1: number; r2: number; c2: number }[]
}

const HDR_W = 44
const HDR_H = 22
const DEFAULT_COL_PX = 72
const DEFAULT_ROW_PX = 21
const key = (r: number, c: number) => `${r}:${c}`

/** ARGB "FF1F4E79" → "#1F4E79" (theme/indexed colors aren't resolved: left default). */
const argb = (c?: { argb?: string }) => (c?.argb && c.argb.length >= 6 ? `#${c.argb.slice(-6)}` : undefined)

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toModel(ws: any): SheetModel {
  const cells = new Map<string, CellView>()
  let maxRow = 0
  let maxCol = 0
  const rowH: number[] = []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ws.eachRow({ includeEmpty: false }, (row: any, r: number) => {
    rowH[r] = row.hidden ? 0 : row.height ? Math.round(row.height * (4 / 3)) : DEFAULT_ROW_PX
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    row.eachCell({ includeEmpty: false }, (cell: any, c: number) => {
      const shown = showCell(cell.value, cell.numFmt)
      const f = cell.font ?? {}
      const fill = cell.fill?.type === 'pattern' && cell.fill.pattern === 'solid' ? argb(cell.fill.fgColor) : undefined
      const align = cell.alignment ?? {}
      const style: React.CSSProperties = {}
      if (f.bold) style.fontWeight = 600
      if (f.italic) style.fontStyle = 'italic'
      if (f.underline || f.strike) style.textDecoration = [f.underline && 'underline', f.strike && 'line-through'].filter(Boolean).join(' ')
      if (argb(f.color)) style.color = argb(f.color)
      if (f.size && f.size !== 11) style.fontSize = `${Math.round(f.size * (4 / 3) * 0.82)}px`
      if (fill) style.background = fill
      if (align.horizontal && ['left', 'center', 'right'].includes(align.horizontal)) style.textAlign = align.horizontal
      if (align.wrapText) style.whiteSpace = 'normal'
      const raw = shown.formula ? `=${shown.formula}` : cell.value instanceof Date ? cell.value.toISOString().slice(0, 10) : typeof cell.value === 'object' && cell.value ? shown.text : cell.value == null ? '' : String(cell.value)
      if (shown.kind !== 'empty' || Object.keys(style).length) cells.set(key(r, c), { ...shown, style, raw })
      maxRow = Math.max(maxRow, r)
      maxCol = Math.max(maxCol, c)
    })
  })
  const colW: number[] = []
  const cols = ws.columns ?? []
  for (let c = 1; c <= Math.max(maxCol, cols.length); c++) {
    const col = cols[c - 1]
    colW[c] = col?.hidden ? 0 : col?.width ? Math.round(col.width * 7 + 5) : DEFAULT_COL_PX
  }
  const mergeRefs: string[] = ws.model?.merges ?? []
  const merges = mergeRefs.map(parseRange).filter((m): m is NonNullable<typeof m> => !!m)
  for (const m of merges) { maxRow = Math.max(maxRow, m.r2); maxCol = Math.max(maxCol, m.c2) }
  return { name: ws.name, hidden: ws.state && ws.state !== 'visible', cells, colW, rowH, maxRow, maxCol, merges }
}

export function SheetView({ pid, path }: { pid: string; path: string }) {
  const version = useFileVersion(pid, path)
  const [sheets, setSheets] = useState<SheetModel[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [active, setActive] = useState<string | null>(null)
  const [sel, setSel] = useState<{ r: number; c: number } | null>(null)
  const [noteMode, setNoteMode] = useState(false)
  const [showResolved, setShowResolved] = useState(false)
  useEscapeEndsNoteMode(noteMode, setNoteMode)
  const allNotes = useNotes((s) => s.notes)

  useEffect(() => {
    let live = true
    void (async () => {
      try {
        const [{ bytes }, ExcelJS] = await Promise.all([api.readFile(pid, path), import('exceljs')])
        const wb = new ExcelJS.Workbook()
        await wb.xlsx.load(bytes)
        const models = wb.worksheets.map(toModel)
        if (!live) return
        setSheets(models)
        setError(null)
        setActive((a) => (a && models.some((m) => m.name === a) ? a : (models.find((m) => !m.hidden) ?? models[0])?.name ?? null))
      } catch (e) {
        if (live) setError((e as Error).message || String(e))
      }
    })()
    return () => {
      live = false
    }
  }, [pid, path, version])

  const sheet = sheets?.find((s) => s.name === active) ?? null

  // A chat link to a sheet / cell of this file: switch to the sheet, select the cell and scroll to it.
  const pendingReveal = useReveal((s) => s.pending)
  const [jump, setJump] = useState(0)
  useEffect(() => {
    if (!sheets || pendingReveal?.path !== path) return
    const loc = useReveal.getState().take(path)
    if (!loc) return
    const want = loc.sheet && sheets.find((m) => m.name.toLowerCase() === loc.sheet!.toLowerCase())
    if (want) setActive(want.name)
    const cell = loc.cell ? parseRange(loc.cell) : null
    setSel(cell ? { r: cell.r1, c: cell.c1 } : null)
    if (cell) setJump((n) => n + 1)
  }, [pendingReveal, sheets, path])

  // Tell the agent which sheet/cell is in view.
  useEffect(() => {
    if (!sheet) return
    const t = setTimeout(() => {
      api.putView(pid, { file: path, sheet: sheet.name, cell: sel ? `${colName(sel.c)}${sel.r}` : undefined }).catch(() => {})
    }, 300)
    return () => clearTimeout(t)
  }, [pid, path, sheet, sel])

  if (error && STALE_BUILD.test(error)) {
    // This page predates a rebuild of the app, and the spreadsheet reader's chunk is gone.
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-sm text-ink-3">
        <div>The app was updated since this page loaded — reload to open spreadsheets.</div>
        <button className="btn-primary" onClick={() => window.location.reload()}>Reload</button>
      </div>
    )
  }
  if (error) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-sm text-ink-3">
        <div className="text-red-700">Couldn’t read this spreadsheet: {error}</div>
        <button className="btn-ghost border border-hair" onClick={() => void api.openExternal(pid, path)}><ExternalLink size={14} /> Open with the default app</button>
      </div>
    )
  }
  if (!sheets) return <div className="flex flex-1 items-center justify-center text-ink-3"><Loader2 className="animate-spin" size={18} /></div>

  const selCell = sel && sheet ? sheet.cells.get(key(sel.r, sel.c)) : undefined
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-white">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-hair bg-panel px-3 text-xs">
        <span className="w-14 shrink-0 rounded border border-hair bg-white px-1.5 py-0.5 text-center font-mono text-ink-2">{sel ? `${colName(sel.c)}${sel.r}` : '—'}</span>
        <span className={clsx('min-w-0 flex-1 truncate font-mono', selCell?.kind === 'formula' ? 'text-ink-3 italic' : 'text-ink')}>{selCell?.raw ?? ''}</span>
        <SelectToolButton active={!noteMode} onSelect={() => setNoteMode(false)} />
        <NoteToolButton active={noteMode} onToggle={() => setNoteMode(!noteMode)} />
        <button className="icon-btn" onClick={() => setShowResolved(!showResolved)} title={showResolved ? 'Hide resolved notes' : 'Show resolved notes'}>{showResolved ? <Eye size={15} /> : <EyeOff size={15} />}</button>
        <div className="h-5 w-px bg-hair" />
        <span className="shrink-0 text-ink-3">read-only preview</span>
        <button className="tool-btn" title="Open in Excel / Numbers" onClick={() => void api.openExternal(pid, path)}><ExternalLink size={14} /> Open</button>
      </div>
      {sheet ? (
        <Grid
          key={sheet.name}
          sheet={sheet}
          sel={sel}
          jump={jump}
          onSelect={setSel}
          notes={notesForSlide(allNotes, path, sheet.name, sheets.indexOf(sheet) + 1)}
          showResolved={showResolved}
          noteMode={noteMode}
          onPinned={async (n, actNow) => {
            const note = await useNotes.getState().add({ deck: path, slideId: sheet.name, slideIndex: sheets.indexOf(sheet) + 1, ...n })
            setNoteMode(false)
            if (actNow && note) await sendToAgent(actNowPrompt(note, 'sheet'))
          }}
        />
      ) : <div className="flex-1" />}
      <div className="flex h-8 shrink-0 items-center gap-0.5 overflow-x-auto border-t border-hair bg-paper px-1">
        {sheets.map((s) => (
          <button
            key={s.name}
            className={clsx('h-6 shrink-0 rounded px-2.5 text-xs', s.name === active ? 'bg-white font-medium text-ink shadow-sm ring-1 ring-hair' : 'text-ink-3 hover:bg-black/5', s.hidden && 'italic opacity-60')}
            title={s.hidden ? `${s.name} (hidden sheet)` : s.name}
            onClick={() => { setActive(s.name); setSel(null) }}
          >
            {s.name}
          </button>
        ))}
      </div>
    </div>
  )
}

/** Offsets of each row/column (prefix sums), with some empty rows/columns past the data. */
function offsets(sizes: number[], count: number, dflt: number): number[] {
  const out = [0, 0]
  for (let i = 1; i <= count; i++) out[i + 1] = out[i] + (sizes[i] ?? dflt)
  return out
}
/** First index i (1-based) whose span ends after `pos`. */
function firstAfter(off: number[], pos: number): number {
  let lo = 1, hi = off.length - 2
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (off[mid + 1] <= pos) lo = mid + 1
    else hi = mid
  }
  return lo
}

type NewSheetNote = { x: number; y: number; shapeName?: string; strokes?: Stroke[]; shapes?: string[]; text: string }

function Grid({ sheet, sel, jump, onSelect, notes, showResolved, noteMode, onPinned }: {
  sheet: SheetModel
  sel: { r: number; c: number } | null
  /** Bumped to scroll the selected cell into the middle of the view. */
  jump: number
  onSelect(s: { r: number; c: number }): void
  notes: Note[]
  showResolved: boolean
  noteMode: boolean
  onPinned(n: NewSheetNote, actNow: boolean): Promise<void>
}) {
  const noteTool = useNotes((s) => s.tool)
  const [draft, setDraft] = useState<NoteDraft | null>(null)
  useEffect(() => setDraft(null), [noteMode, noteTool])
  const scroller = useRef<HTMLDivElement>(null)
  const [view, setView] = useState({ top: 0, left: 0, w: 800, h: 600 })
  const rows = Math.max(sheet.maxRow + 30, 60)
  const cols = Math.max(sheet.maxCol + 6, 16)
  const rowOff = useMemo(() => offsets(sheet.rowH, rows, DEFAULT_ROW_PX), [sheet, rows])
  const colOff = useMemo(() => offsets(sheet.colW, cols, DEFAULT_COL_PX), [sheet, cols])
  const { covered, mergeStart } = useMemo(() => {
    const covered = new Set<string>()
    const mergeStart = new Map<string, (typeof sheet.merges)[number]>()
    for (const m of sheet.merges) {
      mergeStart.set(key(m.r1, m.c1), m)
      for (let r = m.r1; r <= m.r2; r++) for (let c = m.c1; c <= m.c2; c++) if (r !== m.r1 || c !== m.c1) covered.add(key(r, c))
    }
    return { covered, mergeStart }
  }, [sheet])

  useEffect(() => {
    const el = scroller.current!
    const ro = new ResizeObserver(() => setView((v) => ({ ...v, w: el.clientWidth, h: el.clientHeight })))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    const el = scroller.current
    if (!jump || !sel || !el) return
    const top = rowOff[Math.min(sel.r, rows)] ?? 0
    const left = colOff[Math.min(sel.c, cols)] ?? 0
    el.scrollTo({ top: Math.max(0, top - el.clientHeight / 2 + HDR_H), left: Math.max(0, left - el.clientWidth / 3 + HDR_W) })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jump])

  const r0 = firstAfter(rowOff, view.top), r1 = Math.min(rows, firstAfter(rowOff, view.top + view.h) + 1)
  const c0 = firstAfter(colOff, view.left), c1 = Math.min(cols, firstAfter(colOff, view.left + view.w) + 1)

  const cellBox = (r: number, c: number, r2 = r, c2 = c) => ({ left: colOff[c], top: rowOff[r], width: colOff[c2 + 1] - colOff[c], height: rowOff[r2 + 1] - rowOff[r] })
  const cellEl = (r: number, c: number, span?: { r2: number; c2: number }) => {
    const v = sheet.cells.get(key(r, c))
    const box = cellBox(r, c, span?.r2, span?.c2)
    if (!box.width || !box.height) return null
    const numeric = v && (v.kind === 'number' || v.kind === 'date')
    return (
      <div
        key={key(r, c)}
        className={clsx('absolute overflow-hidden whitespace-nowrap border-b border-r border-stone-200 px-1 text-[12px] leading-[20px] text-ink', v?.kind === 'formula' && 'italic text-ink-3', v?.kind === 'error' && 'text-red-700', span && 'bg-white')}
        style={{ ...box, textAlign: numeric ? 'right' : undefined, ...(span ? { display: 'flex', alignItems: 'center' } : {}), ...v?.style }}
        onMouseDown={() => { if (!noteMode) onSelect({ r, c }) }}
      >
        {span ? <span className="w-full" style={{ textAlign: v?.style?.textAlign }}>{v?.text}</span> : v?.text}
      </div>
    )
  }

  // ── notes: cell units (column/row + fraction into the cell) ⇄ pixels in the grid ──
  const totalW = colOff[cols + 1], totalH = rowOff[rows + 1]
  const toUnit = (off: number[], n: number, px: number) => {
    const i = Math.min(n, firstAfter(off, px))
    const size = off[i + 1] - off[i] || 1
    return i + Math.max(0, Math.min(0.999, (px - off[i]) / size))
  }
  const fromUnit = (off: number[], n: number, u: number) => {
    const i = Math.max(1, Math.min(n, Math.floor(u)))
    return off[i] + (u - i) * (off[i + 1] - off[i])
  }
  const unitX = (f: number) => toUnit(colOff, cols, f * totalW), unitY = (f: number) => toUnit(rowOff, rows, f * totalH)
  const shownNotes = notes.map((n) => ({
    ...n,
    x: fromUnit(colOff, cols, n.x) / totalW,
    y: fromUnit(rowOff, rows, n.y) / totalH,
    strokes: n.strokes?.map((st) => st.map(([x, y]) => [fromUnit(colOff, cols, x) / totalW, fromUnit(rowOff, rows, y) / totalH] as [number, number])),
  }))
  const cellLabel = (r: number, c: number) => {
    const v = sheet.cells.get(key(r, c))?.text
    return v ? `${colName(c)}${r} = "${v.length > 40 ? `${v.slice(0, 39)}…` : v}"` : `${colName(c)}${r}`
  }
  /** The non-empty cells a mark covers (first few), for the agent. */
  const coveredCells = (strokes: Stroke[]) => {
    const b = strokesBox(strokes)
    const ra = Math.floor(unitY(b.y1)), rb = Math.floor(unitY(b.y2)), ca = Math.floor(unitX(b.x1)), cb = Math.floor(unitX(b.x2))
    const out: string[] = []
    for (let r = ra; r <= rb && out.length < 8; r++) for (let c = ca; c <= cb && out.length < 8; c++) {
      const v = sheet.cells.get(key(r, c))?.text
      if (v) out.push(`${colName(c)}${r} "${v.length > 30 ? `${v.slice(0, 29)}…` : v}"`)
    }
    return out
  }
  const addStroke = (st: Stroke) => {
    const strokes = [...(draft?.strokes ?? []), st]
    setDraft({ ...pinFor(strokes), strokes, shapes: coveredCells(strokes) })
  }
  const pinAt = (e: React.MouseEvent) => {
    const box = e.currentTarget.getBoundingClientRect()
    const px = e.clientX - box.left, py = e.clientY - box.top
    setDraft({ x: px / totalW, y: py / totalH, shapeName: cellLabel(Math.floor(toUnit(rowOff, rows, py)), Math.floor(toUnit(colOff, cols, px))) })
  }
  const saveDraft = async (text: string, actNow: boolean) => {
    if (!draft) return
    const d = draft
    setDraft(null)
    await onPinned({
      x: unitX(d.x), y: unitY(d.y), shapeName: d.shapeName, shapes: d.shapes, text,
      strokes: d.strokes?.map((st) => st.map(([x, y]) => [unitX(x), unitY(y)] as [number, number])),
    }, actNow)
  }

  const items: React.ReactNode[] = []
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
    const k = key(r, c)
    if (covered.has(k) || mergeStart.has(k)) continue
    items.push(cellEl(r, c))
  }
  for (const m of sheet.merges) if (m.r2 >= r0 && m.r1 <= r1 && m.c2 >= c0 && m.c1 <= c1) items.push(cellEl(m.r1, m.c1, m))

  const selBox = sel && (() => { const m = mergeStart.get(key(sel.r, sel.c)); return cellBox(sel.r, sel.c, m?.r2, m?.c2) })()
  return (
    <div className="relative min-h-0 flex-1 overflow-hidden">
      <div
        ref={scroller}
        className="absolute overflow-auto"
        style={{ left: HDR_W, top: HDR_H, right: 0, bottom: 0 }}
        onScroll={(e) => {
          // Read now: React clears the event's target before a state updater runs.
          const { scrollTop: top, scrollLeft: left } = e.currentTarget
          setView((v) => ({ ...v, top, left }))
        }}
      >
        <div
          className={clsx('relative', noteMode && noteTool === 'pin' && 'cursor-crosshair')}
          style={{ width: colOff[cols + 1], height: rowOff[rows + 1] }}
          onMouseDown={(e) => {
            if (!noteMode || noteTool !== 'pin' || e.button !== 0 || (e.target as HTMLElement).closest('[data-note-popover]')) return
            e.preventDefault() // no default focus change: the note box that opens takes the typing
            pinAt(e)
          }}
        >
          {items}
          {noteMode && noteTool === 'draw' && <DrawLayer width={totalW} height={totalH} onStroke={addStroke} onTap={(p) => setDraft((d) => (d?.strokes?.length ? d : { x: p.x, y: p.y, shapeName: cellLabel(Math.floor(unitY(p.y)), Math.floor(unitX(p.x))) }))} />}
          <NotePins notes={shownNotes} width={totalW} height={totalH} showResolved={showResolved} draft={draft} onSaveDraft={saveDraft} onCancelDraft={() => setDraft(null)} />
          {selBox && <div className="pointer-events-none absolute border-2 border-emerald-600" style={{ ...selBox, left: selBox.left - 1, top: selBox.top - 1, width: selBox.width + 1, height: selBox.height + 1 }} />}
        </div>
      </div>
      {/* column letters */}
      <div className="absolute right-0 top-0 overflow-hidden border-b border-stone-300 bg-stone-50" style={{ left: HDR_W, height: HDR_H }}>
        <div className="relative h-full" style={{ transform: `translateX(${-view.left}px)` }}>
          {Array.from({ length: c1 - c0 + 1 }, (_, i) => c0 + i).map((c) => (
            <div key={c} className={clsx('absolute top-0 border-r border-stone-200 text-center text-[11px] leading-[22px] text-ink-3', sel?.c === c && 'bg-emerald-100 font-medium text-emerald-800')} style={{ left: colOff[c], width: colOff[c + 1] - colOff[c], height: HDR_H }}>
              {colOff[c + 1] - colOff[c] > 0 ? colName(c) : ''}
            </div>
          ))}
        </div>
      </div>
      {/* row numbers */}
      <div className="absolute bottom-0 left-0 overflow-hidden border-r border-stone-300 bg-stone-50" style={{ top: HDR_H, width: HDR_W }}>
        <div className="relative w-full" style={{ transform: `translateY(${-view.top}px)` }}>
          {Array.from({ length: r1 - r0 + 1 }, (_, i) => r0 + i).map((r) => (
            <div key={r} className={clsx('absolute left-0 w-full border-b border-stone-200 pr-1.5 text-right text-[11px] text-ink-3', sel?.r === r && 'bg-emerald-100 font-medium text-emerald-800')} style={{ top: rowOff[r], height: rowOff[r + 1] - rowOff[r], lineHeight: `${rowOff[r + 1] - rowOff[r]}px` }}>
              {rowOff[r + 1] - rowOff[r] > 0 ? r : ''}
            </div>
          ))}
        </div>
      </div>
      <div className="absolute left-0 top-0 border-b border-r border-stone-300 bg-stone-100" style={{ width: HDR_W, height: HDR_H }} />
    </div>
  )
}
