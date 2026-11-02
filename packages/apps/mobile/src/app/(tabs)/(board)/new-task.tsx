import { useLocalSearchParams, useRouter } from 'expo-router'
import { HOME, taskHref } from '../../../routes'
import { NewTaskScreen } from '../../../task-edit/NewTaskScreen'

/**
 * `/new-task?hub=&project=[&status=][&priority=][&due=][&parent=]` (in the Board tab;
 * `task-edit/routes.ts`):
 * create a task. Created, the task's screen takes its place; Cancel goes back.
 */
export default function NewTaskRoute() {
  const { hub, project, status, priority, due, parent } = useLocalSearchParams<{
    hub: string
    project: string
    status?: string
    priority?: string
    due?: string
    parent?: string
  }>()
  const router = useRouter()
  const back = () => (router.canGoBack() ? router.back() : router.replace(HOME))
  return (
    <NewTaskScreen
      hubAddress={hub ?? ''}
      projectId={project ?? ''}
      status={status || undefined}
      priority={priority ? Number(priority) : undefined}
      dueDate={due || undefined}
      parentId={parent || undefined}
      onCreated={(hubAddress, taskId) => router.replace(taskHref(hubAddress, taskId))}
      onCancel={back}
    />
  )
}
