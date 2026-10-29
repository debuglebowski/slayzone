import type { HubThemeSettings } from '@slayzone/theme-tokens'
import { FederationProvider, HubScope } from '@slayzone/transport/client'
import { StatusBar } from 'expo-status-bar'
import { type ReactNode, useEffect, useState } from 'react'
import { ActivityIndicator, StyleSheet, View } from 'react-native'
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context'
import { type HubSession, restoreSession, signOut } from './hub-session'
import { SignInScreen } from './SignInScreen'
import { TaskBrowser } from './TaskBrowser'
import { HubThemeProvider, KeptThemeProvider, useTheme, useThemeVariant } from './theme'
import { hubThemeCache } from './theme-cache'

/** The default hub id of a client with no co-located hub: names no hub in the list. */
const NO_LOCAL_HUB = 'local'

/** Signed in: the hub session, and what to paint until that hub's theme settings load. */
interface SignedIn {
  session: HubSession
  /** The theme inputs kept from that hub at the last launch; null = none (fresh sign-in). */
  cachedTheme: HubThemeSettings | null
}

/**
 * Signed out: the sign-in screen. Signed in: the hub's API through the SAME federation
 * path desktop uses for a remote hub — `FederationProvider` (per-hub socket + bearer
 * as tRPC `connectionParams`) and `HubScope` (its React Query cache + tRPC context),
 * painted in the user's theme from that hub (`HubThemeProvider`). A restored session
 * starts in the theme last read from its hub, until the hub answers; the loading screen
 * before that (the keychain read) paints in the theme of the hub signed in last.
 */
export function App() {
  // undefined = still reading what the last launch kept (keychain, then theme cache).
  const [signedIn, setSignedIn] = useState<SignedIn | null | undefined>(undefined)
  // Synchronous file read, once: the loading screen's first frame is already in the
  // user's theme, before the (asynchronous) keychain read says which session this is.
  const [lastTheme] = useState(() => hubThemeCache.loadLast())

  useEffect(() => {
    void restoreSession().then((session) => {
      // Read in the same step as the session: the first signed-in render already paints
      // the theme last read from that hub (no extra render pass in the default).
      const restored = session && { session, cachedTheme: hubThemeCache.load(session.entry.id) }
      setSignedIn((cur) => cur ?? restored)
    })
  }, [])

  const handleSignOut = (): void => {
    if (signedIn) {
      hubThemeCache.forget(signedIn.session.entry.id)
      void signOut(signedIn.session)
    }
    setSignedIn(null)
  }

  let body
  if (signedIn === undefined) {
    body = (
      <KeptThemeProvider settings={lastTheme}>
        <Screen>
          <Loading />
        </Screen>
      </KeptThemeProvider>
    )
  } else if (signedIn === null) {
    body = (
      <Screen>
        <SignInScreen onSignedIn={(session) => setSignedIn({ session, cachedTheme: null })} />
      </Screen>
    )
  } else {
    const { session, cachedTheme } = signedIn
    body = (
      <FederationProvider
        hubs={[session.entry]}
        defaultHubId={NO_LOCAL_HUB}
        tokens={{ [session.entry.id]: session.token }}
      >
        <HubScope hubId={session.entry.id}>
          <HubThemeProvider hubId={session.entry.id} cached={cachedTheme}>
            <Screen>
              <TaskBrowser hubLabel={session.entry.label} onSignOut={handleSignOut} />
            </Screen>
          </HubThemeProvider>
        </HubScope>
      </FederationProvider>
    )
  }

  return <SafeAreaProvider>{body}</SafeAreaProvider>
}

/** The window: safe-area insets in the theme's background, a status bar readable on it. */
function Screen({ children }: { children: ReactNode }) {
  const theme = useTheme()
  const variant = useThemeVariant()
  return (
    <SafeAreaView style={[styles.root, { backgroundColor: theme.background }]}>
      <StatusBar style={variant === 'dark' ? 'light' : 'dark'} />
      {children}
    </SafeAreaView>
  )
}

function Loading() {
  const theme = useTheme()
  return (
    <View style={styles.center}>
      <ActivityIndicator color={theme.foreground} />
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' }
})
