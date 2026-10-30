// Web shell entry. Install window.api BEFORE the renderer module graph
// evaluates (mirrors chromium-shell's main.tsx — @slayzone/settings' module-
// eval read of `window.api` must happen after this assignment), then boot.
// zod-jitless first: it must run before any module builds a zod schema.
import './zod-jitless'
import './main.css'
import { createRoot } from 'react-dom/client'
import { electronBootstrap } from '@slayzone/transport/client'
import { initTrpcClient } from './trpc'
import { setupWindowApi } from './window-api'
import { authInvalidationLink } from './auth-invalidation-link'
import { LoginScreen } from './LoginScreen'
import { SignOutControl } from './SignOutControl'
import { fetchHubSignIn } from './hub-health'
import { fetchSignedIn } from './web-session'
import { clearLegacySessionToken } from './web-session-storage'
import { takeSignInError } from './sign-in-error'

// T-13: the session lives only in the hub's HttpOnly cookie. Delete the token an earlier
// version kept in localStorage, first thing on every load.
clearLegacySessionToken()
;(window as unknown as { api: ReturnType<typeof setupWindowApi> }).api = setupWindowApi()

function withWindowId(url: string, windowId: number | null): string {
  if (windowId == null) return url
  return `${url}${url.includes('?') ? '&' : '?'}windowId=${windowId}`
}

/** The sign-out control, in its own root beside the app (SignOutControl.tsx). */
function mountSignOut(): void {
  const host = document.createElement('div')
  host.id = 'web-shell-sign-out'
  document.body.appendChild(host)
  createRoot(host).render(<SignOutControl />)
}

async function boot(): Promise<void> {
  const el = document.getElementById('root')
  if (!el) throw new Error('[web-shell] #root element not found')
  // A sign-in that did not complete comes back with `?signin=failed` or, from
  // better-auth's error page under NODE_ENV=production, `?error=` (sign-in-error.ts).
  const signInError = takeSignInError()

  const [server, windowId, signIn] = await Promise.all([
    electronBootstrap.getServerUrl(),
    electronBootstrap.getWindowId(),
    fetchHubSignIn()
  ])

  // A hub with login off verifies no credential at all — `authRequired` (from /health,
  // public and unauthenticated) is how this shell learns that before it signs in, and
  // it then connects straight through, as desktop/CLI clients do. Every other hub
  // enforces auth; there the session is the hub's HttpOnly cookie, which this page
  // cannot read, so it asks the hub whether this browser holds a live one.
  if (signIn.authRequired && !(await fetchSignedIn())) {
    createRoot(el).render(<LoginScreen methods={signIn.methods} signInError={signInError} />)
    return
  }

  const trpcUrl = withWindowId(server.url, windowId)
  // Pre-initialize the tRPC singleton with the auth-invalidation link BEFORE
  // renderer-app's mountApp() makes its own (now cache-hit — initTrpcClient is
  // idempotent, first call wins, see its docstring) initTrpcClient call. This decides
  // the whole link stack for the web shell: mountApp()'s own browserMojoLink() never
  // gets added, which is correct — a plain web page has no native browser-panel host
  // for that link to bridge to.
  //
  // No token (T-13): the browser sends the session cookie with the `/trpc` upgrade on
  // its own, and the hub honours it only from this page's Origin.
  initTrpcClient(trpcUrl, { links: [authInvalidationLink()] })

  const { mountApp } = await import('@slayzone/renderer-app')
  // The web shell has no onboarding (MountAppOptions in renderer-app's main.tsx).
  await mountApp({ onboarding: false })
  if (signIn.authRequired) mountSignOut()
}

void boot()
