import { describe, expect, it } from 'vitest'
import { pinNearMark, pinFor } from '../NoteDrawing'
import type { Stroke } from '../../api/types'

const W = 1000
const H = 500

/** A closed loop drawn around (cx, cy) with radii in px, as slide fractions. */
const loop = (cx: number, cy: number, rx: number, ry: number, n = 120): Stroke =>
  Array.from({ length: n + 1 }, (_, i) => {
    const a = (i / n) * Math.PI * 2
    return [(cx + rx * Math.cos(a)) / W, (cy + ry * Math.sin(a)) / H] as [number, number]
  })

describe('pinNearMark', () => {
  it('pulls a circled note’s pin in from the bounding-box corner to just outside the circle', () => {
    const circle = loop(500, 250, 100, 100)
    const p = pinNearMark([circle], W, H)
    const d = Math.hypot(p.x * W - 500, p.y * H - 250)
    expect(d).toBeGreaterThan(100 + 5)
    expect(d).toBeLessThan(100 + 9) // ~7 px outside the circle
    // On the diagonal towards the old corner (top-right).
    expect(p.x * W - 500).toBeCloseTo(250 - p.y * H, 0)
    const corner = pinFor([circle])
    expect(Math.hypot(corner.x * W - 500, corner.y * H - 250)).toBeGreaterThan(140)
  })

  it('does the same towards the top-left corner (when the bubble wouldn’t fit on the right)', () => {
    const circle = loop(500, 250, 100, 100)
    const p = pinNearMark([circle], W, H, 'tl')
    expect(p.x * W).toBeLessThan(500)
    expect(p.y * H).toBeLessThan(250)
    expect(Math.hypot(p.x * W - 500, p.y * H - 250)).toBeLessThan(100 + 9)
  })

  it('keeps the corner when the drawing doesn’t cross the ray (a line from bottom-left to top-right)', () => {
    const diagonal: Stroke = [[0.2, 0.8], [0.4, 0.2]]
    expect(pinNearMark([diagonal], W, H)).toEqual(pinFor([diagonal]))
  })

  it('never moves the pin outwards', () => {
    const blob = loop(300, 300, 40, 25)
    const p = pinNearMark([blob], W, H)
    const c = pinFor([blob])
    expect(Math.hypot(p.x * W - 300, p.y * H - 300)).toBeLessThanOrEqual(Math.hypot(c.x * W - 300, c.y * H - 300) + 1e-6)
  })
})
