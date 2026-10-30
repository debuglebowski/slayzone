import { useLocalSearchParams } from 'expo-router'
import { TaskArtifactsRoute } from '../../../../../../artifacts/ArtifactRoutes'

/** `/artifacts/<hub address>/<task id>`: a task's artifacts, on that hub. */
export default function TaskArtifacts() {
  const { hub, task } = useLocalSearchParams<{ hub: string; task: string }>()
  return <TaskArtifactsRoute hub={hub} taskId={task} artifactId={null} version={null} />
}
