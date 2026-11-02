import { TabStack } from '../../../TabStack'

/** The Settings tab's stack. It starts at `settings`, also under a deep link into the tab. */
export const unstable_settings = { anchor: 'settings' }

export default function SettingsTabLayout() {
  return <TabStack tab="settings" />
}
