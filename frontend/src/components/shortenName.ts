/**
 * File names shortened to fit by dropping whole words from the middle — the words that tell a name
 * apart from its siblings' (the other files in its folder, the other open tabs) stay longest:
 *
 *   "Deep Origin — Ultra Short Investor Deck - WIP_3_a.pptx"  →  "Deep … Ultra Short … WIP_3_a.pptx"
 *
 * Words: split at spaces (a lone "-" / "—" between words is a mark, shown only between two kept
 * words); a long word with underscores / dots is split there too, and a name without spaces is split
 * at its underscores, dashes and dots. Short or numeric pieces stick to their neighbour
 * ("MA_WIP_1", "RAISE_2", "School_5" stay whole). The extension (also ".docx.md") always stays, and
 * so do the first and last words; only when "first … last.ext" doesn't fit are letters cut — from the
 * first word's end, then the last word's start — keeping at least 3 of each.
 */

export interface NameUnit {
  text: string
  /** The separator before it in the name ("" for the first). */
  before: string
  /** A lone dash, bar… between words: shown only when both its neighbours are. */
  mark: boolean
}

const DOC_EXT = /\.(pptx?|potx|docx?|xlsx?|pdf|txt|csv|json|md|key|pages|numbers|html?)$/i
const MARK = /^[-–—|·:+&/]+$/
/** Pieces that stick to a neighbour: short ones ("MA", "WIP", "a", "5R") and bare numbers ("2026"). */
const isCode = (p: string) => p.length <= 3 || /^\d+$/.test(p)

/** "Deck (Short).docx.md" → ["Deck (Short)", ".docx.md"]; no extension for "v1.2" or ".env". */
export function splitExt(name: string): [string, string] {
  const m = /\.[A-Za-z0-9]{1,5}$/.exec(name)
  if (!m || m.index === 0 || !/[A-Za-z]/.test(m[0])) return [name, '']
  let stem = name.slice(0, m.index)
  let ext = m[0]
  const inner = DOC_EXT.exec(stem)
  if (inner && inner.index > 0) {
    ext = inner[0] + ext
    stem = stem.slice(0, inner.index)
  }
  return [stem, ext]
}

/** Split `text` at separator runs (keeping them), then glue code-like pieces to their neighbours. */
function pieces(text: string, sep: RegExp, firstBefore: string): NameUnit[] {
  const raw: { text: string; before: string }[] = []
  let last = 0
  let before = firstBefore
  for (const m of text.matchAll(sep)) {
    if (m.index! > last) raw.push({ text: text.slice(last, m.index), before })
    before = raw.length ? m[0] : before + m[0]
    last = m.index! + m[0].length
  }
  if (last < text.length) raw.push({ text: text.slice(last), before })
  else if (raw.length && last > 0) raw[raw.length - 1].text += before // "name_": its trailing "_" stays on the last piece
  const out: (NameUnit & { lastCode: boolean })[] = []
  for (const p of raw) {
    const prev = out[out.length - 1]
    const mark = MARK.test(p.text)
    // A code-like piece joins the unit before it when that ends in a code-like piece too
    // ("MA" + "WIP" + "1"), or when it has a digit ("RAISE" + "2"; but "Nov17" stands alone).
    if (prev && !prev.mark && !mark && isCode(p.text) && (prev.lastCode || /\d/.test(p.text))) {
      prev.text += p.before + p.text
      prev.lastCode = true
      continue
    }
    out.push({ text: p.text, before: p.before, mark, lastCode: !mark && isCode(p.text) })
  }
  return out.map(({ text, before, mark }) => ({ text, before, mark }))
}

/** A name's stem (no extension) as units. */
export function nameUnits(stem: string): NameUnit[] {
  if (!/\s/.test(stem.trim())) return pieces(stem, /[_\-.]+/g, '')
  const out: NameUnit[] = []
  let last = 0
  let before = ''
  const words: { text: string; before: string }[] = []
  for (const m of stem.matchAll(/\s+/g)) {
    if (m.index! > last) words.push({ text: stem.slice(last, m.index), before })
    before = m[0]
    last = m.index! + m[0].length
  }
  if (last < stem.length) words.push({ text: stem.slice(last), before })
  for (const w of words) {
    if (MARK.test(w.text)) out.push({ ...w, mark: true })
    // A long word with underscores / dots: those act like spaces (code-like pieces still stick).
    else if (w.text.length > 12 && /[_.]/.test(w.text)) out.push(...pieces(w.text, /[_.]+/g, w.before))
    else out.push({ ...w, mark: false })
  }
  return out
}

const key = (u: NameUnit) => u.text.toLowerCase()
const siblingSets = new WeakMap<readonly string[], Map<string, Set<string>>>()

/** A name's words and adjacent word pairs ("ultra|short"; marks skipped), for comparing with siblings. */
function keys(units: NameUnit[]): Set<string> {
  const words = units.filter((u) => !u.mark).map(key)
  return new Set([...words, ...words.slice(1).map((w, i) => `${words[i]}|${w}`)])
}

/**
 * How much each unit tells this name apart from its siblings: 1 for a word none of the related
 * siblings (those sharing any word with it) has, 0 for one they all have. A word they all have can
 * still count through its neighbour — "Short" after "Origin" differs from the siblings' "Ultra Short".
 */
function distinctness(name: string, units: NameUnit[], siblings: readonly string[] | undefined): number[] {
  if (!siblings?.length) return units.map(() => 1)
  let sets = siblingSets.get(siblings)
  if (!sets) {
    sets = new Map(siblings.map((s) => [s, keys(nameUnits(splitExt(s)[0]))]))
    siblingSets.set(siblings, sets)
  }
  const related = [...sets].filter(([s, set]) => s !== name && units.some((u) => !u.mark && set.has(key(u)))).map(([, set]) => set)
  if (!related.length) return units.map(() => 1)
  const rarity = (k: string) => 1 - related.filter((set) => set.has(k)).length / related.length
  const words = units.map((u, i) => ({ u, i })).filter(({ u }) => !u.mark)
  const out = units.map(() => 0)
  words.forEach(({ u, i }, w) => {
    // The pair with the word before it: "Short" after "Origin" vs the siblings' "Ultra Short". It counts
    // only as far as that word is common itself (after a unique word every pair is unique).
    const prev = words[w - 1]?.u
    const pair = prev ? rarity(`${key(prev)}|${key(u)}`) * (1 - rarity(key(prev))) : 0
    out[i] = Math.max(rarity(key(u)), 0.6 * pair)
  })
  return out
}

/** Which units show: kept words, and marks between two kept words. */
function visible(units: NameUnit[], kept: boolean[]): boolean[] {
  return units.map((u, i) => (u.mark ? i > 0 && i < units.length - 1 && kept[i - 1] && kept[i + 1] : kept[i]))
}

const sepChar = (s: string) => (/\s/.test(s) ? ' ' : s.includes('_') ? '_' : s.includes('-') ? '-' : s.includes('.') ? '.' : '')

function render(units: NameUnit[], kept: boolean[], ext: string): string {
  const vis = visible(units, kept)
  let out = ''
  let gapFrom = -1
  units.forEach((u, i) => {
    if (!vis[i]) {
      if (gapFrom < 0) gapFrom = i
      return
    }
    if (!out) out = (i === 0 ? u.before : '') + u.text // a leading "_" stays
    else if (gapFrom >= 0) out += `${sepChar(units[gapFrom].before)}…${sepChar(u.before)}${u.text}`
    else out += u.before + u.text
    gapFrom = -1
  })
  return out + ext
}

const gaps = (units: NameUnit[], kept: boolean[]) => {
  const vis = visible(units, kept)
  return vis.filter((v, i) => !v && (i === 0 || vis[i - 1])).length
}

/**
 * `name` shortened to fit `maxWidth` as measured by `measure` (px), keeping the words that set it
 * apart from `siblings` (names; the same array each time, for caching). Returns `name` if it fits.
 */
export function shortenName(name: string, maxWidth: number, measure: (s: string) => number, siblings?: readonly string[]): string {
  if (measure(name) <= maxWidth + 0.5) return name
  const [stem, ext] = splitExt(name)
  const units = nameUnits(stem)
  const n = units.length
  const fits = (s: string) => measure(s) <= maxWidth + 0.5
  if (n >= 3) {
    const distinct = distinctness(name, units, siblings)
    // Keep longest: the last word (often the version), the first (an anchor), then the words that
    // differ from the siblings — a little more towards the end.
    const score = units.map((_, i) => (i === n - 1 ? 1e6 : i === 0 ? 1e5 : 10 + 40 * distinct[i] + 6 * (i / (n - 1))))
    const kept = units.map(() => true)
    for (;;) {
      if (fits(render(units, kept, ext))) return render(units, kept, ext)
      let best = -1
      let bestCost = Infinity
      const now = gaps(units, kept)
      for (let i = 1; i < n - 1; i++) {
        if (!kept[i] || units[i].mark) continue
        kept[i] = false
        const more = gaps(units, kept) - now
        kept[i] = true
        // A new "…" costs a little (one gap reads better than several); a third one is a last resort.
        const cost = score[i] + (more > 0 ? (now >= 2 ? 500 : 8) : 0)
        if (cost < bestCost) {
          bestCost = cost
          best = i
        }
      }
      if (best < 0) break
      kept[best] = false
    }
  }
  // Letters: "first…last.ext", the first word's end cut first, then the last word's start.
  const first = n > 1 ? units[0].text : stem
  const last = n > 1 ? units[n - 1].text : ''
  if (n <= 1) {
    // One word: cut its middle, a bit more kept at the end.
    for (let k = stem.length - 1; k >= 2; k--) {
      const head = Math.ceil(k * 0.45)
      const s = `${stem.slice(0, head)}…${stem.slice(stem.length - (k - head))}${ext}`
      if (fits(s)) return s
    }
    return `${stem.slice(0, 1)}…${ext}`
  }
  let a = first.length
  let b = last.length
  const make = () => `${first.slice(0, a)}…${last.slice(last.length - b)}${ext}`
  while (!fits(make()) && a > 3) a--
  while (!fits(make()) && b > 3) b--
  return make()
}
