// Speaker notes edited with the change marked: the marks follow the Changes view's paragraph
// alignment (a rewritten paragraph is a struck block, not word salad), and are never part of the text.
import { clearNotesChangeMarks, markNotesChanges } from '../notesChangeMarks'
import { paragraphsText, readParagraphs } from '../textEdit'

const editor = (...paras: string[]) => {
  const div = document.createElement('div')
  div.innerHTML = paras.map((p, i) => `<div data-pptx-p="${i}"><span data-pptx-r="0">${p}</span></div>`).join('')
  document.body.appendChild(div)
  return div
}
const struck = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>('[data-text-ghost]')].map((g) => ({ text: g.textContent?.trim(), block: g.style.display === 'block' }))

describe('markNotesChanges', () => {
  it('marks a rewritten paragraph as a removed block, keeping the text as it is', () => {
    const el = editor(
      'Medicine is the bottom row.',
      'Meanwhile the old approach is running out of road — the easy targets are gone.',
    )
    const before = paragraphsText(readParagraphs(el))
    markNotesChanges(el, "Medicine is the bottom row.\nAnd the timing isn't an accident: the old model ran out of road.")
    expect(struck(el)).toEqual([{ text: "And the timing isn't an accident: the old model ran out of road.", block: true }])
    expect(paragraphsText(readParagraphs(el))).toBe(before)
    clearNotesChangeMarks(el)
    expect(struck(el)).toEqual([])
  })

  it('marks an edited paragraph word by word, removed words before the next word', () => {
    const el = editor('Everyone has seen the clip of an astronaut chasing coffee.')
    markNotesChanges(el, 'Everyone has seen the video of an astronaut chasing coffee.')
    expect(struck(el)).toEqual([{ text: 'video', block: false }])
    expect(el.textContent).toBe('Everyone has seen the video clip of an astronaut chasing coffee.')
    expect(paragraphsText(readParagraphs(el))).toBe('Everyone has seen the clip of an astronaut chasing coffee.')
  })

  it('redoing the marks replaces them', () => {
    const el = editor('One two three.')
    markNotesChanges(el, 'One four three.')
    markNotesChanges(el, 'One four three.')
    expect(struck(el)).toEqual([{ text: 'four', block: false }])
  })
})
