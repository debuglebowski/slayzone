import { TabStack } from '../../../TabStack'

/** The Search tab's stack. It starts at `artifacts/index`, also under a deep link into the tab. */
export const unstable_settings = { anchor: 'artifacts/index' }

export default function SearchTabLayout() {
  return <TabStack tab="search" />
}
