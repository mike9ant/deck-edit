/**
 * Editing Markdown in its formatted view without rewriting the file.
 *
 * `rehypeSourceText` wraps every text run of the rendered document in a
 * `<span data-s data-e data-v>` carrying its exact source range and original
 * value. When the user edits text in place, only the runs they changed are
 * written back — each into its own source range (`writeRun`) — so markup,
 * spacing, list markers, tables and everything untouched stay byte-for-byte.
 *
 * Bold/italic toggles work the same way: `**`/`*` are inserted around the
 * selected characters' source (`wrapMark`) or a formatted element's own
 * delimiters are removed (`unwrapMark`) — and `sameVisibleText` checks the
 * result still reads the same, i.e. the delimiters parsed as formatting.
 */

import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'

type HNode = {
  type: string
  tagName?: string
  value?: string
  position?: { start: { offset?: number }; end: { offset?: number } }
  children?: HNode[]
  properties?: Record<string, unknown>
}

/** Where text can be edited: blocks, plus the inline formatting inside them. */
const TEXT_PARENTS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'td', 'th', 'strong', 'em', 'del', 'a'])
/** Containers whose whitespace-only text is just source layout (editable blocks would show it as blank lines). */
/** Formatted elements whose source range is exposed (for removing their delimiters). */
const MARKS = new Set(['strong', 'em'])
const LAYOUT_PARENTS = new Set(['li', 'ul', 'ol', 'table', 'thead', 'tbody', 'tr', 'blockquote'])
const BLOCKS = new Set(['p', 'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'td', 'th', 'blockquote', 'pre', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'input'])

export function rehypeSourceText() {
  return (tree: HNode) => {
    // Top-level blocks carry their source range too ("Copy Markdown" of a selection).
    for (const c of tree.children ?? []) {
      if (c.type === 'element' && c.position?.start.offset != null && c.position.end.offset != null) {
        c.properties = { ...c.properties, dataBs: c.position.start.offset, dataBe: c.position.end.offset }
      }
    }
    const walk = (node: HNode) => {
      if (!node.children || node.tagName === 'code' || node.tagName === 'pre') return
      if (node.tagName && MARKS.has(node.tagName) && node.position?.start.offset != null && node.position.end.offset != null) {
        node.properties = { ...node.properties, dataFs: node.position.start.offset, dataFe: node.position.end.offset }
      }
      if (node.tagName && LAYOUT_PARENTS.has(node.tagName)) {
        // Only whitespace at the edges or beside a block — a space between two formatted words stays.
        const kids = node.children
        const isBlock = (n?: HNode) => !!n?.tagName && BLOCKS.has(n.tagName)
        node.children = kids.filter((c, i) =>
          !(c.type === 'text' && !c.value?.trim() && (i === 0 || i === kids.length - 1 || isBlock(kids[i - 1]) || isBlock(kids[i + 1]))))
      }
      node.children = node.children.map((c) => {
        const s = c.position?.start.offset
        const e = c.position?.end.offset
        if (c.type === 'text' && node.tagName && TEXT_PARENTS.has(node.tagName) && s != null && e != null && c.value?.trim()) {
          return { type: 'element', tagName: 'span', properties: { dataS: s, dataE: e, dataV: c.value }, children: [c] }
        }
        walk(c)
        return c
      })
    }
    walk(tree)
  }
}

export type RunContext = 'text' | 'heading' | 'cell'

/**
 * The source for a text run whose value changed to `text`: escaped so it stays
 * plain text, and keeping each continuation line's prefix (`> ` in quotes,
 * indentation in list items) from the original source.
 */
export function writeRun(src: string, s: number, e: number, text: string, ctx: RunContext): string {
  if (ctx !== 'text') text = text.replace(/\s*\n\s*/g, ' ')
  const slice = src.slice(s, e)
  const prefixes = slice.split('\n').slice(1).map((l) => l.match(/^[ \t>]*/)![0])
  const lastPrefix = prefixes.at(-1) ?? ''
  const lineStart = src.lastIndexOf('\n', s - 1) + 1
  const atLineStart = /^[ \t>]*$/.test(src.slice(lineStart, s))
  return text
    .split('\n')
    .map((line, i) => {
      let l = escapeInline(line, ctx)
      if (i > 0 || atLineStart) l = escapeLineStart(l)
      return i === 0 ? l : (prefixes[i - 1] ?? lastPrefix) + l
    })
    .join('\n')
}

function escapeInline(t: string, ctx: RunContext): string {
  let out = t
    .replace(/\\/g, '\\\\')
    .replace(/([*`[\]~])/g, '\\$1')
    .replace(/<(?=[A-Za-z/!])/g, '\\<')
    // `_` only where it could open/close emphasis (not inside words like snake_case)
    .replace(/(^|[^A-Za-z0-9])_|_(?=$|[^A-Za-z0-9])/g, (m) => m.replace('_', '\\_'))
  if (ctx === 'cell') out = out.replace(/\|/g, '\\|')
  return out
}

/** Text at the start of a line mustn't turn into a heading, quote, list item or rule. */
function escapeLineStart(l: string): string {
  return l
    .replace(/^(\s*)([#>+-])(?=\s|$)/, '$1\\$2')
    .replace(/^(\s*)(#{1,6})(?=\s)/, '$1\\$2')
    .replace(/^(\s*)(\d+)([.)])(?=\s)/, '$1$2\\$3')
}

export interface RunEdit {
  s: number
  e: number
  text: string
  ctx: RunContext
}

/** Apply run edits (non-overlapping source ranges) to the source. */
export function applyRunEdits(src: string, edits: RunEdit[]): string {
  let out = src
  for (const ed of [...edits].sort((a, b) => b.s - a.s)) {
    out = out.slice(0, ed.s) + writeRun(src, ed.s, ed.e, ed.text, ed.ctx) + out.slice(ed.e)
  }
  return out
}

/**
 * The source offset of each character of a run's value, plus one for its end
 * (`value.length + 1` entries) — or null when the run can't be mapped
 * character by character (entities and the like).
 */
export function runSourceMap(src: string, s: number, e: number, value: string): number[] | null {
  const map: number[] = []
  let i = s
  for (let j = 0; j < value.length; j++) {
    // A continuation line's prefix (quote markers, indentation) isn't part of the value.
    if (j > 0 && value[j - 1] === '\n') while (i < e && src[i] !== value[j] && /[ \t>]/.test(src[i])) i++
    if (src[i] === '\\' && src[i + 1] === value[j] && i + 1 < e) {
      map.push(i)
      i += 2
      continue
    }
    if (i >= e || src[i] !== value[j]) return null
    map.push(i)
    i++
  }
  map.push(i)
  return map
}

export type Mark = 'strong' | 'em'

/** Wrap source [a, b) in bold/italic delimiters. */
export function wrapMark(src: string, a: number, b: number, mark: Mark): string {
  const d = mark === 'strong' ? '**' : '*'
  return src.slice(0, a) + d + src.slice(a, b) + d + src.slice(b)
}

/** Remove the delimiters of a bold/italic element spanning source [s, e); null if they aren't plain delimiters. */
export function unwrapMark(src: string, s: number, e: number, mark: Mark): string | null {
  const n = mark === 'strong' ? 2 : 1
  const open = src.slice(s, s + n)
  const close = src.slice(e - n, e)
  const ok = mark === 'strong' ? ['**', '__'] : ['*', '_']
  if (!ok.includes(open) || open !== close || e - s <= 2 * n) return null
  return src.slice(0, s) + src.slice(s + n, e - n) + src.slice(e)
}

/** The document's visible text (what a reader sees, formatting ignored). */
export function visibleText(src: string): string {
  const processor = unified().use(remarkParse).use(remarkGfm)
  let out = ''
  const walk = (n: { type: string; value?: string; children?: unknown[] }) => {
    if (n.type === 'text' || n.type === 'inlineCode' || n.type === 'code') out += n.value ?? ''
    for (const c of (n.children ?? []) as (typeof n)[]) walk(c)
    if (n.type === 'paragraph' || n.type === 'heading' || n.type === 'tableCell') out += '\n'
  }
  walk(processor.parse(src) as never)
  return out
}

/** A formatting toggle is sound when the text still reads the same (no stray `*` left visible). */
export const sameVisibleText = (a: string, b: string) => visibleText(a) === visibleText(b)

/** A bold/italic element's source range, delimiters included. */
export interface MarkRange {
  s: number
  e: number
}

function delimiterOf(src: string, m: MarkRange, mark: Mark): string | null {
  const n = mark === 'strong' ? 2 : 1
  const d = src.slice(m.s, m.s + n)
  const ok = mark === 'strong' ? ['**', '__'] : ['*', '_']
  return ok.includes(d) && src.slice(m.e - n, m.e) === d && m.e - m.s > 2 * n ? d : null
}

/** `t` wrapped in `d`, with its edge whitespace kept outside (delimiters must touch text). */
function wrapTrimmed(t: string, d: string): string {
  if (!t.trim()) return t
  const lead = t.match(/^\s*/)![0]
  const trail = t.match(/\s*$/)![0]
  return lead + d + t.slice(lead.length, t.length - trail.length) + d + trail
}

/**
 * Toggle bold/italic over the source range [a, b) of a selection, given the
 * block's elements of that kind (`marks`):
 * - all of the selection already formatted → remove it from just that part,
 *   re-wrapping what remains of each element on either side;
 * - otherwise → format the whole selection, absorbing elements it overlaps or
 *   touches, even across spaces (so `**old bold** text` + "bold text" →
 *   `**old bold text**`, and `**old** bold` + "bold" → `**old bold**`).
 * Returns null when an element's delimiters aren't plain `**`/`*`/`__`/`_`.
 */
export function toggleMarkRange(src: string, a: number, b: number, marks: MarkRange[], mark: Mark, allMarked: boolean): string | null {
  if (allMarked) {
    let out = src
    for (const m of [...marks].filter((m) => m.s < b && m.e > a).sort((x, y) => y.s - x.s)) {
      const d = delimiterOf(src, m, mark)
      if (!d) return null
      const innerS = m.s + d.length
      const innerE = m.e - d.length
      const oa = Math.max(a, innerS)
      const ob = Math.min(b, innerE)
      const piece = wrapTrimmed(src.slice(innerS, oa), d) + src.slice(oa, ob) + wrapTrimmed(src.slice(ob, innerE), d)
      out = out.slice(0, m.s) + piece + out.slice(m.e)
    }
    return out
  }
  const d = mark === 'strong' ? '**' : '*'
  let a2 = a
  let b2 = b
  const ops: { s: number; e: number; t: string }[] = []
  // Absorb sections the selection overlaps or touches — directly or across just spaces.
  const near = (m: MarkRange) =>
    (m.s <= b && m.e >= a) || (m.e < a && /^[ \t]+$/.test(src.slice(m.e, a))) || (m.s > b && /^[ \t]+$/.test(src.slice(b, m.s)))
  for (const m of marks.filter(near)) {
    const md = delimiterOf(src, m, mark)
    if (!md) return null
    a2 = Math.min(a2, m.s)
    b2 = Math.max(b2, m.e)
    ops.push({ s: m.s, e: m.s + md.length, t: '' }, { s: m.e - md.length, e: m.e, t: '' })
  }
  ops.push({ s: a2, e: a2, t: d }, { s: b2, e: b2, t: d })
  ops.sort((x, y) => x.s - y.s || (x.e - x.s) - (y.e - y.s))
  let out = ''
  let at = 0
  for (const op of ops) {
    out += src.slice(at, op.s) + op.t
    at = Math.max(at, op.e)
  }
  return out + src.slice(at)
}
