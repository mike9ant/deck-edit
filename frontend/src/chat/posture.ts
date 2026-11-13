/**
 * The agent's "posture" for a turn — approval mode, model, effort, fast mode,
 * auth — and how it reads on the composer chip. Ported from
 * ma-code-navigator's approvalModes.ts / PosturePopover.
 */

import type { ApprovalMode, Chat, Effort, ModelOption, Posture } from '../api/types'

/** The approval-mode cycle (⇧Tab, Claude Code-style). Order = cycle order. */
export const APPROVAL_MODES: { id: ApprovalMode; chip: string; name: string; className: string; blurb: string }[] = [
  { id: 'manual', chip: 'manual', name: 'manual', className: 'bg-paper text-ink-3 ring-1 ring-hair', blurb: 'Ask before every edit and command' },
  { id: 'acceptEdits', chip: '⏵⏵ accept edits', name: 'accept edits', className: 'bg-teal-50 text-teal-800 font-semibold ring-1 ring-teal-200', blurb: 'Auto-approve edits inside the project folder; commands still ask' },
  { id: 'plan', chip: '⏸ plan mode', name: 'plan', className: 'bg-teal-50 text-teal-800 font-semibold ring-1 ring-teal-200', blurb: 'Read-only planning turn — no edits, no changing commands, only a proposal' },
  { id: 'auto', chip: '⏵⏵ auto approve', name: 'auto approve', className: 'bg-rose-50 text-rose-700 font-semibold ring-1 ring-rose-200', blurb: 'Auto-approve edits AND commands — Revert undoes the turn’s file changes in the folder' },
]

export const modeInfo = (m: ApprovalMode) => APPROVAL_MODES.find((x) => x.id === m) ?? APPROVAL_MODES[3]

/** Effort stops, left → right ('' = the model's own). */
export const EFFORT_OPTIONS: { id: Effort | ''; label: string }[] = [
  { id: '', label: 'Default (model’s own)' },
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
  { id: 'xhigh', label: 'XHigh' },
  { id: 'max', label: 'Max' },
]

/** Until the CLI has been asked what each alias resolves to. */
export const FALLBACK_MODELS: ModelOption[] = [
  { id: 'fable', label: 'Fable' },
  { id: 'opus', label: 'Opus' },
  { id: 'sonnet', label: 'Sonnet' },
  { id: 'haiku', label: 'Haiku' },
]

/** Fast mode is Opus-only: the Opus alias, or the CLI default (typically Opus). */
export const fastSupported = (model: string) => model === '' || model === 'default' || model.includes('opus')

export function chatPosture(chat: Chat, defaults: { auth: 'subscription' | 'key' }): Posture {
  return {
    mode: chat.mode,
    model: chat.model ?? '',
    effort: chat.effort ?? '',
    fast: !!chat.fast,
    auth: chat.auth ?? defaults.auth,
  }
}

export function modelLabel(model: string, options: ModelOption[]) {
  if (!model || model === 'default') {
    const d = options.find((o) => o.default)
    return d ? `Default (${d.label})` : 'Default'
  }
  return options.find((o) => o.id === model)?.label ?? model
}

/** `mode · model · effort · ⚡` — the composer chip. */
export function postureLabel(p: Posture, options: ModelOption[]) {
  const model = !p.model ? 'Default' : (options.find((o) => o.id === p.model)?.label ?? p.model)
  return `${modeInfo(p.mode).chip} · ${model}${p.effort ? ` · ${p.effort}` : ''}${p.fast && fastSupported(p.model) ? ' · ⚡' : ''}`
}

/** One-line description of the posture a past turn ran under. */
export function turnPostureLabel(t: { mode?: ApprovalMode; model?: string; effort?: string; fast?: boolean; auth?: string }, options: ModelOption[]) {
  if (!t.mode) return ''
  const bits = [modeInfo(t.mode).name, t.model ? (options.find((o) => o.id === t.model)?.label ?? t.model) : 'default model']
  if (t.effort) bits.push(`${t.effort} effort`)
  if (t.fast) bits.push('⚡ fast')
  if (t.auth === 'key') bits.push('API key')
  return bits.join(' · ')
}
