import { Stack } from 'expo-router'
import type { ComponentProps } from 'react'
import { DemoBanner } from './demo/DemoBanner'
import { Screen } from './Screen'
import { useTheme } from './theme'

/** The app's tabs, by the name of their route group (`app/(tabs)/(<tab>)/`). */
export type TabName = 'board' | 'search' | 'settings'

type ScreenOptions = NonNullable<ComponentProps<typeof Stack.Screen>['options']>

/** The tabs whose stacks hold a task's page. */
const TASK_TABS: ReadonlySet<TabName> = new Set(['board', 'search'])
/** A task's Details / Artifacts sheet (`app/(tabs)/(board,search)/task/[hub]/[id]/info.tsx`). */
const TASK_INFO_ROUTE = 'task/[hub]/[id]/info'

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
 *
 * The tabs that hold a task's page (Board, Search: `app/(tabs)/(board,search)/`) present
 * its Details / Artifacts (`task/<hub>/<id>/info`) as iOS's sheet over it — medium
 * first, then large, with a grabber; a native sheet, so the page stays mounted (and in
 * sight) under it and drags, detents and VoiceOver's escape work as anywhere in iOS.
 */
export function TabStack({ tab }: { tab: TabName }) {
  const theme = useTheme()
  return (
    <Screen testID={`tab-${tab}`}>
      <DemoBanner />
      <Stack
        screenOptions={{ headerShown: false, contentStyle: { backgroundColor: theme.background } }}
      >
        {TASK_TABS.has(tab) ? (
          <Stack.Screen
            name={TASK_INFO_ROUTE}
            options={
              {
                presentation: 'formSheet',
                sheetAllowedDetents: [0.5, 1],
                sheetInitialDetentIndex: 0,
                sheetGrabberVisible: true,
                contentStyle: { backgroundColor: theme.background }
              } satisfies ScreenOptions
            }
          />
        ) : null}
      </Stack>
    </Screen>
  )
}
