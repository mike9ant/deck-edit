/**
 * The slide toolbar's text and color tools (applied by SlideEditor, see formatting.ts):
 * - a font box listing the deck's fonts (shown when text is selected or being edited);
 * - a size box with ▲ / ▼ that step each run through PowerPoint's preset sizes (or type a size);
 * - a color button whose popup has black, white and the standard colors, then the deck's colors
 *   in color-wheel order — for the text, a shape's fill or line, or (nothing selected) the slide
 *   background, whichever apply.
 * Buttons keep the text selection (no focus change); the size field saves it before taking focus.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown, ChevronUp, Palette } from 'lucide-react'
import clsx from 'clsx'
import type { PresentationData } from '@diceui/pptx-core'
import type { ColorTarget, FormatState, SlideActions } from './SlideEditor'
import { STANDARD_COLORS, colorRows, deckColors, deckFonts, parseSize } from './formatting'

const keep = (e: React.MouseEvent) => e.preventDefault() // a click must not end the text editing

/**
 * A popup over everything: rendered at the page's top level (the toolbar is a CSS container, which
 * would clip it and its fixed overlay), placed under `anchor` and kept inside the window.
 */
function Popup({ anchor, width, onClose, children }: { anchor: HTMLElement | null; width: number; onClose(): void; children: React.ReactNode }) {
  const r = anchor?.getBoundingClientRect()
  if (!r) return null
  const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8))
  return createPortal(
    <>
      <div className="fixed inset-0 z-[60]" onMouseDown={(e) => { e.preventDefault(); onClose() }} />
      <div className="fixed z-[61] rounded-lg border border-hair bg-white shadow-xl" style={{ left, top: r.bottom + 4, width }} onMouseDown={keep}>
        {children}
      </div>
    </>,
    document.body,
  )
}

export function FormatTools({ fmt, pres, version, actions }: { fmt: FormatState; pres: PresentationData; version: number; actions: React.MutableRefObject<SlideActions> }) {
  const [open, setOpen] = useState<'font' | 'color' | null>(null)
  const fontBtn = useRef<HTMLButtonElement>(null)
  const colorBtn = useRef<HTMLButtonElement>(null)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const fonts = useMemo(() => deckFonts(pres), [pres, version])
  if (!fmt.text && !fmt.shape && !fmt.background) return null
  return (
    <div className="relative ml-1 flex items-center gap-1">
      <div className="mx-1 h-5 w-px bg-hair" />
      {fmt.text && (
        <>
          <button
            ref={fontBtn}
            className="tool-btn max-w-[9rem] gap-1 border border-hair px-1.5"
            title="Font — the fonts this deck uses"
            onMouseDown={keep}
            onClick={() => setOpen(open === 'font' ? null : 'font')}
          >
            <span className="truncate" style={{ fontFamily: fmt.font }}>{fmt.font ?? 'Font'}</span>
            <ChevronDown size={12} className="shrink-0" />
          </button>
          <SizeBox size={fmt.size} actions={actions} />
        </>
      )}
      <button
        ref={colorBtn}
        className="tool-btn flex-col gap-0 px-1.5"
        title="Color"
        onMouseDown={keep}
        onClick={() => setOpen(open === 'color' ? null : 'color')}
      >
        <Palette size={15} />
        {(() => {
          const c = fmt.text ? fmt.textColor : fmt.shape ? fmt.fill : undefined
          return <span className="mt-px h-[3px] w-4 rounded-sm" style={{ background: c && c !== 'none' ? `#${c}` : '#ffffff', boxShadow: '0 0 0 0.5px rgba(0,0,0,.25)' }} />
        })()}
      </button>
      {open === 'font' && (
        <Popup anchor={fontBtn.current} width={224} onClose={() => setOpen(null)}>
        <div className="max-h-80 overflow-y-auto overflow-x-hidden p-1">
          <div className="px-2 pb-1 pt-1.5 text-[11px] font-medium text-ink-3">Fonts in this deck</div>
          {fonts.map((f) => (
            <button
              key={f}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-paper"
              style={{ fontFamily: f }}
              onClick={() => { setOpen(null); actions.current.setFont(f) }}
            >
              <span className="min-w-0 flex-1 truncate">{f}</span>
              {f === fmt.font && <Check size={13} className="shrink-0 text-accent" />}
            </button>
          ))}
          {!fonts.length && <div className="px-2 py-1.5 text-xs text-ink-3">No fonts found in this deck.</div>}
        </div>
        </Popup>
      )}
      {open === 'color' && (
        <ColorPopup anchor={colorBtn.current} fmt={fmt} pres={pres} version={version} onClose={() => setOpen(null)} onPick={(t, hex) => { setOpen(null); actions.current.setColor(t, hex) }} />
      )}
    </div>
  )
}

/** The size field (type a size, Enter) with ▲ / ▼. */
function SizeBox({ size, actions }: { size?: number; actions: React.MutableRefObject<SlideActions> }) {
  const [text, setText] = useState(size != null ? String(size) : '')
  useEffect(() => setText(size != null ? String(size) : ''), [size])
  // Enter applies and leaves the field, and leaving applies too: one value is applied once.
  const applied = useRef<number | null>(null)
  const commit = () => {
    const pt = parseSize(text)
    if (pt != null && pt !== size && pt !== applied.current) {
      applied.current = pt
      actions.current.setSize(pt)
    } else if (pt == null) setText(size != null ? String(size) : '')
  }
  return (
    <div className="flex h-7 items-center rounded-md border border-hair bg-white">
      <input
        className="h-full w-10 rounded-l-md bg-transparent text-center text-xs outline-none"
        value={text}
        title="Font size in points — type a size and press Enter"
        // Before the focus moves here (which ends text editing), remember the text selection.
        onMouseDown={() => actions.current.holdSelection()}
        onFocus={() => (applied.current = null)}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); commit(); (e.target as HTMLInputElement).blur() }
          if (e.key === 'Escape') { setText(size != null ? String(size) : ''); (e.target as HTMLInputElement).blur() }
          e.stopPropagation()
        }}
        // Left the field: apply what was typed — and if that applied nothing, let the held text selection go.
        onBlur={() => { commit(); actions.current.releaseSelection() }}
      />
      <div className="flex h-full flex-col border-l border-hair">
        <button className="flex flex-1 items-center px-0.5 text-ink-2 hover:bg-black/5" title="Bigger (⌘⇧>)" onMouseDown={keep} onClick={() => actions.current.stepSize(1)}><ChevronUp size={11} /></button>
        <button className="flex flex-1 items-center px-0.5 text-ink-2 hover:bg-black/5" title="Smaller (⌘⇧<)" onMouseDown={keep} onClick={() => actions.current.stepSize(-1)}><ChevronDown size={11} /></button>
      </div>
    </div>
  )
}

const TARGET_LABEL: Record<ColorTarget, string> = { text: 'Text', fill: 'Fill', line: 'Line', background: 'Background' }

/**
 * Swatch grid geometry: a fixed 13 columns — the first slot is "None" for a fill or line (kept empty
 * for text, so the colors stay in the same places on every tab), then black, white and the ten
 * standard colors. The popup's width follows from it (no sideways scrolling).
 */
const SW = 20
const GAP = 4
const COLS = 13
/** Room around the grid for the selection ring (2 px + 1 px offset). */
const RING = 3
const GRID_W = COLS * SW + (COLS - 1) * GAP + 2 * RING
/** Deck colors beyond this many rows scroll (vertically only). */
const MAX_ROWS = 6
const SCROLLBAR = 12
const PAD = 8
const EDGE = 'inset 0 0 0 1px rgba(0,0,0,.15)'
/** The current color's ring: a white gap, then the accent color. */
const RING_SHADOW = '0 0 0 1px #fff, 0 0 0 3px #3d63dd'

/** The tab (Text / Fill / Line / Background) last picked, while the app runs. */
let lastTarget: ColorTarget | null = null
const NONE = 'NONE'
/** "None": white with a red diagonal, as in PowerPoint. */
const NONE_BG = 'linear-gradient(to top right, #fff calc(50% - 1.2px), #D7263D calc(50% - 1.2px), #D7263D calc(50% + 1.2px), #fff calc(50% + 1.2px))'

function ColorPopup({ anchor, fmt, pres, version, onClose, onPick }: { anchor: HTMLElement | null; fmt: FormatState; pres: PresentationData; version: number; onClose(): void; onPick(t: ColorTarget, hex: string): void }) {
  const targets: ColorTarget[] = [...(fmt.text ? ['text' as const] : []), ...(fmt.shape ? ['fill' as const, 'line' as const] : []), ...(fmt.background ? ['background' as const] : [])]
  const [target, setTargetState] = useState<ColorTarget>(lastTarget && targets.includes(lastTarget) ? lastTarget : targets[0])
  const setTarget = (t: ColorTarget) => { lastTarget = t; setTargetState(t) }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const rows = useMemo(() => colorRows(deckColors(pres)), [pres, version])
  const current = (target === 'text' ? fmt.textColor : target === 'fill' ? fmt.fill : target === 'line' ? fmt.line : undefined)?.toUpperCase()
  // Each row wraps at COLS; the row count decides whether the deck colors scroll.
  const lineCount = rows.reduce((n, r) => n + Math.ceil(r.length / COLS), 0)
  const scrolls = lineCount > MAX_ROWS
  const width = GRID_W + 2 * PAD + (scrolls ? SCROLLBAR : 0)
  const inPalette = !!current && (current === NONE || STANDARD_COLORS.includes(current) || rows.some((r) => r.includes(current)))
  // The current color's swatch may be in a scrolled-off row: bring it into view.
  const scroller = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = scroller.current?.querySelector<HTMLElement>('[data-current]')
    if (el && scroller.current) scroller.current.scrollTop = Math.max(0, el.offsetTop - scroller.current.offsetTop - SW)
  }, [current, target])
  // The current color is ringed wherever it appears — in the standard colors and the deck's both.
  const ring = (on: boolean) => (on ? `${EDGE}, ${RING_SHADOW}` : EDGE)
  const swatch = (hex: string) => (
    <button
      key={hex}
      className={clsx('rounded-sm', current !== hex && 'hover:scale-110')}
      style={{ width: SW, height: SW, background: `#${hex}`, boxShadow: ring(current === hex) }}
      title={`#${hex}`}
      data-current={current === hex || undefined}
      onClick={() => onPick(target, hex)}
    />
  )
  const noneSlot = target === 'fill' || target === 'line'
    ? (
      <button
        key="none"
        className={clsx('rounded-sm', current !== NONE && 'hover:scale-110')}
        style={{ width: SW, height: SW, background: NONE_BG, boxShadow: ring(current === NONE) }}
        title={target === 'fill' ? 'No fill (transparent)' : 'No line'}
        data-none=""
        onClick={() => onPick(target, 'none')}
      />
    )
    : <span key="none" style={{ width: SW, height: SW }} />
  const grid = (items: React.ReactNode[], extra?: React.CSSProperties) => (
    <div className="grid" style={{ gridTemplateColumns: `repeat(${COLS}, ${SW}px)`, gap: GAP, padding: RING, width: GRID_W, ...extra }}>{items}</div>
  )
  return (
    <Popup anchor={anchor} width={width} onClose={onClose}>
      <div style={{ padding: PAD }}>
        {targets.length > 1 && (
          <div className="mb-2 flex rounded-md bg-black/5 p-0.5">
            {targets.map((t) => (
              <button key={t} className={clsx('flex-1 rounded px-2 py-0.5 text-xs', t === target ? 'bg-white font-medium text-ink shadow-sm' : 'text-ink-3 hover:text-ink')} onClick={() => setTarget(t)}>
                {TARGET_LABEL[t]}
              </button>
            ))}
          </div>
        )}
        {targets.length === 1 && <div className="mb-1.5 text-[11px] font-medium text-ink-3">{TARGET_LABEL[target]} color</div>}
        {grid([noneSlot, ...STANDARD_COLORS.map(swatch)])}
        <div className="mb-0.5 mt-2 text-[11px] font-medium text-ink-3">Deck colors</div>
        {rows.length ? (
          <div
            ref={scroller}
            className="relative overflow-x-hidden"
            style={scrolls ? { maxHeight: MAX_ROWS * SW + (MAX_ROWS - 1) * GAP + 2 * RING + (rows.length - 1) * 6, overflowY: 'auto', width: GRID_W + SCROLLBAR } : undefined}
            data-deck-colors=""
          >
            {/* Dark, medium, light, grays: each row wraps; a small gap between rows. */}
            {rows.map((row, i) => <div key={i} style={{ marginTop: i ? 6 - RING * 2 : 0 }}>{grid(row.map(swatch))}</div>)}
          </div>
        ) : (
          <div className="text-xs text-ink-3">No colors found in this deck.</div>
        )}
        {/* The selection's color when it isn't one of the swatches above (e.g. a theme color, or mixed in by an app). */}
        {current && !inPalette && (
          <div className="mt-2 flex items-center gap-1.5 text-[11px] text-ink-3">
            Current:
            <span className="inline-block rounded-sm" style={{ width: 14, height: 14, background: `#${current}`, boxShadow: `${EDGE}, ${RING_SHADOW}` }} />
            #{current}
          </div>
        )}
      </div>
    </Popup>
  )
}
