import { useMemo } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useSubscription } from '@slayzone/transport/client'
import type { AgentId } from '@slayzone/terminal-contracts'
import type { TerminalTab } from '../shared/types'
import { beginModeSwitch } from './mode-switch'
import { useTRPC, useTRPCClient } from './trpc'

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
  /**
   * Restart a group's agent — its first terminal — in `mode` (an agent panel's
   * provider): its session ends, the row takes the new mode, and every window
   * showing it remounts the pane, which starts the new mode fresh. Resolves to the
   * mode it had (null: no such group, or already in `mode`).
   */
  setGroupMode: (taskId: string, groupId: string, mode: AgentId) => Promise<AgentId | null>
}

/** A group's agent: its first terminal by position. */
function agentTabOf(tabs: readonly TerminalTab[], groupId: string): TerminalTab | null {
  return (
    tabs.filter((t) => t.groupId === groupId).sort((a, b) => a.position - b.position)[0] ?? null
  )
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
      },
      setGroupMode: async (taskId, groupId, mode) => {
        const tab = agentTabOf(await client.taskTerminals.list.query({ taskId }), groupId)
        if (!tab || tab.mode === mode) return null
        const sessionId = `${taskId}:${tab.id}`
        if (await client.pty.exists.query({ sessionId })) {
          beginModeSwitch(sessionId)
          await client.pty.kill.mutate({ sessionId })
        }
        await client.chat.remove.mutate({ tabId: tab.id }).catch(() => undefined)
        await client.taskTerminals.update.mutate({ id: tab.id, mode })
        return tab.mode
      }
    }
  }, [client])
}

/**
 * The mode of a group's agent (its first terminal), or null while unknown or when
 * the group has no terminal. Follows mode changes made anywhere (`tabs:changed`).
 */
export function useTerminalGroupMode(taskId: string, groupId: string | null): AgentId | null {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const options = trpc.taskTerminals.list.queryOptions(
    { taskId },
    { enabled: groupId !== null, staleTime: 5_000 }
  )
  const { data } = useQuery(options)
  useSubscription(
    trpc.taskTerminals.onChanged.subscriptionOptions(undefined, {
      enabled: groupId !== null,
      onData: ({ taskId: changed }) => {
        if (changed === taskId) void queryClient.invalidateQueries({ queryKey: options.queryKey })
      }
    })
  )
  if (!data || groupId === null) return null
  return agentTabOf(data, groupId)?.mode ?? null
}
