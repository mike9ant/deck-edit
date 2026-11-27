/**
 * Text being typed and not yet saved, per deck — a text box being edited on a slide, or the speaker
 * notes — for the comparison to preview as you type (CompareView `useCompareDiff`). Outside the
 * stores: it changes on every keystroke, and only the comparison listens.
 */

import { useSyncExternalStore } from 'react'
import type { Typing } from './deckDiff'

const typing = new Map<string, Typing>()
const listeners = new Map<string, Set<() => void>>()

/** Report the text being typed in deck `key` (null: done — saved, or the box / notes left). */
export function setTyping(key: string, t: Typing | null) {
  const was = typing.get(key)
  if (t ? was && was.slide === t.slide && was.node === t.node && was.text === t.text : !was) return
  if (t) typing.set(key, t)
  else typing.delete(key)
  listeners.get(key)?.forEach((f) => f())
}

export const getTyping = (key: string): Typing | null => typing.get(key) ?? null

export function useTyping(key: string | undefined): Typing | null {
  return useSyncExternalStore(
    (f) => {
      if (!key) return () => {}
      let set = listeners.get(key)
      if (!set) listeners.set(key, (set = new Set()))
      set.add(f)
      return () => set!.delete(f)
    },
    () => (key ? getTyping(key) : null),
  )
}
