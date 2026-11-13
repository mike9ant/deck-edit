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
 * path, read from saved package bytes. The engine's own slide ids are part
 * paths, which python-pptx renumbers on every save; `sldId` survives both.
 */
export async function readSlideIds(bytes: ArrayBuffer | Uint8Array): Promise<Map<string, string>> {
  const zip = await JSZip.loadAsync(bytes)
  const presXml = await zip.file('ppt/presentation.xml')?.async('string')
  const relsXml = await zip.file('ppt/_rels/presentation.xml.rels')?.async('string')
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
export async function slideXmlBySldId(bytes: ArrayBuffer | Uint8Array): Promise<Map<string, string>> {
  const ids = await readSlideIds(bytes)
  const zip = await JSZip.loadAsync(bytes)
  const out = new Map<string, string>()
  for (const [part, sid] of ids) {
    const xml = await zip.file(part)?.async('string')
    if (xml !== undefined) out.set(sid, xml)
  }
  return out
}

export const slideById = (pres: PresentationData, id: string) => pres.slides.find((s) => s.id === id)
