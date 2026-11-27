import React, { useEffect, useLayoutEffect, useMemo } from 'react'
import { useSuspenseQuery } from '@tanstack/react-query'
import { useHubId } from '@slayzone/transport/client'
import { isFullTaskRow, type Task } from '@slayzone/task-contracts'
import { TaskDetailPage, type TaskDetailPageProps } from './TaskDetailPage'
import { taskDetailCache, type TaskDetailData } from './taskDetailCache'
import { clearTerminalFirst } from './terminal-first'
import { useTRPC } from './trpc'

export type TaskDetailDataLoaderProps = Omit<TaskDetailPageProps, 'initialData'>

/**
 * Suspense wrapper for TaskDetailPage.
 * Suspends until task data is loaded, then renders TaskDetailPage with initialData.
 * The parent must wrap this in a <Suspense> boundary.
 *
 * Multi-hub: reads the enclosing HubScope's hub id and passes it as the cache's
 * second arg so a remote task's detail loads from — and is cached under — its
 * OWN hub. `undefined` outside a HubScope (fork / single-hub) → default hub.
 *
 * A detail primed from the board carries the board's row; a board of card rows
 * (`isFullTaskRow` false) lacks what the page reads at once — the agent's launch
 * config, the description. Then the page also waits for the task's full row
 * (`task.get`, the same query `useTaskFullRow` reads, which a batch prime may have
 * filled already).
 */
export const TaskDetailDataLoader = React.memo(function TaskDetailDataLoader(
  props: TaskDetailDataLoaderProps
): React.JSX.Element {
  const hubId = useHubId() ?? undefined
  const data = taskDetailCache.useData('taskDetail', props.taskId, hubId)
  // The page (and its own terminal) is up: the terminal-first pane is done.
  useEffect(() => clearTerminalFirst(props.taskId), [props.taskId])
  // Per-task "detail page committed" mark — read by the e2e perf scenarios.
  useLayoutEffect(() => {
    performance.mark(`sz:taskDetail:${props.taskId}:mount`)
  }, [props.taskId])
  if (data?.task && !isFullTaskRow(data.task)) return <WithFullRow {...props} data={data} />
  return <TaskDetailPage {...props} initialData={data} />
})

function WithFullRow({
  data,
  ...props
}: TaskDetailDataLoaderProps & { data: TaskDetailData }): React.JSX.Element {
  const trpc = useTRPC()
  const { data: full } = useSuspenseQuery(
    trpc.task.get.queryOptions(
      { id: props.taskId },
      { staleTime: Infinity, refetchOnWindowFocus: false }
    )
  )
  // Gone meanwhile (null): the page shows what it has, as without a full row.
  const initialData = useMemo(
    () => (full ? { ...data, task: { ...data.task, ...(full as Task) } } : data),
    [data, full]
  )
  return <TaskDetailPage {...props} initialData={initialData} />
}
