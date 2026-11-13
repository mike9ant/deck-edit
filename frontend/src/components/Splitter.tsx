/**
 * A vertical drag handle that resizes the panel next to it.
 *
 * The width is computed from the width at drag START plus the total pointer
 * movement since then — never from the render-time width plus a per-move
 * delta, which goes stale mid-drag and makes the panel wobble around its
 * starting size. `side="right"` is for a panel to the right of the handle
 * (dragging left makes it wider).
 */

interface Props {
  /** Current width of the panel this handle resizes. */
  width: number
  min: number
  max: number
  onChange(width: number): void
  side?: 'left' | 'right'
}

export function Splitter({ width, min, max, onChange, side = 'left' }: Props) {
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    const handle = e.currentTarget
    const startX = e.clientX
    const startWidth = width
    const sign = side === 'left' ? 1 : -1
    // Pointer capture keeps the drag alive over the slide, iframes and
    // scrollbars, and even outside the window.
    handle.setPointerCapture(e.pointerId)
    let frame = 0
    let pending = startWidth
    const move = (ev: PointerEvent) => {
      pending = Math.max(min, Math.min(max, startWidth + sign * (ev.clientX - startX)))
      if (!frame) {
        frame = requestAnimationFrame(() => {
          frame = 0
          onChange(pending)
        })
      }
    }
    const up = (ev: PointerEvent) => {
      handle.releasePointerCapture(ev.pointerId)
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', up)
      handle.removeEventListener('pointercancel', up)
      if (frame) cancelAnimationFrame(frame)
      onChange(pending)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', up)
    handle.addEventListener('pointercancel', up)
  }
  return (
    <div onPointerDown={onPointerDown} className="group relative z-10 w-px shrink-0 cursor-col-resize touch-none bg-hair">
      <div className="absolute inset-y-0 -left-1.5 -right-1.5 group-hover:bg-accent/20 group-active:bg-accent/30" />
    </div>
  )
}
