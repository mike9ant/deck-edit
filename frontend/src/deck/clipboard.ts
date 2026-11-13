/** In-app clipboard for shapes and slides (works across decks in this window). */

import type { NodeClipboard } from '@diceui/pptx-core'

export type AppClipboard =
  | { kind: 'nodes'; deckKey: string; slideId: string; data: NodeClipboard; label: string }
  | { kind: 'slides'; deckKey: string; slideIds: string[] }

let current: AppClipboard | null = null
export const getClipboard = () => current
export const setClipboard = (c: AppClipboard) => {
  current = c
}
