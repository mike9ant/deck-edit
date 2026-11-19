import { describe, expect, it } from 'vitest'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkRehype from 'remark-rehype'
import { applyRunEdits, codeBlockEdit, codeBlockSourcePos, codeBlockTextOffset, codeFence, inlineCodeSource, inlineCodeTextStart, rehypeSourceText, visibleText } from '../mdSourceEdit'
import { DocHistory } from '../docHistory'
import { history } from '@codemirror/commands'

/** The source ranges rehypeSourceText puts on code: code blocks (pre) and inline code. */
function codeRanges(src: string) {
  const processor = unified().use(remarkParse).use(remarkGfm).use(remarkRehype)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tree: any = processor.runSync(processor.parse(src))
  rehypeSourceText()(tree)
  const blocks: [number, number][] = []
  const inline: { s: number; e: number; v: string }[] = []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const walk = (n: any) => {
    if (n.tagName === 'pre') blocks.push([n.properties.dataHs, n.properties.dataHe])
    if (n.tagName === 'code' && n.properties?.dataCs != null) inline.push({ s: n.properties.dataCs, e: n.properties.dataCe, v: n.properties.dataCv })
    for (const c of n.children ?? []) walk(c)
  }
  walk(tree)
  return { blocks, inline }
}

describe('editing a fenced code block', () => {
  const src = 'Intro\n\n```js\nconst a = 1\n\nfoo()\n```\n\nAfter\n'

  it('writes the new text between the fences, nothing else', () => {
    const [[hs, he]] = codeRanges(src).blocks
    const ed = codeBlockEdit(src, hs, he, 'const a = 2\n\nfoo()\nbar()')!
    expect(applyRunEdits(src, [ed])).toBe('Intro\n\n```js\nconst a = 2\n\nfoo()\nbar()\n```\n\nAfter\n')
    expect(applyRunEdits(src, [codeBlockEdit(src, hs, he, '')!])).toBe('Intro\n\n```js\n```\n\nAfter\n')
  })

  it('keeps the indentation of a block inside a list item', () => {
    const li = '- step\n\n  ```sh\n  make\n  ```\n'
    const [[hs, he]] = codeRanges(li).blocks
    expect(applyRunEdits(li, [codeBlockEdit(li, hs, he, 'make\nmake test')!])).toBe('- step\n\n  ```sh\n  make\n  make test\n  ```\n')
  })

  it('refuses text that would close the block, and blocks it can’t map', () => {
    const [[hs, he]] = codeRanges(src).blocks
    expect(codeBlockEdit(src, hs, he, 'a\n```\nb')).toBeNull()
    expect(codeBlockEdit(src, hs, he, 'a\n````js\nb')).not.toBeNull() // an opening fence inside is just text
    const indented = 'Text\n\n    indented code\n'
    const [[ihs, ihe]] = codeRanges(indented).blocks
    expect(codeFence(indented, ihs, ihe)).toBeNull()
    const quoted = '> ```\n> x\n> ```\n'
    const [[qhs, qhe]] = codeRanges(quoted).blocks
    expect(codeFence(quoted, qhs, qhe)).toBeNull()
  })

  it('maps text offsets to source offsets and back', () => {
    const li = '- step\n\n  ```sh\n  make\n  go\n  ```\n'
    const [[hs, he]] = codeRanges(li).blocks
    // Text "make\ngo": offset 6 is the "o" of "go".
    const pos = codeBlockSourcePos(li, hs, he, 6)!
    expect(li[pos]).toBe('o')
    expect(codeBlockTextOffset(li, hs, he, pos)).toBe(6)
  })
})

describe('editing inline code', () => {
  it('picks backticks and padding that keep the text exactly', () => {
    expect(inlineCodeSource('npm i', 'text')).toBe('`npm i`')
    expect(inlineCodeSource('a`b', 'text')).toBe('``a`b``')
    expect(inlineCodeSource('`x', 'text')).toBe('`` `x ``')
    expect(inlineCodeSource(' padded ', 'text')).toBe('`  padded  `')
    expect(inlineCodeSource('a|b', 'cell')).toBe('`a\\|b`')
    expect(inlineCodeSource('', 'text')).toBe('')
    for (const t of ['npm i', 'a`b', '`x', 'x`', ' padded ']) expect(visibleText(`p ${inlineCodeSource(t, 'text')} q`)).toBe(`p ${t} q\n`)
  })

  it('is found with its source range, and rewritten in place', () => {
    const src = 'Run `npm install` then ``a`b``.\n'
    const { inline } = codeRanges(src)
    expect(inline.map((c) => c.v)).toEqual(['npm install', 'a`b'])
    const [c] = inline
    expect(src.slice(c.s, c.e)).toBe('`npm install`')
    expect(inlineCodeTextStart(src, c.s, c.e)).toBe(c.s + 1)
    expect(applyRunEdits(src, [{ s: c.s, e: c.e, text: inlineCodeSource('npm ci', 'text'), ctx: 'raw' }])).toBe('Run `npm ci` then ``a`b``.\n')
  })
})

describe('the shared undo history', () => {
  it('undoes and redoes edits from either view, keeping changes from disk', () => {
    const h = new DocHistory('one\n')
    h.edit('one two\n')
    h.edit('one two three\n')
    h.external('agent\none two three\n')
    expect(h.undo()).toBe('agent\none two\n')
    expect(h.cursor().head).toBe('agent\none two'.length) // where the undone edit was
    expect(h.undo()).toBe('agent\none\n')
    expect(h.undo()).toBeNull()
    expect(h.redo()).toBe('agent\none two\n')
  })

  it('carries the history into a source editor state and back', () => {
    const h = new DocHistory('a\n')
    h.edit('ab\n')
    h.sync(h.stateFor(history())) // as the Markdown tab does on opening
    expect(h.text()).toBe('ab\n')
    expect(h.undo()).toBe('a\n')
  })
})
