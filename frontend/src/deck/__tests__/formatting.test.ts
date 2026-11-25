import { describe, expect, it } from 'vitest'
import { colorRows, cssToHex, firstFamily, parseSize, sortByHue, stepSize } from '../formatting'

describe('font sizes', () => {
  it('steps through PowerPoint’s preset list', () => {
    expect(stepSize(18, 1)).toBe(20)
    expect(stepSize(18, -1)).toBe(16)
    expect(stepSize(13, 1)).toBe(14) // between presets: the next one up
    expect(stepSize(13, -1)).toBe(12)
    expect(stepSize(10.5, -1)).toBe(10)
    expect(stepSize(96, 1)).toBe(100) // past the list: steps of 10
    expect(stepSize(8, -1)).toBe(7) // below it: a point at a time
    expect(stepSize(1, -1)).toBe(1)
  })

  it('reads a typed size within PowerPoint’s limits', () => {
    expect(parseSize('13.5')).toBe(13.5)
    expect(parseSize(' 24 pt ')).toBe(24)
    expect(parseSize('13.3')).toBe(13.5) // half points
    expect(parseSize('9000')).toBe(4000)
    expect(parseSize('big')).toBeNull()
    expect(parseSize('0')).toBeNull()
  })
})

describe('colors', () => {
  it('orders colors around the wheel, grays last from black to white', () => {
    expect(sortByHue(['FFFFFF', '0070C0', 'FF0000', '808080', '00B050', '000000', 'C00000'])).toEqual(['C00000', 'FF0000', '00B050', '0070C0', '000000', '808080', 'FFFFFF'])
  })

  it('groups deck colors into dark / medium / light rows around the wheel, grays last', () => {
    // navy, red, pale pink, mid green, light blue, gray, white, dark green
    const rows = colorRows(['14123A', 'D7263D', 'F9E1E8', '2BB3A3', 'BFE3F5', '808080', 'FFFFFF', '1F5E40'])
    expect(rows).toEqual([['1F5E40', '14123A'], ['D7263D', '2BB3A3'], ['BFE3F5', 'F9E1E8'], ['808080', 'FFFFFF']])
    expect(colorRows(['D7263D', '2BB3A3'])).toEqual([['D7263D', '2BB3A3']]) // empty rows are left out
  })

  it('reads computed CSS colors and font families', () => {
    expect(cssToHex('rgb(0, 112, 192)')).toBe('0070C0')
    expect(cssToHex('rgba(0, 0, 0, 0)')).toBeNull()
    expect(firstFamily('"Inter Display", Inter, sans-serif')).toBe('Inter Display')
  })
})
