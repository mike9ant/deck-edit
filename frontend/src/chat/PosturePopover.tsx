/**
 * The composer's one posture control: a chip reading `mode · model · effort`
 * (⚡ when fast) that opens a popover with everything about how the next turn
 * runs — approval mode, model, effort, auth source, fast mode. Ported from
 * ma-code-navigator's PosturePopover. ⇧Tab in the composer cycles the mode.
 */

import { useEffect, useRef, useState } from 'react'
import { Check, KeyRound, UserRound, Zap } from 'lucide-react'
import clsx from 'clsx'
import type { ApprovalMode, Effort, ModelOption, Posture } from '../api/types'
import { APPROVAL_MODES, EFFORT_OPTIONS, fastSupported, modeInfo, postureLabel } from './posture'

interface Props {
  posture: Posture
  models: ModelOption[]
  /** The mode governing the running turn, when one is running. */
  runningMode: ApprovalMode | null
  running: boolean
  apiKeyAvailable: boolean
  onChange(p: Partial<Posture>): void
}

export function PosturePopover({ posture, models, runningMode, running, apiKeyAvailable, onChange }: Props) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])

  const current = running && runningMode ? modeInfo(runningMode) : modeInfo(posture.mode)
  const differs = running && runningMode && runningMode !== posture.mode
  const label = differs
    ? `${current.chip} · next ${modeInfo(posture.mode).name} · ${postureLabel(posture, models).split(' · ').slice(1).join(' · ')}`
    : postureLabel({ ...posture, mode: current.id }, models)
  const defaultModel = models.find((o) => o.default)?.label
  const canFast = fastSupported(posture.model)
  const fastActive = posture.fast && canFast
  const auth = apiKeyAvailable ? posture.auth : 'subscription'

  const stepEffort = (dir: number) => {
    const i = EFFORT_OPTIONS.findIndex((o) => o.id === posture.effort)
    const next = EFFORT_OPTIONS[Math.min(EFFORT_OPTIONS.length - 1, Math.max(0, i + dir))]
    onChange({ effort: next.id })
  }

  return (
    <div className="relative min-w-0" ref={ref}>
      <button
        type="button"
        className={clsx('max-w-full truncate whitespace-pre rounded-md px-2 py-[3px] text-[11px]', current.className, open && 'outline outline-2 outline-accent/40')}
        title={`${running && runningMode ? `Current turn: ${current.name}. ` : ''}Next turn: ${modeInfo(posture.mode).name} — ${modeInfo(posture.mode).blurb}. Click for mode · model · effort · auth · fast; ⇧Tab cycles the mode.`}
        onClick={() => setOpen(!open)}
      >
        {label}
      </button>
      {open && (
        <div
          className="absolute bottom-8 left-0 z-50 w-[340px] overflow-hidden rounded-xl border border-hair bg-white text-ink shadow-2xl"
          tabIndex={-1}
          onKeyDown={(e) => {
            if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
              e.preventDefault()
              stepEffort(e.key === 'ArrowRight' ? 1 : -1)
            }
            if (e.key === 'Escape') setOpen(false)
          }}
        >
          <Heading>Approval mode <span className="normal-case tracking-normal">· ⇧Tab cycles</span></Heading>
          <div className="flex flex-col px-1.5 pb-1.5">
            {APPROVAL_MODES.map((m) => (
              <button
                key={m.id}
                type="button"
                title={m.blurb}
                onClick={() => {
                  onChange({ mode: m.id })
                  setOpen(false)
                }}
                className={clsx('flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px]', posture.mode === m.id ? 'bg-accent-soft' : 'hover:bg-paper')}
              >
                <span className={clsx('w-[92px] shrink-0 text-[10.5px]', posture.mode === m.id ? 'font-semibold text-accent' : 'text-ink-3')}>{m.chip}</span>
                <span className="min-w-0 flex-1 text-ink-2">{m.blurb}</span>
                {posture.mode === m.id && <Check size={12} className="shrink-0 text-accent" />}
              </button>
            ))}
            {running && (
              <div className="px-2 pt-1 text-[10.5px] text-ink-3">A running turn switches right away, except into or out of plan mode (that applies to your next message).</div>
            )}
          </div>

          <Heading border>Model</Heading>
          <div className="flex flex-wrap gap-1.5 px-3 pb-2">
            {[{ id: '', label: defaultModel ? `Default (${defaultModel})` : 'Default' } as ModelOption, ...models].map((o) => (
              <button
                key={o.id || 'default'}
                type="button"
                disabled={running}
                onClick={() => onChange({ model: o.id })}
                title={o.id === '' ? `No model override — the CLI runs its own default${defaultModel ? ` (${defaultModel})` : ''}` : o.default ? `${o.label} — the CLI's default` : undefined}
                className={clsx(
                  'rounded-md border px-2.5 py-[3px] text-[11px] disabled:opacity-40',
                  posture.model === o.id ? 'border-accent/40 bg-accent-soft font-semibold text-accent' : 'border-hair text-ink-3 hover:border-accent/40 hover:text-accent',
                )}
              >
                {o.label}
              </button>
            ))}
          </div>

          <EffortSlider value={posture.effort} onChange={(effort) => onChange({ effort })} />

          <div className="flex items-center gap-2 border-t border-hair px-3 py-2 text-[11.5px]">
            <button
              type="button"
              disabled={running || (auth === 'subscription' && !apiKeyAvailable)}
              onClick={() => onChange({ auth: auth === 'subscription' ? 'key' : 'subscription' })}
              className="inline-flex min-w-0 items-center gap-1.5 rounded-md px-1 py-0.5 text-ink-2 hover:bg-paper disabled:opacity-50"
              title={
                !apiKeyAvailable
                  ? 'Using your Claude Code login — no Anthropic API key is set (add one in Settings to switch)'
                  : auth === 'subscription'
                    ? 'Using your Claude Code login (claude login) — click to bill the Anthropic API key instead'
                    : 'Using the Anthropic API key (API billing) — click to use your Claude Code login instead'
              }
            >
              {auth === 'subscription' ? <UserRound size={13} className="shrink-0 text-ink-3" /> : <KeyRound size={13} className="shrink-0 text-ink-3" />}
              <span className="truncate">{auth === 'subscription' ? 'Claude subscription' : 'Anthropic API key'}</span>
              <Check size={12} className="shrink-0 text-accent" />
            </button>
            <span className="flex-1" />
            <button
              type="button"
              disabled={running || !canFast}
              onClick={() => onChange({ fast: !posture.fast })}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-md px-1 py-0.5 text-ink-3 hover:bg-paper disabled:opacity-40"
              title={canFast ? 'Opus ~2.5× faster, higher cost' : 'Fast mode is Opus-only — not available on the selected model.'}
              aria-pressed={fastActive}
            >
              <Zap size={13} /> Fast mode
              <span className={clsx('relative h-[14px] w-[26px] rounded-full border', fastActive ? 'border-accent/40 bg-accent-soft' : 'border-hair')}>
                <span className={clsx('absolute top-[1px] h-[10px] w-[10px] rounded-full transition-all', fastActive ? 'left-[13px] bg-accent' : 'left-[1px] bg-hair')} />
              </span>
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function Heading({ children, border }: { children: React.ReactNode; border?: boolean }) {
  return <div className={clsx('px-3 pb-1 pt-2 font-mono text-[10px] uppercase tracking-[0.1em] text-ink-3', border && 'border-t border-hair')}>{children}</div>
}

/** Discrete six-stop effort slider (dots click; ←/→ step while the popover has focus). */
function EffortSlider({ value, onChange }: { value: Effort | ''; onChange(e: Effort | ''): void }) {
  const idx = Math.max(0, EFFORT_OPTIONS.findIndex((o) => o.id === value))
  const pct = (idx / (EFFORT_OPTIONS.length - 1)) * 100
  return (
    <div className="px-3 pb-2 pt-1.5" role="group" aria-label="Reasoning effort">
      <div className="flex items-baseline justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-ink-3">Effort</span>
        <span className="text-[12px] font-semibold text-accent">{idx === 0 ? 'model’s own' : EFFORT_OPTIONS[idx].label}</span>
      </div>
      <div className="relative mt-2 h-4">
        <div className="absolute left-0 right-0 top-1/2 h-[3px] -translate-y-1/2 rounded-full bg-hair" />
        <div className="absolute left-0 top-1/2 h-[3px] -translate-y-1/2 rounded-full bg-accent" style={{ width: `${pct}%` }} />
        <div className="absolute inset-0 flex items-center justify-between">
          {EFFORT_OPTIONS.map((o, i) => (
            <button key={o.id || 'default'} type="button" onClick={() => onChange(o.id)} title={o.label} className="flex h-4 w-4 items-center justify-center rounded-full">
              {i === idx ? (
                <span className="h-4 w-4 rounded-full border-2 border-accent bg-white shadow" />
              ) : (
                <span className={clsx('h-2 w-2 rounded-full', i < idx ? 'bg-accent' : 'bg-hair')} />
              )}
            </button>
          ))}
        </div>
      </div>
      <div className="mt-1 flex justify-between text-[10px] text-ink-3"><span>model’s own</span><span>max</span></div>
      <p className="mt-1 text-[10.5px] leading-snug text-ink-3">Higher effort thinks longer and costs more. ← → to adjust.</p>
    </div>
  )
}
