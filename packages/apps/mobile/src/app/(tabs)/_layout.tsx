import { NativeTabs } from 'expo-router/native-tabs'
import { useTheme, useThemeVariant } from '../../theme'

/**
 * Signed in: the app's tabs, iOS's own tab bar (`UITabBarController`). Each tab is a
 * stack (`(<tab>)/_layout.tsx`); detail screens push inside the tab that opened them,
 * so the tab bar stays. The detail routes live once in `(tasks,agents,search)/` and
 * Expo Router gives each of those tabs its own copy; a push resolves to the copy in
 * the tab it starts from, a link from outside the app to the tab `deep-links.ts` names.
 * Every tab is mounted from the start (native tabs keep them all), each screen in the
 * theme's background.
 *
 * iPad (iPadOS 18+): the tab bar can turn into a sidebar (`sidebarAdaptable`).
 *
 * Colours: the bar draws in the theme's variant (`colorScheme`), not the device's, so
 * the theme's foreground tint reads on it whichever the device uses; before iOS 26 its
 * background is the theme's (iOS 26 draws its own glass).
 */
export const unstable_settings = { anchor: '(agents)' }

export default function TabsLayout() {
  const theme = useTheme()
  const variant = useThemeVariant()
  const content = { backgroundColor: theme.background }
  return (
    <NativeTabs
      sidebarAdaptable
      tintColor={theme.foreground}
      backgroundColor={theme.background}
      unstable_nativeProps={{ colorScheme: variant }}
    >
      <NativeTabs.Trigger name="(agents)" disableAutomaticContentInsets contentStyle={content}>
        <NativeTabs.Trigger.Icon sf="sparkles" />
        <NativeTabs.Trigger.Label>Agents</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="(tasks)" disableAutomaticContentInsets contentStyle={content}>
        <NativeTabs.Trigger.Icon sf="checklist" />
        <NativeTabs.Trigger.Label>Tasks</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="(search)" disableAutomaticContentInsets contentStyle={content}>
        <NativeTabs.Trigger.Icon sf="magnifyingglass" />
        <NativeTabs.Trigger.Label>Search</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="(hubs)" disableAutomaticContentInsets contentStyle={content}>
        <NativeTabs.Trigger.Icon sf="server.rack" />
        <NativeTabs.Trigger.Label>Hubs</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  )
}
