import { Redirect, useLocalSearchParams } from 'expo-router'
import { taskHref } from '../../../../../routes'

/**
 * `/agent/<hub address>/<task id>?tab=<tab id>` (deep link `slayzone://agent/…`, from
 * before a task's agent moved into its page): the task's page, its Agent shown.
 */
export default function OldAgentRoute() {
  const { hub, id, tab } = useLocalSearchParams<{ hub: string; id: string; tab?: string }>()
  return <Redirect href={taskHref(hub, id, { segment: 'agent', tab: tab || undefined })} />
}
