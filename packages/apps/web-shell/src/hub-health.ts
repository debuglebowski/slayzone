// Web shell — pre-boot probe: must this browser sign in, and how?
//
// `GET /health` is deliberately unauthenticated and PUBLIC (see health.ts's
// own docstring: "a client has to learn it needs a token BEFORE it has one")
// — read directly here, not via tRPC (no connection exists yet), so
// `main.tsx` can decide whether to show `LoginScreen` or connect straight
// through. This is what lets a hub with login off serve the web shell usefully:
// it never verifies a credential at all — mirroring how desktop/CLI clients
// already connect to one with no token.
//
// HOW (T-13): the switches /health reports, read by the shared hub sign-in client
// (`hubBrowserSignInOf`, @slayzone/hub-auth/client). Password sign-in when
// `enablePassword` is on; "Sign in with Microsoft" when Entra sign-in is
// (`enableSso` with `requireLogin`, the hub's `ssoActive`).
//
// FAILS CLOSED: any fetch/parse error resolves `authRequired: true` with no
// sign-in method — a transient health-check hiccup must never silently skip the
// login screen against a hub that actually enforces auth; the screen says to
// reload instead.
import {
  HUB_BROWSER_SIGN_IN_UNKNOWN,
  hubBrowserSignInOf,
  type HubBrowserSignIn
} from '@slayzone/hub-auth/client'

export type HubSignIn = HubBrowserSignIn

export async function fetchHubSignIn(): Promise<HubSignIn> {
  try {
    const res = await fetch('/health', { credentials: 'same-origin' })
    if (!res.ok) return HUB_BROWSER_SIGN_IN_UNKNOWN
    return hubBrowserSignInOf(await res.json())
  } catch {
    return HUB_BROWSER_SIGN_IN_UNKNOWN
  }
}
