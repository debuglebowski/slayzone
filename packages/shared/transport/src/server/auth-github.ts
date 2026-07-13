// Convex GitHub OAuth "sign-in start" — shared by the Electron-main host
// (`packages/apps/app/src/main/index.ts` githubSystemSignIn) and the
// chromium-fork sidecar (`packages/apps/hub/src/composition.ts`
// authGithubSystemSignIn). Both shells drive the SAME PKCE handshake: POST the
// Convex `auth:signIn` action to obtain the GitHub authorize URL + the PKCE
// verifier, then open that URL in the user's browser. The two shells diverge
// only in HOW the `slayzone://auth/callback` code gets back to the renderer
// (Electron: the main process waits for `open-url` and returns the code inline;
// fork: the chromium shell forwards the deep-link to the sidecar socket, which
// pushes it over the `app.auth.onCallback` tRPC subscription). The start is
// identical, so it lives here — never reimplement it per shell.

export interface GithubSignInStart {
  /** The GitHub OAuth authorize URL to open in the user's browser. */
  redirect: string
  /** PKCE verifier the renderer stashes in localStorage to complete the code. */
  verifier: string
}

/**
 * Kick off a Convex GitHub OAuth flow. Returns the authorize URL + PKCE
 * verifier. Throws on any validation/bootstrap failure (callers map it to a
 * `{ ok: false, error }` result).
 *
 * @param convexClient identifies the caller in the `Convex-Client` header
 *        (cosmetic; defaults to `slayzone`).
 */
export async function requestGithubSignInStart(
  convexUrl: string,
  redirectTo: string,
  convexClient = 'slayzone'
): Promise<GithubSignInStart> {
  let convexSite: URL
  try {
    convexSite = new URL(convexUrl)
  } catch {
    throw new Error('Convex URL is invalid')
  }
  if (convexSite.protocol !== 'https:' && convexSite.protocol !== 'http:') {
    throw new Error('Convex URL must use http or https')
  }

  const response = await fetch(`${convexSite.origin}/api/action`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Convex-Client': convexClient
    },
    body: JSON.stringify({
      path: 'auth:signIn',
      format: 'convex_encoded_json',
      args: [
        {
          provider: 'github',
          params: { redirectTo }
        }
      ]
    })
  })

  if (!response.ok) {
    throw new Error(`Auth bootstrap failed (${response.status})`)
  }

  const body = (await response.json()) as {
    status?: string
    value?: { redirect?: string; verifier?: string }
    errorMessage?: string
  }
  if (body.status === 'error') {
    throw new Error(body.errorMessage ?? 'Auth bootstrap failed')
  }
  if (body.status !== 'success') {
    throw new Error('Auth bootstrap returned an unexpected response')
  }

  const redirect = body.value?.redirect
  const verifier = body.value?.verifier
  if (!redirect || !verifier) {
    throw new Error('Auth bootstrap response missing redirect or verifier')
  }

  let redirectUrl: URL
  try {
    redirectUrl = new URL(redirect)
  } catch {
    throw new Error('Auth bootstrap returned an invalid redirect URL')
  }
  if (redirectUrl.protocol !== 'https:') {
    throw new Error('GitHub sign-in URL must use https')
  }

  return { redirect: redirectUrl.toString(), verifier }
}

/**
 * Parse a `slayzone://auth/callback?code=…` deep-link URL into its OAuth
 * callback payload. Mirrors the Electron-main `handleOAuthDeepLink` extraction
 * (query OR hash params; `error_description` preferred over `error`). Returns
 * `null` when the URL is unparseable or is not an auth callback.
 */
export function parseAuthCallbackUrl(url: string): { code?: string; error?: string } | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  const normalizedPath = parsed.pathname.replace(/\/+$/, '')
  const isAuthCallback =
    (parsed.hostname === 'auth' && normalizedPath === '/callback') ||
    // Some platforms normalize custom URLs as slayzone:///auth/callback
    (parsed.hostname === '' && normalizedPath === '/auth/callback')
  if (!isAuthCallback) return null

  const hashParams = new URLSearchParams(
    parsed.hash.startsWith('#') ? parsed.hash.slice(1) : parsed.hash
  )
  const code = parsed.searchParams.get('code') ?? hashParams.get('code') ?? undefined
  const error =
    parsed.searchParams.get('error_description') ??
    parsed.searchParams.get('error') ??
    hashParams.get('error_description') ??
    hashParams.get('error') ??
    undefined
  return { code, error }
}
