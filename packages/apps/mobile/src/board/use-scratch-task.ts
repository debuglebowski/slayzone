/**
 * The board's ＋ tap: a temporary task in the shown project ("Terminal N", desktop's
 * ⌘T), opened straight away on its agent. Hidden from the board; "Keep as task" in the
 * task's ⋯ menu turns it into a regular one. Call inside the project's `HubScope`.
 */
import { scratchTaskInput } from '@slayzone/tasks/board'
import type { Task } from '@slayzone/task-contracts'
import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Alert } from 'react-native'
import type { BoardProject, BoardTask } from '../hub-board'
import { messageOf } from '../task-edit/use-task-writes'
import { useTRPC, useTRPCClient } from '../trpc'

export function useScratchTask(onCreated: (task: Task) => void): {
  creating: boolean
  create: (project: BoardProject, tasks: readonly BoardTask[]) => void
} {
  const trpc = useTRPC()
  const client = useTRPCClient()
  const queryClient = useQueryClient()
  const [creating, setCreating] = useState(false)
  const create = (project: BoardProject, tasks: readonly BoardTask[]) => {
    if (creating) return
    setCreating(true)
    client.task.create
      .mutate(scratchTaskInput(project, tasks))
      .then((task) =>
        // The task screen finds the task in the board: load it before opening.
        queryClient
          .invalidateQueries(trpc.task.loadBoardData.queryFilter())
          .then(() => onCreated(task))
      )
      .catch((err: unknown) => Alert.alert("Couldn't start a session", messageOf(err)))
      .then(() => setCreating(false))
  }
  return { creating, create }
}
