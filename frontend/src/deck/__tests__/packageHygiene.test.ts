import JSZip from 'jszip'
import { repairPackage } from '../packageHygiene'

const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const rels = (items: [string, string, string][]) =>
  `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items
    .map(([id, type, target]) => `<Relationship Id="${id}" Type="${R}/${type}" Target="${target}"/>`)
    .join('')}</Relationships>`

/** slide1 + its notes; slide2 = a duplicate of slide1 pointing at notes1; notes3 belongs to a deleted slide3. */
async function fixture() {
  const z = new JSZip()
  z.file('[Content_Types].xml', '<Types><Override PartName="/ppt/notesSlides/notesSlide1.xml" ContentType="x"/><Override PartName="/ppt/notesSlides/notesSlide3.xml" ContentType="x"/></Types>')
  z.file('ppt/slides/slide1.xml', '<sld/>')
  z.file('ppt/slides/slide2.xml', '<sld/>')
  z.file('ppt/slides/_rels/slide1.xml.rels', rels([['rId1', 'notesSlide', '../notesSlides/notesSlide1.xml']]))
  z.file('ppt/slides/_rels/slide2.xml.rels', rels([['rId1', 'notesSlide', '../notesSlides/notesSlide1.xml']]))
  z.file('ppt/notesSlides/notesSlide1.xml', '<notes>speaker notes</notes>')
  z.file('ppt/notesSlides/_rels/notesSlide1.xml.rels', rels([['rId2', 'slide', '../slides/slide1.xml']]))
  z.file('ppt/notesSlides/notesSlide3.xml', '<notes/>')
  z.file('ppt/notesSlides/_rels/notesSlide3.xml.rels', rels([['rId2', 'slide', '../slides/slide3.xml']]))
  return z.generateAsync({ type: 'uint8array' })
}

describe('repairPackage', () => {
  it('drops orphaned notes pages and gives duplicated slides their own', async () => {
    const { bytes, report } = await repairPackage(await fixture())
    expect(report.removedNotes).toEqual(['ppt/notesSlides/notesSlide3.xml'])
    expect(report.createdNotes).toEqual(['ppt/notesSlides/notesSlide2.xml'])
    const z = await JSZip.loadAsync(bytes)
    expect(z.file('ppt/notesSlides/notesSlide3.xml')).toBeNull()
    expect(await z.file('ppt/slides/_rels/slide2.xml.rels')!.async('string')).toContain('../notesSlides/notesSlide2.xml')
    expect(await z.file('ppt/notesSlides/_rels/notesSlide2.xml.rels')!.async('string')).toContain('../slides/slide2.xml')
    expect(await z.file('ppt/notesSlides/notesSlide2.xml')!.async('string')).toBe('<notes>speaker notes</notes>')
    const ct = await z.file('[Content_Types].xml')!.async('string')
    expect(ct).not.toContain('notesSlide3.xml')
    expect(ct).toContain('/ppt/notesSlides/notesSlide2.xml')
    // Idempotent.
    expect((await repairPackage(bytes)).report).toEqual({ removedNotes: [], createdNotes: [] })
  })

  it('hands a notes page to the duplicate when its original slide was deleted', async () => {
    const z = await JSZip.loadAsync(await fixture())
    z.remove('ppt/slides/slide1.xml')
    z.remove('ppt/slides/_rels/slide1.xml.rels')
    const { bytes } = await repairPackage(await z.generateAsync({ type: 'uint8array' }))
    const out = await JSZip.loadAsync(bytes)
    expect(await out.file('ppt/notesSlides/_rels/notesSlide1.xml.rels')!.async('string')).toContain('../slides/slide2.xml')
    expect(out.file('ppt/notesSlides/notesSlide1.xml')).not.toBeNull()
  })

  it('returns a clean package untouched', async () => {
    const z = await JSZip.loadAsync(await fixture())
    z.remove('ppt/slides/slide2.xml')
    z.remove('ppt/slides/_rels/slide2.xml.rels')
    z.remove('ppt/notesSlides/notesSlide3.xml')
    z.remove('ppt/notesSlides/_rels/notesSlide3.xml.rels')
    const clean = await z.generateAsync({ type: 'uint8array' })
    const { bytes } = await repairPackage(clean)
    expect(bytes).toBe(clean)
  })
})
