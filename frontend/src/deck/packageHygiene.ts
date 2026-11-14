/**
 * Package hygiene: repairs the two relationship problems the PPTX engine
 * (@diceui/pptx-core, which doesn't model speaker-notes pages) leaves behind,
 * applied to the saved bytes before they're written to disk:
 *
 * 1. **Orphaned notes pages** — deleting a slide removes the slide part but
 *    leaves its `notesSlideN.xml`, whose relationship now points at a missing
 *    slide. PowerPoint treats a dangling internal relationship as damage and
 *    offers to "repair" the file. We drop the orphan (part, rels, content type).
 * 2. **Shared notes pages** — duplicating a slide copies its relationships
 *    verbatim, so the copy points at the ORIGINAL's notes page (notes pages
 *    are 1:1 with slides). We give the copy its own notes page, like
 *    PowerPoint's own Duplicate Slide, so the speaker notes travel with it.
 *
 * Idempotent: a clean package comes back unchanged (same bytes, no re-zip).
 */

import JSZip from 'jszip'

const NOTES_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide'
const SLIDE_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide'
const NOTES_CT = 'application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml'

const relsPathFor = (part: string) => {
  const i = part.lastIndexOf('/')
  return `${part.slice(0, i)}/_rels/${part.slice(i + 1)}.rels`
}

/** Resolve a relationship target relative to its source part's folder. */
function resolveTarget(sourcePart: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1)
  const parts = sourcePart.split('/').slice(0, -1)
  for (const seg of target.split('/')) {
    if (seg === '..') parts.pop()
    else if (seg !== '.' && seg !== '') parts.push(seg)
  }
  return parts.join('/')
}

interface Rel {
  id: string
  type: string
  target: string
  external: boolean
}

function parseRels(xml: string): Rel[] {
  const out: Rel[] = []
  for (const m of xml.matchAll(/<Relationship\b([^>]*?)\/?>/g)) {
    const attrs = Object.fromEntries([...m[1].matchAll(/(\w+)="([^"]*)"/g)].map((a) => [a[1], a[2]]))
    out.push({ id: attrs.Id, type: attrs.Type, target: attrs.Target, external: attrs.TargetMode === 'External' })
  }
  return out
}

export interface HygieneReport {
  removedNotes: string[]
  createdNotes: string[]
}

export async function repairPackage(bytes: Uint8Array): Promise<{ bytes: Uint8Array; report: HygieneReport }> {
  const zip = await JSZip.loadAsync(bytes)
  const report: HygieneReport = { removedNotes: [], createdNotes: [] }
  const has = (p: string) => zip.file(p) !== null
  const text = (p: string) => zip.file(p)!.async('string')
  let contentTypes = await text('[Content_Types].xml')

  const notesParts = Object.keys(zip.files).filter((p) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(p))
  const slideParts = Object.keys(zip.files).filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p))

  // notes page → the slide it says it belongs to
  const notesOwner = new Map<string, string>()
  for (const n of notesParts) {
    const rp = relsPathFor(n)
    const rel = has(rp) ? parseRels(await text(rp)).find((r) => r.type === SLIDE_REL) : undefined
    if (rel) notesOwner.set(n, resolveTarget(n, rel.target))
  }

  // notes page → live slides whose relationships point at it
  const referencedBy = new Map<string, string[]>()
  for (const s of slideParts.sort()) {
    const srp = relsPathFor(s)
    if (!has(srp)) continue
    const rel = parseRels(await text(srp)).find((r) => r.type === NOTES_REL && !r.external)
    if (!rel) continue
    const n = resolveTarget(s, rel.target)
    referencedBy.set(n, [...(referencedBy.get(n) ?? []), s])
  }

  // 1. Orphans. A notes page whose own slide is gone but which a duplicate
  //    still points at is handed to that duplicate instead of being dropped.
  for (const [n, owner] of notesOwner) {
    if (has(owner)) continue
    const heir = referencedBy.get(n)?.[0]
    if (heir) {
      const rp = relsPathFor(n)
      zip.file(
        rp,
        (await text(rp)).replace(
          /(<Relationship\b[^>]*Type="[^"]*\/relationships\/slide"[^>]*Target=")[^"]*(")/,
          `$1../slides/${heir.split('/').pop()}$2`,
        ),
      )
      notesOwner.set(n, heir)
      report.createdNotes.push(`${n} (reassigned to ${heir})`)
      continue
    }
    zip.remove(n)
    zip.remove(relsPathFor(n))
    contentTypes = contentTypes.replace(new RegExp(`<Override PartName="/${n}"[^>]*/>`), '')
    notesOwner.delete(n)
    report.removedNotes.push(n)
  }

  // 2. Shared notes pages: a slide whose notes page claims another owner gets a copy.
  let nextIndex =
    Math.max(0, ...Object.keys(zip.files).map((p) => Number(/notesSlide(\d+)\.xml$/.exec(p)?.[1] ?? 0))) + 1
  for (const s of slideParts.sort()) {
    const srp = relsPathFor(s)
    if (!has(srp)) continue
    let relsXml = await text(srp)
    const notesRel = parseRels(relsXml).find((r) => r.type === NOTES_REL && !r.external)
    if (!notesRel) continue
    const notes = resolveTarget(s, notesRel.target)
    if (notesOwner.get(notes) === s) continue
    if (!has(notes)) {
      // Points at a notes page that doesn't exist: drop the relationship.
      relsXml = relsXml.replace(new RegExp(`<Relationship\\b[^>]*Id="${notesRel.id}"[^>]*/>`), '')
      zip.file(srp, relsXml)
      continue
    }
    const copy = `ppt/notesSlides/notesSlide${nextIndex++}.xml`
    zip.file(copy, await zip.file(notes)!.async('uint8array'))
    const nrp = relsPathFor(notes)
    if (has(nrp)) {
      const slideName = s.split('/').pop()!
      const copiedRels = (await text(nrp)).replace(
        /(<Relationship\b[^>]*Type="[^"]*\/relationships\/slide"[^>]*Target=")[^"]*(")/,
        `$1../slides/${slideName}$2`,
      )
      zip.file(relsPathFor(copy), copiedRels)
    }
    contentTypes = contentTypes.replace('</Types>', `<Override PartName="/${copy}" ContentType="${NOTES_CT}"/></Types>`)
    relsXml = relsXml.replace(
      new RegExp(`(<Relationship\\b[^>]*Id="${notesRel.id}"[^>]*Target=")[^"]*(")`),
      `$1../notesSlides/${copy.split('/').pop()}$2`,
    )
    // Attribute order varies between writers; handle Target-before-Id too.
    if (!relsXml.includes(`notesSlides/${copy.split('/').pop()}`)) {
      relsXml = relsXml.replace(
        new RegExp(`(<Relationship\\b[^>]*Target=")[^"]*("[^>]*Id="${notesRel.id}")`),
        `$1../notesSlides/${copy.split('/').pop()}$2`,
      )
    }
    zip.file(srp, relsXml)
    notesOwner.set(copy, s)
    report.createdNotes.push(copy)
  }

  if (!report.removedNotes.length && !report.createdNotes.length) return { bytes, report }
  zip.file('[Content_Types].xml', contentTypes)
  const out = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 } })
  return { bytes: out, report }
}

/**
 * Give every shape on a slide a unique id (`p:cNvPr/@id`). Decks assembled by
 * scripts (python-pptx copying shapes between slides) often repeat ids; the
 * editor addresses shapes by id, so a repeated id would select — and edit —
 * the first shape that has it instead of the one clicked. Like PowerPoint on
 * open, the first shape keeps its id and later duplicates get the next free
 * numbers, in document order (so the result is the same on every load).
 * Applied to the parsed slide text only: a slide is saved with the new ids
 * only when it's edited.
 */
export function uniqueShapeIds(slideXml: string): string {
  const re = /(<p:cNvPr\b[^>]*?\bid=")(\d+)(")/g
  const ids = [...slideXml.matchAll(re)].map((m) => Number(m[2]))
  if (new Set(ids).size === ids.length) return slideXml
  let next = Math.max(0, ...ids)
  const seen = new Set<number>()
  return slideXml.replace(re, (all, a: string, id: string, b: string) => {
    const n = Number(id)
    if (!seen.has(n)) {
      seen.add(n)
      return all
    }
    next += 1
    seen.add(next)
    return `${a}${next}${b}`
  })
}
