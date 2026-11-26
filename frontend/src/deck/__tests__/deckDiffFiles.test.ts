// Diagnostic: the deck diff on two real decks, printed as the agent gets it. Skipped unless
// DECKEDIT_DIFF_A (before) and DECKEDIT_DIFF_B (after) name two .pptx files.
import { readFileSync, writeFileSync } from 'node:fs'
import { readPptx, buildPresentation, materializeAllSlides } from '@diceui/pptx-core'
import { diffDecks, describeDiff, type DeckSide } from '../deckDiff'
import { slideIdsFromXml } from '../deckModel'
import { uniqueShapeIds } from '../packageHygiene'
import { readNotes } from '../speakerNotes'
import { readDeckComments } from '../comments'
import { mergeDecks } from '../mergeDecks'
import { applyPlan, reviewItems } from '../review'

const A = process.env.DECKEDIT_DIFF_A, B = process.env.DECKEDIT_DIFF_B

async function side(path: string | Uint8Array): Promise<DeckSide> {
  const b = typeof path === 'string' ? readFileSync(path) : path
  const files = await readPptx(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer, { keepSourcePackage: true })
  for (const [p, xml] of files.slides) files.slides.set(p, uniqueShapeIds(xml))
  const pres = buildPresentation(files)
  materializeAllSlides(pres)
  const notes = new Map<string, string>()
  for (const s of pres.slides) notes.set(s.id, await readNotes(pres, s).catch(() => ''))
  return { pres, sldIds: slideIdsFromXml(files.presentation, files.presentationRels), notes, comments: await readDeckComments(pres) }
}

describe.skipIf(!A || !B)('deck diff on two given decks', () => {
  it('prints the comparison', async () => {
    const d = diffDecks(await side(A!), await side(B!))
    console.log(describeDiff(d, A!.split('/').pop()!, B!.split('/').pop()!))
  }, 120_000)

  it('accepting everything turns A into B', async () => {
    const a = await side(A!), b = await side(B!)
    const d = diffDecks(a, b)
    const all = Object.fromEntries(reviewItems(d).map((i) => [i.key, 'accept' as const]))
    const merged = await mergeDecks(readFileSync(A!), readFileSync(B!), applyPlan(d, all, a.pres, b.pres))
    if (process.env.DECKEDIT_MERGE_OUT) writeFileSync(process.env.DECKEDIT_MERGE_OUT, merged)
    const left = diffDecks(await side(merged), b)
    console.log('LEFT AFTER ACCEPT-ALL:', describeDiff(left, 'merged', 'B'))
  }, 240_000)
})
