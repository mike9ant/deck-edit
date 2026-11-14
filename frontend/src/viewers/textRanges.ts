/** Finding quoted text in rendered DOM (to highlight the text a note is about). */

export /** A DOM range for `text` in rendered content (matching across text nodes). */
function domRangeOf(root: HTMLElement, text: string): Range | null {
  if (!text) return null
  const nodes: Text[] = []
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let n = w.nextNode() as Text | null; n; n = w.nextNode() as Text | null) nodes.push(n)
  const all = nodes.map((n) => n.data).join('')
  let i = all.indexOf(text)
  // A quote taken from the Markdown source may carry markup the rendered text doesn't.
  if (i < 0) text = text.replace(/[*_`~]/g, '').replace(/^#+\s*|^>\s*|^[-+]\s+/gm, '')
  if (i < 0) i = all.indexOf(text)
  if (i < 0 || !text) return null
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
  const [a, ao] = at(i)
  const [b, bo] = at(i + text.length)
  r.setStart(a, ao)
  r.setEnd(b, bo)
  return r
}
