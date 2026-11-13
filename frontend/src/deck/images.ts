/** Image helpers for dropping/pasting pictures onto slides. */

const NATIVE = new Set(['image/png', 'image/jpeg', 'image/gif'])

export interface PreparedImage {
  data: Uint8Array
  contentType: string
  width: number
  height: number
  name: string
}

/** Read an image blob; formats PowerPoint-safe as-is (PNG/JPEG/GIF) pass through, others are converted to PNG. */
export async function prepareImage(blob: Blob, name: string): Promise<PreparedImage> {
  const type = blob.type || guessType(name)
  const bitmap = await createImageBitmap(blob)
  const { width, height } = bitmap
  if (NATIVE.has(type)) {
    bitmap.close()
    return { data: new Uint8Array(await blob.arrayBuffer()), contentType: type, width, height, name }
  }
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0)
  bitmap.close()
  const png = await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG conversion failed'))), 'image/png'))
  return { data: new Uint8Array(await png.arrayBuffer()), contentType: 'image/png', width, height, name: name.replace(/\.\w+$/, '.png') }
}

function guessType(name: string) {
  const ext = name.split('.').pop()?.toLowerCase()
  return ext === 'png' ? 'image/png' : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'gif' ? 'image/gif' : ext === 'svg' ? 'image/svg+xml' : ext === 'webp' ? 'image/webp' : ''
}

/** Fit an image's natural size within a fraction of the slide, keeping its aspect ratio. */
export function fitSize(img: { width: number; height: number }, slideW: number, slideH: number, frac = 0.5) {
  const s = Math.min(1, (slideW * frac) / img.width, (slideH * frac) / img.height)
  return { w: Math.max(8, img.width * s), h: Math.max(8, img.height * s) }
}
