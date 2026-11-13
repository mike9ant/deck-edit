/**
 * Editable text documents (Markdown, .txt, code/config files) on CodeMirror 6.
 *
 * `useTextDoc` owns the file: it loads it, autosaves edits shortly after you
 * stop typing (etag-guarded, like decks — a file changed on disk meanwhile is
 * reloaded instead of overwritten), reloads when the agent or another app
 * changes it, and reports saved edits to the agent (textEdits.ts). While an
 * agent turn runs the editor is read-only, as decks are.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { basicSetup } from 'codemirror'
import { Compartment, EditorState, type Extension } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { indentWithTab } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { json } from '@codemirror/lang-json'
import { python } from '@codemirror/lang-python'
import { javascript } from '@codemirror/lang-javascript'
import { html } from '@codemirror/lang-html'
import { css } from '@codemirror/lang-css'
import { xml } from '@codemirror/lang-xml'
import { yaml } from '@codemirror/lang-yaml'
import { ApiError, api } from '../api/client'
import { useFileVersion } from '../store/fileVersions'
import { useApp } from '../store/appStore'
import { markTextEdited, registerTextSaver } from './textEdits'

export type SaveStatus = 'saved' | 'dirty' | 'saving' | 'error'

const ext = (path: string) => path.split('.').pop()?.toLowerCase() ?? ''

function languageFor(path: string): Extension[] {
  switch (ext(path)) {
    case 'md': case 'markdown': return [markdown()]
    case 'json': return [json()]
    case 'py': return [python()]
    case 'js': return [javascript()]
    case 'ts': return [javascript({ typescript: true })]
    case 'html': return [html()]
    case 'css': return [css()]
    case 'xml': return [xml()]
    case 'yaml': case 'yml': return [yaml()]
    default: return []
  }
}

/** Prose-like files wrap long lines; code doesn't. */
const wraps = (path: string) => ['md', 'markdown', 'txt', 'csv', 'log'].includes(ext(path))

export function useTextDoc(pid: string, path: string) {
  const version = useFileVersion(pid, path)
  /** Text loaded from disk; `rev` bumps when the editor must take it over. */
  const [doc, setDoc] = useState<{ text: string; rev: number } | null>(null)
  const [status, setStatus] = useState<SaveStatus>('saved')
  const [error, setError] = useState<string | null>(null)
  const cur = useRef('')
  const saved = useRef('')
  const etag = useRef('')
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const inflight = useRef<Promise<void> | null>(null)
  const loaded = useRef(false)

  const load = useCallback(async (fromDisk: boolean) => {
    if (inflight.current) await inflight.current
    const r = await api.readText(pid, path)
    if (r.etag && r.etag === etag.current) return // our own save, or nothing new
    etag.current = r.etag
    if (r.text === cur.current && loaded.current) {
      saved.current = r.text
      return
    }
    const lost = fromDisk && cur.current !== saved.current
    saved.current = r.text
    cur.current = r.text
    loaded.current = true
    setDoc((d) => ({ text: r.text, rev: (d?.rev ?? 0) + 1 }))
    setStatus('saved')
    if (lost) useApp.getState().toast(`${path} changed on disk — reloaded it (your last unsaved edit was replaced).`, 'error')
  }, [pid, path])

  useEffect(() => {
    load(version > 0).catch((e) => setError(String((e as Error).message)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pid, path, version])

  const flush = useCallback(async () => {
    clearTimeout(timer.current)
    if (inflight.current) await inflight.current
    const text = cur.current
    if (text === saved.current) return
    setStatus('saving')
    const run = (async () => {
      try {
        const r = await api.writeFile(pid, path, new TextEncoder().encode(text), etag.current)
        etag.current = r.etag
        saved.current = text
        markTextEdited(pid, path)
        setStatus(cur.current === text ? 'saved' : 'dirty')
      } catch (e) {
        if (e instanceof ApiError && e.status === 409) {
          etag.current = ''
          inflight.current = null
          useApp.getState().toast(`${path} changed on disk before your edit was saved — reloaded it.`, 'error')
          saved.current = cur.current = '\u0000' // force the reload to replace the editor
          await load(false)
        } else {
          setStatus('error')
          useApp.getState().toast(`Couldn't save ${path}: ${(e as Error).message}`, 'error')
        }
      }
    })()
    inflight.current = run
    await run
    if (inflight.current === run) inflight.current = null
  }, [pid, path, load])

  const change = useCallback((text: string) => {
    cur.current = text
    if (text !== saved.current) useApp.getState().markChanged(pid, path) // shows "Saved", keeps the tab open
    setStatus(text === saved.current ? 'saved' : 'dirty')
    clearTimeout(timer.current)
    timer.current = setTimeout(() => void flush(), 700)
  }, [flush, pid, path])

  // Pending edits are written before an agent turn, when leaving the file, and
  // a closing tab warns about them.
  useEffect(() => registerTextSaver(`${pid}:${path}`, flush), [pid, path, flush])
  const flushRef = useRef(flush)
  flushRef.current = flush
  useEffect(() => () => void flushRef.current(), [])
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (cur.current !== saved.current) e.preventDefault()
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [])

  return { doc, status, error, change, flush, current: () => cur.current }
}

export function CodeEditor({ path, doc, initialText, readOnly, onChange, onSave }: {
  path: string
  doc: { text: string; rev: number }
  /** What to show on mount — the latest text, which may include edits made since `doc` was loaded. */
  initialText: string
  readOnly: boolean
  onChange(text: string): void
  onSave(): void
}) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const ro = useRef(new Compartment())
  const handlers = useRef({ onChange, onSave })
  handlers.current = { onChange, onSave }

  const readOnlyRef = useRef(readOnly)
  readOnlyRef.current = readOnly
  const editable = (r: boolean) => [EditorState.readOnly.of(r), EditorView.editable.of(!r)]
  const makeState = (text: string, head = 0) =>
    EditorState.create({
      doc: text,
      selection: { anchor: Math.min(head, text.length) },
      extensions: [
        basicSetup,
        keymap.of([
          indentWithTab,
          { key: 'Mod-s', preventDefault: true, run: () => (handlers.current.onSave(), true) },
        ]),
        ...languageFor(path),
        wraps(path) ? EditorView.lineWrapping : [],
        ro.current.of(editable(readOnlyRef.current)),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) handlers.current.onChange(u.state.doc.toString())
        }),
        EditorView.theme({
          '&': { height: '100%', fontSize: '13px', backgroundColor: '#fff' },
          '.cm-scroller': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', lineHeight: '1.6' },
          '.cm-content': { padding: '12px 0' },
          '.cm-gutters': { backgroundColor: '#fafaf9', borderRight: '1px solid #ecebe8', color: '#a8a29e' },
          '&.cm-focused': { outline: 'none' },
        }),
      ],
    })

  useEffect(() => {
    const v = new EditorView({ parent: host.current!, state: makeState(initialText) })
    view.current = v
    return () => {
      v.destroy()
      view.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path])

  // The file changed on disk: take over its text with a fresh undo history (so
  // ⌘Z can't bring back the stale version), keeping the cursor where it was.
  const firstRev = useRef(doc.rev)
  useEffect(() => {
    const v = view.current
    if (!v || doc.rev === firstRev.current || v.state.doc.toString() === doc.text) return
    v.setState(makeState(doc.text, v.state.selection.main.head))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc])

  useEffect(() => {
    view.current?.dispatch({ effects: ro.current.reconfigure(editable(readOnly)) })
  }, [readOnly])

  return <div ref={host} className="min-h-0 flex-1 overflow-hidden" />
}
