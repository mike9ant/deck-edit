/**
 * Freehand notes: instead of pinning a note at a point, the user circles or
 * marks an area of the slide (several strokes allowed). The strokes are kept
 * as slide fractions, drawn over the slide, and sent to the agent with the
 * area they cover (see backend notes.rs `describe_place`).
 *
 * - `NoteToolButton` — the toolbar's [AI Note: 📍 ✏️] group: "AI Note" toggles
 *   note mode with the last tool; the pin / draw buttons turn it on with that
 *   tool (or switch tools); the one in use is highlighted while it's on.
 * - `SelectToolButton` — the pointer tool: back to selecting shapes (as does Esc,
 *   see `useEscapeEndsNoteMode`).
 * - `DrawLayer` — captures strokes over the stage while drawing.
 * - `StrokesSvg` — renders strokes at any size.
 */

import { useEffect, useRef, useState } from 'react'
import { BotMessageSquare, MapPin, MousePointer2, PenLine } from 'lucide-react'
import clsx from 'clsx'
import type { Stroke } from '../api/types'
import { useNotes, type NoteTool } from '../store/notesStore'

export type Box = { x1: number; y1: number; x2: number; y2: number }

const TOOLS: { id: NoteTool; label: string; hint: string; icon: typeof MapPin }[] = [
  { id: 'pin', label: 'Pin at a point', hint: 'Click where the note goes', icon: MapPin },
  { id: 'draw', label: 'Draw a mark', hint: 'Circle or mark an area — the agent focuses there', icon: PenLine },
]

export function NoteToolButton({ active, onToggle }: { active: boolean; onToggle(): void }) {
  const tool = useNotes((s) => s.tool)
  const setTool = useNotes((s) => s.setTool)
  /** A tool's button: turns note mode on with it, switches to it, or (already on with it) turns note mode off. */
  const pick = (t: NoteTool) => {
    if (active && tool === t) return onToggle()
    setTool(t)
    if (!active) onToggle()
  }
  return (
    <div
      className={clsx('flex h-7 shrink-0 items-center gap-0.5 rounded-md border pl-0.5 pr-0.5', active ? 'border-amber-300 bg-amber-50' : 'border-hair')}
      role="group"
      aria-label="AI note"
    >
      <button
        className={clsx('tool-btn h-6 px-1.5', active && 'text-amber-900 hover:bg-amber-100')}
        onClick={onToggle}
        title={active ? 'Stop adding notes for the AI agent (Esc)' : `Add a note for the AI agent — ${tool === 'draw' ? 'draw a mark' : 'pin it at a point'}`}
      >
        <BotMessageSquare size={15} /> <span className="tb-label">AI Note:</span>
      </button>
      {TOOLS.map((t) => (
        <button
          key={t.id}
          className={clsx('icon-btn h-6 w-6', active && tool === t.id ? 'bg-amber-200 text-amber-900 hover:bg-amber-200' : active && 'hover:bg-amber-100')}
          aria-pressed={active && tool === t.id}
          title={`${t.label} — ${t.hint.toLowerCase()}`}
          onClick={() => pick(t.id)}
        >
          <t.icon size={14} />
        </button>
      ))}
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

/** How far outside the drawing a drawn note's pin sits (px). */
const PIN_GAP = 7

/**
 * Where a drawn note's pin is shown, in fractions of a `w`×`h` px area: the
 * mark's top-right corner (or top-left: `corner`), pulled in along the ray
 * from the mark's centre when the drawing crosses that ray first — to
 * PIN_GAP px outside the outermost crossing. A circled area keeps its pin on
 * the circle instead of out in its bounding box's corner. Computed in pixels,
 * so the gap and the ray hold on any aspect ratio.
 */
export function pinNearMark(strokes: Stroke[], w: number, h: number, side: 'tr' | 'tl' = 'tr'): { x: number; y: number } {
  const b = strokesBox(strokes)
  const corner = { x: side === 'tr' ? b.x2 : b.x1, y: b.y1 }
  if (!w || !h) return corner
  const cx = ((b.x1 + b.x2) / 2) * w
  const cy = ((b.y1 + b.y2) / 2) * h
  const dx = corner.x * w - cx
  const dy = b.y1 * h - cy
  const len = Math.hypot(dx, dy)
  if (len < 8) return corner
  // The outermost crossing of the ray centre → corner with the drawing (t = fraction of the way).
  let tMax = -1
  for (const s of strokes) {
    for (let i = 1; i < s.length; i++) {
      const ax = s[i - 1][0] * w, ay = s[i - 1][1] * h
      const ex = s[i][0] * w - ax, ey = s[i][1] * h - ay
      const den = dx * ey - dy * ex
      if (Math.abs(den) < 1e-9) continue // parallel
      const t = ((ax - cx) * ey - (ay - cy) * ex) / den
      const u = ((ax - cx) * dy - (ay - cy) * dx) / den
      if (t > 0 && t <= 1 && u >= 0 && u <= 1) tMax = Math.max(tMax, t)
    }
  }
  if (tMax < 0) return corner
  const dist = Math.min(len, tMax * len + PIN_GAP)
  return { x: (cx + (dx / len) * dist) / w, y: (cy + (dy / len) * dist) / h }
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
