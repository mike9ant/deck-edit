// Find in a deck: the query as a regex (case, whole words, special characters), and the matches
// in the sample deck's slides and speaker notes.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readPptx, buildPresentation, materializeAllSlides } from '@diceui/pptx-core'
import { readNotes } from '../speakerNotes'
import { findInDeck, findRegex } from '../find'

const deckPath = resolve(process.cwd(), '..', 'sample-project', 'Rabbit Hole Roasters — Investor Deck.pptx')

describe('findRegex', () => {
  it('escapes, and honours case and whole words', () => {
    expect(findRegex('  ', { matchCase: false, wholeWord: false })).toBeNull()
    expect('cost $12M (est.)'.match(findRegex('$12M (est.)', { matchCase: false, wholeWord: false })!)?.[0]).toBe('$12M (est.)')
    expect('Orbit orbital orbit'.match(findRegex('orbit', { matchCase: false, wholeWord: false })!)).toHaveLength(3)
    expect('Orbit orbital orbit'.match(findRegex('orbit', { matchCase: true, wholeWord: false })!)).toHaveLength(2)
    expect('Orbit orbital orbit'.match(findRegex('orbit', { matchCase: false, wholeWord: true })!)).toHaveLength(2)
    expect('café cafés'.match(findRegex('café', { matchCase: false, wholeWord: true })!)).toHaveLength(1)
  })
})

describe('findInDeck', () => {
  it('finds in the slides and, when asked, the notes — in deck order', async () => {
    const bytes = readFileSync(deckPath)
    const pres = buildPresentation(await readPptx(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, { keepSourcePackage: true }))
    materializeAllSlides(pres)
    const notes = new Map<string, string>()
    for (const s of pres.slides) notes.set(s.id, await readNotes(pres, s))
    const re = findRegex('orbit', { matchCase: false, wholeWord: true })!
    const slidesOnly = findInDeck(pres, notes, re, { matchCase: false, wholeWord: true, notes: false })
    const all = findInDeck(pres, notes, re, { matchCase: false, wholeWord: true, notes: true })
    expect(slidesOnly.every((m) => m.where === 'slide' && m.nodeId)).toBe(true)
    expect(all.length).toBeGreaterThan(slidesOnly.length)
    // Slide 1: its subtitle, then its notes.
    expect(all.filter((m) => m.slideIndex === 0).map((m) => m.where)).toEqual(['slide', 'notes'])
    expect(all.map((m) => m.slideIndex)).toEqual([...all.map((m) => m.slideIndex)].sort((a, b) => a - b))
    for (const m of all) expect(m.snippet.match.toLowerCase()).toBe('orbit')
  })
})
