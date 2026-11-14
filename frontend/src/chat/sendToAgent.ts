/**
 * Send a message to the agent from elsewhere in the app (e.g. a note's
 * "Act now"): into the active chat — or a new one — with that chat's posture
 * (mode, model, effort) and the usual context block, exactly as if typed.
 */

import { useChat } from '../store/chatStore'
import { useAgent } from '../store/agentStore'
import { useApp } from '../store/appStore'
import { buildTurnContext } from './turnContext'
import { chatPosture } from './posture'

/** Is an agent turn running in the current project (a new message can't start yet)? */
export const agentBusy = () => {
  const { pid, busyProjects } = useChat.getState()
  return !!pid && !!busyProjects[pid]
}

export async function sendToAgent(text: string): Promise<boolean> {
  const chats = useChat.getState()
  if (!chats.pid) return false
  if (agentBusy()) {
    useApp.getState().toast('The agent is working — try again when its turn ends.')
    return false
  }
  const id = chats.activeId ?? (await chats.newChat())
  if (!id) return false
  if (!useChat.getState().chats[id]) await useChat.getState().reloadChat(id)
  const chat = useChat.getState().chats[id]
  if (!chat) return false
  const posture = chatPosture(chat, { auth: useAgent.getState().settings?.auth ?? 'subscription' })
  return useChat.getState().send(id, text, await buildTurnContext(true), posture)
}
