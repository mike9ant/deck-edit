/**
 * Send a message to the agent from elsewhere in the app (e.g. a note's
 * "Act now"): into the active chat — or a new one — with that chat's posture
 * (mode, model, effort) and the usual context block, exactly as if typed.
 */

import { chatIsRunning, useChat } from '../store/chatStore'
import { useAgent } from '../store/agentStore'
import { useApp } from '../store/appStore'
import { buildTurnContext } from './turnContext'
import { chatPosture } from './posture'

/** Is the active chat's agent working (a new message can't go into that chat yet)? Other chats may run alongside. */
export const agentBusy = () => chatIsRunning(useChat.getState(), useChat.getState().activeId)

export async function sendToAgent(text: string): Promise<boolean> {
  const chats = useChat.getState()
  if (!chats.pid) return false
  if (agentBusy()) {
    useApp.getState().toast('The agent in this chat is working — try again when its turn ends, or switch to another chat tab.')
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
