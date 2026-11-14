import { describe, expect, it } from 'vitest'
import { colName, formatDate, formatNumber, parseRange, showCell } from '../sheetFormat'

describe('Excel number formats', () => {
  it('formats the common patterns', () => {
    expect(formatNumber(1234.5)).toBe('1234.5')
    expect(formatNumber(1 / 3)).toBe('0.3333333333')
    expect(formatNumber(1234567.891, '#,##0')).toBe('1,234,568')
    expect(formatNumber(1234.5, '#,##0.00')).toBe('1,234.50')
    expect(formatNumber(0.1234, '0.0%')).toBe('12.3%')
    expect(formatNumber(0.5, '0%')).toBe('50%')
    expect(formatNumber(2500000, '"$"#,##0')).toBe('$2,500,000')
    expect(formatNumber(-1500, '$#,##0;($#,##0)')).toBe('($1,500)')
    expect(formatNumber(-1500, '#,##0;[Red](#,##0)')).toBe('(1,500)')
    expect(formatNumber(42, '[$€-407] #,##0.00')).toBe('€ 42.00')
    expect(formatNumber(3.14159, '0.00')).toBe('3.14')
  })
  it('formats dates and times (wall-clock, as stored)', () => {
    const d = new Date(Date.UTC(2026, 2, 7, 14, 30))
    expect(formatDate(d, 'mm/dd/yyyy')).toBe('Mar 7, 2026')
    expect(formatDate(d, 'h:mm')).toBe('2:30 PM')
  })
})

describe('cell values', () => {
  it('shows formulas by their result, or the formula when there is none', () => {
    expect(showCell({ formula: 'SUM(A1:A3)', result: 6 }, '0.0')).toEqual({ text: '6.0', kind: 'number', formula: 'SUM(A1:A3)' })
    expect(showCell({ formula: 'SUM(A1:A3)' })).toEqual({ text: '=SUM(A1:A3)', kind: 'formula', formula: 'SUM(A1:A3)' })
    expect(showCell({ richText: [{ text: 'Hello ' }, { text: 'world' }] }).text).toBe('Hello world')
    expect(showCell({ text: 'site', hyperlink: 'https://x.y' }).text).toBe('site')
    expect(showCell({ error: '#DIV/0!' })).toEqual({ text: '#DIV/0!', kind: 'error' })
    expect(showCell(true).text).toBe('TRUE')
    expect(showCell(null).kind).toBe('empty')
  })
  it('names columns and parses ranges', () => {
    expect([1, 26, 27, 52, 703].map(colName)).toEqual(['A', 'Z', 'AA', 'AZ', 'AAA'])
    expect(parseRange('B3:$D$5')).toEqual({ r1: 3, c1: 2, r2: 5, c2: 4 })
  })
})
