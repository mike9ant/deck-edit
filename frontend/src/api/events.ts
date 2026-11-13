/** One shared EventSource for every server push (file changes, chat stream, notes…). */

import type { ServerEvent } from './types'

type Handler = (e: ServerEvent) => void
const handlers = new Set<Handler>()
let source: EventSource | null = null

function connect() {
  source = new EventSource('/api/events')
  source.onmessage = (msg) => {
    let ev: ServerEvent
    try {
      ev = JSON.parse(msg.data)
    } catch {
      return
    }
    for (const h of handlers) {
      try {
        h(ev)
      } catch (err) {
        console.error('event handler', err)
      }
    }
  }
  // EventSource reconnects by itself; a reconnect is announced by a fresh
  // `hello`, which handlers treat as "resync".
}

export function onServerEvent(h: Handler): () => void {
  if (!source) connect()
  handlers.add(h)
  return () => handlers.delete(h)
}
