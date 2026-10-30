import { Stack } from 'expo-router'
import { Screen } from './Screen'
import { useTheme } from './theme'

/** The app's tabs, by the name of their route group (`app/(tabs)/(<tab>)/`). */
export type TabName = 'agents' | 'tasks' | 'search' | 'hubs'

/**
 * One tab's screen stack (`app/(tabs)/(<tab>)/_layout.tsx`): what the tab opens pushes
 * here, so the tab bar stays. No native header (screens draw their own), the theme's
 * background.
 *
 * Safe area: a native tab's screen sits under the status bar and above the tab bar
 * (iPad: beside the sidebar). Expo Router gives each tab its own `SafeAreaProvider`,
 * which measures the insets from inside the tab, the tab bar included; `Screen` pads
 * the stack by them.
 */
export function TabStack({ tab }: { tab: TabName }) {
  const theme = useTheme()
  return (
    <Screen testID={`tab-${tab}`}>
      <Stack
        screenOptions={{ headerShown: false, contentStyle: { backgroundColor: theme.background } }}
      />
    </Screen>
  )
}
