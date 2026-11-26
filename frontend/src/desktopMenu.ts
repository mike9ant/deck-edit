/**
 * The desktop app's menu bar (desktop/src/main.rs) ↔ the page. Components say which menu items they
 * carry out while mounted (`useMenuActions`) — whether each applies now, and is ticked. The app asks
 * `window.__deckeditMenuState()` a few times a second to grey out / tick its items, and a chosen
 * item arrives as a `deckedit-menu` event. In a browser nothing asks or sends: this is inert.
 */

import { useEffect, useRef } from 'react'

export interface MenuAction {
  run(): void
  /** Default: true. A greyed-out item does nothing (its shortcut neither). */
  enabled?: boolean
  /** For the View / Deck toggles: shown ticked. */
  checked?: boolean
}

type Provider = { get(): Record<string, MenuAction> }
const providers = new Set<Provider>()

/** The actions of every mounted provider; a later-mounted one wins for the same item. */
function actions(): Map<string, MenuAction> {
  const all = new Map<string, MenuAction>()
  for (const p of providers) for (const [id, a] of Object.entries(p.get())) all.set(id, a)
  return all
}

/**
 * Menu items this component carries out while mounted. `get` runs when the app asks (and when an
 * item is chosen), with this render's values — keep it cheap.
 */
export function useMenuActions(get: () => Record<string, MenuAction>) {
  const ref = useRef(get)
  ref.current = get
  useEffect(() => {
    const p: Provider = { get: () => ref.current() }
    providers.add(p)
    return () => {
      providers.delete(p)
    }
  }, [])
}

/** "enabled,ids|checked,ids" — what the app reads. */
function menuState(): string {
  const enabled: string[] = []
  const checked: string[] = []
  for (const [id, a] of actions()) {
    if (a.enabled !== false) enabled.push(id)
    if (a.checked) checked.push(id)
  }
  return `${enabled.sort().join(',')}|${checked.sort().join(',')}`
}

declare global {
  interface Window {
    __deckeditMenuState?: () => string
  }
}

window.__deckeditMenuState = menuState
window.addEventListener('deckedit-menu', (e) => {
  const a = actions().get((e as CustomEvent<string>).detail)
  if (a && a.enabled !== false) a.run()
})
