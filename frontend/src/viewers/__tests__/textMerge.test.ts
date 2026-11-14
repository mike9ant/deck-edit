import { describe, expect, it } from 'vitest'
import { rebase, textChanges } from '../textMerge'

describe('merging unsaved typing with the agent’s saved change', () => {
  const base = '# Notes\n\nIntro line.\n\nMiddle paragraph.\n\nClosing line.\n'
  it('keeps both when they touch different places', () => {
    const mine = base.replace('Intro line.', 'Intro line, edited by me.')
    const theirs = base.replace('Closing line.', 'Closing line, rewritten by the agent.')
    const r = rebase(base, mine, theirs)
    expect(r.clean).toBe(true)
    expect(r.text).toBe('# Notes\n\nIntro line, edited by me.\n\nMiddle paragraph.\n\nClosing line, rewritten by the agent.\n')
  })
  it('takes theirs when I changed nothing, mine when they changed nothing', () => {
    expect(rebase(base, base, 'X')).toEqual({ text: 'X', clean: true })
    expect(rebase(base, 'Y', base)).toEqual({ text: 'Y', clean: true })
  })
  it('reports an overlap it could not place', () => {
    const mine = base.replace('Middle paragraph.', 'Middle paragraph — my words.')
    const theirs = base.replace('\nMiddle paragraph.\n', '\nCompletely different text from the agent here.\n')
    expect(rebase(base, mine, theirs).clean).toBe(false)
  })
  it('turns two texts into minimal separate edits', () => {
    const a = 'one two three four'
    const b = 'one 2 three four!'
    const ch = textChanges(a, b)
    let out = a
    for (const c of [...ch].reverse()) out = out.slice(0, c.from) + c.insert + out.slice(c.to)
    expect(out).toBe(b)
    expect(ch.length).toBe(2)
  })
})
