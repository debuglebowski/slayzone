import { TabStack } from '../../../TabStack'

/** The Tasks tab's stack. It starts at `tasks`, also under a deep link into the tab. */
export const unstable_settings = { anchor: 'tasks' }

export default function TasksTabLayout() {
  return <TabStack tab="tasks" />
}
