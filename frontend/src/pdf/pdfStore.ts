/**
 * Open PDFs: pdf.js for rendering, pdf-lib for the few page edits we allow
 * (reorder, duplicate, delete pages; place an image on a page). Each edit
 * produces new bytes; undo keeps the previous bytes. Saves are etag-guarded
 * like decks, and external changes (the agent) reload live.
 */

import { create } from 'zustand'
import * as pdfjs from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { PDFDocument } from 'pdf-lib'
import { api, ApiError, CLIENT_ID } from '../api/client'
import { useApp } from '../store/appStore'
import { isProjectBusy } from '../deck/deckStore'

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

export interface PdfSession {
  key: string
  pid: string
  path: string
  bytes: Uint8Array | null
  doc: pdfjs.PDFDocumentProxy | null
  etag: string
  pageIndex: number
  version: number
  undo: { bytes: Uint8Array; description: string }[]
  redo: { bytes: Uint8Array; description: string }[]
  turnBaseline: number
  saving: boolean
  loading: boolean
  error: string | null
  externalAt: number
}

interface PdfStore {
  sessions: Record<string, PdfSession>
  open(pid: string, path: string): Promise<void>
  reload(key: string, external: boolean): Promise<void>
  setPage(key: string, i: number): void
  edit(key: string, description: string, fn: (doc: PDFDocument) => Promise<void> | void): Promise<void>
  undo(key: string): Promise<void>
  redo(key: string): Promise<void>
  peekUserChanges(key: string): string[]
  takeUserChanges(key: string): string[]
}

export const pdfKey = (pid: string, path: string) => `${pid}:${path}`

async function loadDoc(bytes: Uint8Array) {
  // pdf.js takes ownership of the buffer it's given — hand it a copy.
  return pdfjs.getDocument({ data: bytes.slice() }).promise
}

export const usePdfs = create<PdfStore>((set, get) => {
  const patch = (key: string, p: Partial<PdfSession>) => {
    const s = get().sessions[key]
    if (s) set({ sessions: { ...get().sessions, [key]: { ...s, ...p } } })
  }

  const commit = async (key: string, bytes: Uint8Array, undo: PdfSession['undo'], redo: PdfSession['redo']) => {
    const s = get().sessions[key]!
    const doc = await loadDoc(bytes)
    const old = s.doc
    patch(key, { bytes, doc, undo, redo, version: s.version + 1, pageIndex: Math.min(s.pageIndex, doc.numPages - 1), saving: true })
    old?.destroy()
    try {
      const { etag } = await api.writeFile(s.pid, s.path, bytes, s.etag)
      patch(key, { etag, saving: false })
    } catch (e) {
      patch(key, { saving: false })
      if (e instanceof ApiError && e.status === 409) {
        useApp.getState().toast('The PDF changed on disk — reloaded it. Your last edit was not saved.', 'error')
        await get().reload(key, true)
      } else useApp.getState().toast(`Save failed: ${(e as Error).message}`, 'error')
    }
  }

  return {
    sessions: {},

    async open(pid, path) {
      const key = pdfKey(pid, path)
      if (get().sessions[key]) return
      set({
        sessions: {
          ...get().sessions,
          [key]: { key, pid, path, bytes: null, doc: null, etag: '', pageIndex: 0, version: 0, undo: [], redo: [], turnBaseline: 0, saving: false, loading: true, error: null, externalAt: 0 },
        },
      })
      await get().reload(key, false)
    },

    async reload(key, external) {
      const s = get().sessions[key]
      if (!s) return
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          const { bytes, etag } = await api.readFile(s.pid, s.path)
          const u8 = new Uint8Array(bytes)
          const doc = await loadDoc(u8)
          const cur = get().sessions[key]!
          cur.doc?.destroy()
          patch(key, {
            bytes: u8, doc, etag, loading: false, error: null, version: cur.version + 1,
            pageIndex: Math.min(cur.pageIndex, doc.numPages - 1),
            undo: external ? [] : cur.undo, redo: external ? [] : cur.redo, turnBaseline: external ? 0 : cur.turnBaseline,
            externalAt: external ? Date.now() : cur.externalAt,
          })
          return
        } catch (e) {
          if (attempt === 4) patch(key, { loading: false, error: `Couldn't open the PDF: ${(e as Error).message}` })
          await new Promise((r) => setTimeout(r, 400 + attempt * 300))
        }
      }
    },

    setPage(key, i) {
      const s = get().sessions[key]
      if (!s?.doc) return
      patch(key, { pageIndex: Math.max(0, Math.min(i, s.doc.numPages - 1)) })
    },

    async edit(key, description, fn) {
      const s = get().sessions[key]
      if (!s?.bytes) return
      if (isProjectBusy(s.pid)) return useApp.getState().toast('The agent is working on this project — editing resumes when its turn ends.')
      try {
        const doc = await PDFDocument.load(s.bytes, { updateMetadata: false })
        await fn(doc)
        const out = await doc.save()
        await commit(key, out, [...s.undo, { bytes: s.bytes, description }], [])
      } catch (e) {
        useApp.getState().toast(`Edit failed: ${(e as Error).message}`, 'error')
      }
    },

    async undo(key) {
      const s = get().sessions[key]
      if (!s?.bytes || !s.undo.length || isProjectBusy(s.pid)) return
      const last = s.undo[s.undo.length - 1]
      await commit(key, last.bytes, s.undo.slice(0, -1), [...s.redo, { bytes: s.bytes, description: last.description }])
      patch(key, { turnBaseline: Math.min(s.turnBaseline, s.undo.length - 1) })
    },

    async redo(key) {
      const s = get().sessions[key]
      if (!s?.bytes || !s.redo.length || isProjectBusy(s.pid)) return
      const last = s.redo[s.redo.length - 1]
      await commit(key, last.bytes, [...s.undo, { bytes: s.bytes, description: last.description }], s.redo.slice(0, -1))
    },

    peekUserChanges(key) {
      const s = get().sessions[key]
      return s ? s.undo.slice(s.turnBaseline).map((u) => u.description) : []
    },
    takeUserChanges(key) {
      const out = get().peekUserChanges(key)
      const s = get().sessions[key]
      if (s) patch(key, { turnBaseline: s.undo.length })
      return out
    },
  }
})

export function handlePdfFileEvent(pid: string, path: string, etag: string | null, writer: string) {
  const s = usePdfs.getState().sessions[pdfKey(pid, path)]
  if (!s || etag === null || writer === CLIENT_ID || etag === s.etag) return
  void usePdfs.getState().reload(s.key, true)
}
