/**
 * Links in chat messages. A link to a place in the project (`Deck.pptx#slide=5`, see
 * revealStore.ts) opens that file there; web links open in the browser, never in the app's window.
 * Mentions the agent didn't link ("Q3 Plan slide 4") are linked when they name a project file
 * (autoLink.ts).
 */

import { memo, useMemo } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useApp } from '../store/appStore'
import { filePaths, locationLabel, parseLocation, useReveal } from '../store/revealStore'
import { autoLink, fileRefs } from './autoLink'

function ChatLink({ href, children }: { href?: string; children?: React.ReactNode }) {
  const folder = useApp((s) => s.projects.find((p) => p.id === s.projectId)?.folder)
  const loc = parseLocation(href, folder)
  if (!loc) {
    return <a href={href} target="_blank" rel="noreferrer">{children}</a>
  }
  return (
    <a
      href={href}
      className="font-medium text-accent underline decoration-accent/50 underline-offset-2 hover:decoration-accent"
      title={`Open ${locationLabel(loc)}`}
      data-location={href}
      onClick={(e) => {
        e.preventDefault()
        useReveal.getState().goTo(loc)
      }}
    >
      {children}
    </a>
  )
}

export const chatMarkdownComponents: Components = { a: ChatLink }

/** A chat message's Markdown, with project locations as links (memoized by its text). */
export const ChatMarkdown = memo(function ChatMarkdown({ text }: { text: string }) {
  const tree = useApp((s) => s.tree)
  const refs = useMemo(() => fileRefs([...filePaths(tree)]), [tree])
  const linked = useMemo(() => autoLink(text, refs), [text, refs])
  return <ReactMarkdown remarkPlugins={[remarkGfm]} components={chatMarkdownComponents}>{linked}</ReactMarkdown>
})
