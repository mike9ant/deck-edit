/**
 * A fallback for chat links (see revealStore.ts): mentions the agent left as plain text —
 * "Michael's ARDD 2025 Talk slide 11", "*report.pdf*, page 3", "slide 4 of the Q3 Plan deck",
 * "plan.md lines 4–9" — become links when the name is one of the project's files.
 *
 * - A mention is a location word (slide / page / p. / line) with a number, and next to it a file
 *   name: just before it ("Deck.pptx — slide 4", "Deck (slide 4)"), or after "of" / "in" / "from";
 *   or "same deck" / "that deck", meaning the file named last in the message.
 * - The name may be written with or without its extension, folder or underscores, in any case,
 *   or shortened to the start of the file name (long enough, and only one file starts so).
 * - Only files of the right kind count: slides are in decks, pages in PDFs (or decks), lines in
 *   text files. A name that could be two files is left alone.
 * - Code, existing links and URLs are never touched.
 */

export interface FileRef {
  path: string
  ext: string
  /** Normalized: the path, the file name, each without the extension too. */
  keys: string[]
  stem: string
}

const norm = (s: string) => s.toLowerCase().replace(/[’‘]/g, "'").replace(/[-–—_\s]+/g, ' ').trim()

const TEXT_EXT = /^(md|markdown|txt|text|csv|tsv|json|ya?ml|toml|py|js|ts|tsx|jsx|html?|css|sh|rs|xml|tex|rst|ini|cfg|log)$/

export function fileRefs(paths: string[]): FileRef[] {
  return paths.map((path) => {
    const name = path.split('/').pop() ?? path
    const dot = name.lastIndexOf('.')
    const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
    const stem = dot > 0 ? name.slice(0, dot) : name
    const noExt = (p: string) => (dot > 0 ? p.slice(0, p.length - ext.length - 1) : p)
    return { path, ext, stem: norm(stem), keys: [...new Set([norm(path), norm(noExt(path)), norm(name), norm(stem)])] }
  })
}

type Kind = 'slide' | 'page' | 'line'
const fits = (kind: Kind, ext: string) => (kind === 'slide' ? ext === 'pptx' : kind === 'page' ? ext === 'pdf' || ext === 'pptx' : TEXT_EXT.test(ext))

/** The one file `text` names (exactly, or as a long enough start of its name), or null. */
export function matchFile(text: string, refs: FileRef[], kind: Kind): FileRef | null {
  const n = norm(text)
  if (n.length < 3) return null
  const ok = refs.filter((r) => fits(kind, r.ext))
  const exact = ok.filter((r) => r.keys.includes(n))
  if (exact.length) return exact.length === 1 ? exact[0] : null
  const starts = ok.filter((r) => r.stem.startsWith(n) && !/[a-z0-9]/.test(r.stem[n.length] ?? ''))
  if (starts.length !== 1) return null
  return n.length >= 12 || n.length >= 0.6 * starts[0].stem.length ? starts[0] : null
}

/** Code, links, autolinks / HTML and URLs: left exactly as written. */
const PROTECTED = /```[\s\S]*?(?:```|$)|`[^`\n]*`|!?\[[^\]\n]*\]\([^)\n]*\)|<[^>\n]*>|https?:\/\/[^\s)]+/g
const ANCHOR = /\b(slides?|pages?|pp?\.|lines?)\s*(\d+)(?:\s*(?:-|–|—|to)\s*(\d+))?\b/gi
/** What may sit between a name and its location word ("*Talk*: slide 4", "Talk's slide 4", "Talk — slide 4", "Talk (slide 4)"). */
const GAP_END = /(?:'s|’s)?[\s,:;*_"”’')(·\-–—]*$/i
/** "same deck, slide 12": the deck named last in the message. */
const SAME_FILE = /\b(?:the\s+)?(?:same|that|this)\s+(?:deck|presentation|pdf|file|document|doc)[\s,:;·(\-–—]*$/i
/** A word after the name that isn't part of it ("the Q3 Plan deck, slide 4"). */
const KIND_WORD = /\s+(?:deck|presentation|pdf|file|doc|document)$/i
const CLOSERS = /[\s,.;:!?)*_"”’']+$/
/** The name as written, and without a trailing "deck" / "PDF" / … word. */
const nameVariants = (s: string) => {
  const a = s.replace(CLOSERS, '')
  const b = a.replace(KIND_WORD, '').replace(CLOSERS, '')
  return b !== a ? [a, b] : [a]
}
const OPENERS = /[*_"“‘'([]/
const WINDOW = 120

export function autoLink(md: string, refs: FileRef[]): string {
  if (!refs.length || !/\b(slide|page|p\.|line)/i.test(md)) return md
  const state: { last: FileRef | null } = { last: null }
  let out = ''
  let last = 0
  for (const m of md.matchAll(PROTECTED)) {
    out += linkPlain(md.slice(last, m.index), refs, state) + m[0]
    last = m.index! + m[0].length
    // A link the agent wrote itself counts as the last file named ("…, and the same deck's slide 4").
    const target = m[0].match(/^\[[^\]]*\]\(<?([^)>#]+)/)?.[1]
    if (target) {
      let path = target
      try { path = decodeURIComponent(target) } catch { /* as written */ }
      state.last = refs.find((r) => r.path === path) ?? state.last
    }
  }
  return out + linkPlain(md.slice(last), refs, state)
}

function linkPlain(seg: string, refs: FileRef[], state: { last: FileRef | null }): string {
  let out = ''
  let done = 0
  for (const m of seg.matchAll(ANCHOR)) {
    const at = m.index!
    if (at < done) continue
    const word = m[1].toLowerCase()
    const kind: Kind = word.startsWith('slide') ? 'slide' : word.startsWith('line') ? 'line' : 'page'
    const end = at + m[0].length
    let hit = nameBefore(seg, Math.max(done, at - WINDOW), at, refs, kind) ?? nameAfter(seg, end, refs, kind)
    if (!hit && state.last && fits(kind, state.last.ext)) {
      const lineStart = Math.max(done, seg.lastIndexOf('\n', at - 1) + 1)
      const same = seg.slice(lineStart, at).match(SAME_FILE)
      if (same) hit = { ref: state.last, from: lineStart + same.index!, to: at }
    }
    if (!hit) continue
    const from = Math.min(hit.from, at)
    let to = Math.max(hit.to, end)
    let label = seg.slice(from, to)
    // "Talk (slide 4)": the closing parenthesis goes in the link with its opening one.
    if ((label.match(/\(/g) ?? []).length > (label.match(/\)/g) ?? []).length && seg[to] === ')') label = seg.slice(from, ++to)
    if (/[[\]\n]/.test(label)) continue
    const a = Number(m[2])
    const b = m[3] ? Number(m[3]) : undefined
    const frag = kind === 'line' ? `line=${a}${b && b > a ? `-${b}` : ''}` : kind === 'page' && hit.ref.ext === 'pdf' ? `page=${a}` : `slide=${a}`
    out += `${seg.slice(done, from)}[${label}](<${hit.ref.path}#${frag}>)`
    state.last = hit.ref
    done = to
  }
  return out + seg.slice(done)
}

/** A file name ending just before `at` (the longest that names one file). */
function nameBefore(seg: string, lo: number, at: number, refs: FileRef[], kind: Kind) {
  const nl = seg.lastIndexOf('\n', at - 1)
  const start = Math.max(lo, nl + 1)
  const before = seg.slice(start, at)
  const gap = before.match(GAP_END)
  const body = gap ? before.slice(0, before.length - gap[0].length) : before
  if (!body) return null
  for (let s = 0; s < body.length; s++) {
    if (s > 0 && !/[\s([/“"‘'*_]/.test(body[s - 1])) continue
    if (/\s/.test(body[s])) continue
    const name = body.slice(s).replace(/^[*_"“‘'([]+/, '')
    const ref = nameVariants(name).map((v) => matchFile(v, refs, kind)).find(Boolean)
    if (!ref) continue
    // Take any opening emphasis / quote marks into the link with it (their closers are in the gap).
    let from = start + s
    while (from > start && OPENERS.test(seg[from - 1])) from--
    return { ref, from, to: at }
  }
  return null
}

/** "slide 4 of the Q3 Plan deck": a file name after "of" / "in" / "from" (the longest that names one file). */
function nameAfter(seg: string, end: number, refs: FileRef[], kind: Kind) {
  const lead = seg.slice(end).match(/^\s+(?:of|in|from)\s+(?:the\s+)?/i)
  if (!lead) return null
  const s = end + lead[0].length
  const nl = seg.indexOf('\n', s)
  const rest = seg.slice(s, Math.min(nl < 0 ? seg.length : nl, s + WINDOW))
  const open = rest.match(/^[*_"“‘']*/)![0]
  for (let e = rest.length; e > open.length; e--) {
    if (e < rest.length && !/[\s,.;:!?)*_"”’']/.test(rest[e])) continue
    const variants = nameVariants(rest.slice(open.length, e))
    const i = variants.findIndex((v) => v && matchFile(v, refs, kind))
    if (i < 0) continue
    const name = variants[i]
    const ref = matchFile(name, refs, kind)!
    // Include closing emphasis / quote marks that match the opening ones.
    let to = s + open.length + name.length
    const closers = seg.slice(to).match(/^[*_"”’']*/)![0]
    if (open) to += Math.min(closers.length, open.length)
    return { ref, from: end, to }
  }
  return null
}
