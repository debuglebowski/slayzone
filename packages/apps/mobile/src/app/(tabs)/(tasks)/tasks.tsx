import { useLocalSearchParams, useRouter } from 'expo-router'
import { TasksScreen } from '../../../TasksScreen'

/** `/tasks` (the Tasks tab): a project's board; on a wide screen `?hub=&task=` is the task beside it. */
export default function TasksRoute() {
  const { hub, task } = useLocalSearchParams<{ hub?: string; task?: string }>()
  const router = useRouter()
  return (
    <TasksScreen
      selectedHub={hub}
      selectedTask={task}
      select={(row) => router.setParams({ hub: row.hubLabel, task: row.task.id })}
      deselect={() => router.setParams({ hub: undefined, task: undefined })}
    />
  )
}
