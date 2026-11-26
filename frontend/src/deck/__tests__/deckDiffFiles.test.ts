// Diagnostic: the deck diff on two real decks, printed as the agent gets it. Skipped unless
// DECKEDIT_DIFF_A (before) and DECKEDIT_DIFF_B (after) name two .pptx files.
import { readFileSync } from 'node:fs'
import { readPptx, buildPresentation, materializeAllSlides } from '@diceui/pptx-core'
import { diffDecks, describeDiff, type DeckSide } from '../deckDiff'
import { slideIdsFromXml } from '../deckModel'
import { uniqueShapeIds } from '../packageHygiene'
import { readNotes } from '../speakerNotes'
import { readDeckComments } from '../comments'

const A = process.env.DECKEDIT_DIFF_A, B = process.env.DECKEDIT_DIFF_B

async function side(path: string): Promise<DeckSide> {
  const b = readFileSync(path)
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
})
