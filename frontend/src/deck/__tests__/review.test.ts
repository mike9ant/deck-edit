// Review + merge on the sample deck: a "To" version made by editing a copy; accepting everything
// turns From into To, rejecting everything leaves From as it was, and the preview with everything
// rejected shows From's content on To's slides.
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { readPptx, buildPresentation, applyEdit, writePptx, materializeAllSlides } from '@diceui/pptx-core'
import { diffDecks, type DeckSide } from '../deckDiff'
import { slideIdsFromXml } from '../deckModel'
import { uniqueShapeIds } from '../packageHygiene'
import { readNotes } from '../speakerNotes'
import { mergeDecks } from '../mergeDecks'
import { applyPlan, previewPlan, reviewItems, type Decisions } from '../review'

const deckPath = resolve(process.cwd(), '..', 'sample-project', 'Rabbit Hole Roasters — Investor Deck.pptx')

async function open(bytes: Uint8Array): Promise<DeckSide> {
  const files = await readPptx(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, { keepSourcePackage: true })
  for (const [p, xml] of files.slides) files.slides.set(p, uniqueShapeIds(xml))
  const pres = buildPresentation(files)
  materializeAllSlides(pres)
  const notes = new Map<string, string>()
  for (const s of pres.slides) notes.set(s.id, await readNotes(pres, s).catch(() => ''))
  return { pres, sldIds: slideIdsFromXml(files.presentation, files.presentationRels), notes }
}

async function makeTo(original: Uint8Array): Promise<Uint8Array> {
  const pres = buildPresentation(await readPptx(original.buffer.slice(original.byteOffset, original.byteOffset + original.byteLength) as ArrayBuffer, { keepSourcePackage: true }))
  materializeAllSlides(pres)
  const s = (i: number) => pres.slides[i]
  const title = s(0).nodes.find((n) => n.nodeType === 'shape' && (n as { textBody?: unknown }).textBody)!
  await applyEdit(pres, { type: 'setTextBody', slideId: s(0).id, nodeId: title.id, paragraphs: [{ sourceParagraphIndex: 0, runs: [{ text: 'A reviewed title', sourceRun: [0, 0] }] }] })
  const pic = s(2).nodes.find((n) => n.nodeType === 'picture')!
  await applyEdit(pres, { type: 'setNodeTransform', slideId: s(2).id, nodeId: pic.id, position: { x: pic.position.x + 40, y: pic.position.y }, size: pic.size })
  await applyEdit(pres, { type: 'deleteSlide', slideId: s(4).id })
  await applyEdit(pres, { type: 'moveSlide', slideId: s(1).id, toIndex: pres.slides.length - 1 })
  await applyEdit(pres, { type: 'duplicateSlide', slideId: s(6).id })
  return await writePptx(pres)
}

const quiet = (d: ReturnType<typeof diffDecks>) => d.rows.filter((r) => r.status !== 'same').map((r) => `${r.status} ${r.oldIndex}->${r.newIndex} ${r.lines.map((l) => l.text).join('; ')}`)

describe.skipIf(!existsSync(deckPath))('review merge', () => {
  it('accept all → From becomes To; reject all → From unchanged; preview of rejections shows From content', async () => {
    const fromBytes = new Uint8Array(readFileSync(deckPath))
    const toBytes = await makeTo(fromBytes)
    const from = await open(fromBytes), to = await open(toBytes)
    const d = diffDecks(from, to)
    const items = reviewItems(d)
    expect(items.length).toBeGreaterThan(3)

    const all = (v: 'accept' | 'reject'): Decisions => Object.fromEntries(items.map((i) => [i.key, v]))

    // Accept everything: the result is the To deck.
    const accepted = await mergeDecks(fromBytes, toBytes, applyPlan(d, all('accept'), from.pres, to.pres))
    const a = await open(accepted)
    expect(a.pres.slides.length).toBe(to.pres.slides.length)
    expect(quiet(diffDecks(a, to))).toEqual([])

    // Reject everything: the result is the From deck.
    const rejected = await mergeDecks(fromBytes, toBytes, applyPlan(d, all('reject'), from.pres, to.pres))
    expect(quiet(diffDecks(from, await open(rejected)))).toEqual([])

    // Preview with everything rejected: To's slides, From's content on the slides in both.
    const preview = await open(await mergeDecks(toBytes, fromBytes, previewPlan(d, all('reject'), from.pres, to.pres)))
    const p = diffDecks(from, preview)
    expect(p.rows.filter((r) => r.status === 'changed' && r.shapes.length)).toEqual([])
  }, 60_000)

  it('accepting one text edit changes only that', async () => {
    const fromBytes = new Uint8Array(readFileSync(deckPath))
    const toBytes = await makeTo(fromBytes)
    const from = await open(fromBytes), to = await open(toBytes)
    const d = diffDecks(from, to)
    const titleItem = reviewItems(d).find((i) => i.kind === 'shape' && i.shape?.details.some((x) => /word/.test(x)))!
    const out = await open(await mergeDecks(fromBytes, toBytes, applyPlan(d, { [titleItem.key]: 'accept' }, from.pres, to.pres)))
    const left = quiet(diffDecks(from, out))
    expect(left).toHaveLength(1)
    expect(left[0]).toMatch(/word/)
  }, 60_000)
})
