export interface Project {
  id: string
  name: string
  folder: string
  createdAt: string
  lastOpenedAt?: string | null
  /** Editing files in the app: 'on', 'off' (read-only), or not asked yet. */
  editing?: 'on' | 'off'
}

export interface TreeNode {
  name: string
  path: string
  kind: 'dir' | 'file'
  size?: number
  children?: TreeNode[]
}

export interface Note {
  id: string
  deck: string
  slideId: string
  slideIndex: number
  x: number
  y: number
  shapeName?: string
  /** A freehand mark instead of a point: polylines of [x, y] slide fractions; x/y is then the pin's spot. */
  strokes?: Stroke[]
  /** Shapes the drawn mark covers (slides), or the contents of the cells it covers (spreadsheets). */
  shapes?: string[]
  /** A note on selected text in a text/code/Markdown file: the text, and its lines ("12" / "12–14"). */
  quote?: string
  lines?: string
  /** A quote note in the speaker notes of slide `slideId`, or in a message of the chat `slideId` (that chat's agent only). */
  target?: 'speakerNotes' | 'chat'
  text: string
  author: 'user' | 'agent'
  createdAt: string
  status: 'open' | 'resolved'
  resolution?: string
  resolvedAt?: string
  resolvedBy?: string
  /** The chats whose agent the note is for: the chat open when it was taken, then any it was brought to. None = every chat. */
  chats?: string[]
}

export type Stroke = [number, number][]

export interface FileChange {
  path: string
  kind: 'modified' | 'created' | 'deleted' | 'moved'
  /** For 'moved': the path before the turn. */
  from?: string
  restorable: boolean
}

/** One event in a turn's transcript (see backend claude_cli.rs / chat.rs). */
export type TurnEvent =
  | { kind: 'message'; text: string }
  | { kind: 'activity'; tool: string; detail: string; /** A finished step (replaces the earlier event for the same tool). */ done?: boolean }
  | { kind: 'command'; command: string; exitCode: number; output: string }
  | { kind: 'fileEdited'; path: string }
  /** Live only (never stored): what the turn is doing now, e.g. waiting for another agent; null clears it. */
  | { kind: 'status'; text: string | null; /** Offer Kill: a stopped turn waits for a command it started to finish. */ kill?: boolean }
  | { kind: 'todos'; items: { text: string; status: string }[] }
  | { kind: 'permission'; requestId: string; tool: 'Bash' | 'Edit' | 'Connector' | 'Web'; detail: string; description?: string; preview?: { old?: string; new?: string } | null }
  | { kind: 'permissionResolved'; requestId: string; decision: 'allow' | 'deny' }
  | { kind: 'notice'; text: string }
  | { kind: 'error'; text: string }
  | { kind: 'delta'; text: string }
  | { kind: 'thinking' }

export interface TurnContext {
  deck?: string
  slideIndex?: number
  slideCount?: number
  slideId?: string
  selection?: { name: string; text?: string }[]
  userChanges?: string[]
  openFile?: string
  /** Other open tabs, besides the one in view. */
  openTabs?: string[]
}

export interface Turn {
  id: string
  prompt: string
  context?: TurnContext
  startedAt: string
  endedAt?: string
  status: 'running' | 'done' | 'error' | 'stopped'
  events: TurnEvent[]
  snapshotId?: string
  changes: FileChange[]
  reverted?: string
  /** Only present when the turn was billed to an API key (a subscription turn costs nothing extra). */
  costUsd?: number
  usage?: TokenUsage
  /** Whether the prompt cache was predicted warm when the turn started. */
  cache?: CacheCheck
  /** This turn continued in a fresh conversation that starts from a summary of the earlier one. */
  split?: SplitInfo
  error?: string
  mode?: ApprovalMode
  model?: string
  effort?: Effort
  fast?: boolean
  auth?: 'subscription' | 'key'
  images?: ChatImage[]
  /** The notes this turn works on: the chat's open notes when it started (notes pinned while it runs are for the next message). */
  notes?: string[]
}

export interface ChatImage {
  file: string
  mediaType: string
  width?: number
  height?: number
  bytes: number
  name?: string
}

export interface Chat {
  id: string
  projectId: string
  title: string
  createdAt: string
  updatedAt: string
  cliSessionId?: string
  mode: ApprovalMode
  model?: string
  effort?: Effort
  fast?: boolean
  auth?: 'subscription' | 'key'
  turns: Turn[]
  runningTurnId?: string | null
}

export interface ChatSummary {
  id: string
  title: string
  updatedAt: string
  turnCount: number
  running: boolean
}

/** Events pushed over /api/events. */
export type ServerEvent =
  | { type: 'hello' }
  | { type: 'resync' }
  | { type: 'file'; projectId: string; path: string; etag: string | null; deleted: boolean; writer: string }
  | { type: 'tree'; projectId: string }
  | { type: 'notes'; projectId: string }
  | { type: 'chat'; chatId: string; turnId: string; event: TurnEvent }
  | { type: 'turn'; chatId: string; turnId: string; projectId: string; status: Turn['status']; changes?: FileChange[] }
  | { type: 'chatUpdated'; chatId: string }
  | { type: 'screenshot'; requestId: string; projectId: string; deck: string; slideIndex: number; showNotes?: boolean }

export type ApprovalMode = 'manual' | 'acceptEdits' | 'plan' | 'auto'
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** The composer's choices for the next turn. Empty model/effort = the CLI's/model's own. */
export interface Posture {
  mode: ApprovalMode
  model: string
  effort: Effort | ''
  fast: boolean
  auth: 'subscription' | 'key'
}

export interface ModelOption {
  id: string
  label: string
  default?: boolean
}

export interface AgentSettings {
  claudePath: string
  auth: 'subscription' | 'key'
  defaultMode: ApprovalMode
  defaultModel: string
  defaultEffort: Effort | ''
  fast: boolean
  maxBudgetUsd: number | null
  /** The agent may also use the user's own MCP servers / claude.ai connectors (Slack, …). */
  userMcp: boolean
  /** Web search / page fetch: allowed, asked each time, or off. */
  webAccess: 'allow' | 'ask' | 'off'
  apiKeyStored: boolean
  apiKeyAvailable: boolean
}

export interface AgentStatus {
  cli: { found: boolean; path: string | null; version: string | null; command: string }
  auth: {
    loggedIn?: boolean
    authMethod?: string
    subscriptionType?: string
    email?: string
    orgName?: string
    loginExpiresAt?: string
  } | null
  apiKeyAvailable: boolean
  /** `setup`: the desktop app is setting up its own env (or couldn't) — what to show instead. */
  python: { path: string | null; pythonPptx: string | null; setup?: string | null }
  conversations?: {
    claudeCode: { path: string; found: boolean; sessions: number }
    desktopApp: { paths: string[]; found: boolean; codeSessions: number; coworkSessions: number }
  } | null
}

/** A past Claude conversation on this machine (CLI, desktop Code, or Cowork). */
export interface ConversationInfo {
  id: string
  source: 'cowork' | 'desktop' | 'cli'
  title: string
  folders: string[]
  createdAt: number
  lastActivityAt: number
  firstMessage?: string
  model?: string
  appChat?: string
  hasTranscript: boolean
  outputCount: number
}

export interface ConversationHit extends ConversationInfo {
  snippets: { role: string; text: string; message: number }[]
}

export interface ConversationDetail {
  info: ConversationInfo
  messages: { role: 'user' | 'assistant'; text: string; tools?: string[]; timestamp?: string }[]
  outputs: { path: string; size: number }[]
  transcriptPath?: string
}

/** Tokens a turn used. `cacheRead`…`context` are only on turns since they were recorded. */
export interface TokenUsage {
  /** All input tokens, including the cached part. */
  input: number
  /** The part of `input` read from or written to the prompt cache. */
  cached: number
  output: number
  /** Of `cached`: read (cheap) / written (the costly part of a cold start). */
  cacheRead?: number
  cacheWrite?: number
  /** The turn's first API call: mostly written means it started on a cold cache. */
  firstRead?: number
  firstWrite?: number
  /** The conversation's size after the turn (what the next turn re-sends). */
  context?: number
  /** Model calls in the turn; each re-sends the conversation, so `input` is the sum over them. */
  calls?: number
}

/** Would a chat's next turn start on a cold prompt cache (backend cache_check.rs)? */
export interface CacheCheck {
  contextTokens: number
  idleSecs?: number
  ttlSecs: number
  ttlLearned: boolean
  cold: boolean
  reason?: string
  /** Cold and at least `threshold` tokens. */
  offerSplit: boolean
  /** The previous turn's settings still have a warm cache (cold only because e.g. fast mode was switched on). */
  previousWarm?: boolean
  threshold: number
}

/** A conversation split (backend conversation_split.rs). */
export interface SplitInfo {
  previousSession?: string
  /** The earlier conversation's size in tokens (0: unknown). */
  previousTokens: number
  /** 'warm': summarized by the same model from its cache · 'sonnet': from a condensed transcript. */
  method: 'warm' | 'sonnet'
  summary: string
  recentTurns: number
}
