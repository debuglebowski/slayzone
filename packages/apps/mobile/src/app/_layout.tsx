/**
 * The app's root (Expo Router): sessions, hub connections, theme, then the screens.
 *
 * - Launch: until the keychain says which hubs are signed in, a spinner painted in the
 *   theme read last (`hubThemeCache.loadLast()`, a synchronous file read: the first
 *   frame is already in the user's theme). No navigator yet, so nothing navigates.
 * - Then one `HubConnections` for every signed-in hub (all hubs merged in one list)
 *   and the screens, behind `Stack.Protected` guards: signed out, only `/sign-in`;
 *   signed in, everything else (`/add-hub` signs in to another hub). A sign-in or the
 *   last sign-out flips the guards and Expo Router moves to the first allowed screen.
 * - Theme: the PRIMARY hub's, the one signed in first. One source keeps the app's look
 *   stable — signing in to another hub, or one hub being slow or unreachable, never
 *   repaints it — and the launch's first frame (the theme read last) is that hub's,
 *   since only its settings are read and kept. Signing out of it hands the theme to the
 *   next hub in sign-in order.
 */
import { focusManager } from '@tanstack/react-query'
import { Stack } from 'expo-router'
import { type ReactNode, useState } from 'react'
import { AppState } from 'react-native'
import { HubConnections } from '../hub-connections'
import { HubSessionsProvider, useHubSessions } from '../hub-sessions'
import { Loading, Screen } from '../Screen'
import { HubThemeProvider } from '../hub-theme'
import { KeptThemeProvider, useTheme } from '../theme'
import { hubThemeCache } from '../theme-cache'

// React Query refetches stale queries when the "window" regains focus; in React Native
// that is the app coming back to the foreground. A refetch also reopens a hub's socket
// at once, instead of at the reconnect loop's next attempt (up to 30s away).
focusManager.setEventListener((setFocused) => {
  const subscription = AppState.addEventListener('change', (state) =>
    setFocused(state === 'active')
  )
  return () => subscription.remove()
})

// Expo Router already wraps every layout in a SafeAreaProvider (with the window's
// initial metrics, so the first frame needs no measuring pass).
export default function RootLayout() {
  return (
    <HubSessionsProvider>
      <Root />
    </HubSessionsProvider>
  )
}

function Root() {
  const { sessions } = useHubSessions()
  const [lastTheme] = useState(() => hubThemeCache.loadLast())

  if (sessions === undefined) {
    return (
      <KeptThemeProvider settings={lastTheme}>
        <Screen>
          <Loading />
        </Screen>
      </KeptThemeProvider>
    )
  }

  const signedIn = sessions.length > 0
  return (
    <HubConnections sessions={sessions}>
      <HubThemeProvider hubId={sessions[0]?.entry.id ?? null}>
        <Screen>
          <Screens>
            <Stack.Protected guard={signedIn}>
              <Stack.Screen name="index" />
              <Stack.Screen name="task/[hub]/[id]" />
              <Stack.Screen name="agent/[hub]/[id]" />
              <Stack.Screen name="hubs" />
              <Stack.Screen name="add-hub" />
            </Stack.Protected>
            <Stack.Protected guard={!signedIn}>
              <Stack.Screen name="sign-in" />
            </Stack.Protected>
          </Screens>
        </Screen>
      </HubThemeProvider>
    </HubConnections>
  )
}

/** The screen stack: no native header (screens draw their own), the theme's background. */
function Screens({ children }: { children: ReactNode }) {
  const theme = useTheme()
  return (
    <Stack
      screenOptions={{ headerShown: false, contentStyle: { backgroundColor: theme.background } }}
    >
      {children}
    </Stack>
  )
}
