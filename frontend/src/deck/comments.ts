/**
 * PowerPoint's review comments, read (not edited) from the retained package:
 *
 * - modern comments (PowerPoint 365, `ppt/comments/modernComment_*.xml`, authors in
 *   `ppt/authors.xml`): a thread per comment — text, author, time, replies, resolved — anchored
 *   to a shape (`ac:spMk`, by its id) or a spot on the slide (`p188:pos`, in EMU);
 * - legacy comments (`ppt/comments/comment*.xml`, authors in `ppt/commentAuthors.xml`): text,
 *   author, time and a spot.
 *
 * A slide finds its comments through its relationships.
 */

import type { PresentationData, SlideData } from '@diceui/pptx-core'

export interface CommentReply {
  author: string
  created?: string
  text: string
}

export interface DeckComment {
  id: string
  author: string
  initials: string
  created?: string
  text: string
  resolved: boolean
  /** The shape it's about (node id), when it names one. */
  shapeId?: string
  /** Where it sits on the slide (slide px), when it says. */
  pos?: { x: number; y: number }
  replies: CommentReply[]
}

const EMU_PER_PX = 9525

function resolvePath(fromDir: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1)
  const parts = fromDir.split('/')
  for (const seg of target.split('/')) {
    if (seg === '..') parts.pop()
    else if (seg && seg !== '.') parts.push(seg)
  }
  return parts.join('/')
}

const parse = (xml: string) => new DOMParser().parseFromString(xml, 'application/xml')
const kids = (e: Element, name: string) => [...e.children].filter((c) => c.localName === name)
const kid = (e: Element, name: string) => kids(e, name)[0]
/** The text of a comment body: its paragraphs, one per line. */
const bodyText = (body: Element | undefined) =>
  body ? [...body.getElementsByTagNameNS('*', 'p')].map((p) => [...p.getElementsByTagNameNS('*', 't')].map((t) => t.textContent ?? '').join('')).join('\n').trim() : ''
const initialsOf = (name: string) => name.split(/\s+/).filter(Boolean).map((w) => w[0]).join('').slice(0, 2).toUpperCase() || '?'

type Author = { name: string; initials: string }

/** Authors of a deck's comments, by id (modern: GUID; legacy: number) — read once per presentation. */
const authorCache = new WeakMap<PresentationData, Promise<Map<string, Author>>>()
function authorsOf(pres: PresentationData): Promise<Map<string, Author>> {
  let p = authorCache.get(pres)
  if (!p) {
    p = (async () => {
      const out = new Map<string, Author>()
      const pkg = pres.sourcePackage
      if (!pkg) return out
      for (const [path, tag] of [['ppt/authors.xml', 'author'], ['ppt/commentAuthors.xml', 'cmAuthor']] as const) {
        const xml = pkg.has(path) ? await pkg.readText(path) : undefined
        if (!xml) continue
        for (const a of parse(xml).getElementsByTagNameNS('*', tag)) {
          const name = a.getAttribute('name') ?? ''
          out.set(a.getAttribute('id') ?? '', { name: name || 'Unknown', initials: a.getAttribute('initials') || initialsOf(name) })
        }
      }
      return out
    })()
    authorCache.set(pres, p)
  }
  return p
}

/** The comments on one slide (oldest first). */
export async function readSlideComments(pres: PresentationData, slide: SlideData): Promise<DeckComment[]> {
  const pkg = pres.sourcePackage
  if (!pkg) return []
  const dir = slide.id.slice(0, slide.id.lastIndexOf('/'))
  const parts = [...slide.rels.values()].filter((r) => /\/comments$/.test(r.type)).map((r) => resolvePath(dir, r.target))
  if (!parts.length) return []
  const authors = await authorsOf(pres)
  const who = (id: string | null) => authors.get(id ?? '') ?? { name: 'Unknown', initials: '?' }
  const out: DeckComment[] = []
  for (const part of parts) {
    const xml = pkg.has(part) ? await pkg.readText(part) : undefined
    if (!xml) continue
    const doc = parse(xml)
    // Modern threads.
    for (const cm of [...doc.getElementsByTagNameNS('*', 'cm')].filter((e) => e.parentElement?.localName === 'cmLst')) {
      if (kid(cm, 'txBody')) {
        const a = who(cm.getAttribute('authorId'))
        const sp = cm.getElementsByTagNameNS('*', 'spMk')[0]
        const pos = kid(cm, 'pos')
        const status = cm.getAttribute('status') ?? ''
        out.push({
          id: cm.getAttribute('id') ?? `${part}#${out.length}`,
          author: a.name,
          initials: a.initials,
          created: cm.getAttribute('created') ?? undefined,
          text: bodyText(kid(cm, 'txBody')),
          resolved: /resolved|closed/i.test(status),
          shapeId: sp?.getAttribute('id') ?? undefined,
          pos: pos ? { x: Number(pos.getAttribute('x')) / EMU_PER_PX, y: Number(pos.getAttribute('y')) / EMU_PER_PX } : undefined,
          replies: [...cm.getElementsByTagNameNS('*', 'reply')].map((r) => {
            const ra = who(r.getAttribute('authorId'))
            return { author: ra.name, created: r.getAttribute('created') ?? undefined, text: bodyText(kid(r, 'txBody')) }
          }),
        })
      } else {
        // Legacy: <p:cm authorId dt idx><p:pos x y/><p:text>…</p:text></p:cm> (pos in 1/8 pt).
        const a = who(cm.getAttribute('authorId'))
        const pos = kid(cm, 'pos')
        out.push({
          // (Not by part name: the same comment in another copy of the deck may sit in another part.)
          id: `legacy:${cm.getAttribute('authorId')}:${cm.getAttribute('idx')}`,
          author: a.name,
          initials: a.initials,
          created: cm.getAttribute('dt') ?? undefined,
          text: (kid(cm, 'text')?.textContent ?? '').trim(),
          resolved: false,
          pos: pos ? { x: (Number(pos.getAttribute('x')) / 8) * (96 / 72), y: (Number(pos.getAttribute('y')) / 8) * (96 / 72) } : undefined,
          replies: [],
        })
      }
    }
  }
  return out.sort((a, b) => (a.created ?? '').localeCompare(b.created ?? ''))
}

/** Every slide's comments, by slide part (slides without comments left out) — worked out once per presentation. */
const deckCache = new WeakMap<PresentationData, Promise<Map<string, DeckComment[]>>>()
export function readDeckComments(pres: PresentationData): Promise<Map<string, DeckComment[]>> {
  let p = deckCache.get(pres)
  if (!p) {
    p = (async () => {
      const out = new Map<string, DeckComment[]>()
      for (const s of pres.slides) {
        const c = await readSlideComments(pres, s).catch(() => [])
        if (c.length) out.set(s.id, c)
      }
      return out
    })()
    deckCache.set(pres, p)
  }
  return p
}

/** "Nov 24, 16:33" (with the year when it isn't this year). */
export function commentTime(iso?: string): string {
  if (!iso) return ''
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`)
  if (Number.isNaN(d.getTime())) return ''
  const sameYear = d.getFullYear() === new Date().getFullYear()
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }), hour: '2-digit', minute: '2-digit' })
}
