import { describe, expect, it } from 'vitest'
import { PPTX_ATTRS } from '@diceui/pptx-core'
import { buildParagraphs, notesText, parseParagraphs, renderNotes, styleRange, type StyledParagraph } from '../notesRich'
import { NO_BULLET, readParagraphs, readParagraphsAt } from '../textEdit'

const A = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const body = (inner: string) =>
  [...new DOMParser().parseFromString(`<a:txBody xmlns:a="${A}" xmlns:r="${R}">${inner}</a:txBody>`, 'application/xml').documentElement.children]

const NOTES = body(
  `<a:p><a:r><a:rPr lang="en-US" b="1"/><a:t>Hello </a:t></a:r>` +
    `<a:r><a:rPr lang="en-US" i="1"><a:solidFill><a:srgbClr val="C00000"/></a:solidFill></a:rPr><a:t>world</a:t></a:r>` +
    `<a:br><a:rPr lang="en-US"/></a:br><a:r><a:rPr lang="en-US"/><a:t>second line</a:t></a:r><a:endParaRPr lang="en-US"/></a:p>` +
    `<a:p><a:pPr marL="171450" lvl="1" indent="-171450"><a:buFont typeface="Arial"/><a:buChar char="•"/></a:pPr>` +
    `<a:r><a:rPr lang="en-US"><a:hlinkClick r:id="rId3"/></a:rPr><a:t>a link</a:t></a:r>` +
    `<a:r><a:rPr lang="en-US"/><a:t> on slide </a:t></a:r>` +
    `<a:fld id="{B6F15528-21DE-4FAA-801E-634DDDAF4B2B}" type="slidenum"><a:rPr lang="en-US"/><a:t>3</a:t></a:fld></a:p>` +
    `<a:p><a:pPr><a:buAutoNum type="romanLcParenR"/></a:pPr><a:r><a:rPr lang="en-US"/><a:t>first</a:t></a:r></a:p>` +
    `<a:p><a:pPr><a:buAutoNum type="romanLcParenR"/></a:pPr><a:r><a:rPr lang="en-US"/><a:t>second</a:t></a:r></a:p>`,
)

const mount = (ps: Element[]) => {
  const el = document.createElement('div')
  document.body.appendChild(el)
  renderNotes(el, ps)
  return el
}
const rebuilt = (el: HTMLElement, base: Element[]) => parseParagraphs(buildParagraphs(base, readParagraphs(el)))
const attr = (p: Element, path: string, name: string) => {
  let cur: Element | undefined = p
  for (const step of path.split('/')) cur = cur ? [...cur.children].filter((c) => c.localName === step.replace(/\[\d+\]/, ''))[Number(/\[(\d+)\]/.exec(step)?.[1] ?? 0)] : undefined
  return cur?.getAttribute(name) ?? null
}

describe('formatted speaker notes', () => {
  it('renders formatting, bullets and numbering', () => {
    const el = mount(NOTES)
    const runs = [...el.querySelectorAll<HTMLElement>(`[${PPTX_ATTRS.run}]`)]
    expect(runs[0].style.fontWeight).toBe('700')
    expect(runs[1].style.fontStyle).toBe('italic')
    expect(runs[1].style.color).toBe('rgb(192, 0, 0)')
    expect(runs[3].style.textDecorationLine).toContain('underline') // the link
    expect([...el.querySelectorAll(`[${PPTX_ATTRS.bullet}]`)].map((b) => b.textContent?.trim())).toEqual(['•', 'i)', 'ii)'])
    expect(notesText(NOTES)).toBe('Hello world\nsecond line\na link on slide 3\nfirst\nsecond')
  })

  it('round-trips unchanged notes with all their formatting', () => {
    const out = rebuilt(mount(NOTES), NOTES)
    expect(out).toHaveLength(4)
    expect(attr(out[0], 'r[0]/rPr', 'b')).toBe('1')
    expect(attr(out[0], 'r[1]/rPr', 'i')).toBe('1')
    expect(attr(out[0], 'r[1]/rPr/solidFill/srgbClr', 'val')).toBe('C00000')
    expect([...out[0].children].map((c) => c.localName)).toEqual(['r', 'r', 'br', 'r', 'endParaRPr'])
    expect(attr(out[1], 'pPr', 'lvl')).toBe('1')
    expect(attr(out[1], 'pPr/buChar', 'char')).toBe('•')
    expect(out[1].getElementsByTagNameNS(A, 'hlinkClick')[0]?.getAttributeNS(R, 'id')).toBe('rId3')
    expect(attr(out[1], 'fld', 'type')).toBe('slidenum') // the slide-number field stays a field
    expect(attr(out[2], 'pPr/buAutoNum', 'type')).toBe('romanLcParenR')
    expect(notesText(out)).toBe(notesText(NOTES))
  })

  it('keeps a run’s formatting when its text is edited, and a new line keeps the paragraph’s', () => {
    const el = mount(NOTES)
    const world = el.querySelectorAll<HTMLElement>(`[${PPTX_ATTRS.run}]`)[1]
    world.textContent = 'wide world'
    // Enter at the end of the bulleted line: the browser clones the paragraph element.
    const bulleted = el.querySelectorAll(`[${PPTX_ATTRS.paragraph}]`)[1]
    const added = bulleted.cloneNode(false) as HTMLElement
    const span = document.createElement('span')
    span.setAttribute(PPTX_ATTRS.run, '1')
    span.textContent = 'another point'
    added.appendChild(span)
    bulleted.after(added)
    const out = rebuilt(el, NOTES)
    expect(out[0].getElementsByTagNameNS(A, 't')[1].textContent).toBe('wide world')
    expect(attr(out[0], 'r[1]/rPr', 'i')).toBe('1')
    expect(out).toHaveLength(5)
    expect(attr(out[2], 'pPr/buChar', 'char')).toBe('•')
    expect(attr(out[2], 'pPr', 'lvl')).toBe('1')
    expect(out[2].getElementsByTagNameNS(A, 't')[0].textContent).toBe('another point')
  })

  it('⌘B toggles just the selected characters, and back', () => {
    const el = mount(NOTES)
    const read = readParagraphsAt(el, [])
    const ps = read.paragraphs as StyledParagraph[]
    // "second line" is paragraph 0 after "Hello world\n" (12 chars); bold "second".
    styleRange(NOTES, ps, { p: 0, o: 12 }, { p: 0, o: 18 }, 'b')
    const out = parseParagraphs(buildParagraphs(NOTES, ps))
    const runs = [...out[0].children].filter((c) => c.localName === 'r')
    expect(runs.map((r) => r.textContent)).toEqual(['Hello ', 'world', 'second', ' line'])
    expect(runs.map((r) => attr(r, 'rPr', 'b'))).toEqual(['1', null, '1', null])
    expect(attr(runs[1], 'rPr/solidFill/srgbClr', 'val')).toBe('C00000') // untouched
    // Toggle "Hello" (already bold) → off.
    const el2 = mount(out)
    const ps2 = readParagraphsAt(el2, []).paragraphs as StyledParagraph[]
    styleRange(out, ps2, { p: 0, o: 0 }, { p: 0, o: 5 }, 'b')
    const out2 = parseParagraphs(buildParagraphs(out, ps2))
    const runs2 = [...out2[0].children].filter((c) => c.localName === 'r')
    expect(runs2.map((r) => [r.textContent, attr(r, 'rPr', 'b')])).toEqual([['Hello', '0'], [' ', '1'], ['world', null], ['second', '1'], [' line', null]])
  })

  it('a line whose bullet was removed (Backspace) is written without one, text in place', () => {
    const el = mount(NOTES)
    const bulleted = el.querySelectorAll(`[${PPTX_ATTRS.paragraph}]`)[1]
    bulleted.querySelector(`[${PPTX_ATTRS.bullet}]`)!.remove()
    bulleted.setAttribute(NO_BULLET, '')
    const out = rebuilt(el, NOTES)
    expect(out[1].getElementsByTagNameNS(A, 'buChar')).toHaveLength(0)
    expect(out[1].getElementsByTagNameNS(A, 'buNone')).toHaveLength(1)
    expect(attr(out[1], 'pPr', 'indent')).toBe('0')
    expect(attr(out[1], 'pPr', 'marL')).toBe('171450')
    expect(attr(out[1], 'pPr', 'lvl')).toBe('1')
    expect(attr(out[2], 'pPr/buAutoNum', 'type')).toBe('romanLcParenR') // other lines untouched
    // Rendered again: no bullet, same left edge as before.
    const again = mount(out)
    const line = again.querySelectorAll<HTMLElement>(`[${PPTX_ATTRS.paragraph}]`)[1]
    expect(line.querySelector(`[${PPTX_ATTRS.bullet}]`)).toBeNull()
    expect(line.style.paddingLeft).toBe((el.querySelectorAll<HTMLElement>(`[${PPTX_ATTRS.paragraph}]`)[1]).style.paddingLeft)
  })

  it('text typed into an empty notes page gets the paragraph end formatting', () => {
    const empty = body(`<a:p><a:endParaRPr lang="en-US" sz="1400"/></a:p>`)
    const el = mount(empty)
    const p = el.querySelector(`[${PPTX_ATTRS.paragraph}]`)!
    p.replaceChildren(document.createTextNode('Fresh note'))
    const out = rebuilt(el, empty)
    expect(out[0].getElementsByTagNameNS(A, 't')[0].textContent).toBe('Fresh note')
    expect(attr(out[0], 'r/rPr', 'sz')).toBe('1400')
  })

  it('⌘B on typed text (no run of its own) bolds only the selection, not the text after it', () => {
    const base = body(`<a:p><a:r><a:rPr/><a:t>Semiconductors were fabricated and te</a:t></a:r></a:p>`)
    // As the editor reads it: the original run, then text typed after it (outside any run).
    const edited: StyledParagraph[] = [{ sourceParagraphIndex: 0, runs: [
      { text: 'Semiconductors were fabricated and te', sourceRun: [0, 0] },
      { text: 'sted; now billions of transistors are verified.' },
    ] }]
    const start = 'Semiconductors were fabricated and te'.length
    styleRange(base, edited, { p: 0, o: start }, { p: 0, o: start + 'sted; now billions '.length }, 'b')
    const [p] = parseParagraphs(buildParagraphs(base, edited))
    const runs = [...p.children].filter((c) => c.localName === 'r').map((r) => [r.textContent, r.firstElementChild?.getAttribute('b')])
    expect(runs).toEqual([
      ['Semiconductors were fabricated and te', null],
      ['sted; now billions ', '1'],
      ['of transistors are verified.', null],
    ])
  })
})
