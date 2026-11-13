/**
 * Image attachments for the chat composer: which pasted/dropped files are
 * taken, and how one is prepared for sending. Ported from ma-code-navigator.
 *
 * Only formats the model reads directly are accepted (the backend re-checks
 * by content). An oversized image is scaled down here before upload: beyond
 * what the model reads, extra pixels only cost tokens.
 */

/** Most images one message may carry (the backend enforces the same cap). */
export const MAX_IMAGES = 4
/** Largest image the backend accepts, in bytes. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024
/** Longest edge for the high-resolution models (the CLI scales larger images to this anyway). */
export const HIGH_RES_EDGE_PX = 2000
/** Longest edge every other model reads. */
export const STANDARD_EDGE_PX = 1568

export const ACCEPTED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']

/** An image held in the composer until send. */
export interface PendingImage {
  id: string
  name?: string
  /** Base64 of the bytes that will be sent (no `data:` prefix). */
  data: string
  /** The same bytes as a data URL, for the thumbnail. */
  previewUrl: string
  width: number
  height: number
  bytes: number
}

/** Haiku reads standard-size images; the other aliases (and the default, Opus) read high-res. */
export const maxImageEdgeFor = (model: string) => (model.includes('haiku') ? STANDARD_EDGE_PX : HIGH_RES_EDGE_PX)

export const isAcceptedImage = (f: File) => ACCEPTED_IMAGE_TYPES.includes(f.type)

/** The files of a paste or drop, split into images we take and the rest. */
export function splitImageFiles(files: FileList | File[] | null | undefined): { images: File[]; rejected: number } {
  const all = Array.from(files ?? [])
  const images = all.filter(isAcceptedImage)
  return { images, rejected: all.length - images.length }
}

/** Whether a drag carries files at all (their types aren't readable until drop). */
export const dragHasFiles = (dt: DataTransfer | null) => !!dt && Array.from(dt.types).includes('Files')

function fitWithin(width: number, height: number, max: number) {
  const longest = Math.max(width, height)
  if (longest <= max || longest === 0) return { width, height }
  const k = max / longest
  return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)) }
}

const toBase64 = (buf: ArrayBuffer) => {
  const bytes = new Uint8Array(buf)
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}

/**
 * Read a file into a PendingImage, scaling it down to `maxEdge` when larger
 * (re-encoded as PNG, or JPEG for photos). GIFs are kept as-is (scaling would
 * drop their animation). Throws a user-readable message when it can't be used.
 */
export async function prepareImage(file: File, maxEdge: number): Promise<PendingImage> {
  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error(`${file.name || 'The image'} could not be read`)
  })
  const { width, height } = bitmap
  const fit = fitWithin(width, height, maxEdge)
  let blob: Blob = file
  let out = { width, height }
  if ((fit.width !== width || file.size > MAX_IMAGE_BYTES) && file.type !== 'image/gif') {
    const canvas = document.createElement('canvas')
    canvas.width = fit.width
    canvas.height = fit.height
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, fit.width, fit.height)
    const type = file.type === 'image/jpeg' ? 'image/jpeg' : 'image/png'
    blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('could not re-encode the image'))), type, 0.9),
    )
    // A big PNG screenshot can still exceed the cap: fall back to JPEG.
    if (blob.size > MAX_IMAGE_BYTES) {
      blob = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('could not re-encode the image'))), 'image/jpeg', 0.85),
      )
    }
    out = fit
  }
  bitmap.close()
  if (blob.size > MAX_IMAGE_BYTES) throw new Error(`${file.name || 'The image'} is larger than 5 MB`)
  const data = toBase64(await blob.arrayBuffer())
  return {
    id: crypto.randomUUID(),
    name: file.name || undefined,
    data,
    previewUrl: `data:${blob.type || file.type};base64,${data}`,
    width: out.width,
    height: out.height,
    bytes: blob.size,
  }
}
