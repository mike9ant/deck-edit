/**
 * Merging decks at the package level: building a deck from a `target` deck plus chosen parts of a
 * `source` deck — whole slides, single shapes, speaker notes, comments — with everything they
 * reference copied along (pictures and media, charts and their data, SmartArt parts, notes pages),
 * layouts mapped by name, and relationship ids, slide ids and shape ids kept consistent.
 *
 * Review uses it both ways: Apply builds From + the accepted changes (target From, source To); the
 * review preview builds To with the rejected items put back (target To, source From).
 *
 * Shapes are addressed by their `p:cNvPr` id after `uniqueShapeIds` — the ids the app's model (and
 * so the diff) uses.
 */

import JSZip from 'jszip'
import { uniqueShapeIds } from './packageHygiene'

const NS = {
  p: 'http://schemas.openxmlformats.org/presentationml/2006/main',
  r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  rel: 'http://schemas.openxmlformats.org/package/2006/relationships',
  ct: 'http://schemas.openxmlformats.org/package/2006/content-types',
  p188: 'http://schemas.microsoft.com/office/powerpoint/2018/8/main',
}
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const T = {
  slide: `${REL}/slide`,
  layout: `${REL}/slideLayout`,
  notes: `${REL}/notesSlide`,
  notesMaster: `${REL}/notesMaster`,
  comments: 'http://schemas.microsoft.com/office/2018/10/relationships/comments',
  authors: 'http://schemas.microsoft.com/office/2018/10/relationships/authors',
  legacyComments: `${REL}/comments`,
}
const CT = {
  slide: 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml',
  comments: 'application/vnd.ms-powerpoint.comments+xml',
  authors: 'application/vnd.ms-powerpoint.authors+xml',
}

/** One shape change on a target slide. */
export type ShapeOp =
  /** The target's shape becomes the source's (same place in the stacking order, the target's id). */
  | { op: 'replace'; targetId: string; sourceId: string }
  /** The source's shape is added, just above the target shape `afterId` (else at the back). */
  | { op: 'insert'; sourceId: string; afterId?: string }
  | { op: 'delete'; targetId: string }

export interface SlideEdits {
  /** The slide part in the source the content comes from. */
  sourcePart: string
  shapes: ShapeOp[]
  /** Use the source slide's speaker notes. */
  notes?: boolean
  /** Use the source slide's own properties: layout, background, hidden. */
  props?: boolean
  /** Copy these comments (modern comment ids) from the source slide. */
  comments?: string[]
  /** Remove these comments (ids) from the target slide. */
  removeComments?: string[]
}

export interface MergePlan {
  /** The resulting slides in order: a target slide (kept, its part) or a source slide (copied in). Target slides left out are removed. */
  order: ({ target: string } | { source: string })[]
  /** Changes to kept target slides, by target slide part. */
  edits: Map<string, SlideEdits>
}

// ─── Package helpers ───────────────────────────────────────────────────────────────────────────

const serializer = () => new XMLSerializer()
const parseXml = (s: string) => new DOMParser().parseFromString(s, 'application/xml')
const dirOf = (path: string) => path.slice(0, path.lastIndexOf('/'))
const relsPathOf = (path: string) => `${dirOf(path)}/_rels/${path.slice(path.lastIndexOf('/') + 1)}.rels`

function resolve(fromDir: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1)
  const parts = fromDir ? fromDir.split('/') : []
  for (const seg of target.split('/')) {
    if (seg === '..') parts.pop()
    else if (seg && seg !== '.') parts.push(seg)
  }
  return parts.join('/')
}

/** `target` relative to the directory `fromDir`. */
function relative(fromDir: string, target: string): string {
  const a = fromDir.split('/').filter(Boolean), b = target.split('/')
  let i = 0
  while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++
  return [...a.slice(i).map(() => '..'), ...b.slice(i)].join('/')
}

interface Rel { id: string; type: string; target: string; external: boolean }

/** An opened package: parsed XML parts are cached and written back on `finish`. */
class Pkg {
  private docs = new Map<string, Document>()
  private dirty = new Set<string>()
  constructor(readonly zip: JSZip) {}

  /** In the package — or created during this merge (written on `finish`). */
  has(path: string) { return !!this.zip.file(path) || this.docs.has(path) }

  async xml(path: string): Promise<Document | null> {
    const cached = this.docs.get(path)
    if (cached) return cached
    const f = this.zip.file(path)
    if (!f) return null
    let text = await f.async('string')
    if (/^ppt\/slides\/slide\d*\.xml$/.test(path)) text = uniqueShapeIds(text)
    const doc = parseXml(text)
    this.docs.set(path, doc)
    return doc
  }

  touch(path: string, doc?: Document) {
    if (doc) this.docs.set(path, doc)
    this.dirty.add(path)
  }

  remove(path: string) {
    this.zip.remove(path)
    this.docs.delete(path)
    this.dirty.delete(path)
  }

  async rels(part: string): Promise<Rel[]> {
    const doc = await this.xml(relsPathOf(part))
    if (!doc) return []
    return [...doc.getElementsByTagNameNS(NS.rel, 'Relationship')].map((r) => {
      const external = r.getAttribute('TargetMode') === 'External'
      const target = r.getAttribute('Target') ?? ''
      return { id: r.getAttribute('Id') ?? '', type: r.getAttribute('Type') ?? '', target: external ? target : resolve(dirOf(part), target), external }
    })
  }

  /** Add a relationship from `part`; returns its id. */
  async addRel(part: string, type: string, target: string, external = false): Promise<string> {
    const path = relsPathOf(part)
    let doc = await this.xml(path)
    if (!doc) {
      doc = parseXml(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${NS.rel}"/>`)
    }
    const ids = new Set([...doc.getElementsByTagNameNS(NS.rel, 'Relationship')].map((r) => r.getAttribute('Id')))
    let n = ids.size + 1
    while (ids.has(`rId${n}`)) n++
    const r = doc.createElementNS(NS.rel, 'Relationship')
    r.setAttribute('Id', `rId${n}`)
    r.setAttribute('Type', type)
    r.setAttribute('Target', external ? target : relative(dirOf(part), target))
    if (external) r.setAttribute('TargetMode', 'External')
    doc.documentElement.appendChild(r)
    this.touch(path, doc)
    return `rId${n}`
  }

  async removeRel(part: string, id: string) {
    const doc = await this.xml(relsPathOf(part))
    if (!doc) return
    for (const r of [...doc.getElementsByTagNameNS(NS.rel, 'Relationship')]) if (r.getAttribute('Id') === id) r.remove()
    this.touch(relsPathOf(part), doc)
  }

  /** A free part name like `path` (same folder and stem, next number). */
  freeName(path: string): string {
    if (!this.has(path)) return path
    const m = /^(.*?)(\d*)(\.[^./]+)$/.exec(path)
    const [stem, ext] = m ? [m[1], m[3]] : [path, '']
    let n = 1
    while (this.has(`${stem}${n}${ext}`)) n++
    return `${stem}${n}${ext}`
  }

  async contentTypes(): Promise<Document> {
    return (await this.xml('[Content_Types].xml'))!
  }

  async overrideOf(path: string): Promise<string | undefined> {
    const ct = await this.contentTypes()
    for (const o of ct.getElementsByTagNameNS(NS.ct, 'Override')) if (o.getAttribute('PartName') === `/${path}`) return o.getAttribute('ContentType') ?? undefined
    return undefined
  }

  async defaultFor(ext: string): Promise<string | undefined> {
    const ct = await this.contentTypes()
    for (const d of ct.getElementsByTagNameNS(NS.ct, 'Default')) if (d.getAttribute('Extension')?.toLowerCase() === ext.toLowerCase()) return d.getAttribute('ContentType') ?? undefined
    return undefined
  }

  async setOverride(path: string, type: string) {
    const ct = await this.contentTypes()
    for (const o of [...ct.getElementsByTagNameNS(NS.ct, 'Override')]) if (o.getAttribute('PartName') === `/${path}`) o.remove()
    const o = ct.createElementNS(NS.ct, 'Override')
    o.setAttribute('PartName', `/${path}`)
    o.setAttribute('ContentType', type)
    ct.documentElement.appendChild(o)
    this.touch('[Content_Types].xml', ct)
  }

  async removeOverride(path: string) {
    const ct = await this.contentTypes()
    for (const o of [...ct.getElementsByTagNameNS(NS.ct, 'Override')]) if (o.getAttribute('PartName') === `/${path}`) o.remove()
    this.touch('[Content_Types].xml', ct)
  }

  async setDefault(ext: string, type: string) {
    if (await this.defaultFor(ext)) return
    const ct = await this.contentTypes()
    const d = ct.createElementNS(NS.ct, 'Default')
    d.setAttribute('Extension', ext)
    d.setAttribute('ContentType', type)
    ct.documentElement.insertBefore(d, ct.documentElement.firstChild)
    this.touch('[Content_Types].xml', ct)
  }

  finish() {
    const s = serializer()
    for (const path of this.dirty) {
      const doc = this.docs.get(path)
      if (!doc) continue
      let text = s.serializeToString(doc)
      if (!text.startsWith('<?xml')) text = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${text}`
      this.zip.file(path, text)
    }
    this.dirty.clear()
  }
}

// ─── Copying parts between packages ───────────────────────────────────────────────────────────

class Copier {
  /** source part → its copy in the target (per merge). */
  private copied = new Map<string, string>()
  private layouts: Map<string, string> | null = null
  constructor(private src: Pkg, private dst: Pkg, private slideMap: Map<string, string>) {}

  /** The target's layout with the same name as the source layout `part` (else the target's first layout). */
  private async layoutFor(part: string): Promise<string | undefined> {
    if (!this.layouts) {
      this.layouts = new Map()
      for (const name of Object.keys(this.dst.zip.files).filter((n) => /^ppt\/slideLayouts\/[^/]+\.xml$/.test(n)).sort()) {
        const doc = await this.dst.xml(name)
        const ln = doc?.getElementsByTagNameNS(NS.p, 'cSld')[0]?.getAttribute('name') ?? ''
        if (!this.layouts.has(ln)) this.layouts.set(ln, name)
      }
    }
    const doc = await this.src.xml(part)
    const name = doc?.getElementsByTagNameNS(NS.p, 'cSld')[0]?.getAttribute('name') ?? ''
    return this.layouts.get(name) ?? [...this.layouts.values()][0]
  }

  /** The same bytes already in the target (media is often shared): reuse it rather than copy. */
  private async sameBytes(path: string): Promise<string | undefined> {
    const f = this.src.zip.file(path)
    if (!f || !/^ppt\/media\//.test(path)) return undefined
    const bytes = await f.async('uint8array')
    for (const [name, entry] of Object.entries(this.dst.zip.files)) {
      if (!name.startsWith('ppt/media/') || entry.dir) continue
      const size = (entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize
      if (size !== undefined && size !== bytes.length) continue
      const other = await entry.async('uint8array')
      if (other.length === bytes.length && other.every((b, i) => b === bytes[i])) return name
    }
    return undefined
  }

  /** Copy a part (and what it references) into the target; returns its name there. */
  async part(path: string, owner?: { slide?: string }): Promise<string> {
    const done = this.copied.get(path)
    if (done) return done
    const reuse = await this.sameBytes(path)
    if (reuse) {
      this.copied.set(path, reuse)
      return reuse
    }
    const name = this.dst.freeName(path)
    this.copied.set(path, name)
    const f = this.src.zip.file(path)
    if (!f) return name
    if (/\.(xml|rels|vml)$/i.test(path)) this.dst.zip.file(name, await f.async('string'))
    else this.dst.zip.file(name, await f.async('uint8array'))
    // Its content type.
    const override = await this.src.overrideOf(path)
    if (override) await this.dst.setOverride(name, override)
    else {
      const ext = path.slice(path.lastIndexOf('.') + 1)
      const def = await this.src.defaultFor(ext)
      if (def) await this.dst.setDefault(ext, def)
    }
    // Its relationships, copied or mapped.
    const rels = await this.src.rels(path)
    if (rels.length) {
      const doc = parseXml(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${NS.rel}"/>`)
      for (const r of rels) {
        const target = r.external ? r.target : await this.mapped(r, owner)
        if (!target) continue
        const e = doc.createElementNS(NS.rel, 'Relationship')
        e.setAttribute('Id', r.id)
        e.setAttribute('Type', r.type)
        e.setAttribute('Target', r.external ? target : relative(dirOf(name), target))
        if (r.external) e.setAttribute('TargetMode', 'External')
        doc.documentElement.appendChild(e)
      }
      this.dst.touch(relsPathOf(name), doc)
    }
    return name
  }

  /** Where a relationship of a copied part points in the target: shared parts mapped, the rest copied. */
  async mapped(r: Rel, owner?: { slide?: string }): Promise<string | undefined> {
    if (r.type === T.layout) return this.layoutFor(r.target)
    if (r.type === T.notesMaster) return Object.keys(this.dst.zip.files).find((n) => /^ppt\/notesMasters\/[^/]+\.xml$/.test(n)) ?? this.part(r.target)
    if (r.type === T.slide) return this.slideMap.get(r.target) ?? owner?.slide ?? Object.keys(this.dst.zip.files).find((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    if (r.type === T.comments || r.type === T.legacyComments) return undefined // comments are copied one by one
    return this.part(r.target, owner)
  }
}

// ─── Slides ───────────────────────────────────────────────────────────────────────────────────

const ID_ATTRS = ['embed', 'link', 'id', 'pict', 'dm', 'lo', 'qs', 'cs', 'href']

/** Shapes on a slide, by id: the top-level children of the shape tree (`p:sp`, `p:pic`, groups…). */
function shapesOf(doc: Document): { tree: Element; byId: Map<string, Element> } {
  const tree = doc.getElementsByTagNameNS(NS.p, 'spTree')[0]
  const byId = new Map<string, Element>()
  for (const el of [...tree.children]) {
    const c = el.getElementsByTagNameNS(NS.p, 'cNvPr')[0]
    const id = c?.getAttribute('id')
    if (id && !['nvGrpSpPr', 'grpSpPr'].includes(el.localName)) byId.set(id, el)
  }
  return { tree, byId }
}

/** Copy the relationships an element refers to (`r:embed`, `r:id`…) from its source slide to the target slide, rewriting the ids. */
async function carryRels(el: Element, src: Pkg, srcPart: string, dst: Pkg, dstPart: string, copier: Copier) {
  const rels = new Map((await src.rels(srcPart)).map((r) => [r.id, r]))
  const done = new Map<string, string>()
  const all = [el, ...el.getElementsByTagName('*')]
  for (const e of all) {
    for (const attr of [...e.attributes]) {
      if (attr.namespaceURI !== NS.r || !ID_ATTRS.includes(attr.localName)) continue
      const old = attr.value
      let id = done.get(old)
      if (!id) {
        const r = rels.get(old)
        if (!r) continue
        const target = r.external ? r.target : await copier.mapped(r, { slide: dstPart })
        if (!target) continue
        id = await dst.addRel(dstPart, r.type, target, r.external)
        done.set(old, id)
      }
      e.setAttributeNS(NS.r, attr.name, id)
    }
  }
}

/** Give an element a shape id not used elsewhere on its slide (when its own is taken). */
function freeId(el: Element, byId: Map<string, Element>) {
  const c = el.getElementsByTagNameNS(NS.p, 'cNvPr')[0]
  if (!c) return
  const id = c.getAttribute('id') ?? ''
  const other = byId.get(id)
  if (!other || other === el) return
  const used = [...byId.keys()].map(Number).filter((n) => !Number.isNaN(n))
  c.setAttribute('id', String(Math.max(1, ...used) + 1))
}

async function editSlide(dst: Pkg, src: Pkg, dstPart: string, e: SlideEdits, copier: Copier) {
  const tdoc = await dst.xml(dstPart)
  const sdoc = await src.xml(e.sourcePart)
  if (!tdoc || !sdoc) return
  const t = shapesOf(tdoc), s = shapesOf(sdoc)
  const imported = async (sourceId: string) => {
    const el = s.byId.get(sourceId)
    if (!el) return null
    const copy = tdoc.importNode(el, true) as Element
    await carryRels(copy, src, e.sourcePart, dst, dstPart, copier)
    return copy
  }
  for (const op of e.shapes) {
    if (op.op === 'delete') {
      t.byId.get(op.targetId)?.remove()
      t.byId.delete(op.targetId)
    } else if (op.op === 'replace') {
      const old = t.byId.get(op.targetId)
      const copy = await imported(op.sourceId)
      if (!old || !copy) continue
      // It keeps the id of the shape it replaces: animations (and anything else) referring to that
      // shape keep working, and the shape stays findable by its id.
      copy.getElementsByTagNameNS(NS.p, 'cNvPr')[0]?.setAttribute('id', op.targetId)
      old.replaceWith(copy)
      t.byId.set(op.targetId, copy)
    } else {
      const copy = await imported(op.sourceId)
      if (!copy) continue
      const after = op.afterId ? t.byId.get(op.afterId) : undefined
      if (after) after.after(copy)
      else {
        // At the back: right after the tree's own properties.
        const props = [...t.tree.children].filter((c) => c.localName === 'nvGrpSpPr' || c.localName === 'grpSpPr')
        if (props.length) props[props.length - 1].after(copy)
        else t.tree.prepend(copy)
      }
      freeId(copy, t.byId)
      t.byId.set(copy.getElementsByTagNameNS(NS.p, 'cNvPr')[0]?.getAttribute('id') ?? op.sourceId, copy)
    }
  }
  if (e.props) await copyProps(tdoc, sdoc, dst, src, dstPart, e.sourcePart, copier)
  dst.touch(dstPart, tdoc)
  if (e.notes) await copyNotes(dst, src, dstPart, e.sourcePart, copier)
  if (e.comments?.length || e.removeComments?.length) await copyComments(dst, src, dstPart, e.sourcePart, e.comments ?? [], e.removeComments ?? [])
}

/** The slide's own properties become the source slide's: shown/hidden, background, layout. */
async function copyProps(tdoc: Document, sdoc: Document, dst: Pkg, src: Pkg, dstPart: string, srcPart: string, copier: Copier) {
  const show = sdoc.documentElement.getAttribute('show')
  if (show === null) tdoc.documentElement.removeAttribute('show')
  else tdoc.documentElement.setAttribute('show', show)
  const tcSld = tdoc.getElementsByTagNameNS(NS.p, 'cSld')[0], scSld = sdoc.getElementsByTagNameNS(NS.p, 'cSld')[0]
  const tbg = [...(tcSld?.children ?? [])].find((c) => c.localName === 'bg')
  const sbg = [...(scSld?.children ?? [])].find((c) => c.localName === 'bg')
  tbg?.remove()
  if (sbg && tcSld) {
    const copy = tdoc.importNode(sbg, true) as Element
    await carryRels(copy, src, srcPart, dst, dstPart, copier)
    tcSld.prepend(copy)
  }
  const sLayout = (await src.rels(srcPart)).find((r) => r.type === T.layout)
  const tLayout = (await dst.rels(dstPart)).find((r) => r.type === T.layout)
  if (sLayout && tLayout) {
    const target = await copier.mapped(sLayout)
    const rdoc = await dst.xml(relsPathOf(dstPart))
    if (target && rdoc) {
      for (const r of rdoc.getElementsByTagNameNS(NS.rel, 'Relationship')) if (r.getAttribute('Id') === tLayout.id) r.setAttribute('Target', relative(dirOf(dstPart), target))
      dst.touch(relsPathOf(dstPart), rdoc)
    }
  }
}

/** The slide's speaker notes become the source slide's (its notes page, or none). */
async function copyNotes(dst: Pkg, src: Pkg, dstPart: string, srcPart: string, copier: Copier) {
  const srcNotes = (await src.rels(srcPart)).find((r) => r.type === T.notes)
  const dstNotes = (await dst.rels(dstPart)).find((r) => r.type === T.notes)
  if (dstNotes) {
    if (!srcNotes) {
      // No notes in the source: empty the body text rather than drop the page.
      const doc = await dst.xml(dstNotes.target)
      if (doc) {
        for (const body of [...doc.getElementsByTagNameNS('http://schemas.openxmlformats.org/drawingml/2006/main', 'p')]) {
          let sp: Element | null = body.parentElement
          while (sp && sp.localName !== 'sp') sp = sp.parentElement
          if (sp?.getElementsByTagNameNS(NS.p, 'ph')[0]?.getAttribute('type') === 'body') body.remove()
        }
        dst.touch(dstNotes.target, doc)
      }
      return
    }
    // Same page, the source's content: its shapes (the body text), keeping the target page's own relationships.
    const sdoc = await src.xml(srcNotes.target)
    if (!sdoc) return
    const doc = parseXml(serializer().serializeToString(sdoc))
    dst.touch(dstNotes.target, doc)
    return
  }
  if (!srcNotes) return
  const copied = await copier.part(srcNotes.target, { slide: dstPart })
  // The copied notes page points back at this slide.
  const rdoc = await dst.xml(relsPathOf(copied))
  if (rdoc) {
    for (const r of rdoc.getElementsByTagNameNS(NS.rel, 'Relationship')) {
      if (r.getAttribute('Type') === T.slide) r.setAttribute('Target', relative(dirOf(copied), dstPart))
    }
    dst.touch(relsPathOf(copied), rdoc)
  }
  await dst.addRel(dstPart, T.notes, copied)
}

/** Copy comment threads (by id) from the source slide to the target slide, and remove others. */
async function copyComments(dst: Pkg, src: Pkg, dstPart: string, srcPart: string, ids: string[], remove: string[]) {
  const sRel = (await src.rels(srcPart)).find((r) => r.type === T.comments)
  let dRel = (await dst.rels(dstPart)).find((r) => r.type === T.comments)
  if (remove.length && dRel) {
    const doc = await dst.xml(dRel.target)
    if (doc) {
      for (const cm of [...doc.getElementsByTagNameNS(NS.p188, 'cm')]) if (remove.includes(cm.getAttribute('id') ?? '')) cm.remove()
      dst.touch(dRel.target, doc)
    }
  }
  if (!ids.length || !sRel) return
  const sdoc = await src.xml(sRel.target)
  if (!sdoc) return
  const wanted = [...sdoc.getElementsByTagNameNS(NS.p188, 'cm')].filter((cm) => ids.includes(cm.getAttribute('id') ?? ''))
  if (!wanted.length) return
  let ddoc: Document | null
  if (!dRel) {
    const name = dst.freeName('ppt/comments/modernComment_1.xml')
    ddoc = parseXml(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p188:cmLst xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${NS.r}" xmlns:p188="${NS.p188}"/>`)
    dst.touch(name, ddoc)
    await dst.setOverride(name, CT.comments)
    await dst.addRel(dstPart, T.comments, name)
    dRel = { id: '', type: T.comments, target: name, external: false }
  } else ddoc = await dst.xml(dRel.target)
  if (!ddoc) return
  const have = new Set([...ddoc.getElementsByTagNameNS(NS.p188, 'cm')].map((c) => c.getAttribute('id')))
  for (const cm of wanted) if (!have.has(cm.getAttribute('id'))) ddoc.documentElement.appendChild(ddoc.importNode(cm, true))
  dst.touch(dRel.target, ddoc)
  // Their authors.
  const authorIds = new Set(wanted.flatMap((cm) => [cm, ...cm.getElementsByTagNameNS(NS.p188, 'reply')].map((x) => x.getAttribute('authorId') ?? '')))
  const sAuthors = await src.xml('ppt/authors.xml')
  if (!sAuthors) return
  let dAuthors = await dst.xml('ppt/authors.xml')
  if (!dAuthors) {
    dAuthors = parseXml(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p188:authorLst xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${NS.r}" xmlns:p188="${NS.p188}"/>`)
    await dst.setOverride('ppt/authors.xml', CT.authors)
    await dst.addRel('ppt/presentation.xml', T.authors, 'ppt/authors.xml')
  }
  const known = new Set([...dAuthors.getElementsByTagNameNS(NS.p188, 'author')].map((a) => a.getAttribute('id')))
  for (const a of sAuthors.getElementsByTagNameNS(NS.p188, 'author')) {
    const id = a.getAttribute('id') ?? ''
    if (authorIds.has(id) && !known.has(id)) dAuthors.documentElement.appendChild(dAuthors.importNode(a, true))
  }
  dst.touch('ppt/authors.xml', dAuthors)
}

/** Copy a whole source slide into the target (not yet in the slide list). Returns its part. */
async function copySlide(dst: Pkg, src: Pkg, srcPart: string, copier: Copier): Promise<string> {
  const name = await copier.part(srcPart)
  // `part` copied the raw text: use the source's id-normalized slide, as the diff saw it.
  const sdoc = await src.xml(srcPart)
  if (sdoc) dst.touch(name, parseXml(serializer().serializeToString(sdoc)))
  await dst.setOverride(name, CT.slide)
  // Its notes page points back at the copy.
  for (const r of await dst.rels(name)) {
    if (r.type !== T.notes) continue
    const rdoc = await dst.xml(relsPathOf(r.target))
    if (!rdoc) continue
    for (const x of rdoc.getElementsByTagNameNS(NS.rel, 'Relationship')) if (x.getAttribute('Type') === T.slide) x.setAttribute('Target', relative(dirOf(r.target), name))
    dst.touch(relsPathOf(r.target), rdoc)
  }
  return name
}

/** Remove a slide's parts (and its notes page, and comments). */
async function dropSlide(dst: Pkg, part: string) {
  for (const r of await dst.rels(part)) {
    if (r.type === T.notes || r.type === T.comments || r.type === T.legacyComments) {
      dst.remove(r.target)
      dst.remove(relsPathOf(r.target))
      await dst.removeOverride(r.target)
    }
  }
  dst.remove(part)
  dst.remove(relsPathOf(part))
  await dst.removeOverride(part)
}

/** Build the merged deck: `target` with the plan's slides, shapes, notes and comments taken from `source`. */
export async function mergeDecks(target: ArrayBuffer | Uint8Array, source: ArrayBuffer | Uint8Array, plan: MergePlan): Promise<Uint8Array> {
  const dst = new Pkg(await JSZip.loadAsync(target))
  const src = new Pkg(await JSZip.loadAsync(source))
  const pres = (await dst.xml('ppt/presentation.xml'))!
  const presRels = await dst.rels('ppt/presentation.xml')
  const relOfPart = new Map(presRels.filter((r) => r.type === T.slide).map((r) => [r.target, r.id]))
  const list = pres.getElementsByTagNameNS(NS.p, 'sldIdLst')[0]
  const entries = new Map<string, Element>() // slide part → its sldId
  for (const s of [...list.children]) {
    const rid = s.getAttributeNS(NS.r, 'id') ?? s.getAttribute('r:id')
    const part = presRels.find((r) => r.id === rid)?.target
    if (part) entries.set(part, s)
  }
  // Source slides copied in, for links between them.
  const slideMap = new Map<string, string>()
  const copier = new Copier(src, dst, slideMap)

  for (const [part, e] of plan.edits) if (entries.has(part)) await editSlide(dst, src, part, e, copier)

  // The new slide list.
  let nextId = Math.max(255, ...[...entries.values()].map((s) => Number(s.getAttribute('id')) || 0))
  const newList: Element[] = []
  const kept = new Set<string>()
  for (const item of plan.order) {
    if ('target' in item) {
      const s = entries.get(item.target)
      if (s) { newList.push(s); kept.add(item.target) }
      continue
    }
    const part = await copySlide(dst, src, item.source, copier)
    slideMap.set(item.source, part)
    const rid = await dst.addRel('ppt/presentation.xml', T.slide, part)
    const s = pres.createElementNS(NS.p, 'p:sldId')
    s.setAttribute('id', String(++nextId))
    s.setAttributeNS(NS.r, 'r:id', rid)
    newList.push(s)
  }
  for (const s of [...list.children]) s.remove()
  for (const s of newList) list.appendChild(s)
  dst.touch('ppt/presentation.xml', pres)
  // Slides left out are removed.
  for (const [part] of entries) {
    if (kept.has(part)) continue
    const rid = relOfPart.get(part)
    if (rid) await dst.removeRel('ppt/presentation.xml', rid)
    await dropSlide(dst, part)
  }
  dst.finish()
  return dst.zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 } })
}
