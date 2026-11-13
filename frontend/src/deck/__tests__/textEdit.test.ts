import { readParagraphs, paragraphsText } from '../textEdit'

const html = (s: string) => {
  const div = document.createElement('div')
  div.innerHTML = s
  return div
}

describe('readParagraphs', () => {
  it('keeps each run’s source formatting when text changes inside it', () => {
    const c = html(
      '<div data-pptx-p="0"><span data-pptx-r="0">We build </span><span data-pptx-r="1">calibrated</span><span data-pptx-r="2"> engines EDITED</span></div>',
    )
    const ps = readParagraphs(c)
    expect(ps).toEqual([
      {
        sourceParagraphIndex: 0,
        runs: [
          { text: 'We build ', sourceRun: [0, 0] },
          { text: 'calibrated', sourceRun: [0, 1] },
          { text: ' engines EDITED', sourceRun: [0, 2] },
        ],
      },
    ])
  })

  it('a paragraph split with Enter inherits its source paragraph; bullets and placeholder breaks are ignored', () => {
    const c = html(
      '<div data-pptx-p="1"><span data-pptx-bullet="">•</span><span data-pptx-r="0">first</span></div>' +
        '<div data-pptx-p="1"><span data-pptx-r="0">second</span></div>' +
        '<div data-pptx-p="2"><br data-pptx-empty-line=""></div>',
    )
    const ps = readParagraphs(c)
    expect(paragraphsText(ps)).toBe('first\nsecond\n')
    expect(ps.map((p) => p.sourceParagraphIndex)).toEqual([1, 1, 2])
    expect(ps[2].runs).toEqual([])
  })

  it('maps a soft line break to a "\\n" run and adopts bare typed text into the paragraph’s run', () => {
    const c = html('<div data-pptx-p="0"><span data-pptx-r="0">line one</span><br>typed</div>')
    const ps = readParagraphs(c)
    expect(ps[0].runs).toEqual([
      { text: 'line one', sourceRun: [0, 0] },
      { text: '\n' },
      { text: 'typed', sourceRun: [0, 0] },
    ])
  })

  it('handles everything selected and retyped (bare text in the container)', () => {
    const c = html('Brand new title')
    expect(readParagraphs(c)).toEqual([{ sourceParagraphIndex: 0, runs: [{ text: 'Brand new title', sourceRun: [0, 0] }] }])
  })
})
