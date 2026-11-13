// Round-trip safety check against a real deck: every edit kind the app uses,
// then save, then compare the zip part-by-part with the original.
// Set PDFEDIT_TEST_DECK to a .pptx path; skipped when absent.
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import JSZip from 'jszip'
import { repairPackage } from '../packageHygiene'
import {
  readPptx, buildPresentation, applyEdit, writePptx, copyNodes, materializeAllSlides,
} from '@diceui/pptx-core'

const deckPath = process.env.PDFEDIT_TEST_DECK ?? ''
const out = process.env.PDFEDIT_TEST_OUT ?? '/tmp/pdfedit-roundtrip.pptx'

describe.skipIf(!deckPath || !existsSync(deckPath))('pptx round trip', () => {
  it('only touched parts change', async () => {
    const original = readFileSync(deckPath)
    const buf = original.buffer.slice(original.byteOffset, original.byteOffset + original.byteLength)
    const pres = buildPresentation(await readPptx(buf as ArrayBuffer, { keepSourcePackage: true }))
    materializeAllSlides(pres)
    const s = (i: number) => pres.slides[i]
    console.log('slides', pres.slides.length, 'size', pres.width, pres.height)

    // 1. Move + resize a picture on slide 3.
    const pic = s(2).nodes.find((n) => n.nodeType === 'picture')!
    await applyEdit(pres, { type: 'setNodeTransform', slideId: s(2).id, nodeId: pic.id,
      position: { x: pic.position.x + 20, y: pic.position.y + 10 }, size: { w: pic.size.w * 0.8, h: pic.size.h * 0.8 } })
    // 2. Edit text of the first text shape on slide 1, keeping run formatting.
    const tb = s(0).nodes.find((n) => n.nodeType === 'shape' && (n as any).textBody?.paragraphs?.length)!
    await applyEdit(pres, { type: 'setTextBody', slideId: s(0).id, nodeId: tb.id, paragraphs: [
      { sourceParagraphIndex: 0, runs: [{ text: 'EDITED TITLE', sourceRun: [0, 0] }] },
    ] })
    // 3. Duplicate slide 2, 4. move it to the end, 5. delete slide 5.
    const dup = await applyEdit(pres, { type: 'duplicateSlide', slideId: s(1).id })
    await applyEdit(pres, { type: 'moveSlide', slideId: dup.createdSlideId!, toIndex: pres.slides.length - 1 })
    await applyEdit(pres, { type: 'deleteSlide', slideId: s(4).id })
    // 6. Add an image (reuse a PNG from the deck).
    const png = [...pres.media.entries()].find(([k]) => k.endsWith('.png'))!
    await applyEdit(pres, { type: 'addImage', slideId: s(3).id, data: png[1], contentType: 'image/png',
      position: { x: 50, y: 50 }, size: { w: 120, h: 80 } })
    // 7. Copy a text box from slide 1 and paste it onto slide 4.
    const clip = await copyNodes(pres, s(0).id, [tb.id])
    await applyEdit(pres, { type: 'pasteNodes', slideId: s(3).id, clipboard: clip, offset: { x: 0, y: 0 } })
    // 8. An undo leaves no trace: move then undo on slide 6.
    const n6 = s(5).nodes[0]
    const r = await applyEdit(pres, { type: 'setNodeTransform', slideId: s(5).id, nodeId: n6.id, position: { x: 1, y: 1 } })
    r.undo()

    const raw = await writePptx(pres)
    const { bytes, report } = await repairPackage(raw)
    console.log('hygiene', JSON.stringify(report))
    expect(report.removedNotes).toEqual(['ppt/notesSlides/notesSlide5.xml'])
    expect(report.createdNotes.length).toBe(1)
    // Idempotent: a repaired package needs nothing more.
    expect((await repairPackage(bytes)).report).toEqual({ removedNotes: [], createdNotes: [] })
    writeFileSync(out, bytes)

    const a = await JSZip.loadAsync(original)
    const b = await JSZip.loadAsync(bytes)
    const changed: string[] = [], added: string[] = [], removed: string[] = []
    for (const name of Object.keys(a.files)) {
      if (a.files[name].dir) continue
      const fb = b.file(name)
      if (!fb) { removed.push(name); continue }
      const [x, y] = await Promise.all([a.file(name)!.async('uint8array'), fb.async('uint8array')])
      if (x.length !== y.length || x.some((v, i) => v !== y[i])) changed.push(name)
    }
    for (const name of Object.keys(b.files)) if (!b.files[name].dir && !a.file(name)) added.push(name)
    console.log(JSON.stringify({ changed, added, removed }, null, 1))
    expect(changed.every((n) => /presentation\.xml|\[Content_Types\]|slides\/slide\d+\.xml|_rels\/|app\.xml/.test(n))).toBe(true)
    // No relationship may point at a missing part.
    const dangling: string[] = []
    for (const name of Object.keys(b.files).filter((n) => n.endsWith('.rels'))) {
      const xml = await b.file(name)!.async('string')
      const src = name.replace('_rels/', '').replace(/\.rels$/, '')
      for (const m of xml.matchAll(/<Relationship\b([^>]*?)\/?>/g)) {
        if (/TargetMode="External"/.test(m[1])) continue
        const t = /Target="([^"]*)"/.exec(m[1])![1]
        const parts = t.startsWith('/') ? [] : src.split('/').slice(0, -1)
        for (const seg of t.replace(/^\//, '').split('/')) seg === '..' ? parts.pop() : parts.push(seg)
        if (!b.file(parts.join('/'))) dangling.push(`${name} -> ${t}`)
      }
    }
    expect(dangling).toEqual([])
    expect(changed).not.toContain('ppt/slides/slide6.xml') // undone edit
  }, 120_000)
})
