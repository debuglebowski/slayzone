import { Redirect, useLocalSearchParams } from 'expo-router'
import { taskHref } from '../../../../../routes'

/**
 * `/agent/<hub address>/<task id>` (deep link `slayzone://agent/…`, from before a
 * task's agent moved into its page): the task's page, its Agent shown — the main agent;
 * an agent tab the link names (`?tab=`) is ignored (the app shows no agent tabs).
 */
export default function OldAgentRoute() {
  const { hub, id } = useLocalSearchParams<{ hub: string; id: string }>()
  return <Redirect href={taskHref(hub, id, { segment: 'agent' })} />
}
