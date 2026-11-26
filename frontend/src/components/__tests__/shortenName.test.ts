// File names shortened by dropping whole middle words, keeping what tells them apart from siblings.
import { describe, expect, it } from 'vitest'
import { nameUnits, shortenName, splitExt } from '../shortenName'

/** Every character 7px wide. */
const measure = (s: string) => s.length * 7
const fit = (name: string, chars: number, siblings?: string[]) => shortenName(name, chars * 7, measure, siblings)
const units = (stem: string) => nameUnits(stem).map((u) => (u.mark ? `[${u.text}]` : u.text))

const DECKS = [
  'Deep Origin — Investor Deck (Full) - MA_WIP_1.pptx',
  'Deep Origin — Investor Deck (Full) - MA_WIP_2.pptx',
  'Deep Origin — Investor Deck (Full) - MA_WIP_4.pptx',
  'Deep Origin — Short Investor Deck - WIP_4_a.pptx',
  'Deep Origin — Short Investor Deck - WIP_5_a.pptx',
  'Deep Origin — Ultra Short Investor Deck - WIP_1.pptx',
  'Deep Origin — Ultra Short Investor Deck - WIP_3_a.pptx',
  'Deep Origin — Ultra Short Investor Deck - WIP_3_b.pptx',
  'Deep_Origin___Short_Investor_Deck_-_RAISE_2_CK_5R.pptx',
]

describe('splitExt', () => {
  it('keeps compound document extensions, not version numbers', () => {
    expect(splitExt('Thesis (Short).docx.md')).toEqual(['Thesis (Short)', '.docx.md'])
    expect(splitExt('report.final.pdf')).toEqual(['report.final', '.pdf'])
    expect(splitExt('Notes v1.2')).toEqual(['Notes v1.2', ''])
    expect(splitExt('.env')).toEqual(['.env', ''])
  })
})

describe('nameUnits', () => {
  it('splits at spaces; dashes between words are marks', () => {
    expect(units('Deep Origin — Investor Deck (Full) - MA_WIP_1')).toEqual(['Deep', 'Origin', '[—]', 'Investor', 'Deck', '(Full)', '[-]', 'MA_WIP_1'])
  })
  it('keeps short / numeric underscore pieces together, splits long words at underscores', () => {
    expect(units('Deck - MA_WIP_4_Edits')).toEqual(['Deck', '[-]', 'MA_WIP_4', 'Edits'])
    expect(units('Thesis School_5 draft')).toEqual(['Thesis', 'School_5', 'draft'])
  })
  it('treats underscores, dashes and dots as spaces in a name without spaces', () => {
    expect(units('Deep_Origin___Short_Investor_Deck_-_RAISE_2')).toEqual(['Deep', 'Origin', 'Short', 'Investor', 'Deck', 'RAISE_2'])
    expect(units('deep-origin-deck-transcript-Nov17')).toEqual(['deep', 'origin', 'deck', 'transcript', 'Nov17'])
    expect(units('_work')).toEqual(['work'])
  })
})

describe('shortenName', () => {
  it('leaves names that fit alone', () => {
    expect(fit('notes.md', 20)).toBe('notes.md')
  })
  it('drops shared middle words first, keeping first word, distinguishing words and the end', () => {
    expect(fit(DECKS[6], 34, DECKS)).toBe('Deep … Ultra Short … WIP_3_a.pptx')
    expect(fit(DECKS[0], 30, DECKS)).toBe('Deep … (Full) - MA_WIP_1.pptx')
    expect(fit(DECKS[3], 28, DECKS)).toBe('Deep … Short … WIP_4_a.pptx')
  })
  it('shows more as it gets room', () => {
    const wide = fit(DECKS[6], 46, DECKS)
    expect(wide.length).toBeGreaterThan(fit(DECKS[6], 34, DECKS).length)
    expect(wide.endsWith('WIP_3_a.pptx')).toBe(true)
    expect(wide.startsWith('Deep')).toBe(true)
  })
  it('keeps the separators of an underscore name around the gap', () => {
    expect(fit(DECKS[8], 30, DECKS)).toMatch(/^Deep_…_.*CK_5R\.pptx$/)
  })
  it('cuts letters only when first … last no longer fits: first word end, then last word start', () => {
    expect(fit(DECKS[6], 18, DECKS)).toBe('Deep…WIP_3_a.pptx')
    expect(fit(DECKS[6], 14, DECKS)).toBe('Dee…P_3_a.pptx')
  })
  it('cuts a single long word in its middle', () => {
    expect(fit('Supercalifragilisticexpialidocious.md', 16)).toMatch(/^Super.*….*ious\.md$/)
  })
  it('without siblings, prefers keeping words nearer the end', () => {
    expect(fit('Acme — Board Review Deck (Full) - draft_3.pptx', 28)).toBe('Acme … (Full) - draft_3.pptx')
  })
})
