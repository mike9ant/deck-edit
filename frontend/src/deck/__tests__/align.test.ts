import { describe, expect, it } from 'vitest'
import { alignPositions } from '../align'

const rs = [
  { id: 'a', x: 10, y: 10, w: 20, h: 10 },
  { id: 'b', x: 50, y: 30, w: 40, h: 20 },
  { id: 'c', x: 200, y: 5, w: 10, h: 50 },
]
const at = (kind: Parameters<typeof alignPositions>[1]) => Object.fromEntries([...alignPositions(rs, kind)].map(([id, p]) => [id, [p.x, p.y]]))

describe('align / distribute selected shapes', () => {
  it('aligns edges and centers to the selection’s bounding box', () => {
    expect(at('left')).toEqual({ a: [10, 10], b: [10, 30], c: [10, 5] })
    expect(at('right')).toEqual({ a: [190, 10], b: [170, 30], c: [200, 5] })
    expect(at('hcenter')).toEqual({ a: [100, 10], b: [90, 30], c: [105, 5] })
    expect(at('top')).toEqual({ a: [10, 5], b: [50, 5], c: [200, 5] })
    expect(at('bottom')).toEqual({ a: [10, 45], b: [50, 35], c: [200, 5] })
    expect(at('vcenter')).toEqual({ a: [10, 25], b: [50, 20], c: [200, 5] })
  })
  it('distributes with equal gaps, keeping the outermost shapes in place', () => {
    // x span 10..210 = 200, widths 70 → gaps 65: a 10..30, b 95..135, c 200..210
    expect(at('hdistribute')).toEqual({ a: [10, 10], b: [95, 30], c: [200, 5] })
    const v = at('vdistribute') // by vertical center: a, c, b — a and b keep their places
    expect(v.a).toEqual([10, 10])
    expect(v.b).toEqual([50, 30])
  })
  it('needs 3 shapes to distribute', () => {
    expect(alignPositions(rs.slice(0, 2), 'hdistribute').size).toBe(0)
  })
})
