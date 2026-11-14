/**
 * Freehand notes: instead of pinning a note at a point, the user circles or
 * marks an area of the slide (several strokes allowed). The strokes are kept
 * as slide fractions, drawn over the slide, and sent to the agent with the
 * area they cover (see backend notes.rs `describe_place`).
 *
 * - `NoteToolButton` — the toolbar's "Note" split button: toggles note mode,
 *   and its ▾ menu picks Pin or Draw (remembered).
 * - `SelectToolButton` — the pointer tool: back to selecting shapes (as does Esc,
 *   see `useEscapeEndsNoteMode`).
 * - `DrawLayer` — captures strokes over the stage while drawing.
 * - `StrokesSvg` — renders strokes at any size.
 */

import { useEffect, useRef, useState } from 'react'
import { Check, ChevronDown, MapPin, MessageSquarePlus, MousePointer2, PenLine } from 'lucide-react'
import clsx from 'clsx'
import type { Stroke } from '../api/types'
import { useNotes, type NoteTool } from '../store/notesStore'

export type Box = { x1: number; y1: number; x2: number; y2: number }

const TOOLS: { id: NoteTool; label: string; hint: string; icon: typeof MapPin }[] = [
  { id: 'pin', label: 'Pin at a point', hint: 'Click where the note goes', icon: MapPin },
  { id: 'draw', label: 'Draw on the slide', hint: 'Circle or mark an area — the agent focuses there', icon: PenLine },
]

export function NoteToolButton({ active, onToggle }: { active: boolean; onToggle(): void }) {
  const tool = useNotes((s) => s.tool)
  const setTool = useNotes((s) => s.setTool)
  const [menu, setMenu] = useState(false)
  const Icon = tool === 'draw' ? PenLine : MessageSquarePlus
  return (
    <div className="relative flex items-center">
      <button
        className={clsx('tool-btn rounded-r-none pr-1.5', active && 'bg-amber-100 text-amber-900')}
        onClick={onToggle}
        title={tool === 'draw' ? 'Draw a note for the agent: circle or mark an area of the slide' : 'Pin a note for the agent (click on the slide)'}
      >
        <Icon size={15} /> {tool === 'draw' ? 'Draw note' : 'Note'}
      </button>
      <button
        className={clsx('tool-btn rounded-l-none px-1', active && 'bg-amber-100 text-amber-900')}
        title="Pin or draw"
        onClick={() => setMenu(!menu)}
      >
        <ChevronDown size={13} />
      </button>
      {menu && (
        <>
          <div className="fixed inset-0 z-40" onMouseDown={() => setMenu(false)} />
          <div className="absolute right-0 top-8 z-50 w-64 rounded-lg border border-hair bg-white p-1 shadow-xl">
            {TOOLS.map((t) => (
              <button
                key={t.id}
                className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-paper"
                onClick={() => {
                  setTool(t.id)
                  setMenu(false)
                  if (!active) onToggle()
                }}
              >
                <t.icon size={15} className="mt-0.5 shrink-0 text-ink-2" />
                <span className="min-w-0 flex-1">
                  <span className="block text-xs font-medium text-ink">{t.label}</span>
                  <span className="block text-[11px] text-ink-3">{t.hint}</span>
                </span>
                {tool === t.id && <Check size={14} className="mt-0.5 text-accent" />}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

/** The pointer tool — highlighted while selecting shapes; clicking it leaves note mode. */
export function SelectToolButton({ active, onSelect }: { active: boolean; onSelect(): void }) {
  return (
    <button
      className={clsx('tool-btn', active && 'bg-accent-soft text-accent')}
      onClick={onSelect}
      title="Select (Esc) — click shapes to select, move and edit them"
    >
      <MousePointer2 size={15} /> Select
    </button>
  )
}

/** Esc leaves note mode, wherever the focus is (drawing keeps it off the slide). */
export function useEscapeEndsNoteMode(noteMode: boolean, setNoteMode: (v: boolean) => void) {
  useEffect(() => {
    if (!noteMode) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.isContentEditable)) return // a note being typed handles its own Esc
      setNoteMode(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [noteMode, setNoteMode])
}

/** Captures strokes (as stage fractions) while the user draws. A tap is reported as a point. */
export function DrawLayer({ width, height, onStroke, onTap }: {
  width: number
  height: number
  onStroke(s: Stroke): void
  onTap(p: { x: number; y: number }): void
}) {
  const [live, setLive] = useState<Stroke | null>(null)
  const pts = useRef<Stroke>([])
  const frac = (e: React.PointerEvent): [number, number] => {
    const r = e.currentTarget.getBoundingClientRect()
    return [clamp01((e.clientX - r.left) / r.width), clamp01((e.clientY - r.top) / r.height)]
  }
  return (
    <div
      className="absolute inset-0 z-10 cursor-crosshair touch-none"
      onPointerDown={(e) => {
        if (e.button !== 0) return
        e.stopPropagation()
        e.preventDefault()
        e.currentTarget.setPointerCapture(e.pointerId)
        pts.current = [frac(e)]
        setLive(pts.current)
      }}
      onPointerMove={(e) => {
        if (!live) return
        const p = frac(e)
        const last = pts.current[pts.current.length - 1]
        if (Math.hypot((p[0] - last[0]) * width, (p[1] - last[1]) * height) < 2.5) return
        pts.current = [...pts.current, p]
        setLive(pts.current)
      }}
      onPointerUp={() => {
        if (!live) return
        const s = pts.current
        setLive(null)
        const b = strokesBox([s])
        if ((b.x2 - b.x1) * width < 6 && (b.y2 - b.y1) * height < 6) onTap({ x: s[0][0], y: s[0][1] })
        else onStroke(compact(s))
      }}
      onPointerCancel={() => setLive(null)}
    >
      {live && <StrokesSvg strokes={[live]} width={width} height={height} color="#f59e0b" />}
    </div>
  )
}

/** Strokes in slide fractions, drawn over a `width`×`height` stage. */
export function StrokesSvg({ strokes, width, height, color, strokeWidth = 3, opacity = 1 }: {
  strokes: Stroke[]
  width: number
  height: number
  color: string
  strokeWidth?: number
  opacity?: number
}) {
  return (
    <svg className="pointer-events-none absolute left-0 top-0" width={width} height={height} style={{ opacity }}>
      {strokes.map((s, i) => (
        <polyline
          key={i}
          points={s.map(([x, y]) => `${x * width},${y * height}`).join(' ')}
          fill="none"
          stroke={color}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ))}
    </svg>
  )
}

export function strokesBox(strokes: Stroke[]): Box {
  const b = { x1: 1, y1: 1, x2: 0, y2: 0 }
  for (const [x, y] of strokes.flat()) {
    b.x1 = Math.min(b.x1, x); b.y1 = Math.min(b.y1, y)
    b.x2 = Math.max(b.x2, x); b.y2 = Math.max(b.y2, y)
  }
  return b
}

/** Where a drawn note's pin sits: the mark's top-right corner. */
export function pinFor(strokes: Stroke[]): { x: number; y: number } {
  const b = strokesBox(strokes)
  return { x: b.x2, y: b.y1 }
}

/** Fewer, rounded points (kept ≤ 400) — enough to redraw the mark faithfully. */
function compact(s: Stroke): Stroke {
  const step = Math.max(1, Math.ceil(s.length / 400))
  const out = s.filter((_, i) => i % step === 0 || i === s.length - 1)
  return out.map(([x, y]) => [Math.round(x * 1e4) / 1e4, Math.round(y * 1e4) / 1e4])
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v))

export const NOTE_COLORS = {
  user: '#f59e0b',
  agent: '#8b5cf6',
  resolved: '#10b981',
}
