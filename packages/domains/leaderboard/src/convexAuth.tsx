import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { ConvexReactClient, useMutation, useConvexAuth } from 'convex/react'
import { ConvexAuthProvider, useAuthActions } from '@convex-dev/auth/react'
import { useVisibleInterval } from '@slayzone/ui'
import { useTRPCClient } from '@slayzone/transport/client'
import { api } from 'convex/_generated/api'
import { LEADERBOARD_AUTH_DISABLED, type LeaderboardAuthState } from './auth'

// Convex + GitHub-OAuth wiring for the leaderboard, shared by BOTH shells:
//   • Electron renderer — mounts <ConvexAuthBootstrap> (default 'inline').
//   • Chromium-shell fork — mounts <ConvexAuthBootstrap oauthDelivery="subscription">.
//
// The Convex session lives in THIS renderer (ConvexAuthProvider owns the token +
// localStorage), because LeaderboardPageInner's Convex useQuery/useMutation need
// an authenticated client. The two shells differ ONLY in how the
// `slayzone://auth/callback` OAuth code reaches the bridge:
//   • inline (Electron): the `app.auth.githubSystemSignIn` mutation runs in the
//     Electron main process, which waits for the deep-link and returns the code
//     synchronously in the mutation result.
//   • subscription (fork): `slayzone://` deep-links route to the chromium C++
//     shell → sidecar `auth:deep-link` socket RPC → `app.auth.onCallback` tRPC
//     subscription. The mutation only STARTS the flow (opens the browser, returns
//     the PKCE verifier + `pending`); the code arrives later over the sub.
// Either way the code is finished with `actions.signIn('github', { code })`,
// which reads the stashed verifier from localStorage to complete PKCE.

const ONE_DAY = 24 * 60 * 60 * 1000

const LeaderboardAuthContext = createContext<LeaderboardAuthState>(LEADERBOARD_AUTH_DISABLED)
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

// The OAuth `error` arrives in the deep-link callback URL — i.e. it is
// attacker-influenceable — and gets rendered in the trusted app chrome. Map the
// known OAuth error codes to fixed copy and never surface a raw string, so a
// forged callback can't plant phishing text in the UI.
const KNOWN_OAUTH_ERRORS: Record<string, string> = {
  access_denied: 'GitHub sign-in was denied.',
  server_error: 'GitHub reported a server error during sign-in.',
  temporarily_unavailable: 'GitHub sign-in is temporarily unavailable. Try again.'
}
function sanitizeAuthError(raw: string | undefined): string {
  if (raw && Object.prototype.hasOwnProperty.call(KNOWN_OAUTH_ERRORS, raw)) {
    return KNOWN_OAUTH_ERRORS[raw]
  }
  return 'GitHub sign-in failed.'
}

interface GithubSystemSignInResult {
  ok?: boolean
  code?: string
  verifier?: string
  /** Fork: the flow started; the code arrives later via app.auth.onCallback. */
  pending?: boolean
  cancelled?: boolean
  error?: string
}

/** How the OAuth callback code is delivered to the bridge (see header). */
export type OAuthDelivery = 'inline' | 'subscription'

function ConvexAuthBridge({
  oauthDelivery = 'inline',
  children
}: {
  oauthDelivery?: OAuthDelivery
  children: React.ReactNode
}): React.JSX.Element {
  const { isLoading, isAuthenticated } = useConvexAuth()
  const actions = useAuthActions()
  const trpcClient = useTRPCClient()
  const [lastError, setLastError] = useState<string | null>(null)
  const handledOAuthCodesRef = useRef<Set<string>>(new Set())
  // True between starting a GitHub sign-in and consuming its callback. The
  // always-on onCallback subscription ignores callbacks when this is false, so a
  // deep-link we didn't initiate can't drive a sign-in (defense-in-depth atop
  // PKCE, which already rejects a code mispaired with this renderer's verifier).
  const flowPendingRef = useRef(false)

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
      } finally {
        // PKCE verifier is single-use — drop it once the exchange has been
        // attempted so a stale verifier can't widen a replay window.
        try {
          window.localStorage.removeItem(namespacedVerifierKey(AUTH_STORAGE_NAMESPACE))
        } catch {
          /* ignore */
        }
      }
    },
    [actions]
  )

  // Fork only: the sidecar relays the OAuth callback over this subscription
  // after the chromium shell forwards the slayzone:// deep-link. Electron uses
  // the inline mutation return and never opens this sub.
  useEffect(() => {
    if (oauthDelivery !== 'subscription') return
    const sub = trpcClient.app.auth.onCallback.subscribe(undefined, {
      onData: (payload: { code?: string; error?: string }) => {
        // Only act on a callback for a sign-in WE started — ignore unsolicited /
        // injected deep-link callbacks.
        if (!flowPendingRef.current) return
        flowPendingRef.current = false
        if (payload.error) {
          setLastError(sanitizeAuthError(payload.error))
          return
        }
        if (payload.code) void completeOAuthCode(payload.code)
      }
    })
    return () => sub.unsubscribe()
  }, [oauthDelivery, trpcClient, completeOAuthCode])

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
            // Arm the callback subscription before opening the browser so a fast
            // (fork) callback isn't dropped; the onCallback handler disarms it.
            flowPendingRef.current = true
            const signInResult = (await trpcClient.app.auth.githubSystemSignIn.mutate({
              convexUrl,
              redirectTo: OAUTH_REDIRECT_URI
            })) as GithubSystemSignInResult

            if (signInResult.ok && signInResult.verifier) {
              // Stash the PKCE verifier so actions.signIn('github', { code })
              // can complete the exchange once the code arrives.
              window.localStorage.setItem(
                namespacedVerifierKey(AUTH_STORAGE_NAMESPACE),
                signInResult.verifier
              )
              if (signInResult.code) {
                // Electron inline path: main returned the code synchronously.
                await completeOAuthCode(signInResult.code)
                return
              }
              if (signInResult.pending) {
                // Fork path: browser opened; await app.auth.onCallback.
                return
              }
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
  oauthDelivery,
  children
}: {
  oauthDelivery?: OAuthDelivery
  children: React.ReactNode
}): React.JSX.Element {
  if (!convexClient) {
    return (
      <LeaderboardAuthContext.Provider value={LEADERBOARD_AUTH_DISABLED}>
        {children}
      </LeaderboardAuthContext.Provider>
    )
  }

  return (
    <ConvexAuthProvider client={convexClient} storageNamespace={AUTH_STORAGE_NAMESPACE}>
      <ConvexAuthBridge oauthDelivery={oauthDelivery}>{children}</ConvexAuthBridge>
    </ConvexAuthProvider>
  )
}

export function useLeaderboardAuth(): LeaderboardAuthState {
  return useContext(LeaderboardAuthContext)
}
