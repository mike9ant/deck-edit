/**
 * Read-only viewers for non-deck files: Markdown (rendered), plain text,
 * images. They reload when the file changes on disk (e.g. the agent edits a
 * script or a speaker-notes .md).
 */

import { useEffect, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ExternalLink, Loader2 } from 'lucide-react'
import { api } from '../api/client'
import { useFileVersion } from '../store/fileVersions'

function useText(pid: string, path: string) {
  const version = useFileVersion(pid, path)
  const [state, setState] = useState<{ text: string | null; error: string | null }>({ text: null, error: null })
  useEffect(() => {
    let live = true
    api
      .readText(pid, path)
      .then(({ text }) => live && setState({ text, error: null }))
      .catch((e) => live && setState({ text: null, error: String(e.message) }))
    return () => {
      live = false
    }
  }, [pid, path, version])
  return state
}

export function MarkdownView({ pid, path }: { pid: string; path: string }) {
  const { text, error } = useText(pid, path)
  if (error) return <div className="p-6 text-sm text-red-700">{error}</div>
  if (text === null) return <Loading />
  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-white">
      <article className="prose prose-slate mx-auto max-w-3xl px-8 py-8 prose-headings:font-semibold prose-a:text-accent prose-table:text-sm">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
      </article>
    </div>
  )
}

export function TextView({ pid, path }: { pid: string; path: string }) {
  const { text, error } = useText(pid, path)
  if (error) return <div className="p-6 text-sm text-red-700">{error}</div>
  if (text === null) return <Loading />
  return (
    <div className="min-h-0 flex-1 overflow-auto bg-white">
      <pre className="whitespace-pre-wrap break-words p-6 font-mono text-[12.5px] leading-relaxed text-ink">{text}</pre>
    </div>
  )
}

export function ImageView({ pid, path }: { pid: string; path: string }) {
  const version = useFileVersion(pid, path)
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-[#e9e8e4] p-6">
      <img src={`${api.fileUrl(pid, path)}&v=${version}`} className="max-h-full max-w-full rounded shadow" alt={path} />
    </div>
  )
}

export function OtherView({ pid, path }: { pid: string; path: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 text-sm text-ink-3">
      No preview for this file type.
      <button className="btn-ghost border border-hair" onClick={() => void api.openExternal(pid, path)}><ExternalLink size={14} /> Open with default app</button>
    </div>
  )
}

const Loading = () => (
  <div className="flex flex-1 items-center justify-center text-ink-3"><Loader2 className="animate-spin" size={18} /></div>
)
