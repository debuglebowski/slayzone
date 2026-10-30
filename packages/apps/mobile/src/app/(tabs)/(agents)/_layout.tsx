import { TabStack } from '../../../TabStack'

/** The Agents tab's stack. It starts at `index`, also under a deep link into the tab. */
export const unstable_settings = { anchor: 'index' }

export default function AgentsTabLayout() {
  return <TabStack tab="agents" />
}
