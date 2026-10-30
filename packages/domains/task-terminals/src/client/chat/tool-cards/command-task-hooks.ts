/**
 * A command the agent runs as a CLI task (plan 3.9), from its card: the live
 * output, polled only while the command runs AND its chat tab is on screen
 * (react-query also pauses while the window is hidden), and the two actions.
 *
 * @module task-terminals/chat/tool-cards/command-task-hooks
 */
import { createContext, useContext } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { toast } from '@slayzone/ui'
import type { CommandTaskOutput } from '@slayzone/terminal-contracts'
import { useTRPC } from '../../trpc'

/** The chat tab a card belongs to, and whether that tab is the one on screen. */
export interface CommandTaskScope {
  tabId: string
  active: boolean
}

/** Provided by ChatPanel. Absent (harnesses, previews): nothing is polled. */
export const CommandTaskContext = createContext<CommandTaskScope | null>(null)

/** How often a running command's output is read (the CLI answers in 1–19 ms). */
const POLL_MS = 1_000

/**
 * The output so far of task `taskId` while `running`. Stops by itself when the
 * command ends, the tab is hidden, or the task is `gone` (its process was
 * replaced); keeps the last answer for the card meanwhile.
 */
export function useCommandTaskOutput(
  taskId: string | undefined,
  running: boolean
): CommandTaskOutput | undefined {
  const scope = useContext(CommandTaskContext)
  const trpc = useTRPC()
  const query = useQuery({
    ...trpc.chat.commandTaskOutput.queryOptions({
      tabId: scope?.tabId ?? '',
      taskId: taskId ?? ''
    }),
    enabled: Boolean(scope?.active && taskId && running),
    refetchInterval: (q) => (q.state.data?.state === 'running' ? POLL_MS : false),
    refetchIntervalInBackground: false,
    staleTime: 0,
    gcTime: 60_000,
    retry: false
  })
  return query.data
}

/** Stop a running command; move a running foreground command to the background. */
export function useCommandTaskActions(): {
  stop: (taskId: string) => void
  background: (toolUseId: string) => void
  pending: boolean
} {
  const scope = useContext(CommandTaskContext)
  const trpc = useTRPC()
  const stopMutation = useMutation(
    trpc.chat.stopCommandTask.mutationOptions({
      onError: (err) => toast(`Could not stop the command: ${err.message}`)
    })
  )
  const backgroundMutation = useMutation(
    trpc.chat.backgroundCommandTask.mutationOptions({
      onSuccess: (moved) => {
        if (!moved) toast('The command could not be moved to the background (it already ended).')
      },
      onError: (err) => toast(`Could not move the command to the background: ${err.message}`)
    })
  )
  return {
    stop: (taskId) => {
      if (scope) stopMutation.mutate({ tabId: scope.tabId, taskId })
    },
    background: (toolUseId) => {
      if (scope) backgroundMutation.mutate({ tabId: scope.tabId, toolUseId })
    },
    pending: stopMutation.isPending || backgroundMutation.isPending
  }
}
