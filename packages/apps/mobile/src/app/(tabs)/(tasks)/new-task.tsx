import { useLocalSearchParams, useRouter } from 'expo-router'
import { TASKS, taskHref } from '../../../routes'
import { NewTaskScreen } from '../../../task-edit/NewTaskScreen'

/**
 * `/new-task?hub=&project=[&status=][&parent=]` (in the Tasks tab; `task-edit/routes.ts`):
 * create a task. Created, the task's screen takes its place; Cancel goes back.
 */
export default function NewTaskRoute() {
  const { hub, project, status, parent } = useLocalSearchParams<{
    hub: string
    project: string
    status?: string
    parent?: string
  }>()
  const router = useRouter()
  const back = () => (router.canGoBack() ? router.back() : router.replace(TASKS))
  return (
    <NewTaskScreen
      hubAddress={hub ?? ''}
      projectId={project ?? ''}
      status={status || undefined}
      parentId={parent || undefined}
      onCreated={(hubAddress, taskId) => router.replace(taskHref(hubAddress, taskId))}
      onCancel={back}
    />
  )
}
