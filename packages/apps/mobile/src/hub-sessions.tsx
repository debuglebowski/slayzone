/**
 * The signed-in hubs, for the whole app: read from the keychain at launch
 * (`hub-session.ts`), added to by a sign-in, removed from by a sign-out. Their order is
 * sign-in order; the first is the primary hub (its theme paints the app).
 *
 * The demo (`demo/`): `enterDemo` opens the app against the demo hub, served inside the
 * app — while it is open, `sessions` is that hub alone. It is kept nowhere: not in the
 * keychain, not across launches; the hubs signed in before are untouched and come back
 * when it closes. Leaving it (`exitDemo`, or signing out of its hub) drops the hub and
 * everything written to it; the next demo starts from the same sample data. Signing in
 * to a real hub while it is open closes it too.
 */
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState
} from 'react'
import { forgetArtifactCache } from './artifacts/files'
import { type DemoHub, openDemoHub } from './demo/demo-hub'
import { type HubSession, type HubSessionStore, hubSessions } from './hub-session'
import { hubThemeCache } from './theme-cache'

export interface HubSessionsValue {
  /** In sign-in order; undefined while the keychain is still being read. */
  sessions: HubSession[] | undefined
  /** A sign-in finished (`signIn` already kept it): list it. */
  signedIn: (session: HubSession) => void
  /**
   * Sign out of one hub: forget its bearer, the theme kept from it and the artifact
   * files downloaded from it. Its socket and cache close when it leaves the federation
   * (`HubConnections`).
   */
  signOut: (hubId: string) => void
  /** The demo is open: `sessions` is its hub alone. */
  demo: boolean
  /** Open the demo: every screen against the demo hub, no network, no account. */
  enterDemo: () => void
  /** Close the demo: back to the hubs signed in before (none: the sign-in screen). */
  exitDemo: () => void
}

const HubSessionsContext = createContext<HubSessionsValue | null>(null)

export function useHubSessions(): HubSessionsValue {
  const value = useContext(HubSessionsContext)
  if (!value) throw new Error('useHubSessions must be used within HubSessionsProvider')
  return value
}

const DEVICE_ARTIFACT_FILES = { forget: forgetArtifactCache }

export function HubSessionsProvider({
  store = hubSessions,
  themeCache = hubThemeCache,
  artifactFiles = DEVICE_ARTIFACT_FILES,
  openDemo = openDemoHub,
  children
}: {
  store?: HubSessionStore
  themeCache?: { forget(hubId: string): void }
  /** The artifact files downloaded from a hub (`artifacts/files.ts`), deleted on its sign-out. */
  artifactFiles?: { forget(hubId: string): void }
  /** A fresh demo hub (`demo/demo-hub.ts`); tests pass their own. */
  openDemo?: () => DemoHub
  children: ReactNode
}) {
  const [sessions, setSessions] = useState<HubSession[] | undefined>(undefined)
  const [demo, setDemo] = useState<DemoHub | null>(null)
  // A closed demo hub stops what it still had scheduled (a reply on its way).
  useEffect(() => (demo ? () => demo.dispose() : undefined), [demo])

  useEffect(() => {
    void store
      .restore()
      // A keychain the app cannot read is no session: the sign-in screen.
      .catch((): HubSession[] => [])
      .then((restored) => setSessions((current) => current ?? restored))
  }, [store])

  const exitDemo = useCallback(() => {
    // The artifact files it showed were written to the device's cache.
    if (demo) artifactFiles.forget(demo.session.entry.id)
    setDemo(null)
  }, [demo, artifactFiles])

  const enterDemo = useCallback(() => setDemo(openDemo()), [openDemo])

  const signedIn = useCallback(
    (session: HubSession) => {
      // A real hub signed in from inside the demo (Hubs → Add a hub) ends it.
      exitDemo()
      setSessions((current = []) => {
        const at = current.findIndex((s) => s.entry.id === session.entry.id)
        if (at === -1) return [...current, session]
        return current.map((s, i) => (i === at ? session : s))
      })
    },
    [exitDemo]
  )

  const signOut = useCallback(
    (hubId: string) => {
      if (demo && hubId === demo.session.entry.id) {
        exitDemo()
        return
      }
      themeCache.forget(hubId)
      artifactFiles.forget(hubId)
      void store.forget(hubId)
      setSessions((current) => current?.filter((s) => s.entry.id !== hubId))
    },
    [store, themeCache, artifactFiles, demo, exitDemo]
  )

  const value = useMemo<HubSessionsValue>(
    () => ({
      sessions: demo ? [demo.session] : sessions,
      signedIn,
      signOut,
      demo: demo !== null,
      enterDemo,
      exitDemo
    }),
    [sessions, demo, signedIn, signOut, enterDemo, exitDemo]
  )
  return <HubSessionsContext.Provider value={value}>{children}</HubSessionsContext.Provider>
}
