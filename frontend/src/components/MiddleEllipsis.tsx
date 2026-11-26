import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import { shortenName } from './shortenName'

/** Text widths in px, per font (a canvas measures them; cached). */
const widths = new Map<string, Map<string, number>>()
let ctx: CanvasRenderingContext2D | null | undefined
function measurer(el: HTMLElement): (s: string) => number {
  const cs = getComputedStyle(el)
  const font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`
  if (ctx === undefined) ctx = document.createElement('canvas').getContext('2d')
  let cache = widths.get(font)
  if (!cache) widths.set(font, (cache = new Map()))
  return (s) => {
    let w = cache!.get(s)
    if (w === undefined) {
      if (!ctx) return s.length * 7
      ctx.font = font
      w = ctx.measureText(s).width
      if (cache!.size > 5000) cache!.clear()
      cache!.set(s, w)
    }
    return w
  }
}

/**
 * A file name shortened to the width it gets by dropping whole middle words — keeping the first
 * and last words, the extension, and the words that set it apart from `siblings` (the other names
 * around it: its folder's, the open tabs'; pass the same array while they don't change). Its width
 * is the full name's when there's room (an invisible sizer), else what its row gives it. Used by the
 * file tree and the tabs.
 */
export function MiddleEllipsis({ name, className, siblings }: { name: string; className?: string; siblings?: readonly string[] }) {
  const box = useRef<HTMLSpanElement>(null)
  const text = useRef<HTMLSpanElement>(null)
  const [width, setWidth] = useState<number | null>(null)
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    setWidth(el.getBoundingClientRect().width)
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const shown = useMemo(
    () => (width == null || !text.current ? name : shortenName(name, width, measurer(text.current), siblings)),
    [name, width, siblings],
  )
  return (
    <span ref={box} className={clsx('relative block min-w-0 overflow-hidden', className)}>
      {/* The full name's width, so the box only narrows when the row has less room. */}
      <span aria-hidden className="block h-0 overflow-hidden whitespace-pre">{name}</span>
      <span ref={text} className="block truncate whitespace-pre">{shown}</span>
    </span>
  )
}
