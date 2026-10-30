import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { ConvexProvider, ConvexReactClient, useMutation, useConvexAuth } from 'convex/react'
import { ConvexAuthProvider, useAuthActions } from '@convex-dev/auth/react'
import { useVisibleInterval } from '@slayzone/ui'
import { hubAllows } from '@slayzone/transport/client'
import { useTelemetry } from '@slayzone/telemetry/client'
import { useTRPCClient } from './trpc'
import { api } from 'convex/_generated/api'
import {
  LEADERBOARD_AUTH_DISABLED,
  type LeaderboardAuthState,
  type LeaderboardUnavailable
} from './auth'

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
//
// Which deployment: the host hands it to <ConvexAuthBootstrap convexUrl>; omitted,
// it is this bundle's build-time `VITE_CONVEX_URL`. '' = Convex off for this host
// (no leaderboard / feedback entry points): read it from
// `useLeaderboardAuth().configured`, never from the build env, so a host-chosen
// deployment (the Electron app's main process decides it, see
// app/src/main/convex-deployment.ts) is the one fact every consumer sees.
//
// Whether: Convex is third-party telemetry. It starts only once
// `useTelemetry().thirdPartyServices` is 'allowed' — the user's tier is not `off` and
// the HOME hub (the one this app's own data lives on) does not have
// `SLAYZONE_HUB_ENABLE_TELEMETRY=0` — and is closed again the moment that changes.
// Another hub with the switch off does not stop it: nothing of that hub's reaches
// Convex — the leaderboard reads the home hub's stats only (`app.leaderboard.getLocalStats`
// on the nearest client), and feedback is what the user types. So the Convex session is a SIBLING of the app tree, not its
// parent: starting or stopping it never remounts the app. The few Convex consumers
// (leaderboard table, feedback) reach the client through <ConvexScope>.

const ONE_DAY = 24 * 60 * 60 * 1000

const LeaderboardAuthContext = createContext<LeaderboardAuthState>(LEADERBOARD_AUTH_DISABLED)
/** The running Convex client (null while Convex is off), for {@link ConvexScope}. */
const ConvexClientContext = createContext<ConvexReactClient | null>(null)
/** This bundle's own Convex deployment — the default when the host names none. */
const BUILD_CONVEX_URL = import.meta.env.VITE_CONVEX_URL?.trim() ?? ''
const OAUTH_REDIRECT_URI = 'slayzone://auth/callback'
const VERIFIER_STORAGE_KEY = '__convexAuthOAuthVerifier'

interface ConvexDeployment {
  url: string
  client: ConvexReactClient
  /** Key namespace of this deployment's auth state in localStorage. */
  storageNamespace: string
}

const deployments = new Map<string, ConvexDeployment>()
/** Mounted users of each deployment ({@link useConvexDeployment}); it closes at none. */
const deploymentUsers = new Map<ConvexDeployment, number>()

/**
 * One client per deployment URL while it is in use ('' → none): a re-render never
 * reconnects. Creating it opens nothing — `ConvexReactClient` connects on first use,
 * which is `ConvexAuthProvider` mounting.
 */
function convexDeployment(url: string): ConvexDeployment | null {
  if (!url) return null
  let deployment = deployments.get(url)
  if (!deployment) {
    deployment = {
      url,
      client: new ConvexReactClient(url),
      storageNamespace: url.replace(/\/+$/, '')
    }
    deployments.set(url, deployment)
  }
  return deployment
}

/**
 * The deployment for `url` while this component uses it ('' → none). When no component
 * uses it any more the client is closed — its socket with it, so nothing reaches Convex
 * — and forgotten, so the next use starts a fresh one. Closing waits a microtask: a
 * StrictMode re-run of the effect takes the same deployment straight back.
 */
function useConvexDeployment(url: string): ConvexDeployment | null {
  const deployment = convexDeployment(url)
  useEffect(() => {
    if (!deployment) return
    deploymentUsers.set(deployment, (deploymentUsers.get(deployment) ?? 0) + 1)
    return () => {
      const left = (deploymentUsers.get(deployment) ?? 1) - 1
      if (left > 0) deploymentUsers.set(deployment, left)
      else deploymentUsers.delete(deployment)
      queueMicrotask(() => {
        if (deploymentUsers.has(deployment) || deployments.get(deployment.url) !== deployment)
          return
        deployments.delete(deployment.url)
        // A socket that is already gone leaves nothing to stop.
        deployment.client.close().catch(() => undefined)
      })
    }
  }, [deployment])
  return deployment
}

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

const ON_CALLBACK_PATH = 'app.auth.onCallback'

/** How the OAuth callback code is delivered to the bridge (see header). */
export type OAuthDelivery = 'inline' | 'subscription'

/** What a bridge reports up: its auth state, tagged with the deployment it is for. */
interface ReportedAuth {
  deployment: ConvexDeployment
  auth: LeaderboardAuthState
}

function ConvexAuthBridge({
  deployment,
  oauthDelivery = 'inline',
  onAuth
}: {
  deployment: ConvexDeployment
  oauthDelivery?: OAuthDelivery
  onAuth: (reported: ReportedAuth) => void
}): null {
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
          window.localStorage.removeItem(namespacedVerifierKey(deployment.storageNamespace))
        } catch {
          /* ignore */
        }
      }
    },
    [actions, deployment]
  )

  // Fork only: the sidecar relays the OAuth callback over this subscription
  // after the chromium shell forwards the slayzone:// deep-link. Electron uses
  // the inline mutation return and never opens this sub. A web session (the same
  // bundle in a browser) may not subscribe — the hub refuses it (`scopes.ts`) — so
  // it asks first (`hubAllows`) rather than open a sub that is only refused.
  useEffect(() => {
    if (oauthDelivery !== 'subscription') return
    let sub: { unsubscribe: () => void } | null = null
    let disposed = false
    void hubAllows(trpcClient, ON_CALLBACK_PATH).then((allowed) => {
      if (!allowed || disposed) return
      sub = trpcClient.app.auth.onCallback.subscribe(undefined, {
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
    })
    return () => {
      disposed = true
      sub?.unsubscribe()
    }
  }, [oauthDelivery, trpcClient, completeOAuthCode])

  const value = useMemo<LeaderboardAuthState>(
    () => ({
      configured: true,
      unavailable: null,
      isLoading,
      isAuthenticated,
      lastError,
      signInWithGitHub: async () => {
        try {
          setLastError(null)
          if (deployment.url) {
            // Arm the callback subscription before opening the browser so a fast
            // (fork) callback isn't dropped; the onCallback handler disarms it.
            flowPendingRef.current = true
            const signInResult = (await trpcClient.app.auth.githubSystemSignIn.mutate({
              convexUrl: deployment.url,
              redirectTo: OAUTH_REDIRECT_URI
            })) as GithubSystemSignInResult

            if (signInResult.ok && signInResult.verifier) {
              // Stash the PKCE verifier so actions.signIn('github', { code })
              // can complete the exchange once the code arrives.
              window.localStorage.setItem(
                namespacedVerifierKey(deployment.storageNamespace),
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
    [actions, completeOAuthCode, deployment, isAuthenticated, isLoading, lastError, trpcClient]
  )

  // Background leaderboard stats sync once a day
  const syncDailyStats = useMutation(api.leaderboard.syncDailyStats)
  const sync = useCallback((): void => {
    trpcClient.app.leaderboard.getLocalStats
      .query()
      .then((stats) => {
        if (stats.days.length > 0) syncDailyStats({ days: stats.days })
      })
      .catch(() => {
        // Background once-a-day stat push — offline or a Convex hiccup must not
        // surface anywhere; the next interval tick re-sends the same days.
      })
  }, [syncDailyStats, trpcClient])

  useEffect(() => {
    if (!isAuthenticated) return
    sync()
  }, [isAuthenticated, sync])

  useVisibleInterval(sync, ONE_DAY, { enabled: isAuthenticated })

  useEffect(() => {
    onAuth({ deployment, auth: value })
  }, [deployment, value, onAuth])

  return null
}

/** Why Convex is not running (yet) on this host — the one reason in force. */
function unavailableReason(
  convexUrl: string,
  telemetry: ReturnType<typeof useTelemetry>
): LeaderboardUnavailable {
  if (!convexUrl) return { kind: 'no-deployment' }
  if (telemetry.thirdPartyServices === 'blocked') {
    if (telemetry.lockedByHub)
      return { kind: 'hub-telemetry-off', hubLabel: telemetry.homeHubLabel }
    if (telemetry.tier === 'off') return { kind: 'telemetry-off' }
  }
  // Answers still coming in, or allowed and the session is starting.
  return { kind: 'starting' }
}

/**
 * Convex for this host: the leaderboard auth state for the app tree, and — once
 * third-party services are allowed (`useTelemetry().thirdPartyServices`) and a deployment
 * is configured — the Convex session beside it. Must sit inside `TelemetryProvider`;
 * outside one, Convex never starts (its default is 'blocked').
 */
export function ConvexAuthBootstrap({
  convexUrl = BUILD_CONVEX_URL,
  oauthDelivery,
  children
}: {
  /** The Convex deployment for this host ('' = Convex off). Default: the bundle's `VITE_CONVEX_URL`. */
  convexUrl?: string
  oauthDelivery?: OAuthDelivery
  children: React.ReactNode
}): React.JSX.Element {
  const telemetry = useTelemetry()
  const allowed = telemetry.thirdPartyServices === 'allowed'
  const deployment = useConvexDeployment(allowed ? convexUrl : '')
  const [reported, setReported] = useState<ReportedAuth | null>(null)
  // Disabled until this deployment's bridge has reported — never a stale state of a
  // closed one.
  const auth =
    deployment && reported?.deployment === deployment
      ? reported.auth
      : { ...LEADERBOARD_AUTH_DISABLED, unavailable: unavailableReason(convexUrl, telemetry) }

  // `children` stays the first child whether or not the session runs, so starting or
  // stopping Convex never remounts the app.
  return (
    <ConvexClientContext.Provider value={deployment?.client ?? null}>
      <LeaderboardAuthContext.Provider value={auth}>{children}</LeaderboardAuthContext.Provider>
      {deployment && (
        <ConvexAuthProvider
          client={deployment.client}
          storageNamespace={deployment.storageNamespace}
        >
          <ConvexAuthBridge
            deployment={deployment}
            oauthDelivery={oauthDelivery}
            onAuth={setReported}
          />
        </ConvexAuthProvider>
      )}
    </ConvexClientContext.Provider>
  )
}

/**
 * The Convex client for a Convex consumer (leaderboard table, feedback dialog): their
 * `useQuery` / `useMutation` / `useAction` need a `ConvexProvider` above them, and the
 * session runs beside the app tree, not around it. Renders nothing while Convex is off —
 * the hosts hide those entry points then anyway (`useLeaderboardAuth().configured`).
 */
export function ConvexScope({ children }: { children: React.ReactNode }): React.JSX.Element | null {
  const client = useContext(ConvexClientContext)
  if (!client) return null
  return <ConvexProvider client={client}>{children}</ConvexProvider>
}

export function useLeaderboardAuth(): LeaderboardAuthState {
  return useContext(LeaderboardAuthContext)
}
