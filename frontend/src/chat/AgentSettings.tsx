/**
 * Settings (the gear, top right). "Agent settings": which Claude Code CLI runs
 * the agent and how it's signed in, which billing source a turn uses, the
 * defaults new chats start with (approval mode, model, effort, fast mode),
 * connectors, web access and a per-turn spend cap. "About": who made the app,
 * its version and purpose.
 */

import { useEffect, useState } from 'react'
import { CheckCircle2, Loader2, Presentation, RefreshCw, X, XCircle } from 'lucide-react'
import clsx from 'clsx'
import { useAgent } from '../store/agentStore'
import { APPROVAL_MODES, EFFORT_OPTIONS, FALLBACK_MODELS, fastSupported, modelLabel } from './posture'
import type { ApprovalMode, Effort } from '../api/types'
import { APP_VERSION } from '../version'

export function SettingsDialog({ onClose }: { onClose(): void }) {
  const [tab, setTab] = useState<'agent' | 'about'>('agent')
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onMouseDown={onClose}>
      <div className="max-h-[90vh] w-[560px] overflow-y-auto rounded-xl bg-white p-5 shadow-2xl" onMouseDown={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center gap-3">
          <h2 className="text-base font-semibold">Settings</h2>
          <div className="flex gap-1">
            {(['agent', 'about'] as const).map((t) => (
              <button
                key={t}
                className={clsx('rounded-md px-2.5 py-1 text-xs font-medium', tab === t ? 'bg-accent-soft text-accent' : 'text-ink-3 hover:bg-paper hover:text-ink')}
                onClick={() => setTab(t)}
              >
                {t === 'agent' ? 'Agent settings' : 'About'}
              </button>
            ))}
          </div>
          <button className="ml-auto text-ink-3 hover:text-ink" onClick={onClose}><X size={16} /></button>
        </div>
        {tab === 'agent' ? <AgentSettings /> : <About />}
      </div>
    </div>
  )
}

function About() {
  return (
    <div className="space-y-3 text-sm text-ink-2">
      <div className="flex items-center gap-2 text-base font-semibold text-ink">
        <Presentation size={20} className="text-accent" /> PPTX Edit <span className="text-sm font-normal text-ink-3">Version {APP_VERSION}</span>
      </div>
      <p>To enable efficient editing of PowerPoint / PPTX files, and related supporting content folders, with help of Claude Code.</p>
      <p>Developed by Michael Antonov.</p>
      <p className="text-xs text-ink-3">Provided as-is, with no warranty of any kind.</p>
    </div>
  )
}

function AgentSettings() {
  const { settings, status, statusLoading, models, refreshStatus, update, setApiKey } = useAgent()
  const [path, setPath] = useState(settings?.claudePath ?? '')
  const [key, setKey] = useState('')
  const [budget, setBudget] = useState(settings?.maxBudgetUsd?.toString() ?? '')
  useEffect(() => {
    void refreshStatus()
  }, [refreshStatus])
  if (!settings) return null
  const options = models.length ? models : FALLBACK_MODELS
  const cliOk = !!status?.cli.found
  const loggedIn = !!status?.auth?.loggedIn

  return (
    <>
        <Section title="Claude Code CLI" action={<button className="icon-btn" title="Re-check" onClick={() => void refreshStatus()}>{statusLoading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}</button>}>
          <Row ok={cliOk} label={cliOk ? `Found ${status?.cli.version ?? ''}` : status ? `Not found (\`${status.cli.command}\`)` : 'Checking…'} detail={status?.cli.path ?? undefined} />
          <Row
            ok={loggedIn}
            label={
              !status ? 'Checking login…'
                : loggedIn ? `Signed in${status.auth?.email ? ` as ${status.auth.email}` : ''}${status.auth?.subscriptionType ? ` · ${status.auth.subscriptionType} plan` : ''}`
                  : 'Not signed in — run `claude login` in a terminal, then re-check'
            }
            detail={loggedIn && status?.auth?.authMethod ? `via ${status.auth.authMethod}${status.auth.orgName ? ` · ${status.auth.orgName}` : ''}` : undefined}
          />
          {status?.conversations && (
            <Row
              ok={status.conversations.claudeCode.found || status.conversations.desktopApp.found}
              label={`Past conversations: ${status.conversations.claudeCode.sessions} Claude Code` +
                (status.conversations.desktopApp.found
                  ? `, ${status.conversations.desktopApp.coworkSessions} Cowork, ${status.conversations.desktopApp.codeSessions} desktop Code`
                  : ' · Claude desktop app data not found')}
              detail={[status.conversations.claudeCode.path, ...status.conversations.desktopApp.paths].join('  ·  ')}
            />
          )}
          <Row ok={!!status?.python.pythonPptx} label={status?.python.pythonPptx ? `Python env ready (python-pptx ${status.python.pythonPptx})` : 'Python env missing — run ./run.sh setup'} detail={status?.python.path ?? undefined} />
          <label className="mt-2 block text-xs font-medium text-ink-2">CLI path <span className="font-normal text-ink-3">(empty = `claude` on PATH)</span></label>
          <div className="mt-1 flex gap-2">
            <input className="input flex-1 font-mono text-xs" value={path} onChange={(e) => setPath(e.target.value)} placeholder="/Users/you/.local/bin/claude" />
            <button className="btn-ghost border border-hair" disabled={path === settings.claudePath} onClick={() => void update({ claudePath: path })}>Save</button>
          </div>
        </Section>

        <Section title="Billing">
          <div className="flex gap-2">
            <Choice active={settings.auth === 'subscription'} onClick={() => void update({ auth: 'subscription' })} title="Claude subscription" sub="your `claude login` (no API billing)" />
            <Choice active={settings.auth === 'key'} disabled={!settings.apiKeyAvailable} onClick={() => void update({ auth: 'key' })} title="Anthropic API key" sub={settings.apiKeyAvailable ? 'billed to the API key' : 'add a key below first'} />
          </div>
          <label className="mt-3 block text-xs font-medium text-ink-2">
            Anthropic API key <span className="font-normal text-ink-3">{settings.apiKeyStored ? '· saved in ~/.pdf-edit (not shown)' : settings.apiKeyAvailable ? '· using ANTHROPIC_API_KEY from the environment' : '· optional'}</span>
          </label>
          <div className="mt-1 flex gap-2">
            <input className="input flex-1 font-mono text-xs" type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder={settings.apiKeyStored ? '••••••••  (enter a new key to replace)' : 'sk-ant-…'} />
            <button className="btn-ghost border border-hair" disabled={!key.trim()} onClick={() => { void setApiKey(key); setKey('') }}>Save</button>
            {settings.apiKeyStored && <button className="btn-ghost text-red-700" onClick={() => void setApiKey('')}>Remove</button>}
          </div>
        </Section>

        <Section title="Defaults for new chats">
          <label className="block text-xs font-medium text-ink-2">Approval mode</label>
          <div className="mt-1 grid grid-cols-2 gap-1.5">
            {APPROVAL_MODES.map((m) => (
              <button key={m.id} className={clsx('rounded-md border px-2 py-1.5 text-left text-xs', settings.defaultMode === m.id ? 'border-accent/50 bg-accent-soft' : 'border-hair hover:bg-paper')} onClick={() => void update({ defaultMode: m.id as ApprovalMode })}>
                <div className="font-medium">{m.chip}</div>
                <div className="text-[11px] text-ink-3">{m.blurb}</div>
              </button>
            ))}
          </div>
          <div className="mt-3 grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-ink-2">Model</label>
              <select className="input mt-1 w-full text-xs" value={settings.defaultModel} onChange={(e) => void update({ defaultModel: e.target.value })}>
                <option value="">{modelLabel('', options)}</option>
                {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-ink-2">Effort</label>
              <select className="input mt-1 w-full text-xs" value={settings.defaultEffort} onChange={(e) => void update({ defaultEffort: e.target.value as Effort | '' })}>
                {EFFORT_OPTIONS.map((o) => <option key={o.id || 'default'} value={o.id}>{o.label}</option>)}
              </select>
            </div>
          </div>
          <label className="mt-3 flex items-center gap-2 text-xs">
            <input type="checkbox" checked={settings.fast} disabled={!fastSupported(settings.defaultModel)} onChange={(e) => void update({ fast: e.target.checked })} />
            Fast mode <span className="text-ink-3">(Opus only — ~2.5× faster, higher cost)</span>
          </label>
          <p className="mt-2 text-[11px] text-ink-3">The composer’s chip changes these per chat; your last pick there also becomes the default.</p>
        </Section>

        <Section title="Your connectors">
          <label className="flex items-start gap-2 text-xs">
            <input type="checkbox" className="mt-0.5" checked={!!settings.userMcp} onChange={(e) => void update({ userMcp: e.target.checked })} />
            <span>
              <span className="font-medium text-ink">Use my MCP servers &amp; connectors</span> (Slack, Google Drive, …) — the ones your
              Claude Code has, besides the app’s own tools.
              <span className="mt-1 block text-[11px] text-ink-3">
                Their actions ask for approval like commands (in manual and accept-edits modes; allowed automatically in auto approve;
                read-only in plan). claude.ai connectors need the Claude subscription login. Applies from the next message.
              </span>
            </span>
          </label>
        </Section>

        <Section title="Web access">
          <div className="flex gap-2">
            {([
              ['allow', 'Allow', 'web search and page fetches run like any tool'],
              ['ask', 'Ask first', 'an approval card each time, in every mode'],
              ['off', 'Off', 'the agent has no web tools'],
            ] as const).map(([id, title, sub]) => (
              <Choice key={id} active={(settings.webAccess ?? 'allow') === id} onClick={() => void update({ webAccess: id })} title={title} sub={sub} />
            ))}
          </div>
          <p className="mt-2 text-[11px] text-ink-3">Applies from the next message.</p>
        </Section>

        <Section title="Spend cap">
          <div className="flex items-center gap-2 text-xs">
            Stop a turn after
            <span className="text-ink-3">$</span>
            <input className="input w-24 text-xs" value={budget} onChange={(e) => setBudget(e.target.value)} placeholder="no cap" />
            <button className="btn-ghost border border-hair" onClick={() => void update({ maxBudgetUsd: budget.trim() ? Number(budget) || null : null })}>Save</button>
            <span className="text-ink-3">(API spend per turn; `--max-budget-usd`)</span>
          </div>
        </Section>
    </>
  )
}

function Section({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="mb-4 rounded-lg border border-hair p-3">
      <div className="mb-2 flex items-center text-[11px] font-semibold uppercase tracking-wide text-ink-3">{title}<span className="ml-auto">{action}</span></div>
      {children}
    </section>
  )
}

function Row({ ok, label, detail }: { ok: boolean; label: string; detail?: string }) {
  return (
    <div className="flex items-start gap-2 py-0.5 text-sm">
      {ok ? <CheckCircle2 size={15} className="mt-0.5 shrink-0 text-emerald-600" /> : <XCircle size={15} className="mt-0.5 shrink-0 text-amber-600" />}
      <div className="min-w-0">
        <div>{label}</div>
        {detail && <div className="truncate font-mono text-[11px] text-ink-3">{detail}</div>}
      </div>
    </div>
  )
}

function Choice({ active, disabled, onClick, title, sub }: { active: boolean; disabled?: boolean; onClick(): void; title: string; sub: string }) {
  return (
    <button disabled={disabled} onClick={onClick} className={clsx('flex-1 rounded-md border px-3 py-2 text-left disabled:opacity-50', active ? 'border-accent/50 bg-accent-soft' : 'border-hair hover:bg-paper')}>
      <div className="text-sm font-medium">{title}</div>
      <div className="text-[11px] text-ink-3">{sub}</div>
    </button>
  )
}
