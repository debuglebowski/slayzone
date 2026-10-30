/**
 * The signed-in hubs, for the whole app: read from the keychain at launch
 * (`hub-session.ts`), added to by a sign-in, removed from by a sign-out. Their order is
 * sign-in order; the first is the primary hub (its theme paints the app).
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
import { type HubSession, type HubSessionStore, hubSessions } from './hub-session'
import { hubThemeCache } from './theme-cache'

export interface HubSessionsValue {
  /** In sign-in order; undefined while the keychain is still being read. */
  sessions: HubSession[] | undefined
  /** A sign-in finished (`signIn` already kept it): list it. */
  signedIn: (session: HubSession) => void
  /**
   * Sign out of one hub: forget its bearer and the theme kept from it. Its socket and
   * cache close when it leaves the federation (`HubConnections`).
   */
  signOut: (hubId: string) => void
}

const HubSessionsContext = createContext<HubSessionsValue | null>(null)

export function useHubSessions(): HubSessionsValue {
  const value = useContext(HubSessionsContext)
  if (!value) throw new Error('useHubSessions must be used within HubSessionsProvider')
  return value
}

export function HubSessionsProvider({
  store = hubSessions,
  themeCache = hubThemeCache,
  children
}: {
  store?: HubSessionStore
  themeCache?: { forget(hubId: string): void }
  children: ReactNode
}) {
  const [sessions, setSessions] = useState<HubSession[] | undefined>(undefined)

  useEffect(() => {
    void store
      .restore()
      // A keychain the app cannot read is no session: the sign-in screen.
      .catch((): HubSession[] => [])
      .then((restored) => setSessions((current) => current ?? restored))
  }, [store])

  const signedIn = useCallback((session: HubSession) => {
    setSessions((current = []) => {
      const at = current.findIndex((s) => s.entry.id === session.entry.id)
      if (at === -1) return [...current, session]
      return current.map((s, i) => (i === at ? session : s))
    })
  }, [])

  const signOut = useCallback(
    (hubId: string) => {
      themeCache.forget(hubId)
      void store.forget(hubId)
      setSessions((current) => current?.filter((s) => s.entry.id !== hubId))
    },
    [store, themeCache]
  )

  const value = useMemo(() => ({ sessions, signedIn, signOut }), [sessions, signedIn, signOut])
  return <HubSessionsContext.Provider value={value}>{children}</HubSessionsContext.Provider>
}
