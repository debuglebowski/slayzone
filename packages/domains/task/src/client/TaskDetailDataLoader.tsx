import React from 'react'
import { useHubId } from '@slayzone/transport/client'
import { TaskDetailPage, type TaskDetailPageProps } from './TaskDetailPage'
import { taskDetailCache } from './taskDetailCache'

export type TaskDetailDataLoaderProps = Omit<TaskDetailPageProps, 'initialData'>

/**
 * Suspense wrapper for TaskDetailPage.
 * Suspends until task data is loaded, then renders TaskDetailPage with initialData.
 * The parent must wrap this in a <Suspense> boundary.
 *
 * Multi-hub: reads the enclosing HubScope's hub id and passes it as the cache's
 * second arg so a remote task's detail loads from — and is cached under — its
 * OWN hub. `undefined` outside a HubScope (fork / single-hub) → default hub.
 */
export const TaskDetailDataLoader = React.memo(function TaskDetailDataLoader(
  props: TaskDetailDataLoaderProps
): React.JSX.Element {
  const hubId = useHubId() ?? undefined
  const data = taskDetailCache.useData('taskDetail', props.taskId, hubId)
  return <TaskDetailPage {...props} initialData={data} />
})
