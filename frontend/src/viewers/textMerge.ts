/**
 * Merging the user's unsaved typing with a change the agent saved meanwhile:
 * the user's edit (last saved text → what's in the editor) is re-applied onto
 * the agent's version as a fuzzy patch (diff-match-patch). Saves happen ~0.7 s
 * after typing stops, so only that much typing is ever in flight.
 */

import DiffMatchPatch from 'diff-match-patch'

const dmp = new DiffMatchPatch()
// Strict placement: an edit whose surroundings the agent rewrote is reported, not glued onto its new text.
dmp.Match_Threshold = 0.3
dmp.Patch_DeleteThreshold = 0.3

/**
 * `mine` was edited from `base`; `theirs` is another edit of `base`. Returns
 * their text with my edit applied; `clean` is false when part of my edit
 * overlapped theirs and couldn't be placed (that part is dropped).
 */
export function rebase(base: string, mine: string, theirs: string): { text: string; clean: boolean } {
  if (mine === base) return { text: theirs, clean: true }
  if (theirs === base || theirs === mine) return { text: mine, clean: true }
  const [text, applied] = dmp.patch_apply(dmp.patch_make(base, mine), theirs)
  return { text, clean: applied.every(Boolean) }
}

/** The edits turning `from` into `to`, as [position in `from`, length removed, text inserted]. */
export function textChanges(from: string, to: string): { from: number; to: number; insert: string }[] {
  const diffs = dmp.diff_main(from, to)
  dmp.diff_cleanupSemantic(diffs)
  const out: { from: number; to: number; insert: string }[] = []
  let pos = 0
  for (const [op, t] of diffs) {
    if (op === DiffMatchPatch.DIFF_EQUAL) pos += t.length
    else if (op === DiffMatchPatch.DIFF_DELETE) {
      const last = out[out.length - 1]
      if (last && last.to === pos && !last.insert) last.to += t.length
      else out.push({ from: pos, to: pos + t.length, insert: '' })
      pos += t.length
    } else {
      const last = out[out.length - 1]
      if (last && last.to === pos) last.insert += t
      else out.push({ from: pos, to: pos, insert: t })
    }
  }
  return out
}
