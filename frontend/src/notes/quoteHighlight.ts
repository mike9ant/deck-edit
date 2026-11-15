/**
 * Highlight the text open notes are about inside an element (CSS Custom
 * Highlight API — no DOM changes), under a highlight `name` of its own so
 * views don't clear each other's (styles: `::highlight(name)` in index.css).
 */

import { domRangeOf } from '../viewers/textRanges'

/** Set the highlight; returns the cleanup. A quote spanning paragraphs falls back to its first line. */
export function setQuoteHighlight(name: string, root: HTMLElement | null, quotes: string[], fromEnd = false): () => void {
  const reg = (globalThis as { CSS?: { highlights?: Map<string, unknown> } }).CSS?.highlights
  const H = (globalThis as { Highlight?: new (...r: Range[]) => unknown }).Highlight
  if (!reg || !H || !root) return () => {}
  const ranges = quotes
    .map((q) => domRangeOf(root, q, fromEnd) ?? domRangeOf(root, q.split('\n').map((l) => l.trim()).find(Boolean) ?? '', fromEnd))
    .filter((r): r is Range => !!r)
  reg.set(name, new H(...ranges))
  return () => reg.delete(name)
}
