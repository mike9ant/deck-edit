/**
 * Align / distribute shapes relative to their common bounding box, as
 * PowerPoint's "Align Selected Objects": left/centers/right, tops/middles/
 * bottoms, and equal gaps horizontally/vertically (3+ shapes; the outermost
 * stay put).
 */

type Rect = { x: number; y: number; w: number; h: number }

/** Align / distribute the selected shapes, relative to their bounding box (as PowerPoint's "Align Selected Objects"). */
export type AlignKind = 'left' | 'hcenter' | 'right' | 'top' | 'vcenter' | 'bottom' | 'hdistribute' | 'vdistribute'
export const ALIGN_LABEL: Record<AlignKind, string> = {
  left: 'aligned left', hcenter: 'aligned centers', right: 'aligned right',
  top: 'aligned tops', vcenter: 'aligned middles', bottom: 'aligned bottoms',
  hdistribute: 'distributed horizontally', vdistribute: 'distributed vertically',
}

/** New positions for aligning/distributing rects within their common bounding box. */
export function alignPositions(rs: (Rect & { id: string })[], kind: AlignKind): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>()
  if (rs.length < 2) return out
  const minX = Math.min(...rs.map((r) => r.x)), maxX = Math.max(...rs.map((r) => r.x + r.w))
  const minY = Math.min(...rs.map((r) => r.y)), maxY = Math.max(...rs.map((r) => r.y + r.h))
  const distribute = (axis: 'x' | 'y') => {
    if (rs.length < 3) return
    const size = axis === 'x' ? 'w' : 'h'
    const sorted = [...rs].sort((a, b) => a[axis] + a[size] / 2 - (b[axis] + b[size] / 2))
    // The first and last shapes stay where they are; the rest get equal gaps between them.
    const first = sorted[0]
    const last = sorted[sorted.length - 1]
    const span = last[axis] + last[size] - first[axis] - sorted.reduce((n, r) => n + r[size], 0)
    const gap = span / (sorted.length - 1)
    let at = first[axis]
    for (const r of sorted) {
      out.set(r.id, axis === 'x' ? { x: at, y: r.y } : { x: r.x, y: at })
      at += r[size] + gap
    }
  }
  for (const r of rs) {
    if (kind === 'left') out.set(r.id, { x: minX, y: r.y })
    if (kind === 'hcenter') out.set(r.id, { x: (minX + maxX) / 2 - r.w / 2, y: r.y })
    if (kind === 'right') out.set(r.id, { x: maxX - r.w, y: r.y })
    if (kind === 'top') out.set(r.id, { x: r.x, y: minY })
    if (kind === 'vcenter') out.set(r.id, { x: r.x, y: (minY + maxY) / 2 - r.h / 2 })
    if (kind === 'bottom') out.set(r.id, { x: r.x, y: maxY - r.h })
  }
  if (kind === 'hdistribute') distribute('x')
  if (kind === 'vdistribute') distribute('y')
  return out
}

