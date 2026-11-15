/**
 * Speaker notes (the slide's notes page, `ppt/notesSlides/notesSlideN.xml`).
 * @diceui/pptx-core doesn't model notes pages, so they're read and written
 * here through the retained package — the same way the engine edits
 * relationship parts: read the part's current text, change it, write it back
 * with `setEntry`, and keep the previous text for undo.
 *
 * Writing keeps the notes page's paragraph and run formatting (the first
 * paragraph's `a:pPr` and first run's `a:rPr` template every new line). A
 * slide without a notes page gets one, wired to the deck's notes master.
 */

import type { PresentationData, SlideData } from '@diceui/pptx-core'

const A = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const P = 'http://schemas.openxmlformats.org/presentationml/2006/main'
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const NOTES_REL = `${REL}/notesSlide`
const NOTES_MASTER_REL = `${REL}/notesMaster`
const SLIDE_REL = `${REL}/slide`
const NOTES_CT = 'application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml'
const NOTES_MASTER_CT = 'application/vnd.openxmlformats-officedocument.presentationml.notesMaster+xml'
const THEME_CT = 'application/vnd.openxmlformats-officedocument.theme+xml'
const THEME_REL = `${REL}/theme`
const PKG_RELS_NS = 'http://schemas.openxmlformats.org/package/2006/relationships'

/** A standard notes master (portrait notes page: slide image on top, notes body below). */
const NOTES_MASTER_XML =
  `${'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n'}<p:notesMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">` +
  `<p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>` +
  `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>` +
  `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image Placeholder 1"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg" idx="2"/></p:nvPr></p:nvSpPr>` +
  `<p:spPr><a:xfrm><a:off x="381000" y="685800"/><a:ext cx="6096000" cy="3429000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln w="12700"><a:solidFill><a:prstClr val="black"/></a:solidFill></a:ln></p:spPr></p:sp>` +
  `<p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes Placeholder 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" sz="quarter" idx="3"/></p:nvPr></p:nvSpPr>` +
  `<p:spPr><a:xfrm><a:off x="685800" y="4343400"/><a:ext cx="5486400" cy="4114800"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>` +
  `<p:txBody><a:bodyPr vert="horz" lIns="91440" tIns="45720" rIns="91440" bIns="45720" rtlCol="0"/><a:lstStyle/><a:p><a:pPr lvl="0"/><a:r><a:rPr lang="en-US"/><a:t>Click to edit Master text styles</a:t></a:r></a:p></p:txBody></p:sp>` +
  `</p:spTree></p:cSld>` +
  `<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>` +
  `<p:notesStyle><a:lvl1pPr marL="0" algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:defRPr sz="1200" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl1pPr></p:notesStyle>` +
  `</p:notesMaster>`
const DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n'

const pkgOf = (pres: PresentationData) => {
  const pkg = pres.sourcePackage
  if (!pkg) throw new Error('deck was opened without its package')
  return pkg
}

const relsPathFor = (part: string) => {
  const i = part.lastIndexOf('/')
  return `${part.slice(0, i)}/_rels/${part.slice(i + 1)}.rels`
}

function resolve(sourcePart: string, target: string) {
  if (target.startsWith('/')) return target.slice(1)
  const parts = sourcePart.split('/').slice(0, -1)
  for (const seg of target.split('/')) {
    if (seg === '..') parts.pop()
    else if (seg && seg !== '.') parts.push(seg)
  }
  return parts.join('/')
}

const parse = (xml: string) => new DOMParser().parseFromString(xml, 'application/xml')
const serialize = (doc: Document) => DECL + new XMLSerializer().serializeToString(doc.documentElement)

interface Rel {
  id: string
  type: string
  target: string
}
function rels(xml: string | undefined): Rel[] {
  if (!xml) return []
  return [...parse(xml).getElementsByTagName('Relationship')].map((r) => ({
    id: r.getAttribute('Id') ?? '',
    type: r.getAttribute('Type') ?? '',
    target: r.getAttribute('Target') ?? '',
  }))
}

/** The slide's notes page path, and whether that page really belongs to this slide. */
async function notesPart(pres: PresentationData, slide: SlideData) {
  const pkg = pkgOf(pres)
  const rel = rels(await pkg.readText(relsPathFor(slide.id))).find((r) => r.type === NOTES_REL)
  if (!rel) return null
  const path = resolve(slide.id, rel.target)
  if (!pkg.has(path)) return null
  const owner = rels(await pkg.readText(relsPathFor(path))).find((r) => r.type === SLIDE_REL)
  return { path, relId: rel.id, owned: !owner || resolve(path, owner.target) === slide.id }
}

/** The notes page's body placeholder (`p:ph type="body"`). */
function bodyShape(doc: Document): Element | null {
  for (const sp of doc.getElementsByTagNameNS(P, 'sp')) {
    const ph = sp.getElementsByTagNameNS(P, 'ph')[0]
    if (ph && ph.getAttribute('type') === 'body') return sp
  }
  return null
}

function paragraphText(p: Element): string {
  let out = ''
  for (const c of p.children) {
    if (c.localName === 'r' || c.localName === 'fld') out += c.getElementsByTagNameNS(A, 't')[0]?.textContent ?? ''
    else if (c.localName === 'br') out += '\n'
  }
  return out
}

/** The notes body's paragraphs (`a:p` elements of a parsed copy of the notes page); [] without notes. */
export async function readNotesParagraphs(pres: PresentationData, slide: SlideData): Promise<Element[]> {
  const part = await notesPart(pres, slide)
  if (!part) return []
  const xml = await pkgOf(pres).readText(part.path)
  if (!xml) return []
  const body = bodyShape(parse(xml))
  if (!body) return []
  return [...body.getElementsByTagNameNS(A, 'p')]
}

export async function readNotes(pres: PresentationData, slide: SlideData): Promise<string> {
  return (await readNotesParagraphs(pres, slide)).map(paragraphText).join('\n')
}

/** Notes content to write: plain text (one paragraph per line), or `a:p` elements serialized as XML. */
export type NotesContent = string | { paragraphs: string[] }

const contentText = (c: NotesContent) => (typeof c === 'string' ? c : c.paragraphs.map((x) => paragraphText(parse(x).documentElement)).join('\n'))

function fillContent(doc: Document, txBody: Element, content: NotesContent) {
  if (typeof content === 'string') return fillBody(doc, txBody, content)
  for (const p of [...txBody.getElementsByTagNameNS(A, 'p')]) p.remove()
  for (const xml of content.paragraphs) txBody.appendChild(doc.importNode(parse(xml).documentElement, true))
  if (!content.paragraphs.length) txBody.appendChild(doc.createElementNS(A, 'a:p'))
}

/** Replace a txBody's paragraphs with `text`, one paragraph per line, keeping formatting templates. */
function fillBody(doc: Document, txBody: Element, text: string) {
  const old = [...txBody.getElementsByTagNameNS(A, 'p')]
  const tplP = old[0]
  const pPr = tplP ? [...tplP.children].find((c) => c.localName === 'pPr') : undefined
  const firstRun = old.flatMap((p) => [...p.children]).find((c) => c.localName === 'r')
  const rPr = firstRun ? [...firstRun.children].find((c) => c.localName === 'rPr') : undefined
  const endRPr = tplP ? [...tplP.children].find((c) => c.localName === 'endParaRPr') : undefined
  old.forEach((p) => p.remove())
  for (const line of text.split('\n')) {
    const p = doc.createElementNS(A, 'a:p')
    if (pPr) p.appendChild(pPr.cloneNode(true))
    if (line) {
      const r = doc.createElementNS(A, 'a:r')
      if (rPr) r.appendChild(rPr.cloneNode(true))
      const t = doc.createElementNS(A, 'a:t')
      t.textContent = line
      r.appendChild(t)
      p.appendChild(r)
    }
    const end = endRPr ? endRPr.cloneNode(true) : rPr ? (() => { const e = doc.createElementNS(A, 'a:endParaRPr'); for (const a of (rPr as Element).attributes) e.setAttribute(a.name, a.value); return e })() : null
    if (end) p.appendChild(end)
    txBody.appendChild(p)
  }
}

function newNotesXml(content: NotesContent): string {
  const doc = parse(
    `<p:notes xmlns:a="${A}" xmlns:r="${R}" xmlns:p="${P}"><p:cSld><p:spTree>` +
      `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>` +
      `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image Placeholder 1"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp>` +
      `<p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes Placeholder 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/>` +
      `<p:txBody><a:bodyPr/><a:lstStyle/><a:p/></p:txBody></p:sp>` +
      `</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>`,
  )
  fillContent(doc, doc.getElementsByTagNameNS(P, 'txBody')[0], content)
  return serialize(doc)
}

/**
 * Write a slide's speaker notes — plain text, or formatted paragraphs (see
 * notesRich.ts). Returns an undo function that restores every part it touched exactly.
 */
export async function writeNotes(pres: PresentationData, slide: SlideData, content: NotesContent): Promise<() => void> {
  const pkg = pkgOf(pres)
  const part = await notesPart(pres, slide)
  const restore: (() => void)[] = []
  const setText = async (path: string, next: string) => {
    const prev = await pkg.readText(path)
    pkg.setEntry(path, next)
    restore.push(() => (prev === undefined ? pkg.deleteEntry(path) : pkg.setEntry(path, prev)))
  }

  if (part?.owned) {
    const doc = parse((await pkg.readText(part.path))!)
    let body = bodyShape(doc)
    if (!body) throw new Error('this notes page has no notes placeholder')
    let txBody = body.getElementsByTagNameNS(P, 'txBody')[0]
    if (!txBody) {
      txBody = doc.createElementNS(P, 'p:txBody')
      txBody.appendChild(doc.createElementNS(A, 'a:bodyPr'))
      txBody.appendChild(doc.createElementNS(A, 'a:lstStyle'))
      body.appendChild(txBody)
    }
    fillContent(doc, txBody, content)
    await setText(part.path, serialize(doc))
    return () => restore.reverse().forEach((f) => f())
  }

  // No notes page of its own (none at all, or one shared with the slide it
  // was duplicated from): create one for this slide.
  const masterPath = await ensureNotesMaster(pres, setText, restore)
  const used = new Set(pkg.paths())
  let n = 1
  while (used.has(`ppt/notesSlides/notesSlide${n}.xml`)) n++
  const path = `ppt/notesSlides/notesSlide${n}.xml`
  const slideName = slide.id.split('/').pop()
  if (!contentText(content).trim() && !part) return () => {} // nothing to add
  await setText(path, newNotesXml(content))
  await setText(
    relsPathFor(path),
    `${DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="${NOTES_MASTER_REL}" Target="../${masterPath.replace(/^ppt\//, '')}"/>` +
      `<Relationship Id="rId2" Type="${SLIDE_REL}" Target="../slides/${slideName}"/></Relationships>`,
  )
  const ct = (await pkg.readText('[Content_Types].xml'))!
  if (!ct.includes(`PartName="/${path}"`)) {
    await setText('[Content_Types].xml', ct.replace('</Types>', `<Override PartName="/${path}" ContentType="${NOTES_CT}"/></Types>`))
  }
  // Point the slide at its new notes page (re-target a shared one, or add the relationship).
  const slideRelsPath = relsPathFor(slide.id)
  const slideRelsText = (await pkg.readText(slideRelsPath)) ?? `${DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`
  const relsDoc = parse(slideRelsText)
  const target = `../notesSlides/notesSlide${n}.xml`
  let relId = part?.relId
  if (relId) {
    const el = [...relsDoc.getElementsByTagName('Relationship')].find((r) => r.getAttribute('Id') === relId)!
    el.setAttribute('Target', target)
  } else {
    const ids = new Set([...relsDoc.getElementsByTagName('Relationship')].map((r) => r.getAttribute('Id')))
    let k = 1
    while (ids.has(`rId${k}`) || slide.rels.has(`rId${k}`)) k++
    relId = `rId${k}`
    const el = relsDoc.createElementNS('http://schemas.openxmlformats.org/package/2006/relationships', 'Relationship')
    el.setAttribute('Id', relId)
    el.setAttribute('Type', NOTES_REL)
    el.setAttribute('Target', target)
    relsDoc.documentElement.appendChild(el)
  }
  await setText(slideRelsPath, serialize(relsDoc))
  const prevRel = slide.rels.get(relId)
  slide.rels.set(relId, { type: NOTES_REL, target })
  restore.push(() => (prevRel ? slide.rels.set(relId!, prevRel) : slide.rels.delete(relId!)))
  return () => restore.reverse().forEach((f) => f())
}

/**
 * The deck's notes master; created (with its own copy of the deck's theme)
 * when the deck has none — python-pptx-made decks often don't, and PowerPoint
 * does the same when the first note is added.
 */
async function ensureNotesMaster(
  pres: PresentationData,
  setText: (path: string, next: string) => Promise<void>,
  restore: (() => void)[],
): Promise<string> {
  const pkg = pkgOf(pres)
  const presRelsPath = 'ppt/_rels/presentation.xml.rels'
  const presRelsText = (await pkg.readText(presRelsPath))!
  const existing = rels(presRelsText).find((r) => r.type === NOTES_MASTER_REL)
  if (existing) return resolve('ppt/presentation.xml', existing.target)

  const paths = pkg.paths()
  const sourceTheme = paths.filter((p) => /^ppt\/theme\/theme\d+\.xml$/.test(p)).sort()[0]
  if (!sourceTheme) throw new Error('this deck has no theme to base a notes master on')
  const free = (prefix: string) => {
    let n = 1
    while (paths.includes(`${prefix}${n}.xml`)) n++
    return `${prefix}${n}.xml`
  }
  const themePath = free('ppt/theme/theme')
  const masterPath = free('ppt/notesMasters/notesMaster')
  await setText(themePath, (await pkg.readText(sourceTheme))!)
  await setText(masterPath, NOTES_MASTER_XML)
  await setText(
    relsPathFor(masterPath),
    `${DECL}<Relationships xmlns="${PKG_RELS_NS}"><Relationship Id="rId1" Type="${THEME_REL}" Target="../theme/${themePath.split('/').pop()}"/></Relationships>`,
  )
  const ct = (await pkg.readText('[Content_Types].xml'))!
  await setText(
    '[Content_Types].xml',
    ct.replace('</Types>', `<Override PartName="/${masterPath}" ContentType="${NOTES_MASTER_CT}"/><Override PartName="/${themePath}" ContentType="${THEME_CT}"/></Types>`),
  )
  // presentation.xml.rels → the new master.
  const relsDoc = parse(presRelsText)
  const ids = new Set([...relsDoc.getElementsByTagName('Relationship')].map((r) => r.getAttribute('Id')))
  let k = 1
  while (ids.has(`rId${k}`)) k++
  const rid = `rId${k}`
  const el = relsDoc.createElementNS(PKG_RELS_NS, 'Relationship')
  el.setAttribute('Id', rid)
  el.setAttribute('Type', NOTES_MASTER_REL)
  el.setAttribute('Target', masterPath.replace(/^ppt\//, ''))
  relsDoc.documentElement.appendChild(el)
  await setText(presRelsPath, serialize(relsDoc))
  // presentation.xml (the engine's live document): <p:notesMasterIdLst> right after <p:sldMasterIdLst>.
  const root = pkg.getXmlRoot('ppt/presentation.xml')?.element as Element | null | undefined
  if (!root) throw new Error('presentation.xml is not loaded')
  const doc = root.ownerDocument
  const lst = doc.createElementNS(P, 'p:notesMasterIdLst')
  const id = doc.createElementNS(P, 'p:notesMasterId')
  id.setAttributeNS(R, 'r:id', rid)
  lst.appendChild(id)
  const after = [...root.children].find((c) => c.localName === 'sldMasterIdLst')
  root.insertBefore(lst, after ? after.nextSibling : root.firstChild)
  pkg.markDirty('ppt/presentation.xml')
  restore.push(() => {
    lst.remove()
    pkg.markDirty('ppt/presentation.xml')
  })
  return masterPath
}
