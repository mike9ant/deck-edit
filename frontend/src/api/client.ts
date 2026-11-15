/** Thin typed wrappers over the backend's /api endpoints. */

import type { AgentSettings, AgentStatus, ApprovalMode, Chat, ChatSummary, ConversationDetail, ConversationHit, ModelOption, Note, Posture, Project, Stroke, TreeNode, TurnContext } from './types'

/** Identifies this browser tab, so the watcher event for our own save can be skipped. */
export const CLIENT_ID: string = (() => {
  const existing = sessionStorage.getItem('deckedit-client')
  if (existing) return existing
  const id = crypto.randomUUID()
  sessionStorage.setItem('deckedit-client', id)
  return id
})()

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

async function json<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${url}`, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!res.ok) {
    let msg = res.statusText
    try {
      msg = (await res.json()).error ?? msg
    } catch {
      /* not json */
    }
    throw new ApiError(res.status, msg)
  }
  return res.json() as Promise<T>
}

/** An image sent with a message: base64 bytes plus what the transcript shows. */
export interface OutgoingImage {
  data: string
  name?: string
  width?: number
  height?: number
}

const q = (path: string) => `path=${encodeURIComponent(path)}`

export const api = {
  projects: () => json<Project[]>('GET', '/projects'),
  createProject: (folder: string, name?: string, createFolder = false) =>
    json<Project>('POST', '/projects', { folder, name, createFolder }),
  updateProject: (id: string, body: { name?: string; touch?: boolean }) => json<Project>('PATCH', `/projects/${id}`, body),
  deleteProject: (id: string) => json('DELETE', `/projects/${id}`),
  pickFolder: () => json<{ path: string | null }>('POST', '/pick-folder'),

  tree: (pid: string) => json<TreeNode[]>('GET', `/projects/${pid}/tree`),
  fileUrl: (pid: string, path: string) => `/api/projects/${pid}/file?${q(path)}`,
  async readFile(pid: string, path: string): Promise<{ bytes: ArrayBuffer; etag: string }> {
    const res = await fetch(`/api/projects/${pid}/file?${q(path)}`, { cache: 'no-store' })
    if (!res.ok) throw new ApiError(res.status, (await res.text()) || res.statusText)
    return { bytes: await res.arrayBuffer(), etag: res.headers.get('x-etag') ?? '' }
  },
  async readText(pid: string, path: string): Promise<{ text: string; etag: string }> {
    const { bytes, etag } = await api.readFile(pid, path)
    return { text: new TextDecoder().decode(bytes), etag }
  },
  /** Save bytes. `ifEtag` makes the write fail with 409 if the file changed on disk meanwhile. */
  async writeFile(pid: string, path: string, bytes: Uint8Array, ifEtag?: string): Promise<{ etag: string }> {
    const res = await fetch(`/api/projects/${pid}/file?${q(path)}`, {
      method: 'PUT',
      headers: { 'x-client-id': CLIENT_ID, 'x-if-etag': ifEtag ?? '', 'Content-Type': 'application/octet-stream' },
      body: bytes,
    })
    if (!res.ok) {
      let msg = res.statusText
      try {
        msg = (await res.json()).error ?? msg
      } catch {
        /* */
      }
      throw new ApiError(res.status, msg)
    }
    return res.json()
  },
  /** Add a file to the project (never overwrites — a taken name gets " (2)"). Returns the path written. */
  /** New folder (a taken name gets " (2)"); returns its path. */
  mkdir: (pid: string, path: string) => json<{ path: string }>('POST', `/projects/${pid}/mkdir`, { path }),
  /** Rename or move one file/folder; never overwrites (409). Notes on moved decks follow. */
  movePath: (pid: string, from: string, to: string) => json<{ path: string }>('POST', `/projects/${pid}/rename`, { from, to }),
  /** Files to the system Trash; folders only when empty. */
  deletePaths: (pid: string, paths: string[]) => json<{ deleted: string[] }>('POST', `/projects/${pid}/delete`, { paths }),
  async upload(pid: string, path: string, data: Blob): Promise<{ path: string }> {
    const res = await fetch(`/api/projects/${pid}/upload?${q(path)}`, {
      method: 'POST',
      headers: { 'x-client-id': CLIENT_ID, 'Content-Type': 'application/octet-stream' },
      body: data,
    })
    if (!res.ok) {
      let msg = res.statusText
      try {
        msg = (await res.json()).error ?? msg
      } catch {
        /* */
      }
      throw new ApiError(res.status, msg)
    }
    return res.json()
  },
  openExternal: (pid: string, path: string) => json('POST', `/projects/${pid}/open?${q(path)}`),
  reveal: (pid: string, path: string) => json('POST', `/projects/${pid}/reveal?${q(path)}`),

  notes: (pid: string) => json<Note[]>('GET', `/projects/${pid}/notes`),
  addNote: (
    pid: string,
    n: { deck: string; slideId: string; slideIndex: number; x: number; y: number; shapeName?: string; strokes?: Stroke[]; shapes?: string[]; quote?: string; lines?: string; target?: 'speakerNotes' | 'chat'; text: string },
  ) => json<Note>('POST', `/projects/${pid}/notes`, n),
  updateNote: (pid: string, id: string, body: Partial<Pick<Note, 'text' | 'x' | 'y' | 'status' | 'slideIndex' | 'slideId'>>) =>
    json<Note>('PATCH', `/projects/${pid}/notes/${id}`, body),
  deleteNote: (pid: string, id: string) => json('DELETE', `/projects/${pid}/notes/${id}`),
  putDeckMap: (pid: string, deck: string, slides: { slideId: string; index: number; title: string }[]) =>
    json('PUT', `/projects/${pid}/deck-map`, { deck, slides }),
  putView: (pid: string, view: unknown) => json('PUT', `/projects/${pid}/view`, view),

  chats: (pid: string) => json<ChatSummary[]>('GET', `/projects/${pid}/chats`),
  createChat: (pid: string) => json<Chat>('POST', `/projects/${pid}/chats`, {}),
  chat: (cid: string) => json<Chat>('GET', `/chats/${cid}`),
  updateChat: (cid: string, body: { title?: string } & Partial<Posture>) => json<Chat>('PATCH', `/chats/${cid}`, body),
  setMode: (cid: string, mode: ApprovalMode) =>
    json<{ mode: ApprovalMode; applied: boolean; runningMode: ApprovalMode | null }>('POST', `/chats/${cid}/mode`, { mode }),
  deleteChat: (cid: string) => json('DELETE', `/chats/${cid}`),
  sendTurn: (cid: string, text: string, context: TurnContext, posture: Posture, images: OutgoingImage[] = []) =>
    json<{ turnId: string }>('POST', `/chats/${cid}/turns`, { text, context, images, ...posture }),
  chatImageUrl: (cid: string, file: string) => `/api/chats/${cid}/images/${file}`,
  stop: (cid: string) => json('POST', `/chats/${cid}/stop`),
  revert: (cid: string, tid: string) => json('POST', `/chats/${cid}/turns/${tid}/revert`),
  unrevert: (cid: string, tid: string) => json('POST', `/chats/${cid}/turns/${tid}/unrevert`),
  answerPermission: (rid: string, decision: 'allow' | 'allowAlways' | 'deny') =>
    json('POST', `/permissions/${rid}`, { decision }),
  models: () => json<ModelOption[]>('GET', '/agent/models'),
  agentStatus: () => json<AgentStatus>('GET', '/agent/status'),
  settings: () => json<AgentSettings>('GET', '/settings'),
  updateSettings: (body: Partial<Omit<AgentSettings, 'apiKeyStored' | 'apiKeyAvailable'>>) => json<AgentSettings>('PUT', '/settings', body),
  setApiKey: (key: string) => json<AgentSettings>('PUT', '/settings/api-key', { key }),
  conversations: (q: string, source?: string) =>
    json<ConversationHit[]>('GET', `/conversations?limit=200&q=${encodeURIComponent(q)}${source ? `&source=${source}` : ''}`),
  conversation: (id: string) => json<ConversationDetail>('GET', `/conversations/${encodeURIComponent(id)}`),
  importConversationOutput: (id: string, projectId: string, path: string) =>
    json<{ path: string }>('POST', `/conversations/${encodeURIComponent(id)}/import`, { projectId, path }),
  screenshotResult: (rid: string, dataUrl: string) => json('POST', `/screenshots/${rid}`, { dataUrl }),
}
