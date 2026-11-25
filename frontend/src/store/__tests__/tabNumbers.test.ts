import { describe, expect, it } from 'vitest'
import { tabNumbers } from '../chatStore'

describe('chat tab numbers', () => {
  it('count up to 9, keep numbers while open, then take the lowest free one', () => {
    let t = tabNumbers(['a', 'b', 'c'], {}, 1)
    expect(t.numbers).toEqual({ a: 1, b: 2, c: 3 })
    // Closing b frees 2, but the next tab still counts up: 4, not the just-closed 2.
    t = tabNumbers(['a', 'c', 'd'], t.numbers, t.nextNumber)
    expect(t.numbers).toEqual({ a: 1, c: 3, d: 4 })
    const ids = ['a', 'c', 'd', 'e', 'f', 'g', 'h', 'i']
    t = tabNumbers(ids, t.numbers, t.nextNumber)
    expect(t.numbers.i).toBe(9)
    // Past 9: the lowest free number (2), then the next lowest (10 once 1–9 are taken).
    t = tabNumbers([...ids, 'j'], t.numbers, t.nextNumber)
    expect(t.numbers.j).toBe(2)
    t = tabNumbers([...ids, 'j', 'k'], t.numbers, t.nextNumber)
    expect(t.numbers.k).toBe(10)
  })

  it('starts over at 1 when no tab is open', () => {
    const t = tabNumbers(['x'], {}, 7)
    expect(t.numbers).toEqual({ x: 1 })
  })
})
