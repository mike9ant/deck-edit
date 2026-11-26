/**
 * Review comments on the slide (toggled from the deck toolbar): a marker with the author's
 * initials where each comment sits — at the shape it's about, else at its spot — and its thread
 * (text, replies, who and when) on click. Read-only.
 */

import { useEffect, useState } from 'react'
import { MessageSquareText, X } from 'lucide-react'
import clsx from 'clsx'
import type { PresentationData, SlideData } from '@diceui/pptx-core'
import { commentTime, readDeckComments, type DeckComment } from './comments'

/** A deck's comments by slide part — loaded once per (re)load of the deck. */
export function useDeckComments(pres: PresentationData | null | undefined): Map<string, DeckComment[]> {
  const [comments, setComments] = useState<Map<string, DeckComment[]>>(new Map())
  useEffect(() => {
    if (!pres) return
    let live = true
    void readDeckComments(pres).then((c) => live && setComments(c))
    return () => { live = false }
  }, [pres])
  return comments
}

/** Where a comment's marker goes (slide px): the top-right of its shape, else its spot, else the slide's top-right corner. */
function anchorOf(c: DeckComment, slide: SlideData, slideW: number, i: number) {
  const node = c.shapeId ? slide.nodes.find((n) => n.id === c.shapeId) : undefined
  if (node) return { x: node.position.x + node.size.w, y: node.position.y }
  if (c.pos) return c.pos
  return { x: slideW - 12, y: 12 + i * 26 }
}

export function CommentMarkers({ comments, slide, scale, slideW }: { comments: DeckComment[]; slide: SlideData; scale: number; slideW: number }) {
  const [open, setOpen] = useState<string | null>(null)
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(null)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])
  // Markers at the same spot fan out sideways.
  const placed: { x: number; y: number }[] = []
  const at = comments.map((c, i) => {
    const a = anchorOf(c, slide, slideW, i)
    let x = a.x * scale - 10, y = a.y * scale - 10
    while (placed.some((p) => Math.abs(p.x - x) < 18 && Math.abs(p.y - y) < 18)) x -= 22
    placed.push({ x, y })
    return { x, y }
  })
  return (
    <div className="pointer-events-none absolute inset-0 z-[7]" data-comment-markers>
      {comments.map((c, i) => (
        <button
          key={c.id}
          className={clsx(
            'pointer-events-auto absolute flex h-5 min-w-5 items-center justify-center rounded-full rounded-bl-none border-2 border-white px-1 text-[9px] font-bold text-white shadow',
            c.resolved ? 'bg-ink-3' : 'bg-sky-600',
            open === c.id && 'ring-2 ring-sky-300',
          )}
          style={{ left: at[i].x, top: at[i].y }}
          title={`${c.author}${c.created ? ` · ${commentTime(c.created)}` : ''}: ${c.text}`}
          onPointerDown={(e) => e.stopPropagation() /* not a click on the slide */}
          onClick={() => setOpen(open === c.id ? null : c.id)}
        >
          {c.initials}
        </button>
      ))}
      {comments.map((c, i) => open === c.id && (
        <div
          key={`card${c.id}`}
          className="pointer-events-auto absolute z-[8] w-64 rounded-lg border border-hair bg-white p-2 text-xs shadow-xl"
          style={{ left: Math.max(4, at[i].x - 230), top: at[i].y + 24 }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <div className="mb-1 flex items-center gap-1.5 text-[11px] text-ink-3">
            <MessageSquareText size={12} className="text-sky-600" />
            Comment{c.resolved ? ' · resolved' : ''}
            <button className="icon-btn ml-auto h-5 w-5" title="Close (Esc)" onClick={() => setOpen(null)}><X size={12} /></button>
          </div>
          <div className="max-h-72 space-y-2 overflow-y-auto">
            {[{ author: c.author, created: c.created, text: c.text }, ...c.replies].map((m, k) => (
              <div key={k} className={clsx(k > 0 && 'border-t border-hair pt-1.5')}>
                <div className="flex items-baseline gap-1.5">
                  <span className="font-semibold text-ink">{m.author}</span>
                  <span className="text-[10px] text-ink-3">{commentTime(m.created)}</span>
                </div>
                <div className="whitespace-pre-wrap break-words text-ink-2">{m.text}</div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
