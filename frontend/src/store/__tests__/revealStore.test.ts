import { describe, expect, it } from 'vitest'
import { locationLabel, parseLocation, resolvePath } from '../revealStore'
import type { TreeNode } from '../../api/types'

describe('chat location links', () => {
  it('reads a path and a location', () => {
    expect(parseLocation('Deck.pptx#slide=5')).toEqual({ path: 'Deck.pptx', slide: 5 })
    expect(parseLocation('Report.pdf#page=3')).toEqual({ path: 'Report.pdf', page: 3 })
    expect(parseLocation('notes/plan.md#line=42-48')).toEqual({ path: 'notes/plan.md', line: 42, endLine: 48 })
    expect(parseLocation('notes/plan.md#L7')).toEqual({ path: 'notes/plan.md', line: 7, endLine: undefined })
    expect(parseLocation('Model.xlsx#cell=Sheet1!B4')).toEqual({ path: 'Model.xlsx', sheet: 'Sheet1', cell: 'B4' })
    expect(parseLocation("Model.xlsx#cell='P&L 2025'!C9")).toEqual({ path: 'Model.xlsx', sheet: 'P&L 2025', cell: 'C9' })
    expect(parseLocation('Model.xlsx#sheet=Inputs')).toEqual({ path: 'Model.xlsx', sheet: 'Inputs' })
    expect(parseLocation('./Deck.pptx')).toEqual({ path: 'Deck.pptx' })
  })

  it('decodes spaces and makes absolute project paths relative', () => {
    expect(parseLocation('Investor%20Deck.pptx#slide=2')).toEqual({ path: 'Investor Deck.pptx', slide: 2 })
    expect(parseLocation('/Users/me/Biz/Deck.pptx#slide=1', '/Users/me/Biz/')).toEqual({ path: 'Deck.pptx', slide: 1 })
    expect(parseLocation('file:///Users/me/Biz/a.md#line=3', '/Users/me/Biz')).toEqual({ path: 'a.md', line: 3, endLine: undefined })
  })

  it('leaves web and in-page links alone', () => {
    expect(parseLocation('https://example.com/a.pdf#page=2')).toBeNull()
    expect(parseLocation('mailto:someone@example.com')).toBeNull()
    expect(parseLocation('#section')).toBeNull()
    expect(parseLocation(undefined)).toBeNull()
  })

  it('labels a location', () => {
    expect(locationLabel({ path: 'Deck.pptx', slide: 5 })).toBe('Deck.pptx · slide 5')
    expect(locationLabel({ path: 'a.md', line: 3, endLine: 9 })).toBe('a.md · lines 3–9')
    expect(locationLabel({ path: 'm.xlsx', sheet: 'S', cell: 'B4' })).toBe('m.xlsx · S!B4')
  })

  it('finds the file a link means', () => {
    const tree: TreeNode[] = [
      { name: 'Deck.pptx', path: 'Deck.pptx', kind: 'file' },
      { name: 'docs', path: 'docs', kind: 'dir', children: [{ name: 'Plan.md', path: 'docs/Plan.md', kind: 'file' }, { name: 'a.md', path: 'docs/a.md', kind: 'file' }] },
      { name: 'old', path: 'old', kind: 'dir', children: [{ name: 'a.md', path: 'old/a.md', kind: 'file' }] },
    ]
    expect(resolvePath('Deck.pptx', tree)).toBe('Deck.pptx')
    expect(resolvePath('deck.PPTX', tree)).toBe('Deck.pptx')
    expect(resolvePath('Plan.md', tree)).toBe('docs/Plan.md') // the one file with that name
    expect(resolvePath('a.md', tree)).toBeNull() // two of them
    expect(resolvePath('missing.md', tree)).toBeNull()
  })
})
