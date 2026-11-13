import { useLayoutEffect, useState, type RefObject } from 'react'

/**
 * An element's usable content width (clientWidth minus horizontal padding),
 * kept current with a ResizeObserver. clientWidth already excludes a classic
 * (always-visible) scrollbar, which a computed "panel width minus constant"
 * does not — that's what clipped rail thumbnails on the right.
 *
 * Pair it with `scrollbar-gutter: stable` on the element: otherwise sizing the
 * content to the width can make the scrollbar appear and disappear in a loop
 * (wider items → overflow → scrollbar → narrower items → fits → no scrollbar…).
 */
export function useInnerWidth(ref: RefObject<HTMLElement | null>, fallback: number): number {
  const [w, setW] = useState(fallback)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = () => {
      const cs = getComputedStyle(el)
      const next = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)
      // Ignore sub-pixel jitter.
      setW((prev) => (Math.abs(prev - next) < 1 ? prev : next))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref])
  return w
}
