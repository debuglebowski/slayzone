import { useLocalSearchParams, useNavigation, usePreventRemove, useRouter } from 'expo-router'
import { useCallback, useState } from 'react'
import { HOME, taskHref } from '../../../routes'
import { confirmDiscardTask, NewTaskScreen } from '../../../task-edit/NewTaskScreen'

/**
 * `/new-task?hub=&project=[&status=][&priority=][&due=][&parent=]` (in the Board tab;
 * `task-edit/routes.ts`):
 * create a task. Created, the task's screen takes its place; Cancel goes back. With a
 * title typed, a swipe back asks first (Cancel asks in the screen itself).
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
  const navigation = useNavigation()
  const [form, setForm] = useState({ dirty: false, creating: false })
  // Leaving on purpose (Cancel already asked, or the task was created) skips the question.
  const allowLeave = usePreventRemove(form.dirty || form.creating, ({ repeat }) =>
    confirmDiscardTask(repeat, form.creating)
  )
  const back = () => {
    allowLeave()
    if (router.canGoBack()) router.back()
    else router.replace(HOME)
  }
  const recordForm = useCallback((dirty: boolean, creating: boolean) => {
    setForm({ dirty, creating })
  }, [])
  return (
    <NewTaskScreen
      hubAddress={hub ?? ''}
      projectId={project ?? ''}
      status={status || undefined}
      priority={priority ? Number(priority) : undefined}
      dueDate={due || undefined}
      parentId={parent || undefined}
      onCreated={(hubAddress, taskId) => {
        if (!navigation.isFocused()) return
        allowLeave()
        router.replace(taskHref(hubAddress, taskId))
      }}
      onCancel={back}
      onDirtyChange={recordForm}
    />
  )
}
