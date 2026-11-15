/** Finding quoted text in rendered DOM (to highlight the text a note is about). */

/**
 * A DOM range for `text` in rendered content (matching across text nodes).
 * Tried exactly first, then ignoring whitespace: a quote selected in one view
 * may have a space where the rendered text has a line break (a paragraph
 * written over several source lines) or nothing at all (between blocks).
 * `fromEnd`: the last occurrence (in a chat, the text noted is most likely in a later message).
 */
export function domRangeOf(root: HTMLElement, text: string, fromEnd = false): Range | null {
  if (!text) return null
  const nodes: Text[] = []
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let n = w.nextNode() as Text | null; n; n = w.nextNode() as Text | null) nodes.push(n)
  if (!nodes.length) return null
  const all = nodes.map((n) => n.data).join('')
  // A quote taken from the Markdown source may carry markup the rendered text doesn't.
  const plain = text.replace(/[*_`~]/g, '').replace(/^#+\s*|^>\s*|^[-+]\s+/gm, '')
  let span: [number, number] | null = null
  for (const q of [text, plain]) {
    const i = q ? (fromEnd ? all.lastIndexOf(q) : all.indexOf(q)) : -1
    if (i >= 0) {
      span = [i, i + q.length]
      break
    }
  }
  if (!span) {
    // Whitespace-blind: match with all whitespace removed, mapped back to positions in `all`.
    const map: number[] = []
    let squeezed = ''
    for (let k = 0; k < all.length; k++) {
      if (!/\s/.test(all[k])) {
        squeezed += all[k]
        map.push(k)
      }
    }
    for (const q of [text, plain].map((s) => s.replace(/\s+/g, ''))) {
      const i = q ? (fromEnd ? squeezed.lastIndexOf(q) : squeezed.indexOf(q)) : -1
      if (i >= 0) {
        span = [map[i], map[i + q.length - 1] + 1]
        break
      }
    }
  }
  if (!span) return null
  const at = (pos: number): [Text, number] => {
    let acc = 0
    for (const n of nodes) {
      if (pos <= acc + n.length) return [n, pos - acc]
      acc += n.length
    }
    const last = nodes[nodes.length - 1]
    return [last, last.length]
  }
  const r = document.createRange()
  r.setStart(...at(span[0]))
  r.setEnd(...at(span[1]))
  return r
}
