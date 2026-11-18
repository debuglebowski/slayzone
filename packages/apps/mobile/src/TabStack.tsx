import { Stack } from 'expo-router'
import { DemoBanner } from './demo/DemoBanner'
import { Screen } from './Screen'
import { useTheme } from './theme'

/** The app's tabs, by the name of their route group (`app/(tabs)/(<tab>)/`). */
export type TabName = 'board' | 'search' | 'settings'

/**
 * One tab's screen stack (`app/(tabs)/(<tab>)/_layout.tsx`): what the tab opens pushes
 * here, so the tab bar stays. No native header (screens draw their own), the theme's
 * background.
 *
 * Safe area: a native tab's screen sits under the status bar and above the tab bar
 * (iPad: beside the sidebar). Expo Router gives each tab its own `SafeAreaProvider`,
 * which measures the insets from inside the tab, the tab bar included; `Screen` pads
 * the stack by them.
 *
 * The demo's banner (`DemoBanner`, only while the demo is open) sits above the stack, so
 * it stays on every screen the tab pushes.
 */
export function TabStack({ tab }: { tab: TabName }) {
  const theme = useTheme()
  return (
    <Screen testID={`tab-${tab}`}>
      <DemoBanner />
      <Stack
        screenOptions={{ headerShown: false, contentStyle: { backgroundColor: theme.background } }}
      />
    </Screen>
  )
}
