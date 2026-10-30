import { useLocalSearchParams, useRouter } from 'expo-router'
import { HomeScreen } from '../HomeScreen'

/** `/`: every hub's tasks; on a wide screen `?hub=&task=` is the one beside the list. */
export default function HomeRoute() {
  const { hub, task } = useLocalSearchParams<{ hub?: string; task?: string }>()
  const router = useRouter()
  return (
    <HomeScreen
      selectedHub={hub}
      selectedTask={task}
      select={(row) => router.setParams({ hub: row.hubLabel, task: row.task.id })}
    />
  )
}
