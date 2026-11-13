/** In-app clipboard for shapes and slides (works across decks in this window). */

import type { NodeClipboard } from '@diceui/pptx-core'

/** One slide, self-contained so it pastes into another deck (its shapes + images). */
export interface PortableSlide {
  title: string
  /** Layout name in the source deck — matched by name in the target. */
  layoutName?: string
  nodes: NodeClipboard
}

export type AppClipboard =
  | { kind: 'nodes'; deckKey: string; slideId: string; data: NodeClipboard; label: string }
  | { kind: 'slides'; deckKey: string; deckName: string; slideIds: string[]; portable: PortableSlide[]; width: number; height: number }

let current: AppClipboard | null = null
export const getClipboard = () => current
export const setClipboard = (c: AppClipboard) => {
  current = c
}
