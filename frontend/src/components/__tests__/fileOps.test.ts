import { describe, expect, it } from 'vitest'
import { planMove, splitForMiddleEllipsis } from '../fileOps'

describe('moving dropped items', () => {
  it('skips no-op and impossible moves, and children of moved folders', () => {
    expect(planMove(['a.md', 'docs/b.md'], 'docs')).toEqual([['a.md', 'docs/a.md']])
    expect(planMove(['docs'], 'docs/sub')).toEqual([]) // a folder into itself
    expect(planMove(['docs', 'docs/b.md'], 'archive')).toEqual([['docs', 'archive/docs']])
    expect(planMove(['docs/b.md'], '')).toEqual([['docs/b.md', 'b.md']])
  })
})

describe('middle ellipsis', () => {
  it('keeps the end of long names (with the extension) visible', () => {
    expect(splitForMiddleEllipsis('Acme — Board Review Deck (Full) - draft_3.pptx')).toEqual(['Acme — Board Review Deck (Full) - d', 'raft_3.pptx'])
    expect(splitForMiddleEllipsis('notes.md')).toEqual(['notes.md', ''])
  })
})
