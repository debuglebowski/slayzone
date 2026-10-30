import { useLocalSearchParams, useRouter } from 'expo-router'
import { TasksScreen } from '../../../TasksScreen'

/** `/tasks` (the Tasks tab): every hub's tasks; on a wide screen `?hub=&task=` is the one beside the list. */
export default function TasksRoute() {
  const { hub, task } = useLocalSearchParams<{ hub?: string; task?: string }>()
  const router = useRouter()
  return (
    <TasksScreen
      selectedHub={hub}
      selectedTask={task}
      select={(row) => router.setParams({ hub: row.hubLabel, task: row.task.id })}
    />
  )
}
