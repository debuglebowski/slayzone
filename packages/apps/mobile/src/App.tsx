import { FederationProvider, HubScope } from '@slayzone/transport/client'
import { StatusBar } from 'expo-status-bar'
import { useEffect, useState } from 'react'
import { ActivityIndicator, StyleSheet, View } from 'react-native'
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context'
import { type HubSession, restoreSession, signOut } from './hub-session'
import { SignInScreen } from './SignInScreen'
import { TaskBrowser } from './TaskBrowser'
import { useTheme } from './theme'

/** The default hub id of a client with no co-located hub: names no hub in the list. */
const NO_LOCAL_HUB = 'local'

/**
 * Signed out: the sign-in screen. Signed in: the hub's API through the SAME federation
 * path desktop uses for a remote hub — `FederationProvider` (per-hub socket + bearer
 * as tRPC `connectionParams`) and `HubScope` (its React Query cache + tRPC context).
 */
export function App() {
  const theme = useTheme()
  // undefined = still reading the keychain.
  const [session, setSession] = useState<HubSession | null | undefined>(undefined)

  useEffect(() => {
    void restoreSession().then((restored) => setSession((cur) => cur ?? restored))
  }, [])

  const handleSignOut = (): void => {
    if (session) void signOut(session)
    setSession(null)
  }

  let body
  if (session === undefined) {
    body = (
      <View style={styles.center}>
        <ActivityIndicator color={theme.foreground} />
      </View>
    )
  } else if (session === null) {
    body = <SignInScreen onSignedIn={setSession} />
  } else {
    body = (
      <FederationProvider
        hubs={[session.entry]}
        defaultHubId={NO_LOCAL_HUB}
        tokens={{ [session.entry.id]: session.token }}
      >
        <HubScope hubId={session.entry.id}>
          <TaskBrowser hubLabel={session.entry.label} onSignOut={handleSignOut} />
        </HubScope>
      </FederationProvider>
    )
  }

  return (
    <SafeAreaProvider>
      <SafeAreaView style={[styles.root, { backgroundColor: theme.background }]}>
        <StatusBar style="auto" />
        {body}
      </SafeAreaView>
    </SafeAreaProvider>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' }
})
