import { describe, expect, it } from 'vitest'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkRehype from 'remark-rehype'
import { applyRunEdits, rehypeSourceText, runSourceMap, sameVisibleText, toggleMarkRange, unwrapMark, wrapMark, type Mark, type RunContext } from '../mdSourceEdit'

type Run = { s: number; e: number; v: string; ctx: RunContext }

/** The editable runs of a document, as the formatted view sees them. */
function runs(src: string): Run[] {
  const processor = unified().use(remarkParse).use(remarkGfm).use(remarkRehype)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tree: any = processor.runSync(processor.parse(src))
  rehypeSourceText()(tree)
  const out: Run[] = []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const walk = (n: any, ctx: RunContext) => {
    const c: RunContext = /^h\d$/.test(n.tagName ?? '') ? 'heading' : n.tagName === 'td' || n.tagName === 'th' ? 'cell' : ctx
    if (n.properties?.dataS != null) out.push({ s: n.properties.dataS, e: n.properties.dataE, v: n.properties.dataV, ctx: c })
    for (const ch of n.children ?? []) walk(ch, c)
  }
  walk(tree, 'text')
  return out
}

/** Edit the run whose value is `from` to read `to`. */
function edit(src: string, from: string, to: string): string {
  const r = runs(src).find((x) => x.v === from)
  if (!r) throw new Error(`no run "${from}" in ${JSON.stringify(runs(src).map((x) => x.v))}`)
  return applyRunEdits(src, [{ s: r.s, e: r.e, text: to, ctx: r.ctx }])
}

describe('editing Markdown text in place', () => {
  it('changes only the edited words, keeping formatting around them', () => {
    const src = '# Title *x*\n\nSome **bold** and [a link](http://x.y) here.\n'
    expect(edit(src, 'bold', 'strong')).toBe('# Title *x*\n\nSome **strong** and [a link](http://x.y) here.\n')
    expect(edit(src, 'a link', 'the site')).toBe('# Title *x*\n\nSome **bold** and [the site](http://x.y) here.\n')
    expect(edit(src, 'Title ', 'Heading ')).toBe('# Heading *x*\n\nSome **bold** and [a link](http://x.y) here.\n')
  })

  it('keeps quote markers on continuation lines', () => {
    const src = '> quoted line\n> second **bold** line\n'
    expect(edit(src, 'quoted line\nsecond ', 'QUOTED line\nsecond ')).toBe('> QUOTED line\n> second **bold** line\n')
    expect(edit(src, 'quoted line\nsecond ', 'one\ntwo\nthree ')).toBe('> one\n> two\n> three **bold** line\n')
  })

  it('edits list items and table cells without breaking structure', () => {
    const src = '- item one\n  - nested\n\n| A | B |\n|---|---|\n| c1 | `code` |\n'
    expect(edit(src, 'nested', 'nested item')).toBe('- item one\n  - nested item\n\n| A | B |\n|---|---|\n| c1 | `code` |\n')
    expect(edit(src, 'c1', 'x | y')).toBe('- item one\n  - nested\n\n| A | B |\n|---|---|\n| x \\| y | `code` |\n')
    expect(runs(src).some((r) => r.v === 'code')).toBe(false) // inline code stays read-only
  })

  it('escapes typed text so it stays plain text', () => {
    const src = 'Plain text.\n\nNext.\n'
    expect(edit(src, 'Plain text.', 'a *star* and snake_case')).toBe('a \\*star\\* and snake_case\n\nNext.\n')
    expect(edit(src, 'Plain text.', '# not a heading')).toBe('\\# not a heading\n\nNext.\n')
    expect(edit(src, 'Next.', '1. not a list')).toBe('Plain text.\n\n1\\. not a list\n')
  })

  it('drops layout newlines in lists but keeps spaces between formatted words', () => {
    const processor = unified().use(remarkParse).use(remarkGfm).use(remarkRehype)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tree: any = processor.runSync(processor.parse('- **a** *b*\n  - sub\n'))
    rehypeSourceText()(tree)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const li = tree.children.find((n: any) => n.tagName === 'ul').children[0]
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(li.children.map((c: any) => c.tagName ?? JSON.stringify(c.value))).toEqual(['strong', '" "', 'em', 'ul'])
  })

  it('round-trips: an edited document renders the typed text', () => {
    const src = 'Some **bold** text.\n'
    const out = edit(src, 'Some ', 'Price: 5 * 3 = [15] ')
    expect(runs(out).map((r) => r.v)).toEqual(['Price: 5 * 3 = [15] ', 'bold', ' text.'])
  })
})

describe('bold and italic toggles', () => {
  it('maps run characters to source, skipping escapes and quote prefixes', () => {
    const src = '> a \\* b\n> next'
    const r = runs(src)[0]
    const map = runSourceMap(src, r.s, r.e, r.v)!
    expect(r.v).toBe('a * b\nnext')
    expect(src.slice(map[2], map[3])).toBe('\\*')
    expect(src.slice(map[6], map[10])).toBe('next')
    expect(map[r.v.length]).toBe(r.e)
  })

  it('wraps a selection and unwraps an element, keeping the visible text', () => {
    const src = 'Make this word bold.\n'
    const r = runs(src)[0]
    const map = runSourceMap(src, r.s, r.e, r.v)!
    const bold = wrapMark(src, map[10], map[14], 'strong')
    expect(bold).toBe('Make this **word** bold.\n')
    expect(sameVisibleText(src, bold)).toBe(true)
    const s = bold.indexOf('**'), e = bold.lastIndexOf('**') + 2
    expect(unwrapMark(bold, s, e, 'strong')).toBe(src)
    expect(unwrapMark('a _b_ c', 2, 5, 'em')).toBe('a b c')
    expect(unwrapMark('a `b` c', 2, 5, 'em')).toBeNull()
  })

  it('notices delimiters that would not parse as formatting', () => {
    const src = 'end.Next'
    expect(sameVisibleText(src, wrapMark(src, 0, 4, 'strong'))).toBe(false) // "**end.**Next" stays literal
    expect(sameVisibleText(src, wrapMark(src, 4, 8, 'em'))).toBe(true)
  })
})

describe('toggling part of (or across the edge of) a bold/italic section', () => {
  /** Toggle over the text `sel` (first occurrence of the plain text, located in the source by `at`). */
  const toggle = (src: string, at: string, mark: Mark, allMarked: boolean) => {
    const a = src.indexOf(at)
    const b = a + at.length
    const re = mark === 'strong' ? /(\*\*|__)(?:(?!\1).)+\1/g : /(?<![*_])([*_])(?![*_])(?:(?!\1).)+\1/g
    const marks = [...src.matchAll(re)].map((m) => ({ s: m.index!, e: m.index! + m[0].length }))
    const out = toggleMarkRange(src, a, b, marks, mark, allMarked)!
    expect(sameVisibleText(src, out)).toBe(true)
    return out
  }
  const src = 'Some **old bold** text.'
  it('removes it from just the selected part', () => {
    expect(toggle(src, 'bold', 'strong', true)).toBe('Some **old** bold text.')
    expect(toggle(src, 'old ', 'strong', true).replace('  ', ' ')).toBe('Some old **bold** text.')
    expect(toggle(src, 'ld bo', 'strong', true)).toBe('Some **o**ld bo**ld** text.')
    expect(toggle(src, 'old bold', 'strong', true)).toBe('Some old bold text.')
    expect(toggle('a *b c* d', 'c', 'em', true)).toBe('a *b* c d')
  })
  it('extends it across the edge, merging with the section', () => {
    expect(toggle(src, 'bold** text', 'strong', false)).toBe('Some **old bold text**.')
    expect(toggle(src, 'Some **old', 'strong', false)).toBe('**Some old bold** text.')
    expect(toggle('**bold**er', 'er', 'strong', false)).toBe('**bolder**')
    expect(toggle('x **a** y **b** z', 'a** y **b', 'strong', false)).toBe('x **a y b** z')
    expect(toggle('a *b* c', '*b* c', 'em', false)).toBe('a *b c*')
    expect(toggle('Some **old** bold text.', 'bold', 'strong', false)).toBe('Some **old bold** text.')
    expect(toggle('x **a** y', 'x', 'strong', false)).toBe('**x a** y')
    expect(toggle('**a**, b', 'b', 'strong', false)).toBe('**a**, **b**')
  })
})
