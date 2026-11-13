/**
 * Renders one slide with @diceui/pptx-core into a host element, scaled to a
 * target width. Re-renders only when the slide's version changes; a width
 * change just updates the CSS scale.
 */

import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef } from 'react'
import { renderSlide, renderThumbnail, type PresentationData, type SlideData } from '@diceui/pptx-core'
import { polishCharts, valueAxisScaling } from './chartFixes'

/** One blob-URL cache per parsed presentation; the previous one is revoked when a deck reloads. */
const caches = new Map<string, { pres: PresentationData; map: Map<string, string> }>()
export function mediaCache(deckKey: string, pres: PresentationData): Map<string, string> {
  const c = caches.get(deckKey)
  if (c && c.pres === pres) return c.map
  if (c) {
    const old = c.map
    // Revoke after the new render has replaced the old DOM.
    setTimeout(() => old.forEach((url) => URL.revokeObjectURL(url)), 2000)
  }
  const map = new Map<string, string>()
  caches.set(deckKey, { pres, map })
  return map
}

interface Props {
  deckKey: string
  pres: PresentationData
  slide: SlideData
  version: number
  width: number
  thumbnail?: boolean
  className?: string
}

export interface SlideRenderHandle {
  /** The rendered slide root (960×540-ish px, unscaled), for hit-testing and text editing. */
  root(): HTMLElement | null
}

/** The value-axis scaling of the chart a rendered chart element belongs to. */
export function scalingForChart(pres: PresentationData, slide: SlideData, dom: HTMLElement | undefined) {
  const id = dom?.closest('[data-pptx-chart]')?.getAttribute('data-pptx-node-id')
  if (!id) return []
  const find = (nodes: SlideData['nodes']): string | undefined => {
    for (const n of nodes) if (n.id === id && n.nodeType === 'chart') return (n as { chartPath: string }).chartPath
    return undefined
  }
  const path = find(slide.nodes)
  const root = path ? (pres.charts.get(path) as { element?: Element } | undefined)?.element : undefined
  return valueAxisScaling(root)
}

export const SlideRender = forwardRef<SlideRenderHandle, Props>(function SlideRender(
  { deckKey, pres, slide, version, width, thumbnail, className },
  ref,
) {
  const host = useRef<HTMLDivElement>(null)
  const rootEl = useRef<HTMLElement | null>(null)
  useImperativeHandle(ref, () => ({ root: () => rootEl.current }), [])

  useLayoutEffect(() => {
    const el = host.current
    if (!el) return
    const cache = mediaCache(deckKey, pres)
    let handle: ReturnType<typeof renderSlide>
    const charts = new Set<never>()
    try {
      handle = thumbnail
        ? renderThumbnail(pres, slide, { mediaUrlCache: cache })
        : renderSlide(pres, slide, { mediaUrlCache: cache, clipContent: true, chartInstances: charts as never })
    } catch (e) {
      console.error('render slide', e)
      el.textContent = 'This slide could not be rendered.'
      return
    }
    handle.element.style.transformOrigin = '0 0'
    handle.element.style.transform = `scale(${width / pres.width})`
    el.replaceChildren(handle.element)
    rootEl.current = handle.element
    // Charts initialise once attached: polish them on the next frame and once
    // the slide's async resources settle.
    let live = true
    const polish = () => live && charts.size && polishCharts(charts, (dom) => scalingForChart(pres, slide, dom))
    requestAnimationFrame(polish)
    void handle.ready.then(polish)
    return () => {
      live = false
      handle.dispose()
    }
    // width handled below without re-rendering
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deckKey, pres, slide, version, thumbnail])

  useEffect(() => {
    if (rootEl.current) rootEl.current.style.transform = `scale(${width / pres.width})`
  }, [width, pres.width])

  return (
    <div
      ref={host}
      className={`pptx-render ${className ?? ''}`}
      style={{ width, height: (width * pres.height) / pres.width, overflow: 'hidden', position: 'relative', background: '#fff' }}
    />
  )
})
