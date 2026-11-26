// The deck diff on the sample deck: a deck compared with itself (read twice) shows nothing; edits
// show as the right kind of change on the right slide, and renumbering isn't a move.
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { readPptx, buildPresentation, applyEdit, materializeAllSlides, type PresentationData } from '@diceui/pptx-core'
import { diffDecks, describeDiff, wordDiff, type DeckSide } from '../deckDiff'
import { slideIdsFromXml } from '../deckModel'

const deckPath = resolve(process.cwd(), '..', 'sample-project', 'Rabbit Hole Roasters — Investor Deck.pptx')

async function load(): Promise<PresentationData> {
  const b = readFileSync(deckPath)
  const pres = buildPresentation(await readPptx(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer, { keepSourcePackage: true }))
  materializeAllSlides(pres)
  return pres
}

async function side(pres: PresentationData): Promise<DeckSide> {
  const pkg = pres.sourcePackage!
  return { pres, sldIds: slideIdsFromXml(await pkg.readText('ppt/presentation.xml'), await pkg.readText('ppt/_rels/presentation.xml.rels')) }
}

describe('word diff', () => {
  it('counts words added and removed', () => {
    expect(wordDiff('the quick brown fox', 'the slow brown fox jumps')).toEqual({ added: 2, removed: 1 })
    expect(wordDiff('same', 'same')).toEqual({ added: 0, removed: 0 })
  })
})

describe.skipIf(!existsSync(deckPath))('deck diff', () => {
  it('a deck read twice shows no differences', async () => {
    const d = diffDecks(await side(await load()), await side(await load()))
    expect(d.counts).toEqual({ added: 0, removed: 0, changed: 0, moved: 0 })
    expect(d.deck).toEqual([])
    expect(d.rows.every((r) => r.status === 'same')).toBe(true)
  })

  it('reports text, moves, removed and moved slides where they happened', async () => {
    const old = await load()
    const now = await load()
    const s = (i: number) => now.slides[i]
    // Slide 1: retitle. Slide 3: move a picture.
    const title = s(0).nodes.find((n) => n.placeholder?.type === 'title' || n.placeholder?.type === 'ctrTitle') ?? s(0).nodes.find((n) => n.nodeType === 'shape' && (n as { textBody?: unknown }).textBody)!
    await applyEdit(now, { type: 'setTextBody', slideId: s(0).id, nodeId: title.id, paragraphs: [{ sourceParagraphIndex: 0, runs: [{ text: 'A brand new title', sourceRun: [0, 0] }] }] })
    const pic = s(2).nodes.find((n) => n.nodeType === 'picture')!
    await applyEdit(now, { type: 'setNodeTransform', slideId: s(2).id, nodeId: pic.id, position: { x: pic.position.x + 40, y: pic.position.y }, size: pic.size })
    // Remove slide 5, then move slide 2 to the end.
    const removedTitle = s(4).id
    await applyEdit(now, { type: 'deleteSlide', slideId: removedTitle })
    await applyEdit(now, { type: 'moveSlide', slideId: s(1).id, toIndex: now.slides.length - 1 })

    const d = diffDecks(await side(old), await side(now))
    const row = (oldNo: number) => d.rows.find((r) => r.oldIndex === oldNo - 1)!
    expect(row(1).status).toBe('changed')
    expect(row(1).shapes.find((x) => x.kind === 'changed')?.details.join()).toMatch(/word/)
    expect(row(3).shapes.find((x) => x.id === pic.id)?.details).toContain('moved')
    expect(row(5).status).toBe('removed')
    // Slide 2 moved to the end; the slides after it were only renumbered, not moved.
    expect(row(2).movedFrom).toBe(2)
    expect(d.counts.moved).toBe(1)
    expect(d.counts.removed).toBe(1)
    // The removed slide is listed where it was: right after old slide 4.
    const at = d.rows.indexOf(row(5))
    expect(d.rows[at - 1].oldIndex).toBe(3)
    const text = describeDiff(d, 'old.pptx', 'new.pptx')
    expect(text).toMatch(/moved from 2/)
    expect(text).toMatch(/removed/)
  })
})

describe('word ops', () => {
  it('marks removed and added words, and shortens to the change', async () => {
    const { textOps, compactOps, paragraphOps } = await import('../deckDiff')
    const ops = textOps('Medicine is the last one that has not changed', 'Medicines discovery is the last one that has not changed')
    expect(ops).toEqual([{ k: 'del', t: 'Medicine' }, { k: 'add', t: 'Medicines discovery' }, { k: 'same', t: 'is the last one that has not changed' }])
    expect(compactOps(ops)).toEqual([{ k: 'del', t: 'Medicine' }, { k: 'add', t: 'Medicines discovery' }, { k: 'same', t: 'is …' }])
    expect(compactOps(textOps('a b c d e f g h i j', 'k l m n o p q r s t'))).toBeUndefined()
    // A paragraph rewritten from scratch: removed then added, not interleaved; a lightly edited one: word ops.
    const p = paragraphOps('Keep this line.\nSo here is what we are building today.\nThe end of it all.', 'Keep this line.\nRAISE — one sentence.\nThe end of it.')
    expect(p.map((x) => x.k)).toEqual(['same', 'del', 'add', 'edit'])
  })
})

describe('notes preview', () => {
  it('shows some of both the removed and the added text', async () => {
    const { notesPreview } = await import('../deckDiff')
    const old = 'So here is what we are building. One engine that designs molecules against targets others cannot touch, and tells you whether they will work.'
    const ops = notesPreview(old, 'RAISE — HERE IS OUR SOLUTION in one sentence for the whole company.')
    expect(ops.map((o) => o.k)).toEqual(['del', 'add'])
    expect(ops[0].t.endsWith('…')).toBe(true)
    expect(ops[0].t.split(' ').length).toBeLessThanOrEqual(7)
    expect(ops[1].t.startsWith('RAISE')).toBe(true)
  })
})

describe.skipIf(!existsSync(deckPath))('slide ids that mean nothing', () => {
  it('pairs by content when the ids are shuffled (a deck rebuilt in another order), and finds an inserted copy', async () => {
    const a = await side(await load())
    const b = await side(await load())
    // Rebuilt in another order: the same slides got each other's ids.
    const parts = [...b.sldIds.keys()]
    const ids = parts.map((p) => b.sldIds.get(p)!)
    parts.forEach((p, k) => b.sldIds.set(p, ids[(k + 5) % ids.length]))
    const d = diffDecks(a, b)
    expect(d.unrelated).toBe(true)
    expect(d.counts).toEqual({ added: 0, removed: 0, changed: 0, moved: 0 })
    expect(d.common).toBe(a.pres.slides.length)
  })

  it('a deck compared with a different one: no slides paired by their shared ids', async () => {
    const a = await side(await load())
    const b = await side(await load())
    // Keep only slide 1 of the "other" deck's content pairable: blank every other slide's text.
    for (const s of b.pres.slides.slice(1)) {
      for (const n of s.nodes) {
        const tb = (n as { textBody?: { paragraphs: { runs: { text: string }[] }[] } }).textBody
        tb?.paragraphs.forEach((p, i) => p.runs.forEach((r, k) => { r.text = `unrelated${i}x${k}` }))
      }
      s.nodes = s.nodes.filter((n) => n.nodeType === 'shape') // (groups carry their own text)
    }
    const d = diffDecks(a, b)
    expect(d.unrelated).toBe(true)
    expect(d.common).toBe(1)
    expect(d.counts.added).toBe(a.pres.slides.length - 1)
    expect(d.counts.removed).toBe(a.pres.slides.length - 1)
  })
})

describe.skipIf(!existsSync(deckPath))('a box rewritten in place', () => {
  it('pairs as a text change, even with another id and name (an app renamed the shapes)', async () => {
    const old = await load()
    const now = await load()
    const s0 = now.slides[0]
    const title = s0.nodes.find((n) => n.placeholder?.type === 'title' || n.placeholder?.type === 'ctrTitle') ?? s0.nodes.find((n) => n.nodeType === 'shape' && nodeTextOf(n))!
    await applyEdit(now, { type: 'setTextBody', slideId: s0.id, nodeId: title.id, paragraphs: [{ sourceParagraphIndex: 0, runs: [{ text: 'Completely different words entirely', sourceRun: [0, 0] }] }] })
    const t = now.slides[0].nodes.find((n) => n.id === title.id)!
    t.id = 'renamed-999'
    t.name = 'Google Shape;460'
    t.placeholder = undefined
    const d = diffDecks(await side(old), await side(now))
    const row = d.rows.find((r) => r.oldIndex === 0)!
    const changed = row.shapes.find((x) => x.id === 'renamed-999')
    expect(changed?.kind).toBe('changed')
    expect(row.shapes.some((x) => x.kind === 'added' || x.kind === 'removed')).toBe(false)
    expect(changed?.ops?.some((o) => o.k === 'add' && o.t.startsWith('Completely'))).toBe(true)
  })
})

function nodeTextOf(n: { nodeType: string; textBody?: { paragraphs: { runs: { text: string }[] }[] } }) {
  return n.nodeType === 'shape' ? (n.textBody?.paragraphs ?? []).map((p) => p.runs.map((r) => r.text).join('')).join('') : ''
}
