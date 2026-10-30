/**
 * Starting, stopping and steering a task's agent from the phone — each the same hub
 * calls desktop makes, through the client of the hub that owns the task.
 *
 * - Start: `task.startMainAgent` only. The hub resolves the folder, provider and
 *   resume, and answers a live session instead of replacing it, so the phone and a
 *   desktop starting together share one agent. The phone never calls `pty.create`.
 * - Stop: `pty.kill` (terminal agent) / `chat.kill` (chat agent).
 * - Restart: stop, start (the conversation resumes).
 * - Reset (fresh conversation): terminal — stop, `task.resetConversation` (the ledger
 *   cutoff desktop's "Start fresh" writes), start; chat — `chat.reset`, which kills,
 *   wipes the tab's history and stored conversation, and leaves a fresh session.
 * - Interrupt (terminal agent): Esc to the agent and `pty.interrupt` (the state flip
 *   desktop sends with Esc / Ctrl+C: claude fires no hook on a user interrupt).
 * - Mode switch: desktop's `TaskDetailPage.handleModeChange` — stop, the new
 *   `terminalMode` with every conversation id cleared, then start.
 *
 * Start / restart / reset concern the task's MAIN agent (the hub procedure starts
 * that one); another tab's agent can be stopped and interrupted here.
 */
import { clearAllConversationIds, type ProviderConfig } from '@slayzone/task-contracts/types'
import { ESCAPE, isChatSupported } from '@slayzone/terminal-contracts'
import type { HubClient } from '../hub-board'
import type { RouterOutputs } from '../trpc'

export type StartedAgent = RouterOutputs['task']['startMainAgent']

/** The agent of one tab: the task, the tab and the tab's mode. */
export interface AgentTarget {
  taskId: string
  tabId: string
  mode: string
}

export const sessionIdOfTarget = (t: AgentTarget): string => `${t.taskId}:${t.tabId}`

export const isMainTab = (t: AgentTarget): boolean => t.tabId === t.taskId

export function startAgent(client: HubClient, taskId: string): Promise<StartedAgent> {
  return client.task.startMainAgent.mutate({ taskId })
}

export async function stopAgent(client: HubClient, target: AgentTarget): Promise<void> {
  if (isChatSupported(target.mode)) await client.chat.kill.mutate({ tabId: target.tabId })
  else await client.pty.kill.mutate({ sessionId: sessionIdOfTarget(target) })
}

export async function restartAgent(client: HubClient, target: AgentTarget): Promise<StartedAgent> {
  await stopAgent(client, target)
  return startAgent(client, target.taskId)
}

export async function resetAgent(client: HubClient, target: AgentTarget): Promise<void> {
  if (!isChatSupported(target.mode)) {
    await stopAgent(client, target)
    await client.task.resetConversation.mutate({ id: target.taskId, mode: target.mode })
    await startAgent(client, target.taskId)
    return
  }
  // `chat.reset` re-creates the tab in its folder, which the hub resolved when it
  // started the agent; a tab with no session yet gets one started (and so resolved).
  let cwd = (await client.chat.getInfo.query({ tabId: target.tabId }))?.cwd ?? null
  if (!cwd) cwd = (await startAgent(client, target.taskId)).cwd
  if (!cwd) cwd = (await client.chat.getInfo.query({ tabId: target.tabId }))?.cwd ?? null
  if (!cwd) throw new Error('The agent has no folder to start a new conversation in')
  await client.chat.reset.mutate({
    tabId: target.tabId,
    taskId: target.taskId,
    mode: target.mode,
    cwd,
    providerFlagsOverride: null
  })
}

export async function interruptAgent(client: HubClient, target: AgentTarget): Promise<void> {
  const sessionId = sessionIdOfTarget(target)
  await client.pty.write.mutate({ sessionId, data: ESCAPE })
  await client.pty.interrupt.mutate({ sessionId })
}

export interface ModeSwitchTask {
  id: string
  terminal_mode: string
  provider_config: ProviderConfig | null | undefined
}

export async function switchAgentMode(
  client: HubClient,
  task: ModeSwitchTask,
  mode: string
): Promise<StartedAgent> {
  await stopAgent(client, { taskId: task.id, tabId: task.id, mode: task.terminal_mode })
  await client.task.update.mutate({
    id: task.id,
    terminalMode: mode,
    providerConfig: clearAllConversationIds(task.provider_config)
  })
  return startAgent(client, task.id)
}
