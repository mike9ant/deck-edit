import { useLayoutEffect, useState, type RefObject } from 'react'

/**
 * An element's usable content width (clientWidth minus horizontal padding),
 * kept current with a ResizeObserver. clientWidth already excludes a classic
 * (always-visible) scrollbar, which a computed "panel width minus constant"
 * does not — that's what clipped rail thumbnails on the right.
 */
export function useInnerWidth(ref: RefObject<HTMLElement | null>, fallback: number): number {
  const [w, setW] = useState(fallback)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = () => {
      const cs = getComputedStyle(el)
      setW(el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref])
  return w
}
