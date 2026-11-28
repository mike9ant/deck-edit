// Mac shortcut labels read the Windows way off the Mac.
import { describe, expect, it } from 'vitest'
import { keyLabel } from '../shortcutLabels'

describe('keyLabel', () => {
  it('spells modifiers out off the Mac', () => {
    expect(keyLabel('Undo (⌘Z)', false)).toBe('Undo (Ctrl+Z)')
    expect(keyLabel('Redo (⇧⌘Z)', false)).toBe('Redo (Ctrl+Shift+Z)')
    expect(keyLabel('Previous (⇧↵, ⇧⌘G)', false)).toBe('Previous (Shift+↵, Ctrl+Shift+G)')
    expect(keyLabel('Paste with formatting (⌥⇧⌘V)', false)).toBe('Paste with formatting (Ctrl+Alt+Shift+V)')
    expect(keyLabel('Pin it (⌘Enter)', false)).toBe('Pin it (Ctrl+Enter)')
    expect(keyLabel('Bring forward (⌘↑)', false)).toBe('Bring forward (Ctrl+↑)')
    expect(keyLabel('⌘B / ⌘I / ⌘U for bold', false)).toBe('Ctrl+B / Ctrl+I / Ctrl+U for bold')
  })
  it('leaves them on the Mac, and text without them', () => {
    expect(keyLabel('Undo (⌘Z)', true)).toBe('Undo (⌘Z)')
    expect(keyLabel('No shortcut here', false)).toBe('No shortcut here')
  })
})
