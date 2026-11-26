/**
 * A row of tabs that scrolls sideways without a scrollbar: the wheel (a mouse's vertical one too)
 * scrolls it, ‹ › arrows appear at an edge with more tabs past it, and the active tab (marked
 * `data-active-tab`) is kept in view — brought into view when it changes or a tab opens, and
 * again RETURN_MS after the pointer leaves a strip the user scrolled it out of (unless the pointer
 * comes back first). Used by the document tabs and the chat tabs.
 */

import { useEffect, useRef, useState } from 'react'

/** How long after the pointer leaves a strip scrolled away from the active tab it scrolls back. */
const RETURN_MS = 5000
import { ChevronLeft, ChevronRight } from 'lucide-react'

export function TabStrip({ active, count, children }: {
  /** The active tab's key: scrolled into view when it changes. */
  active: unknown
  /** The number of tabs (re-measured when it changes). */
  count: number
  children: React.ReactNode
}) {
  const scroller = useRef<HTMLDivElement>(null)
  const [more, setMore] = useState({ left: false, right: false })
  const measure = () => {
    const el = scroller.current
    if (!el) return
    // (Within the strip's own edge padding counts as the end.)
    const left = el.scrollLeft > 5
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 5
    setMore((m) => (m.left === left && m.right === right ? m : { left, right }))
  }
  useEffect(() => {
    const el = scroller.current
    if (!el) return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    for (const c of el.children) ro.observe(c)
    measure()
    return () => ro.disconnect()
  }, [count])
  /** Scroll the active tab fully into view (the strip only — not the page around it). */
  const reveal = (smooth: boolean) => {
    const el = scroller.current
    const tab = el?.querySelector<HTMLElement>('[data-active-tab]')
    if (!el || !tab) return
    const a = el.getBoundingClientRect(), t = tab.getBoundingClientRect()
    const pad = 8
    let d = 0
    if (t.left < a.left + pad) d = t.left - a.left - pad
    else if (t.right > a.right - pad) d = Math.min(t.right - a.right + pad, t.left - a.left - pad)
    if (d) el.scrollTo({ left: el.scrollLeft + d, behavior: smooth ? 'smooth' : 'auto' })
  }
  // A new or newly active tab: into view now, and again once tab widths settle (names are
  // measured for their middle ellipsis after they render).
  useEffect(() => {
    reveal(false)
    measure()
    const raf = requestAnimationFrame(() => reveal(false))
    const t = setTimeout(() => { reveal(true); measure() }, 150)
    return () => {
      cancelAnimationFrame(raf)
      clearTimeout(t)
    }
  }, [active, count])
  // Scrolled away by the user, then left: back to the active tab after a while.
  const returnTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(returnTimer.current), [])
  // Non-passive, to keep the page still while the wheel scrolls the tabs.
  useEffect(() => {
    const el = scroller.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY
      if (!d || el.scrollWidth <= el.clientWidth) return
      e.preventDefault()
      el.scrollLeft += d
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])
  const page = (dir: -1 | 1) => scroller.current?.scrollBy({ left: dir * scroller.current.clientWidth * 0.7, behavior: 'smooth' })
  const arrow = 'flex h-8 w-6 shrink-0 items-center justify-center self-end rounded-t-md text-ink-3 hover:bg-black/5 hover:text-ink'
  return (
    <div className="flex h-9 min-w-0 flex-1 items-end">
      {more.left && <button className={arrow} title="Scroll the tabs left" onClick={() => page(-1)}><ChevronLeft size={14} /></button>}
      <div
        ref={scroller}
        onScroll={measure}
        onMouseEnter={() => clearTimeout(returnTimer.current)}
        onMouseLeave={() => {
          clearTimeout(returnTimer.current)
          returnTimer.current = setTimeout(() => reveal(true), RETURN_MS)
        }}
        className="no-scrollbar flex h-9 min-w-0 flex-1 items-end gap-0.5 overflow-x-auto px-1"
      >
        {children}
      </div>
      {more.right && <button className={arrow} title="Scroll the tabs right" onClick={() => page(1)}><ChevronRight size={14} /></button>}
    </div>
  )
}
