/**
 * Shortcut labels for the platform. The app writes them the Mac way ("⌘Z", "⇧⌘G", "⌥⇧⌘V"); on
 * Windows / Linux they read "Ctrl+Z", "Ctrl+Shift+G", "Ctrl+Alt+Shift+V" — in tooltips (rewritten as
 * the pointer reaches them: titles are many and spread out) and in toasts (`keyLabel`). The keys
 * themselves already work either way (handlers take ⌘ or Ctrl).
 */

export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)

const MODS = /([⌃⌥⇧⌘]+)([A-Za-z][a-z]*|[^\s,;)\]A-Za-z])/g

/** "⇧⌘Z" → "Ctrl+Shift+Z" (and "⌘Enter" → "Ctrl+Enter") off the Mac; unchanged on it. */
export function keyLabel(text: string, mac = isMac): string {
  if (mac || !/[⌃⌥⇧⌘]/.test(text)) return text
  return text.replace(MODS, (_, mods: string, key: string) => {
    const names: string[] = []
    if (mods.includes('⌘') || mods.includes('⌃')) names.push('Ctrl')
    if (mods.includes('⌥')) names.push('Alt')
    if (mods.includes('⇧')) names.push('Shift')
    return [...names, key].join('+')
  })
}

/** Off the Mac: tooltips with Mac shortcut symbols are rewritten as the pointer reaches them. */
export function installShortcutLabels() {
  if (isMac) return
  document.addEventListener(
    'mouseover',
    (e) => {
      const el = (e.target as Element | null)?.closest?.('[title]')
      const t = el?.getAttribute('title')
      if (el && t && /[⌃⌥⇧⌘]/.test(t)) el.setAttribute('title', keyLabel(t))
    },
    true,
  )
}
