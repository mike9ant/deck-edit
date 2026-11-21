import { describe, expect, it } from 'vitest'
import { agentBlock } from '../AgentSetup'
import type { AgentStatus } from '../../api/types'

const status = (found: boolean, loggedIn?: boolean | null): AgentStatus => ({
  cli: { found, path: found ? '/x/claude' : null, version: null, command: 'claude' },
  auth: loggedIn == null ? null : { loggedIn },
  apiKeyAvailable: false,
  python: { path: null, pythonPptx: null },
})

describe('when the agent can’t run', () => {
  it('blocks only on a certain status', () => {
    expect(agentBlock(null, 'subscription', false)).toBeNull() // still checking
    expect(agentBlock(status(false), 'subscription', false)).toEqual({ kind: 'missing', command: 'claude' })
    expect(agentBlock(status(true, false), 'subscription', false)).toEqual({ kind: 'signedOut', keyAvailable: false })
    expect(agentBlock(status(true, null), 'subscription', false)).toBeNull() // a CLI that can't report its sign-in
    expect(agentBlock(status(true, true), 'subscription', false)).toBeNull()
  })

  it('an API key in use needs no sign-in, but still needs Claude Code', () => {
    expect(agentBlock(status(true, false), 'key', true)).toBeNull()
    expect(agentBlock(status(true, false), 'subscription', true)).toEqual({ kind: 'signedOut', keyAvailable: true })
    expect(agentBlock(status(false), 'key', true)).toEqual({ kind: 'missing', command: 'claude' })
  })
})
