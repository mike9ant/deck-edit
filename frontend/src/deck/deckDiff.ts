/**
 * What changed between two versions of a deck — "old" (the base) and "new" — as the user sees it,
 * not as the XML spells it: slides and shapes are paired up, and each pair is compared on what
 * shows (text, position and size, formatting, pictures, chart values, table cells, speaker notes).
 *
 * Pairing: a slide's stable id (`p:sldId`) and a shape's id are strong hints — the same in two
 * versions of one deck, and the same when a script builds a deck again — but not proof (a deck
 * rebuilt in another order can give an id to a different slide), so every id match is checked
 * against the content, and what isn't paired by id is paired by similarity. Slides that really
 * changed places are told from slides that were only renumbered by an insert or delete with a
 * longest-increasing-subsequence, the way code diffs do it.
 *
 * Ignored, so a deck saved again — by PowerPoint, or rebuilt by the same script — shows no diff:
 * part file names and relationship ids, PowerPoint's random creation ids (`extLst`), spell-check
 * and language flags, run splits, attribute order, xml namespace declarations, sub-point position
 * rounding, and the height PowerPoint recomputes for auto-fit text boxes.
 */

import type { PresentationData, SlideData, SlideNode } from '@diceui/pptx-core'
import type { DeckComment } from './comments'

export type ChangeKind = 'added' | 'removed' | 'changed'

export interface Box {
  x: number
  y: number
  w: number
  h: number
  rotation: number
}

/** One shape that was added, removed or changed. */
export interface ShapeDiff {
  kind: ChangeKind
  /** The shape's node id: in the new slide, or (removed) in the old one. */
  id: string
  /** Its id in the old slide (changed shapes). */
  oldId?: string
  /** Where it is (removed: where it was), in slide px. */
  box: Box
  /** Where it was (changed shapes), for marking it on the base version. */
  oldBox?: Box
  /** What it is, in a word or two ("Title", "Picture", "Chart"…). */
  what: string
  /** The changes, short ("+4 −2 words", "moved", "3 values"); empty for added/removed. */
  details: string[]
  /** Its text before and after, when the text changed (to mark the changed words). */
  text?: { old: string; new: string }
  /** The changed words in a few words, when only a few changed. */
  ops?: Op[]
}

export interface SummaryLine {
  kind: ChangeKind
  text: string
  /** The words that changed, with a little context, when only a few did (shown struck / green). */
  ops?: Op[]
  /** What the ops belong to ("Title"), shown before them. */
  what?: string
  /** Words removed and added (shown red / green after `what`). */
  counts?: { added: number; removed: number }
  /** The shapes the line is about: node ids in the new slide (removed shapes: in the old one). */
  ids?: string[]
}

/** A piece of a word diff: words kept, removed or added (spaces included). */
export interface Op {
  k: 'same' | 'add' | 'del'
  t: string
}

/** One row of the comparison: a slide of the new deck, or a removed one (at the place it had). */
export interface SlideDiff {
  status: 'same' | 'changed' | 'added' | 'removed'
  /** 0-based, in the new deck (null: removed). */
  newIndex: number | null
  /** 0-based, in the old deck (null: added). */
  oldIndex: number | null
  newSlide?: string
  oldSlide?: string
  /** It changed places: its 1-based number in the old deck. */
  movedFrom: number | null
  /** What changed, most telling first. */
  lines: SummaryLine[]
  shapes: ShapeDiff[]
  /** The speaker notes before and after, when they changed. */
  notes?: { old: string; new: string }
  /** Every pair of shapes (old id, new id) — changed or not (for placing shapes when merging). */
  pairs?: [string, string][]
  /** Comment threads added, removed or changed (by id). */
  comments?: { kind: ChangeKind; id: string }[]
  /** The slide's own properties changed: layout, background, hidden. */
  props?: boolean
}

export interface DeckDiff {
  rows: SlideDiff[]
  /** Changes to the whole deck (theme, slide size, layouts). */
  deck: string[]
  /** Slides found in both decks. */
  common: number
  /** The decks don't look like versions of one deck (their slide ids were ignored). */
  unrelated: boolean
  counts: { added: number; removed: number; changed: number; moved: number }
}

/** One version of a deck, as the diff reads it. */
export interface DeckSide {
  pres: PresentationData
  /** slide part → stable slide id (`p:sldId`). */
  sldIds: Map<string, string>
  /** slide part → its speaker notes text (optional). */
  notes?: Map<string, string>
  /** slide part → its review comments (optional; slides without any left out). */
  comments?: Map<string, DeckComment[]>
}

// ─── Normalized XML ──────────────────────────────────────────────────────────────────────────────

const IGNORED_ATTRS = new Set(['lang', 'altLang', 'dirty', 'err', 'smtClean', 'smtId', 'noProof', 'bmk', 'kumimoji', 'spcFirstLastPara'])
/**
 * Attributes at their default value — the same as leaving them out. Google Slides (and some other
 * apps) write them all out when they save a deck (`spc="0" u="none" cap="none"`…).
 */
const DEFAULT_ATTRS: Record<string, string> = {
  spc: '0', u: 'none', cap: 'none', strike: 'noStrike', baseline: '0', lvl: '0', rtl: '0', anchorCtr: '0', rtlCol: '0',
  fromWordArt: '0', forceAA: '0', kern: '0',
}
/**
 * Defaults that only go without saying outside placeholders: in a placeholder an explicit zero
 * (or "no bullet") can override what the slide layout gives it.
 */
const PLAIN_DEFAULT_ATTRS: Record<string, string> = {
  indent: '0', marL: '0', marR: '0', anchor: 't', wrap: 'square', b: '0', i: '0',
  // Text margins (after rounding, see INSETS): 0.1" left/right, 0.05" top/bottom.
  lIns: '92000', rIns: '92000', tIns: '46000', bIns: '46000',
}
/** Text margins, rounded to 2000 EMU (0.16 pt): apps round them differently (91440 vs 91425). */
const INSETS = new Set(['lIns', 'rIns', 'tIns', 'bIns'])
/** Elements that add nothing: other scripts' copies of the font (for Latin text), and — outside placeholders — zero spacing, no bullet. */
const IGNORED_ELEMENTS = new Set(['ea', 'cs', 'sym'])
const serializer = typeof XMLSerializer !== 'undefined' ? new XMLSerializer() : null

/**
 * An element as text, minus what doesn't show: ext lists (creation ids), spell/language flags,
 * namespace declarations, attributes at their default value, other scripts' font copies. `plain`:
 * the element belongs to a shape that isn't a placeholder (more defaults go without saying).
 */
function norm(el: Element | null | undefined, dropIds = false, plain = false): string {
  if (!el || !serializer) return ''
  const c = el.cloneNode(true) as Element
  for (const ext of [...c.getElementsByTagNameNS('*', 'extLst')]) ext.remove()
  for (const name of IGNORED_ELEMENTS) for (const e of [...c.getElementsByTagNameNS('*', name)]) e.remove()
  if (plain) {
    for (const e of [...c.getElementsByTagNameNS('*', 'buNone')]) e.remove()
    for (const e of [...c.getElementsByTagNameNS('*', 'noAutofit')]) e.remove() // the default
    for (const tag of ['spcBef', 'spcAft']) {
      for (const e of [...c.getElementsByTagNameNS('*', tag)]) {
        const v = e.firstElementChild
        if (e.children.length === 1 && v && (v.localName === 'spcPts' || v.localName === 'spcPct') && v.getAttribute('val') === '0') e.remove()
      }
    }
  }
  const isDefault = (a: Attr) => DEFAULT_ATTRS[a.localName] === a.value || (plain && PLAIN_DEFAULT_ATTRS[a.localName] === a.value)
  // Attributes in name order: PowerPoint writes the same attributes in another order when it saves
  // a file (`lIns rIns tIns bIns` → `lIns tIns rIns bIns`), which is no change at all.
  const strip = (e: Element) => {
    for (const a of [...e.attributes]) {
      if (INSETS.has(a.localName) && /^\d+$/.test(a.value)) e.setAttribute(a.name, String(Math.round(Number(a.value) / 2000) * 2000))
    }
    const keep = [...e.attributes]
      .filter((a) => !IGNORED_ATTRS.has(a.localName) && !isDefault(a) && !(dropIds && a.localName === 'id' && e.localName === 'cNvPr'))
      .map((a) => [a.name, a.value] as const)
      .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))
    for (const a of [...e.attributes]) e.removeAttribute(a.name)
    for (const [name, value] of keep) e.setAttribute(name, value)
    for (const ch of e.children) strip(ch)
  }
  strip(c)
  return serializer.serializeToString(c).replace(/\s+xmlns(:\w+)?="[^"]*"/g, '')
}
const el = (n: { element: Element | null } | undefined) => n?.element ?? null

// ─── Text ────────────────────────────────────────────────────────────────────────────────────────

type Para = { runs: { text: string; properties?: { element: Element | null } }[]; properties?: { element: Element | null } }
type Body = { paragraphs: Para[]; bodyProperties?: { element: Element | null } } | undefined

const paraText = (p: Para) => p.runs.map((r) => r.text).join('')
const bodyText = (b: Body) => (b ? b.paragraphs.map(paraText).join('\n') : '')

/**
 * The text with its formatting, runs merged where their formatting is the same (run splits don't
 * count). `plain`: not a placeholder (see `norm`).
 */
function bodyStyle(b: Body, plain = false): string {
  if (!b) return ''
  const out: string[] = [norm(el(b.bodyProperties), false, plain)]
  for (const p of b.paragraphs) {
    out.push(`¶${norm(el(p.properties), false, plain)}`)
    let last = '\u0000'
    for (const r of p.runs) {
      if (!r.text) continue
      const s = norm(el(r.properties), false, plain)
      out.push(s === last ? r.text : `‹${s}›${r.text}`)
      last = s
    }
  }
  return out.join('')
}

const words = (t: string) => t.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'’.,%$-]*/gu) ?? []

/** Words added and removed from `a` to `b` (longest common subsequence; long texts: by word counts). */
export function wordDiff(a: string, b: string): { added: number; removed: number } {
  const x = words(a), y = words(b)
  if (x.length * y.length > 250_000) {
    const count = (ws: string[]) => ws.reduce((m, w) => m.set(w, (m.get(w) ?? 0) + 1), new Map<string, number>())
    const cx = count(x), cy = count(y)
    let common = 0
    for (const [w, n] of cx) common += Math.min(n, cy.get(w) ?? 0)
    return { added: y.length - common, removed: x.length - common }
  }
  let prev = new Array<number>(y.length + 1).fill(0)
  for (let i = 1; i <= x.length; i++) {
    const cur = new Array<number>(y.length + 1).fill(0)
    for (let j = 1; j <= y.length; j++) cur[j] = x[i - 1] === y[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1])
    prev = cur
  }
  const lcs = prev[y.length]
  return { added: y.length - lcs, removed: x.length - lcs }
}

const wordsLabel = (d: { added: number; removed: number }) =>
  d.added || d.removed ? [d.added && `+${d.added}`, d.removed && `−${d.removed}`].filter(Boolean).join(' ') + ` word${d.added + d.removed === 1 ? '' : 's'}` : 'text edited'

/** Indexes of `a` kept by a longest common subsequence with `b` (null when too big to work out). */
export function lcsKeep(a: string[], b: string[]): boolean[] | null {
  const n = a.length, m = b.length
  if (n * m > 2_000_000) return null
  const w = m + 1
  const dp = new Int32Array((n + 1) * w)
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) dp[i * w + j] = a[i] === b[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1])
  }
  const keep = new Array<boolean>(n).fill(false)
  let i = 0, j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) { keep[i] = true; i++; j++ }
    else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) i++
    else j++
  }
  return keep
}

/**
 * Word diff of two texts: the words of both in order, in runs kept, removed or added. A run's words
 * are joined with single spaces; runs are shown with a space between them.
 */
export function textOps(a: string, b: string): Op[] {
  const x = a.split(/\s+/).filter(Boolean), y = b.split(/\s+/).filter(Boolean)
  const kx = lcsKeep(x, y), ky = lcsKeep(y, x)
  if (!kx || !ky) return [...(x.length ? [{ k: 'del' as const, t: x.join(' ') }] : []), ...(y.length ? [{ k: 'add' as const, t: y.join(' ') }] : [])]
  const out: Op[] = []
  const push = (k: Op['k'], w: string) => {
    const last = out[out.length - 1]
    if (last?.k === k) last.t += ` ${w}`
    else out.push({ k, t: w })
  }
  let i = 0, j = 0
  while (i < x.length || j < y.length) {
    // At each change, the removed words before the added ones ("old new").
    while (i < x.length && !kx[i]) push('del', x[i++])
    while (j < y.length && !ky[j]) push('add', y[j++])
    if (i < x.length && j < y.length) { push('same', y[j]); i++; j++ }
  }
  return out
}

/**
 * The changed words with a word of context either side, the rest elided ("…") — when at most `max`
 * words changed; else undefined (a count says it better).
 */
export function compactOps(ops: Op[], max = 16): Op[] | undefined {
  const count = (o: Op) => o.t.split(' ').length
  const changed = ops.filter((o) => o.k !== 'same').reduce((n, o) => n + count(o), 0)
  if (!changed || changed > max) return undefined
  return ops.map((o, i) => {
    if (o.k !== 'same') return o
    const ws = o.t.split(' ')
    const first = i === 0, last = i === ops.length - 1
    if (first && last) return o
    if (first) return ws.length > 1 ? { k: 'same', t: `… ${ws[ws.length - 1]}` } : o
    if (last) return ws.length > 1 ? { k: 'same', t: `${ws[0]} …` } : o
    return ws.length > 2 ? { k: 'same', t: `${ws[0]} … ${ws[ws.length - 1]}` } : o
  })
}

/**
 * Speaker notes (or any text) as paragraphs, for showing the change in place: unchanged paragraphs,
 * removed and added ones, and paragraphs edited only in part (with their word diff). A paragraph
 * rewritten from scratch shows as the old one removed and the new one added, not word salad.
 */
export function paragraphOps(a: string, b: string): { k: 'same' | 'add' | 'del' | 'edit'; ops: Op[] }[] {
  const pa = a.split('\n'), pb = b.split('\n')
  const ka = lcsKeep(pa.map((p) => p.trim()), pb.map((p) => p.trim())) ?? pa.map(() => false)
  const kb = lcsKeep(pb.map((p) => p.trim()), pa.map((p) => p.trim())) ?? pb.map(() => false)
  const out: { k: 'same' | 'add' | 'del' | 'edit'; ops: Op[] }[] = []
  let i = 0, j = 0
  while (i < pa.length || j < pb.length) {
    const dels: string[] = [], adds: string[] = []
    while (i < pa.length && !ka[i]) dels.push(pa[i++])
    while (j < pb.length && !kb[j]) adds.push(pb[j++])
    // Pair removed and added paragraphs in order where they're mostly the same text (edited);
    // the rest: removed ones first, then added ones.
    let d = 0
    let pending: string[] = []
    const flush = (upTo: number) => {
      for (const del of dels.slice(d, upTo)) out.push({ k: 'del', ops: [{ k: 'del', t: del }] })
      for (const add of pending) out.push({ k: 'add', ops: [{ k: 'add', t: add }] })
      d = upTo
      pending = []
    }
    for (const add of adds) {
      const k = dels.slice(d).findIndex((del) => jaccard(new Set(words(del)), new Set(words(add))) >= 0.4)
      if (k < 0) {
        pending.push(add)
        continue
      }
      flush(d + k)
      out.push({ k: 'edit', ops: textOps(dels[d], add) })
      d++
    }
    flush(dels.length)
    if (i < pa.length && j < pb.length) { out.push({ k: 'same', ops: [{ k: 'same', t: pb[j] }] }); i++; j++ }
  }
  return out
}

/**
 * What changed in a long text (speaker notes), as a preview: the removed and added text, paragraph
 * by paragraph (an edited paragraph as its changed words), unchanged stretches elided ("…").
 */
export function notesPreview(a: string, b: string): Op[] {
  const out: Op[] = []
  const push = (o: Op) => {
    const last = out[out.length - 1]
    if (o.k === 'same' && last?.k === 'same') return // one "…" for a run of unchanged text
    out.push(o)
  }
  for (const p of paragraphOps(a, b)) {
    if (p.k === 'same') { if (p.ops[0].t.trim()) push({ k: 'same', t: '…' }) }
    else if (p.k === 'edit') for (const o of compactOps(p.ops, Infinity) ?? p.ops) push(o)
    else if (p.ops[0].t.trim()) push(p.ops[0])
  }
  // Both removed and added text: a share of the room for each, so a long removed passage doesn't
  // leave no room for what replaced it.
  if (!out.some((o) => o.k === 'del') || !out.some((o) => o.k === 'add')) return out
  const left = { del: PREVIEW_WORDS.del, add: PREVIEW_WORDS.add }
  const cut: Op[] = []
  for (const o of out) {
    if (o.k === 'same') {
      if (cut[cut.length - 1]?.k !== 'same') cut.push(o)
      continue
    }
    if (left[o.k] <= 0) continue
    const ws = o.t.split(' ')
    cut.push(ws.length > left[o.k] ? { k: o.k, t: `${ws.slice(0, left[o.k]).join(' ')} …` } : o)
    left[o.k] -= ws.length
  }
  return cut
}

/** Words of removed and of added text a notes preview shows when it has both. */
const PREVIEW_WORDS = { del: 6, add: 9 }

/** How alike two token bags are (0–1). */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size && !b.size) return 1
  let common = 0
  for (const t of a) if (b.has(t)) common++
  return common / (a.size + b.size - common)
}

// ─── Media, charts, tables ───────────────────────────────────────────────────────────────────────

function resolvePath(fromDir: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1)
  const parts = fromDir.split('/')
  for (const seg of target.split('/')) {
    if (seg === '..') parts.pop()
    else if (seg && seg !== '.') parts.push(seg)
  }
  return parts.join('/')
}

const hashes = new WeakMap<Uint8Array, string>()
function hashBytes(b: Uint8Array): string {
  let h = hashes.get(b)
  if (h) return h
  let x = 0x811c9dc5
  // Every byte of small images; a sample of big ones (with the length, collisions are not a concern here).
  const step = b.length > 400_000 ? Math.floor(b.length / 200_000) : 1
  for (let i = 0; i < b.length; i += step) x = Math.imul(x ^ b[i], 0x01000193)
  h = `${b.length}:${(x >>> 0).toString(16)}`
  hashes.set(b, h)
  return h
}

/** A picture's bytes (undefined: linked, or not found). */
function pictureBytes(pres: PresentationData, slide: SlideData, n: SlideNode): Uint8Array | undefined {
  if (n.nodeType !== 'picture') return undefined
  const rid = n.blipEmbed ?? n.mediaRId
  const rel = rid ? slide.rels.get(rid) : undefined
  if (!rel) return undefined
  return pres.media.get(resolvePath(slide.id.slice(0, slide.id.lastIndexOf('/')), rel.target))
}

/**
 * What pictures look like: a 16×16 grey thumbnail of each, worked out by `fingerprintPictures`
 * (decoding images is asynchronous) before a diff. The same picture saved again by another app —
 * re-encoded, re-compressed, resized — has other bytes but looks the same.
 */
const looks = new WeakMap<Uint8Array, Uint8Array>()
/** Each decoded picture's size in pixels. */
const pixelSizes = new WeakMap<Uint8Array, { w: number; h: number }>()
const LOOK = 16

/** Work out what each picture of the deck looks like (once per image; where the browser can decode it). */
export async function fingerprintPictures(pres: PresentationData): Promise<void> {
  if (typeof createImageBitmap === 'undefined' || typeof document === 'undefined') return
  const todo = new Set<Uint8Array>()
  for (const slide of pres.slides) {
    for (const n of slide.nodes) {
      const b = pictureBytes(pres, slide, n)
      if (b && !looks.has(b)) todo.add(b)
    }
  }
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = LOOK
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return
  for (const bytes of todo) {
    try {
      const bmp = await createImageBitmap(new Blob([bytes as BlobPart]))
      // Halve step by step: one jump from thousands of pixels to 16 samples a scattered few, so two
      // sizes of one picture (an app downsized it on save) would land on different pixels.
      let src: CanvasImageSource = bmp
      let w = bmp.width, h = bmp.height
      while (w > LOOK * 2 || h > LOOK * 2) {
        w = Math.max(LOOK, Math.ceil(w / 2))
        h = Math.max(LOOK, Math.ceil(h / 2))
        const step = document.createElement('canvas')
        step.width = w
        step.height = h
        const sx = step.getContext('2d')
        if (!sx) break
        sx.imageSmoothingQuality = 'high'
        sx.drawImage(src, 0, 0, w, h)
        src = step
      }
      ctx.imageSmoothingQuality = 'high'
      ctx.fillStyle = '#fff' // (transparent parts as on a white slide)
      ctx.fillRect(0, 0, LOOK, LOOK)
      ctx.drawImage(src, 0, 0, LOOK, LOOK)
      const size = { w: bmp.width, h: bmp.height }
      bmp.close()
      const px = ctx.getImageData(0, 0, LOOK, LOOK).data
      const grey = new Uint8Array(LOOK * LOOK)
      for (let i = 0; i < grey.length; i++) grey[i] = Math.round(0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2])
      looks.set(bytes, grey)
      pixelSizes.set(bytes, size)
    } catch {
      /* not an image the browser decodes (EMF, …): compared by bytes */
    }
  }
}

/** Two pictures look the same: the same bytes, or thumbnails that differ by no more than re-encoding does. */
function samePicture(a: Uint8Array | undefined, b: Uint8Array | undefined): boolean {
  if (!a || !b) return a === b
  if (a === b || (a.length === b.length && hashBytes(a) === hashBytes(b))) return true
  const la = looks.get(a), lb = looks.get(b)
  if (!la || !lb) return false
  let d = 0
  for (let i = 0; i < la.length; i++) d += Math.abs(la[i] - lb[i])
  // Average difference, out of 255: the same picture saved again (re-encoded, downsized) ~3–4;
  // a different picture of a near-identical scene ~20.
  return d / la.length <= 8
}

/** A picture as a token for telling slides apart: what it looks like (coarsely) when known, else its bytes. */
function pictureToken(pres: PresentationData, slide: SlideData, n: SlideNode): string {
  const b = pictureBytes(pres, slide, n)
  if (!b) return n.nodeType === 'picture' ? (n.blipLink ?? '') : ''
  const l = looks.get(b)
  if (!l) return hashBytes(b)
  // 8×8, one bit each: brighter than the picture's average or not.
  const cells: number[] = []
  for (let y = 0; y < LOOK; y += 2) for (let x = 0; x < LOOK; x += 2) cells.push(l[y * LOOK + x] + l[y * LOOK + x + 1] + l[(y + 1) * LOOK + x] + l[(y + 1) * LOOK + x + 1])
  const mean = cells.reduce((a, c) => a + c, 0) / cells.length
  return `look:${cells.map((c) => (c > mean ? '1' : '0')).join('')}`
}

/**
 * Crops that differ only a little are the same: apps round them, and write out zeros. Only a
 * meaningful re-crop (an edge moving by more than CROP_TOL of the picture) counts.
 */
const CROP_TOL = 0.01
function sameCrop(a: { top: number; bottom: number; left: number; right: number } | undefined, b: typeof a): boolean {
  const z = { top: 0, bottom: 0, left: 0, right: 0 }
  const x = a ?? z, y = b ?? z
  return (['top', 'bottom', 'left', 'right'] as const).every((k) => Math.abs(x[k] - y[k]) <= CROP_TOL)
}

interface ChartData {
  kinds: string[]
  series: { name: string; cats: string[]; vals: string[] }[]
  style: string
}

function chartData(pres: PresentationData, n: SlideNode): ChartData | null {
  if (n.nodeType !== 'chart') return null
  const root = el(pres.charts.get(n.chartPath))
  if (!root) return null
  const pts = (e: Element | undefined) => (e ? [...e.getElementsByTagNameNS('*', 'pt')].map((p) => p.getElementsByTagNameNS('*', 'v')[0]?.textContent ?? '') : [])
  const plot = root.getElementsByTagNameNS('*', 'plotArea')[0]
  const kinds = plot ? [...plot.children].map((c) => c.localName).filter((k) => k.endsWith('Chart')) : []
  const series = [...root.getElementsByTagNameNS('*', 'ser')].map((s) => {
    const kid = (name: string) => [...s.children].find((c) => c.localName === name)
    return { name: pts(kid('tx')).join(' ') || kid('tx')?.textContent || '', cats: pts(kid('cat') ?? kid('xVal')), vals: pts(kid('val') ?? kid('yVal')) }
  })
  // Formatting: the chart without its data caches.
  const c = root.cloneNode(true) as Element
  for (const tag of ['numCache', 'strCache', 'externalData']) for (const e of [...c.getElementsByTagNameNS('*', tag)]) e.remove()
  return { kinds, series, style: norm(c) }
}

function chartDetails(a: ChartData | null, b: ChartData | null): string[] {
  if (!a || !b) return a === b ? [] : ['chart changed']
  const out: string[] = []
  if (a.kinds.join() !== b.kinds.join()) out.push('chart type')
  const sa = a.series.length, sb = b.series.length
  if (sb > sa) out.push(`+${sb - sa} series`)
  if (sa > sb) out.push(`−${sa - sb} series`)
  let values = 0, cats = 0, names = 0
  for (let i = 0; i < Math.min(sa, sb); i++) {
    const x = a.series[i], y = b.series[i]
    if (x.name !== y.name) names++
    for (let k = 0; k < Math.max(x.vals.length, y.vals.length); k++) if (x.vals[k] !== y.vals[k]) values++
    if (i === 0) for (let k = 0; k < Math.max(x.cats.length, y.cats.length); k++) if (x.cats[k] !== y.cats[k]) cats++
  }
  if (values) out.push(`${values} value${values > 1 ? 's' : ''}`)
  if (cats) out.push(`${cats} label${cats > 1 ? 's' : ''}`)
  if (names) out.push(`${names} series name${names > 1 ? 's' : ''}`)
  if (!out.length && a.style !== b.style) out.push('chart formatting')
  return out
}

function tableDetails(a: SlideNode, b: SlideNode): string[] {
  if (a.nodeType !== 'table' || b.nodeType !== 'table') return []
  const out: string[] = []
  const ra = a.rows.length, rb = b.rows.length, ca = a.columns.length, cb = b.columns.length
  if (rb !== ra) out.push(`${rb > ra ? '+' : '−'}${Math.abs(rb - ra)} row${Math.abs(rb - ra) > 1 ? 's' : ''}`)
  if (cb !== ca) out.push(`${cb > ca ? '+' : '−'}${Math.abs(cb - ca)} column${Math.abs(cb - ca) > 1 ? 's' : ''}`)
  let cells = 0, style = false
  for (let r = 0; r < Math.min(ra, rb); r++) {
    for (let c = 0; c < Math.min(a.rows[r].cells.length, b.rows[r].cells.length); c++) {
      const x = a.rows[r].cells[c], y = b.rows[r].cells[c]
      if (bodyText(x.textBody as Body) !== bodyText(y.textBody as Body)) cells++
      else if (bodyStyle(x.textBody as Body, true) !== bodyStyle(y.textBody as Body, true) || norm(el(x.properties), false, true) !== norm(el(y.properties), false, true)) style = true
    }
  }
  if (cells) out.push(`${cells} cell${cells > 1 ? 's' : ''}`)
  if (!out.length && (style || a.tableStyleId !== b.tableStyleId || a.columns.join() !== b.columns.join())) out.push('table formatting')
  return out
}

// ─── Shapes ──────────────────────────────────────────────────────────────────────────────────────

/**
 * A shape's outline, as it shows: an explicit "no line" is none (it overrides the shape's style);
 * no line of its own is the style's (`p:style/a:lnRef`), if any.
 */
function lineOf(n: SlideNode): string {
  const line = 'line' in n ? norm(el(n.line)) : ''
  // An explicit "no line" is no line, whatever the style says.
  if (/^<a:ln><a:noFill\/><\/a:ln>$/.test(line)) return ''
  if (line) return line
  // No line of its own: the style's (`p:style/a:lnRef`), if it has one.
  const ref = el(n.source)?.getElementsByTagNameNS('*', 'lnRef')[0]
  return ref && ref.getAttribute('idx') !== '0' ? `style:${norm(ref)}` : ''
}

/** All the text in a node (shapes, table cells, groups). */
export function nodeText(n: SlideNode): string {
  if (n.nodeType === 'shape') return bodyText(n.textBody as Body)
  if (n.nodeType === 'table') return n.rows.map((r) => r.cells.map((c) => bodyText(c.textBody as Body)).join('\t')).join('\n')
  if (n.nodeType === 'group') return [...(el(n.source)?.getElementsByTagNameNS('*', 't') ?? [])].map((t) => t.textContent ?? '').join(' ')
  return ''
}

/** What a shape is, in a word or two. */
function whatIs(n: SlideNode): string {
  const ph = n.placeholder?.type
  if (ph === 'title' || ph === 'ctrTitle') return 'Title'
  if (ph === 'subTitle') return 'Subtitle'
  if (ph === 'sldNum') return 'Slide number'
  if (ph === 'ftr') return 'Footer'
  if (ph === 'dt') return 'Date'
  switch (n.nodeType) {
    case 'picture': return n.isVideo ? 'Video' : n.isAudio ? 'Audio' : 'Picture'
    case 'chart': return 'Chart'
    case 'table': return 'Table'
    case 'group': return 'Group'
    case 'shape': return nodeText(n).trim() ? (n.isTextBox || ph ? 'Text' : 'Shape') : n.presetGeometry === 'line' || /connector/i.test(n.presetGeometry ?? '') ? 'Line' : 'Shape'
    default: return 'Object'
  }
}

const boxOf = (n: SlideNode): Box => ({ x: n.position.x, y: n.position.y, w: n.size.w, h: n.size.h, rotation: n.rotation || 0 })

function iou(a: Box, b: Box): number {
  const x = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x))
  const y = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y))
  const inter = x * y
  const uni = a.w * a.h + b.w * b.h - inter
  return uni > 0 ? inter / uni : a.x === b.x && a.y === b.y ? 1 : 0
}

/**
 * Two boxes in the same place: nearly the same area, or the same top-left corner and width (an
 * auto-fit text box's height is recomputed by whatever app saved it last).
 */
function samePlace(a: Box, b: Box): boolean {
  if (iou(a, b) >= 0.8) return true
  return Math.abs(a.x - b.x) <= 2 && Math.abs(a.y - b.y) <= 2 && Math.abs(a.w - b.w) <= Math.max(2, a.w * 0.02)
}

/** Positions closer than this (slide px, ~0.5 pt) are the same: rounding, not a move. */
const TOL = 0.75

interface ShapeCtx { pres: PresentationData; slide: SlideData }

/** What changed in one shape, short ("moved", "+4 −2 words", "3 values"…); [] when nothing shows. */
function shapeDetails(o: SlideNode, n: SlideNode, oc: ShapeCtx, nc: ShapeCtx): string[] {
  const out: string[] = []
  if (o.nodeType !== n.nodeType) return ['replaced']
  // Content first: it's what a summary should lead with.
  if (n.nodeType === 'shape' && o.nodeType === 'shape') {
    const ta = bodyText(o.textBody as Body), tb = bodyText(n.textBody as Body)
    if (ta !== tb) out.push(wordsLabel(wordDiff(ta, tb)))
    // (The formatting of an empty text box doesn't show.)
    else if ((ta.trim() || tb.trim()) && bodyStyle(o.textBody as Body, !o.placeholder) !== bodyStyle(n.textBody as Body, !n.placeholder)) out.push('text formatting')
    if (o.presetGeometry !== n.presetGeometry || norm(el(o.customGeometry)) !== norm(el(n.customGeometry)) || [...o.adjustments].join() !== [...n.adjustments].join()) out.push('shape')
    if (norm(el(o.fill)) !== norm(el(n.fill)) || lineOf(o) !== lineOf(n) || JSON.stringify([o.headEnd, o.tailEnd]) !== JSON.stringify([n.headEnd, n.tailEnd])) out.push('fill/line')
  } else if (n.nodeType === 'picture' && o.nodeType === 'picture') {
    const pa = pictureBytes(oc.pres, oc.slide, o), pb = pictureBytes(nc.pres, nc.slide, n)
    if (!samePicture(pa, pb)) out.push('replaced')
    else {
      // The same picture, stored at another size (an app downsized it on save): worth knowing.
      const sa = pa && pixelSizes.get(pa), sb = pb && pixelSizes.get(pb)
      if (sa && sb && (sa.w !== sb.w || sa.h !== sb.h)) out.push(`image resized ${sa.w}×${sa.h} → ${sb.w}×${sb.h} px`)
    }
    if (!sameCrop(o.crop, n.crop)) out.push('cropped')
    if (lineOf(o) !== lineOf(n) || o.presetGeometry !== n.presetGeometry) out.push('frame')
  } else if (n.nodeType === 'chart') {
    out.push(...chartDetails(chartData(oc.pres, o), chartData(nc.pres, n)))
  } else if (n.nodeType === 'table') {
    out.push(...tableDetails(o, n))
  } else if (n.nodeType === 'group') {
    const ta = nodeText(o), tb = nodeText(n)
    if (ta !== tb) out.push(wordsLabel(wordDiff(ta, tb)))
    else if (norm(el(o.source), true).replace(/<p:grpSpPr>.*?<\/p:grpSpPr>/, '') !== norm(el(n.source), true).replace(/<p:grpSpPr>.*?<\/p:grpSpPr>/, '')) out.push('contents')
  }
  const moved = Math.abs(o.position.x - n.position.x) > TOL || Math.abs(o.position.y - n.position.y) > TOL
  // An auto-fit text box's height is the app's to set (PowerPoint recomputes it on save): not a resize.
  const autoFit = (x: SlideNode) => x.nodeType === 'shape' && !!el(x.textBody?.bodyProperties)?.getElementsByTagNameNS('*', 'spAutoFit').length
  const resized = Math.abs(o.size.w - n.size.w) > TOL || (Math.abs(o.size.h - n.size.h) > TOL && !(autoFit(o) && autoFit(n)))
  if (moved && resized) out.push('moved, resized')
  else if (moved) out.push('moved')
  else if (resized) out.push('resized')
  if (Math.abs((o.rotation || 0) - (n.rotation || 0)) > 0.1) out.push('rotated')
  if (o.flipH !== n.flipH || o.flipV !== n.flipV) out.push('flipped')
  if (JSON.stringify(o.hlinkClick ?? null) !== JSON.stringify(n.hlinkClick ?? null)) out.push('link')
  return out
}

/** Pair the shapes of two versions of a slide: by id (checked against the content), then name, then likeness. */
function pairShapes(olds: SlideNode[], news: SlideNode[], oc: ShapeCtx, nc: ShapeCtx): [SlideNode, SlideNode][] {
  const pairs: [SlideNode, SlideNode][] = []
  const freeO = new Set(olds), freeN = new Set(news)
  const take = (o: SlideNode, n: SlideNode) => { pairs.push([o, n]); freeO.delete(o); freeN.delete(n) }
  const text = new Map<SlideNode, Set<string>>()
  const tok = (x: SlideNode) => text.get(x) ?? (text.set(x, new Set(words(nodeText(x)))), text.get(x)!)
  const sameMedia = (o: SlideNode, n: SlideNode) => o.nodeType === 'picture' && n.nodeType === 'picture' && samePicture(pictureBytes(oc.pres, oc.slide, o), pictureBytes(nc.pres, nc.slide, n))
  const alike = (o: SlideNode, n: SlideNode) =>
    o.name === n.name || jaccard(tok(o), tok(n)) >= 0.3 || iou(boxOf(o), boxOf(n)) >= 0.3 || sameMedia(o, n) ||
    (!!o.placeholder && o.placeholder.type === n.placeholder?.type && o.placeholder.idx === n.placeholder?.idx)
  const byId = new Map(olds.map((o) => [o.id, o]))
  for (const n of news) {
    const o = byId.get(n.id)
    if (o && freeO.has(o) && o.nodeType === n.nodeType && alike(o, n)) take(o, n)
  }
  // Same placeholder (title, body idx…), then same unique name.
  for (const n of [...freeN]) {
    if (!n.placeholder) continue
    const o = [...freeO].find((x) => x.placeholder && x.placeholder.type === n.placeholder!.type && x.placeholder.idx === n.placeholder!.idx && x.nodeType === n.nodeType)
    if (o) take(o, n)
  }
  for (const n of [...freeN]) {
    const os = [...freeO].filter((x) => x.name === n.name && x.nodeType === n.nodeType)
    if (os.length === 1 && news.filter((x) => x.name === n.name).length === 1) take(os[0], n)
  }
  // The same box in the same place, its contents rewritten (text replaced, picture swapped) —
  // when it's the only one that close on either side, so it's surely the same box.
  const textless = (x: SlideNode) => !nodeText(x).trim()
  for (const n of [...freeN]) {
    const near = [...freeO].filter((o) => o.nodeType === n.nodeType && textless(o) === textless(n) && samePlace(boxOf(o), boxOf(n)))
    if (near.length !== 1) continue
    const o = near[0]
    if ([...freeN].some((x) => x !== n && x.nodeType === o.nodeType && samePlace(boxOf(o), boxOf(x)))) continue
    take(o, n)
  }
  // The rest: most alike first.
  const scored: [number, SlideNode, SlideNode][] = []
  for (const n of freeN) {
    for (const o of freeO) {
      if (o.nodeType !== n.nodeType) continue
      const s = 0.5 * jaccard(tok(o), tok(n)) + 0.3 * iou(boxOf(o), boxOf(n)) + (sameMedia(o, n) ? 0.4 : 0) + (o.name === n.name ? 0.1 : 0)
      if (s >= 0.4) scored.push([s, o, n])
    }
  }
  scored.sort((a, b) => b[0] - a[0])
  for (const [, o, n] of scored) if (freeO.has(o) && freeN.has(n)) take(o, n)
  return pairs
}

// ─── Slides ──────────────────────────────────────────────────────────────────────────────────────

/** A slide's content as tokens: its words, pictures and charts — for telling which slides are the same slide. */
function slideTokens(pres: PresentationData, slide: SlideData): Set<string> {
  const out = new Set<string>()
  for (const n of slide.nodes) {
    for (const w of words(nodeText(n))) out.add(w)
    if (n.nodeType === 'picture') out.add(`img:${pictureToken(pres, slide, n)}`)
    if (n.nodeType === 'chart') out.add(`chart:${chartData(pres, n)?.series.map((s) => s.name).join('|') ?? ''}`)
    if (n.nodeType === 'table') out.add('table')
  }
  return out
}

/** Indexes of a longest increasing subsequence of `xs` (patience sorting). */
function lis(xs: number[]): Set<number> {
  const tails: number[] = [], prev = new Array<number>(xs.length).fill(-1)
  for (let i = 0; i < xs.length; i++) {
    let lo = 0, hi = tails.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (xs[tails[mid]] < xs[i]) lo = mid + 1
      else hi = mid
    }
    if (lo > 0) prev[i] = tails[lo - 1]
    tails[lo] = i
  }
  const out = new Set<number>()
  for (let i = tails.length ? tails[tails.length - 1] : -1; i >= 0; i = prev[i]) out.add(i)
  return out
}

const layoutName = (pres: PresentationData, s: SlideData) => pres.layouts.get(s.layoutIndex)?.name ?? s.layoutIndex

/** The themes of the slide masters (not of the notes or handout pages), in master order. */
function themeOf(pres: PresentationData) {
  const themes = [...pres.masters.keys()].sort().map((m) => pres.themes.get(pres.masterToTheme.get(m) ?? '')).filter((t) => !!t)
  return {
    colors: themes.map((t) => [...t.colorScheme].sort().join()).join('|'),
    fonts: themes.map((t) => `${t.majorFont.latin}/${t.minorFont.latin}`).join('|'),
  }
}

/** A summary line for a shape: "Title: moved" — but for a text box just "moved" (text goes without saying). */
const lineText = (what: string, detail: string) => (what === 'Text' ? detail : `${what}: ${detail}`)

/** What changed between the slides of a matched pair: summary lines and the shapes to mark. */
function slideChanges(old: DeckSide, now: DeckSide, os: SlideData, ns: SlideData): { lines: SummaryLine[]; shapes: ShapeDiff[]; notes?: { old: string; new: string }; pairs: [string, string][]; comments: { kind: ChangeKind; id: string }[]; props: boolean } {
  const commentChanges: { kind: ChangeKind; id: string }[] = []
  const lines: SummaryLine[] = []
  const shapes: ShapeDiff[] = []
  const oc = { pres: old.pres, slide: os }, nc = { pres: now.pres, slide: ns }
  if (layoutName(old.pres, os) !== layoutName(now.pres, ns)) lines.push({ kind: 'changed', text: `Layout: ${layoutName(now.pres, ns)}` })
  if (norm(el(os.background)) !== norm(el(ns.background))) lines.push({ kind: 'changed', text: 'Background' })
  if (!!os.hidden !== !!ns.hidden) lines.push({ kind: 'changed', text: ns.hidden ? 'Hidden' : 'Shown again' })
  const props = lines.length > 0
  const pairs = pairShapes(os.nodes, ns.nodes, oc, nc)
  const pairedO = new Set(pairs.map(([o]) => o)), pairedN = new Set(pairs.map(([, n]) => n))
  const onlyMoved: ShapeDiff[] = []
  for (const [o, n] of pairs) {
    const details = shapeDetails(o, n, oc, nc)
    if (!details.length) continue
    const d: ShapeDiff = { kind: 'changed', id: n.id, oldId: o.id, box: boxOf(n), oldBox: boxOf(o), what: whatIs(n), details }
    const ta = nodeText(o), tb = nodeText(n)
    if (ta !== tb) {
      d.text = { old: ta, new: tb }
      // A few words changed: those words; rewritten: some of the old text and some of the new.
      d.ops = compactOps(textOps(ta, tb)) ?? (ta.trim() && tb.trim() ? notesPreview(ta, tb) : undefined)
    }
    shapes.push(d)
    if (details.every((x) => /^(moved|resized|moved, resized|rotated|flipped)$/.test(x))) onlyMoved.push(d)
    else lines.push({ kind: 'changed', text: lineText(d.what, details.join(', ')), ids: [n.id], ...(d.ops ? { ops: d.ops, ...(d.what !== 'Text' ? { what: d.what } : {}) } : {}) })
  }
  // Shapes that only moved: one line for several.
  if (onlyMoved.length === 1) lines.push({ kind: 'changed', text: lineText(onlyMoved[0].what, onlyMoved[0].details.join(', ')), ids: [onlyMoved[0].id] })
  else if (onlyMoved.length > 1) lines.push({ kind: 'changed', text: `${onlyMoved.length} shapes moved/resized`, ids: onlyMoved.map((d) => d.id) })
  const quote = (n: SlideNode) => {
    const t = nodeText(n).replace(/\s+/g, ' ').trim()
    return t ? ` “${t.length > 18 ? `${t.slice(0, 17)}…` : t}”` : ''
  }
  for (const n of ns.nodes) {
    if (pairedN.has(n)) continue
    const d: ShapeDiff = { kind: 'added', id: n.id, box: boxOf(n), what: whatIs(n), details: [] }
    shapes.push(d)
    lines.push({ kind: 'added', text: d.what === 'Text' && quote(n) ? `Added:${quote(n)}` : `${d.what} added${quote(n)}`, ids: [n.id] })
  }
  for (const o of os.nodes) {
    if (pairedO.has(o)) continue
    const d: ShapeDiff = { kind: 'removed', id: o.id, box: boxOf(o), what: whatIs(o), details: [] }
    shapes.push(d)
    lines.push({ kind: 'removed', text: d.what === 'Text' && quote(o) ? `Removed:${quote(o)}` : `${d.what} removed${quote(o)}`, ids: [o.id] })
  }
  const na = old.notes?.get(os.id), nb = now.notes?.get(ns.id)
  let notes: { old: string; new: string } | undefined
  if (na !== undefined && nb !== undefined && na.trim() !== nb.trim()) {
    notes = { old: na, new: nb }
    const label = !na.trim() ? 'Notes added' : !nb.trim() ? 'Notes removed' : `Notes: ${wordsLabel(wordDiff(na, nb))}`
    const counts = wordDiff(na, nb)
    lines.push({ kind: 'changed', text: label, ops: notesPreview(na, nb), what: na.trim() && nb.trim() ? 'Notes' : label, counts })
  }
  // Review comments: matched by their ids (kept in every copy of the deck).
  if (old.comments && now.comments) {
    const said = (c: DeckComment) => `${c.author}: “${c.text.replace(/\s+/g, ' ').slice(0, 40)}${c.text.length > 40 ? '…' : ''}”`
    const before = new Map((old.comments.get(os.id) ?? []).map((c) => [c.id, c]))
    for (const c of now.comments.get(ns.id) ?? []) {
      const o = before.get(c.id)
      if (!o) { lines.push({ kind: 'added', text: `Comment added: ${said(c)}`, ids: [c.id] }); commentChanges.push({ kind: 'added', id: c.id }); continue }
      before.delete(c.id)
      const what: string[] = []
      if (o.text !== c.text) what.push('edited')
      const n = c.replies.length - o.replies.length
      if (n > 0) what.push(`${n} new repl${n > 1 ? 'ies' : 'y'}`)
      if (n < 0) what.push(`${-n} repl${n < -1 ? 'ies' : 'y'} removed`)
      if (o.resolved !== c.resolved) what.push(c.resolved ? 'resolved' : 'reopened')
      if (what.length) { lines.push({ kind: 'changed', text: `Comment (${c.author}): ${what.join(', ')}`, ids: [c.id] }); commentChanges.push({ kind: 'changed', id: c.id }) }
    }
    for (const o of before.values()) { lines.push({ kind: 'removed', text: `Comment removed: ${said(o)}`, ids: [o.id] }); commentChanges.push({ kind: 'removed', id: o.id }) }
  }
  // The same line for several shapes ("Text: text formatting") once, with a count.
  const counted = new Map<string, { line: SummaryLine; n: number }>()
  for (const l of lines) {
    const k = `${l.kind}\u0000${l.text}\u0000${JSON.stringify(l.ops ?? null)}`
    const c = counted.get(k)
    if (c) {
      c.n++
      c.line = { ...c.line, ids: [...(c.line.ids ?? []), ...(l.ids ?? [])] }
    } else counted.set(k, { line: l, n: 1 })
  }
  const merged = [...counted.values()].map(({ line, n }) => (n > 1 ? { ...line, text: `${line.text} ×${n}` } : line))
  // Content first — text, data and notes changes, then shapes added and removed — then formatting, then position.
  const rank = (l: SummaryLine) =>
    l.text.startsWith('Comment') ? 2.5
    : l.kind === 'added' ? 1 : l.kind === 'removed' ? 2
      : /moved|resized/.test(l.text) && !/word|value|cell|series|replaced|label/.test(l.text) ? 4
        : /formatting|fill\/line|: shape|: frame|: link|: contents|^Background/.test(l.text) && !/word|value|cell|series|replaced|label/.test(l.text) ? 3
          : 0
  merged.sort((a, b) => rank(a) - rank(b))
  return { lines: merged, shapes, notes, pairs: pairs.map(([o, n]) => [o.id, n.id]), comments: commentChanges, props }
}

/** An id pair "looks alike" at this likeness (the share of words, pictures and charts the slides have in common). */
const ID_ALIKE = 0.25
/** An id pair with less in common than this is two different slides that happen to share an id. */
const ID_MIN = 0.1
/** Slides not paired by id are the same slide when at least this alike. */
const LIKENESS = 0.4
/** What a shared id adds to a pair's likeness when choosing pairs. */
const ID_BONUS = 0.25
/** Words (pictures…) on at least this share of all the slides are boilerplate, not content. */
const BOILERPLATE = 0.5

/** Compare two versions of a deck: `old` (the base) → `now`. */
export function diffDecks(old: DeckSide, now: DeckSide): DeckDiff {
  const oSlides = old.pres.slides, nSlides = now.pres.slides
  // What each slide has: its words, pictures and charts — less what most slides of the decks have
  // (footers, the company name, a logo), which would make any two slides look alike.
  const oAll = oSlides.map((s) => slideTokens(old.pres, s)), nAll = nSlides.map((s) => slideTokens(now.pres, s))
  const df = new Map<string, number>()
  for (const t of [...oAll, ...nAll]) for (const w of t) df.set(w, (df.get(w) ?? 0) + 1)
  const common = (oAll.length + nAll.length) * BOILERPLATE
  const strip = (t: Set<string>) => (oAll.length + nAll.length >= 6 ? new Set([...t].filter((w) => df.get(w)! < common)) : t)
  const oTok = oAll.map(strip), nTok = nAll.map(strip)
  const match = new Array<number>(nSlides.length).fill(-1)
  const used = new Set<number>()
  const sim = (i: number, j: number) => jaccard(nTok[i], oTok[j])

  // 1. Same stable slide id. Ids are numbered from 256 in every deck, so in two unrelated decks
  // they pair unrelated slides: they count only when the decks are versions of one deck (most id
  // pairs look alike), and even then not for a pair whose contents have nothing in common.
  const oBySid = new Map<string, number>()
  oSlides.forEach((s, j) => { const sid = old.sldIds.get(s.id); if (sid) oBySid.set(sid, j) })
  const idPairs = nSlides.map((s, i) => [i, oBySid.get(now.sldIds.get(s.id) ?? '') ?? -1]).filter(([, j]) => j >= 0)
  const tiny = (i: number, j: number) => nTok[i].size <= 3 && oTok[j].size <= 3 // too little content to tell
  const alikePairs = idPairs.filter(([i, j]) => sim(i, j) >= ID_ALIKE || tiny(i, j)).length
  const unrelated = idPairs.length >= 3 && alikePairs < idPairs.length / 3
  // 2. Pair the most alike first, a shared id counting for a little more: a slide whose id went
  // to another slide (a deck rebuilt by a script numbers its slides in order) still pairs with the
  // slide it really is; a slide copied in from the other deck, or a similar one, is found too.
  const sameId = new Set(unrelated ? [] : idPairs.map(([i, j]) => `${i}:${j}`))
  const cand: [number, number, number][] = []
  nSlides.forEach((_, i) => {
    oSlides.forEach((__, j) => {
      const s = sim(i, j)
      if (sameId.has(`${i}:${j}`)) { if (s >= ID_MIN || tiny(i, j)) cand.push([s + ID_BONUS, i, j]) }
      else if (s >= LIKENESS) cand.push([s, i, j])
    })
  })
  cand.sort((a, b) => b[0] - a[0])
  for (const [, i, j] of cand) if (match[i] < 0 && !used.has(j)) { match[i] = j; used.add(j) }

  // Slides that changed places (not just renumbered): those outside a longest run in the old order.
  const matched = match.map((j, i) => [i, j]).filter(([, j]) => j >= 0)
  const stay = lis(matched.map(([, j]) => j))
  const moved = new Set(matched.filter((_, k) => !stay.has(k)).map(([i]) => i))

  const rows: (SlideDiff & { key: [number, number, number] })[] = []
  nSlides.forEach((ns, i) => {
    const j = match[i]
    if (j < 0) {
      rows.push({ status: 'added', newIndex: i, oldIndex: null, newSlide: ns.id, movedFrom: null, lines: [{ kind: 'added', text: 'New slide' }], shapes: [], key: [i, 0, 0] })
      return
    }
    const { lines, shapes, notes, pairs, comments, props } = slideChanges(old, now, oSlides[j], ns)
    const movedFrom = moved.has(i) ? j + 1 : null
    rows.push({
      status: lines.length || shapes.length || movedFrom ? 'changed' : 'same',
      newIndex: i, oldIndex: j, newSlide: ns.id, oldSlide: oSlides[j].id, movedFrom, lines, shapes, notes, pairs, comments, props, key: [i, 0, 0],
    })
  })
  // A removed slide goes where it was: after the new place of the old slide before it.
  const newOf = new Map(matched.map(([i, j]) => [j, i]))
  oSlides.forEach((os, j) => {
    if (used.has(j)) return
    let anchor = -1
    for (let k = j - 1; k >= 0; k--) if (newOf.has(k)) { anchor = newOf.get(k)!; break }
    rows.push({ status: 'removed', newIndex: null, oldIndex: j, oldSlide: os.id, movedFrom: null, lines: [{ kind: 'removed', text: `Removed slide (was ${j + 1})` }], shapes: [], key: [anchor, 1, j] })
  })
  rows.sort((a, b) => a.key[0] - b.key[0] || a.key[1] - b.key[1] || a.key[2] - b.key[2])

  const deck: string[] = []
  if (Math.abs(old.pres.width - now.pres.width) > TOL || Math.abs(old.pres.height - now.pres.height) > TOL) deck.push('Slide size changed')
  const ta = themeOf(old.pres), tb = themeOf(now.pres)
  if (ta.colors !== tb.colors) deck.push('Theme colors changed')
  if (ta.fonts !== tb.fonts) deck.push('Theme fonts changed')
  const la = new Set([...old.pres.layouts.values()].map((l) => l.name ?? '')), lb = new Set([...now.pres.layouts.values()].map((l) => l.name ?? ''))
  const addedL = [...lb].filter((x) => !la.has(x)).length, removedL = [...la].filter((x) => !lb.has(x)).length
  if (addedL) deck.push(`${addedL} layout${addedL > 1 ? 's' : ''} added`)
  if (removedL) deck.push(`${removedL} layout${removedL > 1 ? 's' : ''} removed`)

  const out = rows.map(({ key: _key, ...r }) => r)
  return {
    rows: out,
    deck,
    common: matched.length,
    unrelated,
    counts: {
      added: out.filter((r) => r.status === 'added').length,
      removed: out.filter((r) => r.status === 'removed').length,
      changed: out.filter((r) => r.status === 'changed' && (r.lines.length || r.shapes.length)).length,
      moved: out.filter((r) => r.movedFrom != null).length,
    },
  }
}

/** The comparison in words, for the agent (and for copying). */
export function describeDiff(d: DeckDiff, oldName: string, newName: string): string {
  const out: string[] = [`Comparing ${oldName} → ${newName} (from → to).`]
  const { added, removed, changed, moved } = d.counts
  if (!added && !removed && !changed && !moved && !d.deck.length) return `${out[0]}\nNo visible differences.`
  out.push(`${changed} slide${changed === 1 ? '' : 's'} changed, ${added} added, ${removed} removed, ${moved} moved.`)
  if (d.unrelated || !d.common) out.push(d.common ? `The decks look unrelated: only ${d.common} slide${d.common === 1 ? '' : 's'} in common.` : 'The decks have no slides in common.')
  for (const x of d.deck) out.push(`- Deck: ${x}`)
  for (const r of d.rows) {
    if (r.status === 'same') continue
    const at = r.newIndex != null ? `Slide ${r.newIndex + 1}` : `Old slide ${r.oldIndex! + 1}`
    const was = r.movedFrom ? ` (moved from ${r.movedFrom})` : r.status === 'changed' && r.oldIndex !== r.newIndex ? ` (was ${r.oldIndex! + 1})` : ''
    const lines = r.lines.map((l) => l.text)
    out.push(`- ${at}${was}: ${r.status === 'added' ? 'new slide' : r.status === 'removed' ? 'removed' : lines.join('; ') || 'moved'}`)
  }
  return out.join('\n')
}
