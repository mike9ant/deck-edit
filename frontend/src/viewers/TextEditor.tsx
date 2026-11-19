/**
 * Editable text documents (Markdown, .txt, code/config files) on CodeMirror 6.
 *
 * `useTextDoc` owns the file: it loads it, autosaves edits shortly after you
 * stop typing (etag-guarded: never overwrites a change made on disk meanwhile),
 * and reports saved edits to the agent (textEdits.ts). It stays editable while
 * the agent works: when the agent (or another app) changes the file, your
 * not-yet-saved typing is merged onto its version (textMerge.ts) and saved,
 * and the editor takes the change in as minimal edits — your cursor stays put
 * and ⌘Z undoes only your own typing.
 *
 * With a `history` (docHistory.ts) the editor's undo history and cursor
 * outlive it: they're shared with the formatted Markdown view and kept when
 * the file is closed and reopened.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { basicSetup } from 'codemirror'
import { Annotation, Compartment, EditorState, Transaction, type Extension } from '@codemirror/state'
import { Decoration, EditorView, WidgetType, keymap } from '@codemirror/view'
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
import { rebase, textChanges } from './textMerge'
import type { DocHistory } from './docHistory'

/** Marks the editor transaction that takes in a change from disk (not the user's typing). */
const fromDisk = Annotation.define<boolean>()

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
  /** Text the editor must take over (`rev` bumps); `mine` is the editor text it was merged from. */
  const [doc, setDoc] = useState<TextDocState | null>(null)
  const [status, setStatus] = useState<SaveStatus>('saved')
  const [error, setError] = useState<string | null>(null)
  const cur = useRef('')
  const saved = useRef('')
  const etag = useRef('')
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const inflight = useRef<Promise<void> | null>(null)
  const loaded = useRef(false)
  const flushRef = useRef<() => Promise<void>>(() => Promise.resolve())

  const load = useCallback(async (onDiskChange: boolean) => {
    if (inflight.current) await inflight.current
    const r = await api.readText(pid, path)
    if (r.etag && r.etag === etag.current) return // our own save, or nothing new
    etag.current = r.etag
    if (r.text === cur.current && loaded.current) {
      saved.current = r.text
      return
    }
    // Typing not saved yet: re-apply it on top of the new version.
    const mine = cur.current
    let text = r.text
    let clean = true
    if (onDiskChange && loaded.current && mine !== saved.current) ({ text, clean } = rebase(saved.current, mine, r.text))
    saved.current = r.text
    cur.current = text
    loaded.current = true
    setDoc((d) => ({ text, rev: (d?.rev ?? 0) + 1, mine }))
    if (text !== r.text) {
      setStatus('dirty')
      clearTimeout(timer.current)
      timer.current = setTimeout(() => void flushRef.current(), 300)
    } else setStatus('saved')
    if (!clean) useApp.getState().toast(`Part of your typing in ${path} overlapped the agent's edit and couldn't be merged — check that spot.`, 'error')
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
          // Changed on disk meanwhile (the agent): merge this typing onto that version; it saves again.
          etag.current = ''
          inflight.current = null
          await load(true)
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

export interface TextDocState {
  text: string
  rev: number
  /** The editor's text this was merged from (typing after that is merged again on arrival). */
  mine?: string
}

/** The selected text and its lines (1-based). */
export interface TextSelection {
  text: string
  fromLine: number
  toLine: number
}
/** Text a note is about, to highlight (found near its line). */
export interface QuoteMark {
  /** The note's id (the Markdown view opens its card from the badge). */
  id?: string
  quote: string
  line?: number
  /** The note's badge (its number) at the right of the text, and the note shown on hover. */
  label?: string
  title?: string
}

/** A note's badge at the end of the line its quote ends on (floated to the right). */
class NoteBadge extends WidgetType {
  constructor(readonly label: string, readonly title: string) {
    super()
  }
  eq(o: NoteBadge) {
    return o.label === this.label && o.title === this.title
  }
  toDOM() {
    const el = document.createElement('span')
    el.className = 'cm-note-badge'
    el.textContent = this.label
    el.title = this.title
    return el
  }
}

/** Where `quote` occurs in `doc`, preferring the occurrence nearest `line`. */
export function findQuote(doc: string, quote: string, line?: number): { from: number; to: number } | null {
  if (!quote) return null
  let best: { from: number; d: number } | null = null
  for (let i = doc.indexOf(quote), n = 0; i >= 0 && n < 200; i = doc.indexOf(quote, i + 1), n++) {
    const at = doc.slice(0, i).split('\n').length
    const d = line ? Math.abs(at - line) : n
    if (!best || d < best.d) best = { from: i, d }
  }
  if (best) return { from: best.from, to: best.from + quote.length }
  // A quote selected in the formatted Markdown view: the source has line breaks, `> ` and `*`
  // where the rendered text doesn't. Match ignoring whitespace and Markdown markers.
  const skip = /[\s*_`~>#]/
  const map: number[] = []
  let squeezed = ''
  for (let k = 0; k < doc.length; k++) {
    if (!skip.test(doc[k])) {
      squeezed += doc[k]
      map.push(k)
    }
  }
  const q = [...quote].filter((c) => !skip.test(c)).join('')
  const i = q ? squeezed.indexOf(q) : -1
  return i >= 0 ? { from: map[i], to: map[i + q.length - 1] + 1 } : null
}

const quoteMark = Decoration.mark({ class: 'cm-note-quote' })
const quoteDecorations = (marks: QuoteMark[]) =>
  EditorView.decorations.compute(['doc'], (state) => {
    const text = state.doc.toString()
    const decos = marks.flatMap((m) => {
      const r = findQuote(text, m.quote, m.line)
      if (!r || r.to <= r.from) return []
      const out = [quoteMark.range(r.from, r.to)]
      if (m.label) out.push(Decoration.widget({ widget: new NoteBadge(m.label, m.title ?? ''), side: 1 }).range(state.doc.lineAt(r.to).to))
      return out
    })
    return Decoration.set(decos, true)
  })

export function CodeEditor({ path, doc, initialText, readOnly, onChange, onSave, onSelection, marks = [], revealRef, history }: {
  path: string
  /** The file's shared undo history and cursor (see docHistory.ts). */
  history?: DocHistory
  doc: TextDocState
  /** The selection changed (null: nothing selected). */
  onSelection?(s: TextSelection | null): void
  /** Text of open notes, highlighted. */
  marks?: QuoteMark[]
  /** Set to a function that selects and scrolls to a quote. */
  revealRef?: React.MutableRefObject<((quote: string, line?: number) => void) | null>
  /** What to show on mount — the latest text, which may include edits made since `doc` was loaded. */
  initialText: string
  readOnly: boolean
  onChange(text: string): void
  onSave(): void
}) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const ro = useRef(new Compartment())
  const marksComp = useRef(new Compartment())
  const handlers = useRef({ onChange, onSave, onSelection })
  handlers.current = { onChange, onSave, onSelection }
  const marksRef = useRef(marks)
  marksRef.current = marks
  const historyRef = useRef(history)
  historyRef.current = history

  const readOnlyRef = useRef(readOnly)
  readOnlyRef.current = readOnly
  const editable = (r: boolean) => [EditorState.readOnly.of(r), EditorView.editable.of(!r)]
  const makeState = (text: string) => {
    const h = historyRef.current
    if (!h) return EditorState.create({ doc: text, extensions: extensions() })
    h.external(text) // normally the same text; if not, the file changed meanwhile
    return h.stateFor(extensions())
  }
  const extensions = (): Extension[] => [
    basicSetup,
    keymap.of([
      indentWithTab,
      { key: 'Mod-s', preventDefault: true, run: () => (handlers.current.onSave(), true) },
    ]),
    ...languageFor(path),
    wraps(path) ? EditorView.lineWrapping : [],
    ro.current.of(editable(readOnlyRef.current)),
    marksComp.current.of(quoteDecorations(marksRef.current)),
    EditorView.updateListener.of((u) => {
      historyRef.current?.sync(u.state, u.selectionSet && u.view.hasFocus)
      if (u.docChanged && !u.transactions.some((t) => t.annotation(fromDisk))) handlers.current.onChange(u.state.doc.toString())
      if (u.selectionSet || u.docChanged) {
        const m = u.state.selection.main
        handlers.current.onSelection?.(m.empty ? null : { text: u.state.sliceDoc(m.from, m.to), fromLine: u.state.doc.lineAt(m.from).number, toLine: u.state.doc.lineAt(m.to).number })
      }
    }),
    EditorView.theme({
      '&': { height: '100%', fontSize: '13px', backgroundColor: '#fff' },
      '.cm-scroller': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', lineHeight: '1.6' },
      '.cm-content': { padding: '12px 0' },
      '.cm-gutters': { backgroundColor: '#fafaf9', borderRight: '1px solid #ecebe8', color: '#a8a29e' },
      '&.cm-focused': { outline: 'none' },
    }),
  ]

  useEffect(() => {
    const v = new EditorView({ parent: host.current!, state: makeState(initialText) })
    view.current = v
    // Opened where the user was (in this view, or in the formatted one).
    if (historyRef.current?.placed) {
      v.dispatch({ effects: EditorView.scrollIntoView(v.state.selection.main.head, { y: 'center' }) })
      v.focus()
    }
    return () => {
      v.destroy()
      view.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path])

  // The file changed on disk: take its text in as minimal edits kept out of the undo history,
  // so the cursor stays put and ⌘Z undoes only the user's own typing.
  const firstRev = useRef(doc.rev)
  useEffect(() => {
    const v = view.current
    if (!v || doc.rev === firstRev.current) return
    const now = v.state.doc.toString()
    // Typed more since the merge was computed: merge that too.
    const target = doc.mine !== undefined && now !== doc.mine ? rebase(doc.mine, now, doc.text).text : doc.text
    if (now === target) return
    v.dispatch({ changes: textChanges(now, target), annotations: [fromDisk.of(true), Transaction.addToHistory.of(false)] })
    if (target !== doc.text) handlers.current.onChange(target)
  }, [doc])

  useEffect(() => {
    view.current?.dispatch({ effects: ro.current.reconfigure(editable(readOnly)) })
  }, [readOnly])

  const marksKey = JSON.stringify(marks)
  useEffect(() => {
    view.current?.dispatch({ effects: marksComp.current.reconfigure(quoteDecorations(marks)) })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [marksKey])

  useEffect(() => {
    if (!revealRef) return
    revealRef.current = (quote, line) => {
      const v = view.current
      const r = v && findQuote(v.state.doc.toString(), quote, line)
      if (!v || !r) return
      v.dispatch({ selection: { anchor: r.from, head: r.to }, effects: EditorView.scrollIntoView(r.from, { y: 'center' }) })
      v.focus()
    }
    return () => { revealRef.current = null }
  }, [revealRef])

  return <div ref={host} className="min-h-0 flex-1 overflow-hidden" />
}
