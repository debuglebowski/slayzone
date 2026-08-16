// Web shell entry. Install window.api BEFORE the renderer module graph
// evaluates (mirrors chromium-shell's main.tsx — @slayzone/settings' module-
// eval read of `window.api` must happen after this assignment), then boot.
import './main.css'
import { createRoot } from 'react-dom/client'
import { initTrpcClient, electronBootstrap } from '@slayzone/transport/client'
import { setupWindowApi } from './window-api'
import { authInvalidationLink } from './auth-invalidation-link'
import { LoginScreen } from './LoginScreen'
import { fetchAuthRequired } from './hub-health'

;(window as unknown as { api: ReturnType<typeof setupWindowApi> }).api = setupWindowApi()

function withWindowId(url: string, windowId: number | null): string {
  if (windowId == null) return url
  return `${url}${url.includes('?') ? '&' : '?'}windowId=${windowId}`
}

async function boot(): Promise<void> {
  const el = document.getElementById('root')
  if (!el) throw new Error('[web-shell] #root element not found')

  const [server, windowId, registry, hubTokens, authRequired] = await Promise.all([
    electronBootstrap.getServerUrl(),
    electronBootstrap.getWindowId(),
    electronBootstrap.getHubRegistry(),
    electronBootstrap.getHubTokens(),
    fetchAuthRequired()
  ])
  const token = hubTokens[registry.defaultHubId]

  // A SUPERVISED hub never verifies a bearer at all (hubAuthRequired =
  // !supervised, see server.ts) — `authRequired` (from /health, public and
  // unauthenticated) is how this shell learns that BEFORE it has a token.
  // Mirrors how desktop/CLI clients already connect to a supervised hub:
  // no bearer, straight through. Every OTHER hub enforces auth
  // unconditionally, so there `!token` really does mean "not signed in
  // yet", not an edge case to route around.
  if (authRequired && !token) {
    createRoot(el).render(<LoginScreen />)
    return
  }

  const trpcUrl = withWindowId(server.url, windowId)
  // Pre-initialize the tRPC singleton with the scoped token (when the hub
  // has one to check) + the auth-invalidation link BEFORE renderer-app's
  // mountApp() makes its own (now cache-hit — initTrpcClient is idempotent,
  // first call wins, see its docstring) initTrpcClient call. This decides
  // the whole link stack for the web shell: mountApp()'s own
  // browserMojoLink() never gets added, which is correct — a plain web page
  // has no native browser-panel host for that link to bridge to.
  initTrpcClient(trpcUrl, {
    links: [authInvalidationLink()],
    ...(token ? { token } : {})
  })

  const { mountApp } = await import('@slayzone/renderer-app')
  await mountApp()
}

void boot()
