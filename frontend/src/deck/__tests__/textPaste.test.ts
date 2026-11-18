import { describe, expect, it } from 'vitest'
import { cssColorHex, cssFontFamily, cssFontSizePt, insertionStart, normalizePasted, parseClipboardHtml, styledRanges, styledText } from '../textPaste'

describe('pasted text', () => {
  it('normalizes line breaks and drops blank lines at the ends', () => {
    expect(normalizePasted('\r\none\r\ntwo\rthree\n\n')).toBe('one\ntwo\nthree')
  })

  it('finds where an insertion began from where it ended', () => {
    // "ab|cd" + "XY" → "abXY|cd"
    expect(insertionStart('XY', { p: 0, o: 4 }, () => 6)).toEqual({ p: 0, o: 2 })
    // "ab|cd" + "X\nYZ" → paragraphs "abX", "YZ|cd"
    expect(insertionStart('X\nYZ', { p: 1, o: 2 }, (p) => (p === 0 ? 3 : 4))).toEqual({ p: 0, o: 2 })
  })
})

describe('formatted clipboard HTML', () => {
  it('reads tags and inline styles, only what is stated', () => {
    const ps = parseClipboardHtml('<meta charset="utf-8"><p>Plain <b>bold</b> <span style="color: rgb(255, 0, 0); font-size: 16px">red</span></p><p><i>second</i></p>')
    expect(ps).toEqual([
      [{ text: 'Plain ', style: {} }, { text: 'bold', style: { bold: true } }, { text: ' ', style: {} }, { text: 'red', style: { color: 'FF0000', fontSize: 12 } }],
      [{ text: 'second', style: { italic: true } }],
    ])
    expect(styledText(ps)).toBe('Plain bold red\nsecond')
  })

  it('understands Google Docs (a <b> that is not bold) and Word', () => {
    const docs = parseClipboardHtml('<b style="font-weight:normal;" id="docs-internal-guid-1"><span style="font-size:11pt;font-family:Arial,sans-serif;color:#000000;font-weight:700;">Hi</span></b>')
    expect(docs).toEqual([[{ text: 'Hi', style: { bold: true, color: '000000', fontFamily: 'Arial', fontSize: 11 } }]])
    const word = parseClipboardHtml(`<p class=MsoNormal><span style='font-size:12.0pt;font-family:"Calibri",sans-serif'>One<o:p></o:p></span></p>\n<p class=MsoNormal><u>Two</u></p>`)
    expect(word).toEqual([
      [{ text: 'One', style: { fontFamily: 'Calibri', fontSize: 12 } }],
      [{ text: 'Two', style: { underline: true } }],
    ])
  })

  it('makes paragraphs of blocks and <br>, keeps blank lines inside, collapses whitespace', () => {
    const ps = parseClipboardHtml('<div>  a\n  b </div><p><br></p><div>c<br>d</div><ul><li>e</li><li>f</li></ul>')
    expect(styledText(ps)).toBe('a b\n\nc\nd\ne\nf')
  })

  it('places each styled piece', () => {
    const ps = parseClipboardHtml('<p>x<b>yz</b></p><p><i>w</i>v</p>')
    expect(styledRanges(ps, { p: 2, o: 5 })).toEqual([
      { start: { p: 2, o: 6 }, end: { p: 2, o: 8 }, style: { bold: true } },
      { start: { p: 3, o: 0 }, end: { p: 3, o: 1 }, style: { italic: true } },
    ])
  })

  it('converts CSS values', () => {
    expect(cssColorHex('#abc')).toBe('AABBCC')
    expect(cssColorHex('rgba(0, 128, 255, 0)')).toBeNull()
    expect(cssColorHex('rgb(0 128 255)')).toBe('0080FF')
    expect(cssColorHex('inherit')).toBeNull()
    expect(cssFontSizePt('24px')).toBe(18)
    expect(cssFontSizePt('1.2em')).toBeNull()
    expect(cssFontFamily('-apple-system, "Helvetica Neue", sans-serif')).toBe('Helvetica Neue')
  })
})
