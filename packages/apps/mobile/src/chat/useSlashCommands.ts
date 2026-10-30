/**
 * What the `/` menu offers for this chat (`slash-menu.ts`), loaded from the hub: skills,
 * command files and agents of the chat's folder (`chat.listSkills` / `listCommands` /
 * `listAgents`), the CLI's own list (the live `turn-init` one, else the last one the
 * task's project saw: `chat.getCliSnapshot`) with its descriptions + argument hints (the
 * live `initialize` ones, else the project's stored ones: `chat.getCliCommandDetails`;
 * desktop's `useCliCommandSnapshot`), and the use counts that break ranking ties
 * (`chat.getAutocompleteUsage`, counted up with `chat.bumpAutocompleteUsage`).
 */
import {
  type ChatCapabilities,
  type CliCommandDetails,
  type CliCommandList,
  type CommandInfo
} from '@slayzone/terminal-contracts'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useMemo } from 'react'
import { type SlashItem, type SlashUsage, slashItems } from './slash-menu'
import { useTRPC, useTRPCClient } from '../trpc'

export interface SlashCommands {
  items: SlashItem[]
  usage: SlashUsage
  /** Raw command files (a provider without native commands expands them here). */
  commands: readonly CommandInfo[]
  /** Count a use of an entry (after a send). */
  bump: (entry: { source: string; name: string }) => void
}

export function useSlashCommands({
  taskId,
  mode,
  cwd,
  caps,
  liveCliList,
  liveCliDetails
}: {
  taskId: string
  mode: string
  cwd: string
  caps: ChatCapabilities
  liveCliList: CliCommandList | null
  liveCliDetails: CliCommandDetails | null
}): SlashCommands {
  const trpc = useTRPC()
  const client = useTRPCClient()
  const queryClient = useQueryClient()
  const native = caps.nativeSlashCommands
  const skills = useQuery(trpc.chat.listSkills.queryOptions({ cwd }))
  const commands = useQuery(
    trpc.chat.listCommands.queryOptions({ cwd, ...(native ? { nested: true } : {}) })
  )
  const agents = useQuery(trpc.chat.listAgents.queryOptions({ cwd }))
  const snapshot = useQuery(
    trpc.chat.getCliSnapshot.queryOptions({ taskId, mode }, { enabled: native && !liveCliList })
  )
  const storedDetails = useQuery(
    trpc.chat.getCliCommandDetails.queryOptions(
      { taskId, mode },
      { enabled: native && !liveCliDetails }
    )
  )
  const usage = useQuery(trpc.chat.getAutocompleteUsage.queryOptions())
  const list = native ? (liveCliList ?? snapshot.data ?? null) : null
  const details = liveCliDetails ?? storedDetails.data ?? null
  const cliList = useMemo(
    () => (list && details && list.details !== details ? { ...list, details } : list),
    [list, details]
  )

  const items = useMemo(
    () =>
      slashItems(
        { skills: skills.data, commands: commands.data, agents: agents.data, cliList },
        caps
      ),
    [skills.data, commands.data, agents.data, cliList, caps]
  )
  const bump = useCallback(
    (entry: { source: string; name: string }) => {
      void client.chat.bumpAutocompleteUsage
        .mutate(entry)
        .then(() => queryClient.invalidateQueries(trpc.chat.getAutocompleteUsage.queryFilter()))
        .catch(() => undefined)
    },
    [client, queryClient, trpc]
  )
  return {
    items,
    usage: (usage.data ?? {}) as SlashUsage,
    commands: commands.data ?? [],
    bump
  }
}
