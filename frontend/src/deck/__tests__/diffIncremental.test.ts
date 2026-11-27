// Re-diffing while editing: the quick (cached per slide version) diff equals a full one after
// slide and notes edits, and a typing preview matches the diff of the text once it's saved.
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readPptx, buildPresentation, applyEdit, materializeAllSlides, type PresentationData } from '@diceui/pptx-core'
import { diffDecks, nodeText, typingPatch, type DeckSide } from '../deckDiff'
import { slideIdsFromXml } from '../deckModel'
import { readNotes, readNotesCached, writeNotes } from '../speakerNotes'

const deckPath = resolve(process.cwd(), '..', 'sample-project', 'Rabbit Hole Roasters — Investor Deck.pptx')

async function load(): Promise<PresentationData> {
  const b = readFileSync(deckPath)
  const pres = buildPresentation(await readPptx(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer, { keepSourcePackage: true }))
  materializeAllSlides(pres)
  return pres
}

async function side(pres: PresentationData, cachedNotes = false): Promise<DeckSide> {
  const pkg = pres.sourcePackage!
  const notes = new Map<string, string>()
  for (const s of pres.slides) notes.set(s.id, await (cachedNotes ? readNotesCached : readNotes)(pres, s))
  return { pres, sldIds: slideIdsFromXml(await pkg.readText('ppt/presentation.xml'), await pkg.readText('ppt/_rels/presentation.xml.rels')), notes }
}

const titleOf = (pres: PresentationData, i: number) =>
  pres.slides[i].nodes.find((n) => n.nodeType === 'shape' && (n as { textBody?: unknown }).textBody && nodeText(n).trim())!

describe.skipIf(!existsSync(deckPath))('incremental deck diff', () => {
  it('quick re-diffs equal full ones after slide and notes edits', async () => {
    const base = await side(await load())
    const live = await load()
    const versions: Record<string, number> = {}
    const same = async () => {
      const quick = diffDecks(base, await side(live, true), versions)
      const full = diffDecks(base, await side(live))
      expect(JSON.stringify(quick)).toBe(JSON.stringify(full))
      return full
    }
    expect((await same()).counts.changed).toBe(0)

    // A slide's text (its version bumps, as deckStore does).
    const s0 = live.slides[0]
    const t = titleOf(live, 0)
    const r = await applyEdit(live, { type: 'setTextBody', slideId: s0.id, nodeId: t.id, paragraphs: [{ sourceParagraphIndex: 0, runs: [{ text: 'A new title for the deck', sourceRun: [0, 0] }] }] })
    for (const id of r.affectedSlideIds) versions[id] = 1
    expect((await same()).counts.changed).toBe(1)

    // Another slide's notes (no version bump: notes edits don't re-render the slide).
    const undo = await writeNotes(live, live.slides[2], 'Fresh notes for slide three')
    expect((await same()).counts.changed).toBe(2)
    undo()
    expect((await same()).counts.changed).toBe(1)

    // A structural change (every slide's version bumps): still the same as a full diff.
    await applyEdit(live, { type: 'moveSlide', slideId: live.slides[1].id, toIndex: live.slides.length - 1 })
    for (const s of live.slides) versions[s.id] = 2
    await same()
  })

  it('a typing preview matches the saved text', async () => {
    const base = await side(await load())
    const live = await load()
    const before = diffDecks(base, await side(live))
    const s0 = live.slides[0]
    const t = titleOf(live, 0)
    const typed = `${nodeText(t)} extra words`
    const preview = typingPatch(before, base, live, { slide: s0.id, node: t.id, text: typed })
    await applyEdit(live, { type: 'setTextBody', slideId: s0.id, nodeId: t.id, paragraphs: [{ sourceParagraphIndex: 0, runs: [{ text: typed, sourceRun: [0, 0] }] }] })
    const saved = diffDecks(base, await side(live))
    const row = (d: typeof saved) => d.rows.find((x) => x.newSlide === s0.id)!
    expect(row(preview).status).toBe('changed')
    expect(row(preview).lines.map((l) => l.text)).toEqual(row(saved).lines.map((l) => l.text))
    expect(row(preview).shapes.find((x) => x.id === t.id)?.text).toEqual(row(saved).shapes.find((x) => x.id === t.id)?.text)

    // Notes typed on slide 3: a notes line, and the notes to show as a diff.
    const s2 = live.slides[2]
    const notes = typingPatch(saved, base, live, { slide: s2.id, text: 'Something else entirely' })
    const r2 = notes.rows.find((x) => x.newSlide === s2.id)!
    expect(r2.notes?.new).toBe('Something else entirely')
    expect(r2.lines.some((l) => /^Notes/.test(l.text))).toBe(true)
    // Typed back to what it was: the slide is the same again.
    const back = typingPatch(notes, base, live, { slide: s2.id, text: base.notes!.get(base.pres.slides[2].id)! })
    expect(back.rows.find((x) => x.newSlide === s2.id)!.status).toBe('same')
  })
})
