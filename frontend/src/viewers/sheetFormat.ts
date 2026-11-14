/**
 * Showing a spreadsheet cell's value the way Excel would: the common number
 * formats (thousands separators, fixed decimals, percentages, currency
 * symbols, negatives in parentheses), dates, booleans, rich text, hyperlinks,
 * errors — and formulas: their last computed result when the file has one
 * (Excel stores it), else the formula itself (files written by scripts, e.g.
 * openpyxl, have no results until Excel recalculates).
 */

export type CellKind = 'empty' | 'number' | 'text' | 'bool' | 'date' | 'error' | 'formula'

export interface Shown {
  text: string
  kind: CellKind
  /** The formula, for a formula cell (shown in the formula bar). */
  formula?: string
}

const general = (n: number): string => {
  if (Number.isInteger(n) && Math.abs(n) < 1e15) return String(n)
  const abs = Math.abs(n)
  if (abs !== 0 && (abs >= 1e11 || abs < 1e-9)) return n.toExponential(5).replace(/\.?0+e/, 'e')
  return String(Number(n.toPrecision(10)))
}

/** The part of a format section outside quotes/brackets, for pattern checks. */
const bare = (s: string) => s.replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '').replace(/\\./g, '')

/** A format section with quoted text, [brackets] and \escapes blanked out (same length), for finding placeholders. */
const mask = (s: string) => s.replace(/"[^"]*"|\[[^\]]*\]|\\./g, (m) => ' '.repeat(m.length))

/** Literal text a section puts before / after the number: "$", "€ ", " USD"… */
function affixes(section: string): [string, string] {
  const lit = (s: string) =>
    [...s.matchAll(/"([^"]*)"|\\(.)|\[\$([^\]-]*)[^\]]*\]|([$€£¥ ])/g)].map((m) => m[1] ?? m[2] ?? m[3] ?? m[4] ?? '').join('')
  const m = mask(section)
  const first = m.search(/[0#?]/)
  if (first < 0) return [lit(section), '']
  let last = first
  for (let i = first; i < m.length; i++) if (/[0#?.,%]/.test(m[i])) last = i
  return [lit(section.slice(0, first)), lit(section.slice(last + 1))]
}

export function formatNumber(n: number, fmt?: string): string {
  if (!fmt || /^general$/i.test(fmt.trim())) return general(n)
  const sections = fmt.split(';')
  let section = sections[0]
  let neg = false
  if (n < 0 && sections.length > 1 && sections[1].trim()) {
    section = sections[1]
    neg = true
  } else if (n === 0 && sections.length > 2 && sections[2].trim()) {
    section = sections[2]
  }
  const b = bare(section)
  if (!/[0#?]/.test(b)) return affixes(section).join('') || general(n) // text-only section
  const pct = b.includes('%')
  const decimals = (b.split('.')[1]?.match(/[0#?]/g) ?? []).length
  const minDecimals = (b.split('.')[1]?.match(/0/g) ?? []).length
  const grouping = /[0#?],[0#?]/.test(b)
  let v = pct ? n * 100 : n
  if (neg) v = Math.abs(v)
  const num = new Intl.NumberFormat('en-US', { minimumFractionDigits: minDecimals, maximumFractionDigits: decimals, useGrouping: grouping }).format(v)
  const [pre, post] = affixes(section)
  const body = `${pre}${num}${post}${pct ? '%' : ''}`
  if (neg && /\(/.test(section) && !/\(/.test(pre)) return `(${body})`
  return body
}

export function formatDate(d: Date, fmt?: string): string {
  const f = bare(fmt ?? '').toLowerCase()
  const hasTime = /h|s/.test(f)
  const hasDate = /[dy]/.test(f) || /m/.test(f.replace(/h+:?m+|m+:?s+/g, ''))
  // ExcelJS gives dates as UTC instants of the wall-clock time in the file.
  const opts: Intl.DateTimeFormatOptions = { timeZone: 'UTC' }
  if (hasDate || !hasTime) Object.assign(opts, { year: 'numeric', month: 'short', day: 'numeric' })
  if (hasTime) Object.assign(opts, { hour: 'numeric', minute: '2-digit' })
  return new Intl.DateTimeFormat('en-US', opts).format(d)
}

/** What a cell shows, from an ExcelJS cell value and its number format. */
export function showCell(value: unknown, numFmt?: string): Shown {
  if (value === null || value === undefined || value === '') return { text: '', kind: 'empty' }
  if (typeof value === 'number') return { text: formatNumber(value, numFmt), kind: 'number' }
  if (typeof value === 'string') return { text: value, kind: 'text' }
  if (typeof value === 'boolean') return { text: value ? 'TRUE' : 'FALSE', kind: 'bool' }
  if (value instanceof Date) return { text: formatDate(value, numFmt), kind: 'date' }
  if (typeof value === 'object') {
    const o = value as Record<string, unknown>
    if (Array.isArray(o.richText)) return { text: (o.richText as { text: string }[]).map((r) => r.text).join(''), kind: 'text' }
    if ('error' in o) return { text: String(o.error), kind: 'error' }
    const formula = (o.formula ?? o.sharedFormula) as string | undefined
    if (formula !== undefined) {
      const res = o.result
      if (res === undefined || res === null) return { text: `=${formula}`, kind: 'formula', formula }
      return { ...showCell(res, numFmt), formula }
    }
    if ('text' in o) return { text: String((o as { text: unknown }).text ?? ''), kind: 'text' }
  }
  return { text: String(value), kind: 'text' }
}

/** 1 → A, 27 → AA. */
export function colName(n: number): string {
  let s = ''
  for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s
  return s
}

/** "B3:D5" → 1-based bounds. */
export function parseRange(ref: string): { r1: number; c1: number; r2: number; c2: number } | null {
  const m = ref.replace(/\$/g, '').match(/^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/i)
  if (!m) return null
  const col = (s: string) => [...s.toUpperCase()].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0)
  const r1 = Number(m[2]), c1 = col(m[1])
  const r2 = m[4] ? Number(m[4]) : r1, c2 = m[3] ? col(m[3]) : c1
  return { r1: Math.min(r1, r2), c1: Math.min(c1, c2), r2: Math.max(r1, r2), c2: Math.max(c1, c2) }
}
