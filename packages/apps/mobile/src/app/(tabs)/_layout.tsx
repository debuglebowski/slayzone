import { NativeTabs } from 'expo-router/native-tabs'
import { useDevLaunchLink } from '../../dev-launch'
import { OpenTasksProvider } from '../../home/OpenTasksProvider'
import { useTheme, useThemeVariant } from '../../theme'

/**
 * Signed in: the app's tabs — Board · Search · Settings — iOS's own tab bar
 * (`UITabBarController`). Each tab is a stack (`(<tab>)/_layout.tsx`); detail screens
 * push inside the tab that opened them, so the tab bar stays. The detail routes live
 * once in `(board,search)/` and
 * Expo Router gives each of those tabs its own copy; a push resolves to the copy in
 * the tab it starts from, a link from outside the app to the tab `deep-links.ts` names.
 * Every tab is mounted from the start (native tabs keep them all), each screen in the
 * theme's background.
 *
 * iPad: the tab bar stays a tab bar — never a sidebar beside the board's own projects
 * rail. `sidebarAdaptable={false}` is explicit: left unset, expo-router uses UIKit's
 * `automatic` mode, which iPadOS may still show as a sidebar. The tasks open as tabs on
 * the board (`OpenTasksProvider`) are kept here, above every tab.
 *
 * Colours: the bar draws in the theme's variant (`colorScheme`), not the device's, so
 * the theme's foreground tint reads on it whichever the device uses; before iOS 26 its
 * background is the theme's (iOS 26 draws its own glass).
 */
export const unstable_settings = { anchor: '(board)' }

export default function TabsLayout() {
  useDevLaunchLink()
  const theme = useTheme()
  const variant = useThemeVariant()
  const content = { backgroundColor: theme.background }
  return (
    <OpenTasksProvider>
      <NativeTabs
        sidebarAdaptable={false}
        tintColor={theme.foreground}
        backgroundColor={theme.background}
        unstable_nativeProps={{ colorScheme: variant }}
      >
        <NativeTabs.Trigger name="(board)" disableAutomaticContentInsets contentStyle={content}>
          <NativeTabs.Trigger.Icon sf="square.grid.3x2" />
          <NativeTabs.Trigger.Label>Board</NativeTabs.Trigger.Label>
        </NativeTabs.Trigger>
        <NativeTabs.Trigger name="(search)" disableAutomaticContentInsets contentStyle={content}>
          <NativeTabs.Trigger.Icon sf="magnifyingglass" />
          <NativeTabs.Trigger.Label>Search</NativeTabs.Trigger.Label>
        </NativeTabs.Trigger>
        <NativeTabs.Trigger name="(settings)" disableAutomaticContentInsets contentStyle={content}>
          <NativeTabs.Trigger.Icon sf="gearshape" />
          <NativeTabs.Trigger.Label>Settings</NativeTabs.Trigger.Label>
        </NativeTabs.Trigger>
      </NativeTabs>
    </OpenTasksProvider>
  )
}
