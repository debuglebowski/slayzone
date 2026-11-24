// Web shell entry. Install window.api BEFORE the renderer module graph
// evaluates (mirrors chromium-shell's main.tsx — @slayzone/settings' module-
// eval read of `window.api` must happen after this assignment), then boot.
// zod-jitless: the bundle's `zod` (vite.config.ts alias), so every schema module already
// depends on it; imported here too so the eval probe is off even before any schema.
import { deviceSettingsLink } from '@slayzone/transport/client'
import { isDeviceSetting } from '@slayzone/settings-core/device-keys'
import './zod-jitless'
import './main.css'
import { createRoot } from 'react-dom/client'
import { electronBootstrap } from '@slayzone/transport/client'
import { initTrpcClient } from './trpc'
import { setupWindowApi } from './window-api'
import { authInvalidationLink } from './auth-invalidation-link'
import { browserOpenExternalLink } from './browser-open-external-link'
import { LoginScreen } from './LoginScreen'
import { SignOutControl } from './SignOutControl'
import { signInErrorMessage } from '@slayzone/hub-auth/client'
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
    createRoot(el).render(
      <LoginScreen
        methods={signIn.methods}
        signInError={
          // Worded for this hub's provider (the error was read before /health answered).
          signInError && signIn.ssoLabel
            ? { ...signInError, message: signInErrorMessage(signInError.code, signIn.ssoLabel) }
            : signInError
        }
        {...(signIn.ssoLabel ? { ssoLabel: signIn.ssoLabel } : {})}
      />
    )
    return
  }

  const trpcUrl = withWindowId(server.url, windowId)
  // Install the web-only links before mountApp() and TrpcProvider reuse the tRPC
  // singleton. This covers both React mutations and vanilla client calls.
  //
  // No token (T-13): the browser sends the session cookie with the `/trpc` upgrade on
  // its own, and the hub honours it only from this page's Origin.
  initTrpcClient(trpcUrl, {
    links: [
      browserOpenExternalLink,
      authInvalidationLink(),
      // Device-only preferences stay in this browser (plans/settings-by-scope.md, phase 4).
      deviceSettingsLink({ isDeviceKey: isDeviceSetting, storage: window.localStorage })
    ]
  })

  const { mountApp } = await import('@slayzone/renderer-app')
  // The web shell has no onboarding (MountAppOptions in renderer-app's main.tsx).
  await mountApp({ onboarding: false })
  if (signIn.authRequired) mountSignOut()
}

void boot()
