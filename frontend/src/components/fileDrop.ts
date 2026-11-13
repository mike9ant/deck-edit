/**
 * Files dropped from Finder onto the Files list: collect them (folders are
 * walked, keeping their structure) and copy them into the project folder.
 */

import { api } from '../api/client'

export interface DroppedFile {
  /** Path relative to the drop target, e.g. "deck.pptx" or "assets/logo.png". */
  rel: string
  file: File
}

/** Does this drag carry files from the OS (as opposed to an in-app drag)? */
export const isOsFileDrag = (dt: DataTransfer | null) => !!dt && Array.from(dt.types).includes('Files')

const skip = (name: string) => name.startsWith('.') || name.startsWith('~$')

function readAll(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  // readEntries returns at most ~100 entries per call: keep reading until empty.
  return new Promise((resolve, reject) => {
    const out: FileSystemEntry[] = []
    const next = () =>
      reader.readEntries((batch) => {
        if (!batch.length) return resolve(out)
        out.push(...batch)
        next()
      }, reject)
    next()
  })
}

async function walk(entry: FileSystemEntry, prefix: string, out: DroppedFile[]) {
  if (skip(entry.name)) return
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject))
    out.push({ rel: prefix + entry.name, file })
  } else if (entry.isDirectory) {
    for (const child of await readAll((entry as FileSystemDirectoryEntry).createReader())) {
      await walk(child, `${prefix}${entry.name}/`, out)
    }
  }
}

/** Everything in a drop, folders included. Must be called synchronously in the drop handler (entries expire). */
export function collectDropped(dt: DataTransfer): Promise<DroppedFile[]> {
  const entries = Array.from(dt.items)
    .filter((i) => i.kind === 'file')
    .map((i) => i.webkitGetAsEntry?.())
    .filter((e): e is FileSystemEntry => !!e)
  if (!entries.length) {
    return Promise.resolve(Array.from(dt.files).filter((f) => !skip(f.name)).map((file) => ({ rel: file.name, file })))
  }
  return (async () => {
    const out: DroppedFile[] = []
    for (const e of entries) await walk(e, '', out)
    return out
  })()
}

/** Copy dropped files into `dir` (project-relative, '' = root). Returns the paths written. */
export async function uploadDropped(pid: string, dir: string, files: DroppedFile[], onProgress?: (done: number, total: number) => void): Promise<string[]> {
  const written: string[] = []
  for (let i = 0; i < files.length; i++) {
    const { rel, file } = files[i]
    const { path } = await api.upload(pid, dir ? `${dir}/${rel}` : rel, file)
    written.push(path)
    onProgress?.(i + 1, files.length)
  }
  return written
}
