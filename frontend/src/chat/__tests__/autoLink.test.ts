import { describe, expect, it } from 'vitest'
import { autoLink, fileRefs } from '../autoLink'

const refs = fileRefs([
  "Michael's ARDD 2025 Talk_FINAL.pptx",
  'Deck A - The Vision for Human.pptx',
  'Deep Origin — Investor_WIP_3.pptx',
  'Deep Origin — Investor_WIP_3.pdf',
  'report.pdf',
  'docs/plan.md',
  'second-deck.pptx',
  'Q3 Plan.pptx',
])

describe('auto-linking plain mentions', () => {
  it('links a deck named before the slide (shortened, any case)', () => {
    expect(autoLink("Figure 2, speed. Michael's ARDD 2025 Talk slide 11: ns/day for a 50K-atom system", refs)).toBe(
      "Figure 2, speed. [Michael's ARDD 2025 Talk slide 11](<Michael's ARDD 2025 Talk_FINAL.pptx#slide=11>): ns/day for a 50K-atom system",
    )
    expect(autoLink('see second-deck.pptx, slide 3', refs)).toBe('see [second-deck.pptx, slide 3](<second-deck.pptx#slide=3>)')
    expect(autoLink('see Second Deck slide 3', refs)).toBe('see [Second Deck slide 3](<second-deck.pptx#slide=3>)')
  })

  it('keeps emphasis and quotes whole', () => {
    expect(autoLink("In *Michael's ARDD 2025 Talk*, slide 11 shows it", refs)).toBe(
      "In [*Michael's ARDD 2025 Talk*, slide 11](<Michael's ARDD 2025 Talk_FINAL.pptx#slide=11>) shows it",
    )
    expect(autoLink('the "Q3 Plan" deck, slide 2', refs)).toBe('the ["Q3 Plan" deck, slide 2](<Q3 Plan.pptx#slide=2>)')
  })

  it('links "slide N of <deck>" and pages and lines', () => {
    expect(autoLink('as on slide 4 of the Q3 Plan deck.', refs)).toBe('as on [slide 4 of the Q3 Plan](<Q3 Plan.pptx#slide=4>) deck.')
    expect(autoLink('report.pdf page 3 has it', refs)).toBe('[report.pdf page 3](<report.pdf#page=3>) has it')
    expect(autoLink('docs/plan.md lines 4–9', refs)).toBe('[docs/plan.md lines 4–9](<docs/plan.md#line=4-9>)')
    expect(autoLink('plan.md line 7', refs)).toBe('[plan.md line 7](<docs/plan.md#line=7>)')
  })

  it('picks the file of the right kind; leaves names that could be two files', () => {
    // A slide is in the deck, a page in the PDF, though both are called "Deep Origin — Investor_WIP_3".
    expect(autoLink('Deep Origin — Investor WIP 3 slide 5', refs)).toBe('[Deep Origin — Investor WIP 3 slide 5](<Deep Origin — Investor_WIP_3.pptx#slide=5>)')
    expect(autoLink('Deep Origin — Investor WIP 3 page 5', refs)).toBe('Deep Origin — Investor WIP 3 page 5') // a deck and a PDF: ambiguous
    expect(autoLink('Deep Origin slide 5', refs)).toBe('Deep Origin slide 5') // too short a start of the name
    expect(autoLink('Deck slide 5', refs)).toBe('Deck slide 5')
  })

  it('leaves bare locations, links, code and URLs alone', () => {
    expect(autoLink('I changed slide 5 and slide 6.', refs)).toBe('I changed slide 5 and slide 6.')
    const linked = '[Q3 Plan slide 2](<Q3 Plan.pptx#slide=2>)'
    expect(autoLink(linked, refs)).toBe(linked)
    expect(autoLink('`Q3 Plan slide 2`', refs)).toBe('`Q3 Plan slide 2`')
    expect(autoLink('```\nQ3 Plan slide 2\n```', refs)).toBe('```\nQ3 Plan slide 2\n```')
  })
})
