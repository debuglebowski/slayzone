import { TabStack } from '../../../TabStack'

/** The Hubs tab's stack. It starts at `hubs`, also under a deep link into the tab. */
export const unstable_settings = { anchor: 'hubs' }

export default function HubsTabLayout() {
  return <TabStack tab="hubs" />
}
