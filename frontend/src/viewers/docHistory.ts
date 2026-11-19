/**
 * One undo/redo history per open text file, shared by its views.
 *
 * A Markdown file has two views — the formatted one (MarkdownEditable) and
 * the source editor (CodeMirror) — and each used to keep its own history,
 * lost whenever the view closed (switching between them, or to another file).
 * Now both work on this one: a CodeMirror `history()` state kept here, per
 * file, for as long as the app runs.
 *
 * - The source editor starts from it (`stateFor`: the editor's own setup,
 *   this history and cursor) and hands every update back (`sync`).
 * - The formatted view records each saved edit as one step (`edit`) and
 *   undoes/redoes through it (`undo` / `redo`).
 * - A change that isn't the user's — the agent saving the file — goes in with
 *   `external`: not undoable, and the user's steps are mapped over it, so
 *   undo keeps working on their own edits.
 *
 * It also remembers the cursor as a position in the source (`cursor`), so the
 * other view can open at the same place.
 */

import { EditorSelection, EditorState, Transaction, type Extension } from '@codemirror/state'
import { history, historyField, isolateHistory, redo, undo } from '@codemirror/commands'
import { textChanges } from './textMerge'

export class DocHistory {
  state: EditorState
  /** Whether `cursor` is a real place the user was at (not just the start of a freshly opened file). */
  placed = false

  constructor(text: string) {
    this.state = EditorState.create({ doc: text, extensions: [history()] })
  }

  text(): string {
    return this.state.doc.toString()
  }

  /** The cursor / selection, as source offsets. */
  cursor(): { anchor: number; head: number } {
    const m = this.state.selection.main
    return { anchor: m.anchor, head: m.head }
  }

  setCursor(anchor: number, head = anchor) {
    const len = this.state.doc.length
    const sel = EditorSelection.single(Math.max(0, Math.min(anchor, len)), Math.max(0, Math.min(head, len)))
    this.state = this.state.update({ selection: sel, annotations: Transaction.addToHistory.of(false) }).state
    this.placed = true
  }

  /**
   * A user edit made outside the source editor: one undo step. The cursor is put at the change
   * first, so undoing it returns the cursor to where the edit was (redoing: to its end).
   */
  edit(next: string) {
    const now = this.text()
    if (next === now) return
    const spec = textChanges(now, next)
    if (!spec.length) return
    this.state = this.state.update({ selection: { anchor: spec[0].from }, annotations: Transaction.addToHistory.of(false) }).state
    const changes = this.state.changes(spec)
    const end = changes.mapPos(spec[spec.length - 1].to, 1)
    this.state = this.state.update({
      changes,
      selection: { anchor: end },
      annotations: [isolateHistory.of('full'), Transaction.userEvent.of('input.formatted')],
    }).state
  }

  /** A change from elsewhere (the file changed on disk): not undoable; earlier steps still apply around it. */
  external(next: string) {
    const now = this.text()
    if (next === now) return
    this.state = this.state.update({ changes: textChanges(now, next), annotations: Transaction.addToHistory.of(false) }).state
  }

  /** Undo one step; the text after it, or null when there's nothing to undo. */
  undo(): string | null {
    return this.run(undo)
  }

  redo(): string | null {
    return this.run(redo)
  }

  private run(command: typeof undo): string | null {
    let done = false
    command({ state: this.state, dispatch: (tr) => { this.state = tr.state; done = true } })
    return done ? this.text() : null
  }

  /** A state for a source editor with `extensions` (which must include `history()`), carrying this history and cursor. */
  stateFor(extensions: Extension): EditorState {
    return EditorState.fromJSON(this.state.toJSON({ history: historyField }), { extensions }, { history: historyField })
  }

  /** The source editor's latest state (it owns the history while it's open). */
  sync(state: EditorState, userMovedCursor = false) {
    this.state = state
    if (userMovedCursor) this.placed = true
  }
}

const histories = new Map<string, DocHistory>()

/**
 * The history of a file (`key`: project and path), created on first use. `text` is what the view
 * is about to show: if the file changed while no view had it open, that change is taken in (not undoable).
 */
export function docHistory(key: string, text: string): DocHistory {
  let h = histories.get(key)
  if (!h) {
    h = new DocHistory(text)
    histories.set(key, h)
  } else h.external(text)
  return h
}
