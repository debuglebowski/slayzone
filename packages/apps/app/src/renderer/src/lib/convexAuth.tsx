import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { ConvexReactClient, useMutation, useConvexAuth } from 'convex/react'
import { ConvexAuthProvider, useAuthActions } from '@convex-dev/auth/react'
import { useVisibleInterval } from '@slayzone/ui'
import { useTRPCClient } from '@slayzone/transport/client'
import { api } from 'convex/_generated/api'

const ONE_DAY = 24 * 60 * 60 * 1000

interface LeaderboardAuthState {
  configured: boolean
  isLoading: boolean
  isAuthenticated: boolean
  lastError: string | null
  signInWithGitHub: () => Promise<void>
  signOut: () => Promise<void>
  forgetMe: () => Promise<void>
}

const defaultState: LeaderboardAuthState = {
  configured: false,
  isLoading: false,
  isAuthenticated: false,
  lastError: null,
  signInWithGitHub: async () => {},
  signOut: async () => {},
  forgetMe: async () => {}
}

const LeaderboardAuthContext = createContext<LeaderboardAuthState>(defaultState)
const convexUrl = import.meta.env.VITE_CONVEX_URL?.trim() ?? ''
const convexClient = convexUrl ? new ConvexReactClient(convexUrl) : null
export const isConvexConfigured = !!convexClient
const OAUTH_REDIRECT_URI = 'slayzone://auth/callback'
const VERIFIER_STORAGE_KEY = '__convexAuthOAuthVerifier'
const AUTH_STORAGE_NAMESPACE = convexUrl.replace(/\/+$/, '')

function namespacedVerifierKey(namespace: string): string {
  const escapedNamespace = namespace.replace(/[^a-zA-Z0-9]/g, '')
  return `${VERIFIER_STORAGE_KEY}_${escapedNamespace}`
}

function clearConvexAuthStorage(): void {
  const keysToRemove: string[] = []
  for (let i = 0; i < window.localStorage.length; i += 1) {
    const key = window.localStorage.key(i)
    if (!key) continue
    if (key.startsWith('__convexAuth')) keysToRemove.push(key)
  }
  for (const key of keysToRemove) {
    window.localStorage.removeItem(key)
  }
}

// Shape returned by app.auth.githubSystemSignIn — the router types it as
// `unknown` (app-deps authGithubSystemSignIn: () => Promise<unknown>), so the
// renderer applies the documented result shape locally.
interface GithubSystemSignInResult {
  ok?: boolean
  code?: string
  verifier?: string
  cancelled?: boolean
  error?: string
}

function ConvexAuthBridge({ children }: { children: React.ReactNode }): React.JSX.Element {
  const { isLoading, isAuthenticated } = useConvexAuth()
  const actions = useAuthActions()
  const trpcClient = useTRPCClient()
  const [lastError, setLastError] = useState<string | null>(null)
  const handledOAuthCodesRef = useRef<Set<string>>(new Set())

  const completeOAuthCode = useCallback(
    async (code: string) => {
      if (handledOAuthCodesRef.current.has(code)) return
      handledOAuthCodesRef.current.add(code)
      try {
        const result = await actions.signIn('github', { code, redirectTo: OAUTH_REDIRECT_URI })
        if (!result.signingIn) {
          setLastError('GitHub callback received, but session activation did not complete.')
        } else {
          setLastError(null)
        }
      } catch (e) {
        setLastError(e instanceof Error ? e.message : 'Sign-in completion failed')
      }
    },
    [actions]
  )

  const value = useMemo<LeaderboardAuthState>(
    () => ({
      configured: true,
      isLoading,
      isAuthenticated,
      lastError,
      signInWithGitHub: async () => {
        try {
          setLastError(null)
          if (convexUrl) {
            const signInResult = (await trpcClient.app.auth.githubSystemSignIn.mutate({
              convexUrl,
              redirectTo: OAUTH_REDIRECT_URI
            })) as GithubSystemSignInResult

            if (signInResult.ok && signInResult.code && signInResult.verifier) {
              window.localStorage.setItem(
                namespacedVerifierKey(AUTH_STORAGE_NAMESPACE),
                signInResult.verifier
              )
              await completeOAuthCode(signInResult.code)
              return
            }
            if (signInResult.cancelled) return
            setLastError(signInResult.error ?? 'GitHub sign-in failed before callback.')
            return
          }

          const result = await actions.signIn('github', { redirectTo: OAUTH_REDIRECT_URI })
          if (!result.signingIn && !result.redirect) {
            setLastError(
              'GitHub sign-in returned no redirect URL. Check Convex auth env vars and provider setup.'
            )
          }
        } catch (error) {
          setLastError(error instanceof Error ? error.message : 'Sign-in failed')
        }
      },
      signOut: async () => {
        try {
          setLastError(null)
          await actions.signOut()
        } catch (error) {
          setLastError(error instanceof Error ? error.message : 'Sign-out failed')
        }
      },
      forgetMe: async () => {
        try {
          setLastError(null)
          try {
            await actions.signOut()
          } catch {
            // Ignore sign-out failures after account deletion.
          }
          clearConvexAuthStorage()
        } catch (error) {
          setLastError(error instanceof Error ? error.message : 'Forget-me failed')
        }
      }
    }),
    [actions, completeOAuthCode, isAuthenticated, isLoading, lastError, trpcClient]
  )

  // Background leaderboard stats sync once a day
  const syncDailyStats = useMutation(api.leaderboard.syncDailyStats)
  const sync = useCallback((): void => {
    trpcClient.app.leaderboard.getLocalStats
      .query()
      .then((stats) => {
        if (stats.days.length > 0) syncDailyStats({ days: stats.days })
      })
      .catch(() => {})
  }, [syncDailyStats, trpcClient])

  useEffect(() => {
    if (!isAuthenticated) return
    sync()
  }, [isAuthenticated, sync])

  useVisibleInterval(sync, ONE_DAY, { enabled: isAuthenticated })

  return <LeaderboardAuthContext.Provider value={value}>{children}</LeaderboardAuthContext.Provider>
}

export function ConvexAuthBootstrap({
  children
}: {
  children: React.ReactNode
}): React.JSX.Element {
  if (!convexClient) {
    return (
      <LeaderboardAuthContext.Provider value={defaultState}>
        {children}
      </LeaderboardAuthContext.Provider>
    )
  }

  return (
    <ConvexAuthProvider client={convexClient} storageNamespace={AUTH_STORAGE_NAMESPACE}>
      <ConvexAuthBridge>{children}</ConvexAuthBridge>
    </ConvexAuthProvider>
  )
}

export function useLeaderboardAuth(): LeaderboardAuthState {
  return useContext(LeaderboardAuthContext)
}
