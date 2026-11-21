/**
 * When the agent can't run, the chat says why and how to fix it — in place of the message box —
 * instead of letting a message fail:
 * - Claude Code isn't installed: how to install it (and, for an unusual install, its path in Settings);
 * - it's installed but not signed in (and the chat isn't using an API key): how to sign in, or
 *   switch this chat to the API key when one is set.
 * Only when the status is certain: an unknown status (still checking, or a CLI too old to report
 * its sign-in) never blocks. It checks again when the app window comes back to the front (after
 * installing or signing in in Terminal) and on "Check again"; the backend then also re-reads the
 * login shell's PATH (see backend login_path.rs), so a new install is found without a restart.
 */

import { useEffect, useState } from 'react'
import { Check, Copy, ExternalLink, KeyRound, Loader2, RefreshCw, Settings, TerminalSquare } from 'lucide-react'
import type { AgentStatus, Chat } from '../api/types'
import { useAgent } from '../store/agentStore'
import { useChat } from '../store/chatStore'
import { chatPosture } from './posture'

export type AgentBlock = { kind: 'missing'; command: string } | { kind: 'signedOut'; keyAvailable: boolean }

const INSTALL_COMMAND = 'curl -fsSL https://claude.ai/install.sh | bash'
const INSTALL_PAGE = 'https://claude.com/claude-code'

/** Why the agent can't run with this auth (null: it can, or the status isn't known). */
export function agentBlock(status: AgentStatus | null, auth: 'subscription' | 'key', apiKeyAvailable: boolean): AgentBlock | null {
  if (!status) return null
  if (!status.cli.found) return { kind: 'missing', command: status.cli.command }
  if (auth === 'key' && apiKeyAvailable) return null
  if (status.auth?.loggedIn === false) return { kind: 'signedOut', keyAvailable: apiKeyAvailable }
  return null
}

/** The block for a chat (null for none, or no chat): with its own auth choice. */
export function useAgentBlock(chat: Chat | null | undefined): AgentBlock | null {
  const status = useAgent((s) => s.status)
  const settings = useAgent((s) => s.settings)
  if (!chat || !settings) return null
  const keyAvailable = !!settings.apiKeyAvailable
  const auth = keyAvailable ? chatPosture(chat, { auth: settings.auth ?? 'subscription' }).auth ?? 'subscription' : 'subscription'
  return agentBlock(status, auth, keyAvailable)
}

/** The same check outside React (sending from a note's "Act now"). */
export function agentBlockFor(chat: Chat | null | undefined): AgentBlock | null {
  const { status, settings } = useAgent.getState()
  if (!settings) return null
  const keyAvailable = !!settings.apiKeyAvailable
  const auth = keyAvailable && chat ? chatPosture(chat, { auth: settings.auth ?? 'subscription' }).auth ?? 'subscription' : keyAvailable ? settings.auth ?? 'subscription' : 'subscription'
  return agentBlock(status, auth, keyAvailable)
}

export const BLOCK_TOAST: Record<AgentBlock['kind'], string> = {
  missing: 'Claude Code isn’t installed yet — the chat panel shows how to set it up.',
  signedOut: 'Claude Code isn’t signed in — the chat panel shows how.',
}

function CopyLine({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="flex items-center gap-1 rounded-md border border-hair bg-paper py-1 pl-2 pr-1 font-mono text-[11.5px] text-ink">
      <span className="min-w-0 flex-1 select-all truncate" title={text}>{text}</span>
      <button
        className="icon-btn shrink-0"
        title="Copy"
        onClick={() => void navigator.clipboard.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) })}
      >
        {copied ? <Check size={13} className="text-emerald-600" /> : <Copy size={13} />}
      </button>
    </div>
  )
}

export function AgentSetupCard({ chat, block }: { chat: Chat; block: AgentBlock }) {
  const refreshStatus = useAgent((s) => s.refreshStatus)
  const checking = useAgent((s) => s.statusLoading)
  const openSettings = useAgent((s) => s.openSettings)
  // Back from Terminal (installed / signed in): check again.
  useEffect(() => {
    const again = () => { if (document.visibilityState === 'visible') void useAgent.getState().refreshStatus() }
    window.addEventListener('focus', again)
    document.addEventListener('visibilitychange', again)
    return () => {
      window.removeEventListener('focus', again)
      document.removeEventListener('visibilitychange', again)
    }
  }, [])
  const checkAgain = (
    <button className="btn-primary h-7 gap-1.5 px-3 text-xs" disabled={checking} onClick={() => void refreshStatus()}>
      {checking ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />} Check again
    </button>
  )
  return (
    <div className="shrink-0 border-t border-hair bg-white p-3" data-agent-setup={block.kind}>
      <div className="rounded-lg border border-amber-200 bg-amber-50/60 p-3 text-xs text-ink-2">
        {block.kind === 'missing' ? (
          <>
            <div className="mb-1 flex items-center gap-1.5 text-sm font-semibold text-ink"><TerminalSquare size={15} /> Install Claude Code to use the agent</div>
            <p className="mb-2">The agent runs on Claude Code. Install it in Terminal — this checks again by itself when you come back:</p>
            <CopyLine text={INSTALL_COMMAND} />
            <p className="mb-2.5 mt-2">Then run <code className="rounded bg-black/5 px-1">claude</code> once in Terminal and sign in (a Claude subscription, or an Anthropic API key).</p>
            <div className="flex flex-wrap items-center gap-2">
              {checkAgain}
              <a className="btn-ghost h-7 gap-1 border border-hair px-2.5 text-xs" href={INSTALL_PAGE} target="_blank" rel="noreferrer"><ExternalLink size={12} /> Other ways to install</a>
              <button className="ml-auto text-[11px] text-ink-3 underline-offset-2 hover:text-ink hover:underline" onClick={() => openSettings()} title={`Looked for \`${block.command}\``}>
                Installed somewhere else? Set its path…
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="mb-1 flex items-center gap-1.5 text-sm font-semibold text-ink"><TerminalSquare size={15} /> Sign in to Claude Code</div>
            <p className="mb-2">Claude Code is installed but not signed in. In Terminal, run this and sign in when it asks (or type <code className="rounded bg-black/5 px-1">/login</code>):</p>
            <CopyLine text="claude" />
            <div className="mt-2.5 flex flex-wrap items-center gap-2">
              {checkAgain}
              {block.keyAvailable ? (
                <button className="btn-ghost h-7 gap-1 border border-hair px-2.5 text-xs" onClick={() => void useChat.getState().update(chat.id, { auth: 'key' })}>
                  <KeyRound size={12} /> Use your API key for this chat
                </button>
              ) : (
                <button className="btn-ghost h-7 gap-1 border border-hair px-2.5 text-xs" onClick={() => openSettings()}>
                  <Settings size={12} /> Use an API key instead…
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
