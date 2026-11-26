import { useMemo } from 'react'
import type { AgentId } from '@slayzone/terminal-contracts'
import type { TerminalTab } from '../shared/types'
import { useTRPCClient } from './trpc'

/**
 * A task's terminal groups as whole units, for panels that each show some of them
 * (docs/plans/panel-model.md step 7: several agent/terminal panels per task). A new
 * panel starts with a group of its own; closing the panel ends its groups.
 */
export interface TerminalGroupsApi {
  /** Create a new group with one terminal of `mode` (the + of a terminal tab bar). */
  createGroup: (taskId: string, mode: AgentId) => Promise<TerminalTab>
  /** The terminal tabs of these groups. */
  tabsOf: (taskId: string, groupIds: readonly string[]) => Promise<TerminalTab[]>
  /** Whether a session of these groups runs right now. */
  anyLive: (taskId: string, groupIds: readonly string[]) => Promise<boolean>
  /** Close every tab of these groups: rows deleted, sessions (pty, chat) ended. */
  closeGroups: (taskId: string, groupIds: readonly string[]) => Promise<void>
}

export function useTerminalGroupsApi(): TerminalGroupsApi {
  const client = useTRPCClient()
  return useMemo(() => {
    const tabsOf = async (taskId: string, groupIds: readonly string[]): Promise<TerminalTab[]> => {
      if (groupIds.length === 0) return []
      const tabs = await client.taskTerminals.list.query({ taskId })
      return tabs.filter((t) => groupIds.includes(t.groupId))
    }
    return {
      createGroup: (taskId, mode) => client.taskTerminals.create.mutate({ taskId, mode }),
      tabsOf,
      anyLive: async (taskId, groupIds) => {
        const tabs = await tabsOf(taskId, groupIds)
        const live = await Promise.all(
          tabs.map((t) => client.pty.exists.query({ sessionId: `${taskId}:${t.id}` }))
        )
        return live.some(Boolean)
      },
      closeGroups: async (taskId, groupIds) => {
        for (const tab of await tabsOf(taskId, groupIds)) {
          await client.taskTerminals.delete.mutate({ tabId: tab.id }).catch(() => false)
          await client.pty.kill.mutate({ sessionId: `${taskId}:${tab.id}` }).catch(() => undefined)
          // A chat tab's session too (a no-op when there is none).
          await client.chat.remove.mutate({ tabId: tab.id }).catch(() => undefined)
        }
      }
    }
  }, [client])
}
