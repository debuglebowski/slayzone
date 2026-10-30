import { useLocalSearchParams } from 'expo-router'
import { TaskArtifactsRoute, versionParam } from '../../../../artifacts/ArtifactRoutes'

/**
 * `/artifacts/<hub address>/<task id>/<artifact id>[?version=<n>]` (deep link
 * `slayzone://artifacts/…`): one artifact, or one of its versions, on that hub.
 */
export default function Artifact() {
  const { hub, task, id, version } = useLocalSearchParams<{
    hub: string
    task: string
    id: string
    version?: string
  }>()
  return (
    <TaskArtifactsRoute hub={hub} taskId={task} artifactId={id} version={versionParam(version)} />
  )
}
