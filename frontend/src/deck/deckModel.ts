/** Small read-only helpers over the @diceui/pptx-core model. */

import JSZip from 'jszip'
import type { PresentationData, SlideData, SlideNode } from '@diceui/pptx-core'

export function nodeText(node: SlideNode): string {
  if (node.nodeType !== 'shape' || !node.textBody) return ''
  return node.textBody.paragraphs.map((p) => p.runs.map((r) => r.text).join('')).join('\n')
}

export function slideTitle(slide: SlideData): string {
  const title = slide.nodes.find((n) => n.placeholder?.type === 'title' || n.placeholder?.type === 'ctrTitle')
  const text = (title && nodeText(title)) || slide.nodes.map(nodeText).find((t) => t.trim()) || ''
  return text.replace(/\s+/g, ' ').trim().slice(0, 80)
}

export const short = (s: string, n = 60) => {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n - 1)}…` : t
}

/**
 * Stable slide ids (`p:sldId/@id` in presentation.xml) keyed by slide part
 * path. The engine's own slide ids are part paths, which python-pptx
 * renumbers on every save; `sldId` survives both.
 */
export function slideIdsFromXml(presXml: string | undefined, relsXml: string | undefined): Map<string, string> {
  const out = new Map<string, string>()
  if (!presXml || !relsXml) return out
  const targets = new Map<string, string>()
  for (const m of relsXml.matchAll(/<Relationship\b([^>]*?)\/?>/g)) {
    const id = /\bId="([^"]*)"/.exec(m[1])?.[1]
    const target = /\bTarget="([^"]*)"/.exec(m[1])?.[1]
    if (id && target) targets.set(id, target.startsWith('/') ? target.slice(1) : `ppt/${target.replace(/^\.\//, '')}`)
  }
  for (const m of presXml.matchAll(/<p:sldId\b([^>]*?)\/?>/g)) {
    const id = /\bid="(\d+)"/.exec(m[1])?.[1]
    const rid = /\br:id="([^"]*)"/.exec(m[1])?.[1]
    const part = rid ? targets.get(rid) : undefined
    if (id && part) out.set(part, id)
  }
  return out
}

/** Raw XML of every slide keyed by stable slide id — used to spot which slides an external save changed. */
export function slideXmlFromParts(sldIds: Map<string, string>, slides: Map<string, string>): Map<string, string> {
  const out = new Map<string, string>()
  for (const [part, sid] of sldIds) {
    const xml = slides.get(part)
    if (xml !== undefined) out.set(sid, xml)
  }
  return out
}

/** Stable slide ids and each slide's raw XML, read from saved package bytes (one unzip). */
export async function readSlideParts(bytes: ArrayBuffer | Uint8Array): Promise<{ sldIds: Map<string, string>; slideXml: Map<string, string> }> {
  const zip = await JSZip.loadAsync(bytes)
  const sldIds = slideIdsFromXml(await zip.file('ppt/presentation.xml')?.async('string'), await zip.file('ppt/_rels/presentation.xml.rels')?.async('string'))
  const slides = new Map<string, string>()
  for (const part of sldIds.keys()) {
    const xml = await zip.file(part)?.async('string')
    if (xml !== undefined) slides.set(part, xml)
  }
  return { sldIds, slideXml: slideXmlFromParts(sldIds, slides) }
}

export const slideById = (pres: PresentationData, id: string) => pres.slides.find((s) => s.id === id)
