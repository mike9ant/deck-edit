/** Agent settings, Claude Code CLI status, and the model picker's options. */

import { create } from 'zustand'
import { api } from '../api/client'
import type { AgentSettings, AgentStatus, ModelOption } from '../api/types'

interface AgentState {
  settings: AgentSettings | null
  status: AgentStatus | null
  statusLoading: boolean
  models: ModelOption[]
  /** The Settings dialog is open (from the top bar, or the chat's setup card). */
  settingsOpen: boolean
  openSettings(): void
  closeSettings(): void
  load(): Promise<void>
  refreshStatus(): Promise<void>
  update(body: Parameters<typeof api.updateSettings>[0]): Promise<void>
  setApiKey(key: string): Promise<void>
}

export const useAgent = create<AgentState>((set, get) => ({
  settings: null,
  status: null,
  statusLoading: false,
  models: [],
  settingsOpen: false,
  openSettings: () => set({ settingsOpen: true }),
  closeSettings: () => set({ settingsOpen: false }),
  async load() {
    const [settings] = await Promise.all([api.settings()])
    set({ settings })
    // Model probes start the CLI a few times — fetched in the background.
    api.models().then((models) => set({ models })).catch(() => {})
    void get().refreshStatus()
  },
  async refreshStatus() {
    set({ statusLoading: true })
    try {
      const status = await api.agentStatus()
      const before = get().status
      set({ status })
      // Just installed: the model picker's options come from the CLI.
      if (status.cli.found && before && !before.cli.found) api.models().then((models) => set({ models })).catch(() => {})
    } catch {
      /* the status stays as it was */
    } finally {
      set({ statusLoading: false })
    }
  },
  async update(body) {
    set({ settings: await api.updateSettings(body) })
    if ('claudePath' in body) {
      void get().refreshStatus()
      api.models().then((models) => set({ models })).catch(() => {})
    }
  },
  async setApiKey(key) {
    set({ settings: await api.setApiKey(key) })
    void get().refreshStatus()
  },
}))
