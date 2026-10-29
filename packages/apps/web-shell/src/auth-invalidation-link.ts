import { TRPCClientError, type TRPCLink } from '@trpc/client'
import { observable } from '@trpc/server/observable'
import type { AppRouter } from '@slayzone/api'

/**
 * Web-only link: reacts to an `UNAUTHORIZED` error from any operation by
 * reloading back to the login screen. The session is the hub's HttpOnly cookie
 * (T-13), which the page can neither read nor clear; on reload `main.tsx` asks
 * the hub (`fetchSignedIn`) and renders `LoginScreen` for a session that ended.
 * That check and the socket apply the same rule (cookie + the hub page's
 * `Origin`), so a reload cannot land on "signed in" for a socket that is not —
 * no reload loop.
 *
 * WHY THIS IS NEEDED. The web shell's hub enforces auth on every non-open
 * procedure (`hubAuthRequired = !supervised`, unconditionally true for a
 * hub reachable at all from a browser). A scoped session's sliding expiry
 * (7d idle / 30d absolute, `web-sessions.ts`) or a server-side revoke
 * (`slay hub sessions revoke`) can invalidate the session at any time
 * WITHOUT closing the already-open WebSocket — `connectionParams` is sent
 * once, at connect (see `initTrpcClient`'s docstring), so the socket stays
 * open and every subsequent call just starts failing `UNAUTHORIZED`. Without
 * this link the app would sit there rendering broken empty states forever,
 * with no path back to a working state short of the user manually clearing
 * site data.
 *
 * ONLY `UNAUTHORIZED`, never `FORBIDDEN`: a `FORBIDDEN` (insufficient scope
 * for an otherwise-valid session — e.g. an `agent`-scoped session hitting a
 * `full`-only procedure) is a real, permanent capability limit. Bouncing a
 * perfectly valid session to login would not fix anything and
 * would just be an infinite reload loop the moment the same request re-fires
 * post-login with the exact same scope.
 *
 * A full page reload (not a React-level state transition back to
 * `LoginScreen`) is deliberate: it discards every in-flight WS subscription
 * and cached query result rather than trying to reconcile a half-torn-down
 * authenticated React tree — the same reasoning `RemoteConfigScreen`'s
 * `relaunch()` recovery path uses on desktop.
 */
export function authInvalidationLink(): TRPCLink<AppRouter> {
  return () =>
    ({ op, next }) =>
      observable((observer) => {
        const sub = next(op).subscribe({
          next: (value) => observer.next(value),
          error: (err) => {
            if (err instanceof TRPCClientError && err.data?.code === 'UNAUTHORIZED') {
              window.location.reload()
              return // reload is already in flight — don't also propagate the error
            }
            observer.error(err)
          },
          complete: () => observer.complete()
        })
        return () => sub.unsubscribe()
      })
}
