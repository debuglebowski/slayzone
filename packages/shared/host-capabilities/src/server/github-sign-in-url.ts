import { assertHubConvexSignInUrl } from '@slayzone/platform/hub-switch-refusal'

/**
 * The Convex URL a HUB may start GitHub sign-in against for a client that asked with
 * `clientConvexUrl`: the hub's own deployment (`SLAYZONE_HUB_CONVEX_ADDRESS`), never the
 * client's value (T-99 — the hub must not POST to a host a client picks). Throws the
 * stable switch refusal (`HUB_CONVEX_NOT_CONFIGURED` / `HUB_CONVEX_MISMATCH`) after one
 * audit line otherwise. Called by the `app.auth.githubSystemSignIn` router (every hub)
 * and again by the standalone hub's own sign-in start as a backstop; the Electron host
 * receives the value the router resolved.
 */
export function hubGithubSignInConvexUrl(clientConvexUrl: unknown): string {
  return assertHubConvexSignInUrl(clientConvexUrl, {
    op: 'sign_in',
    detail: { provider: 'github' }
  })
}
